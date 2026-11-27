import { SPRITE_FLOATS, StreetGraph, defineLayer, seededRandom } from '@mrstudio/sdk';
import type { LayerManifest, SpriteImage } from '@mrstudio/sdk';

import manifest from '../layer.json';
import { carNetworks } from './network.ts';

interface Params {
  density: number;
  taxis: number;
  buses: number;
  emergency: boolean;
  speed: number;
  size: number;
  headlights: boolean;
  opacity: number;
}

type Kind = 'car' | 'taxi' | 'bus' | 'emergency';

interface Vehicle {
  kind: Kind;
  edge: number;
  /** Metres travelled along the edge. */
  s: number;
  /** This driver's speed relative to the control. */
  pace: number;
  /** Drawn heading, eased towards the edge's so turns are not instant. */
  angle: number;
  paint: string;
  /** Seconds since the vehicle came onto the street, for fading in. */
  age: number;
  /** Seconds left before the vehicle is gone, once it has reached a dead end. */
  leaving: number | null;
  /** A bus waiting at a stop, seconds left. */
  stopped: number;
}

/** Seconds a vehicle takes to fade in, or out at a dead end. */
const FADE_S = 0.8;

const MAX_CARS = 600;
/** Vehicles keep right of the centre line by this many metres. */
const LANE_M = 1.8;
const SIZE_M: Record<Kind, { length: number; width: number }> = {
  car: { length: 4.4, width: 1.9 },
  taxi: { length: 4.7, width: 2 },
  bus: { length: 12, width: 2.6 },
  emergency: { length: 5.4, width: 2.1 },
};
const PAINTS = ['#d7dde8', '#9aa4b5', '#5c6a82', '#c9b458', '#b5513c', '#3f6fb5', '#e8e8e8'];
/** As in the interactive map: gold taxis with a green roof sign, transit blue and gold buses. */
const TAXI_PAINTS = ['#ffcc00', '#e6e600'];
const BUS_PAINTS = ['#0088cc', '#ffcc00'];
/** An ambulance or a police car comes through every 10 to 20 seconds, as in the interactive map. */
const EMERGENCY_GAP_S: [number, number] = [10, 20];

/**
 * Seconds between redraws: a full-table picture drawn every frame cost the presented table dearly
 * in WebKit (#596), and at a few pixels a second, movement 30 times a second looks the same.
 */
const FRAME_S = 1 / 30;
/** Pixels per metre in a vehicle's picture: sharp at a table's scale, small for the graphics card. */
const LOOK_PX = 10;

export default defineLayer<Params>({
  manifest: manifest as LayerManifest,

  async table(ctx) {
    const sprites = ctx.map.addSprites('cars', [], { opacity: ctx.params.opacity });
    // No streets, no cars: the editor offers to bring streets in (requires.data).
    const networks = await carNetworks(ctx.site);
    const roads = networks?.cars ?? new StreetGraph([]);
    const busRoads = networks?.buses ?? new StreetGraph([]);
    const random = seededRandom(5);
    const traffic: Vehicle[] = [];
    const buses: Vehicle[] = [];
    let siren: Vehicle | null = null;
    let sirenWait = 4;
    let clock = 0;

    function spawn(kind: Kind, network: StreetGraph, anywhere = true): Vehicle {
      const edge = network.start(random);
      const paints = kind === 'taxi' ? TAXI_PAINTS : kind === 'bus' ? BUS_PAINTS : kind === 'emergency' ? ['#f2f4f8'] : PAINTS;
      return {
        kind,
        edge,
        s: anywhere ? random() * network.edges[edge]!.length : 0,
        pace: kind === 'emergency' ? 1.5 : kind === 'bus' ? 0.6 + random() * 0.2 : 0.7 + random() * 0.6,
        angle: network.edges[edge]!.angle,
        paint: paints[Math.floor(random() * paints.length)]!,
        age: 0,
        leaving: null,
        stopped: 0,
      };
    }
    const spawnTraffic = () => spawn(random() < ctx.params.taxis ? 'taxi' : 'car', roads);

    function resize() {
      const wanted = roads.edges.length === 0 ? 0 : Math.min(MAX_CARS, Math.round((roads.length / 1000) * ctx.params.density));
      while (traffic.length < wanted) traffic.push(spawnTraffic());
      traffic.length = wanted;
      const wantedBuses = busRoads.edges.length === 0 ? 0 : Math.round(ctx.params.buses);
      while (buses.length < wantedBuses) buses.push(spawn('bus', busRoads));
      buses.length = wantedBuses;
    }
    resize();

    /** Moves a vehicle on; false when it has gone and should start again elsewhere. */
    function drive(v: Vehicle, network: StreetGraph, metresPerSecond: number, dt: number): boolean {
      v.age += dt;
      if (v.leaving !== null) {
        v.leaving -= dt;
        // Gone: the vehicle starts again somewhere else, as in the interactive map's traffic.
        if (v.leaving <= 0) return false;
      }
      if (v.stopped > 0) v.stopped -= dt;
      else {
        if (v.kind === 'bus' && random() < dt * 0.06) v.stopped = 1 + random() * 2;
        v.s += metresPerSecond * v.pace * dt;
      }
      let edge = network.edges[v.edge]!;
      // A fast car on short segments may pass more than one junction in a frame.
      for (let hops = 0; v.s >= edge.length && hops < 8; hops++) {
        const next = network.next(v.edge, random);
        if (next === null) {
          // A dead end: the vehicle stops at the end and fades, rather than turning round on the spot (#201).
          v.s = edge.length;
          v.leaving ??= FADE_S;
          break;
        }
        v.s -= edge.length;
        v.edge = next;
        edge = network.edges[v.edge]!;
      }
      const turn = Math.atan2(Math.sin(edge.angle - v.angle), Math.cos(edge.angle - v.angle));
      v.angle += turn * Math.min(1, dt * 6);
      return true;
    }

    // Each look of a vehicle is drawn once, as a picture the graphics card stamps for every vehicle
    // that has it (#609): nothing is drawn on the processor while they drive.
    const looks: SpriteImage[] = [];
    const lookOf = new Map<string, { image: number; w: number; h: number }>();
    function look(kind: Kind, paint: string, headlights: boolean, flash: number) {
      const key = `${kind}|${paint}|${headlights}|${flash}`;
      let found = lookOf.get(key);
      if (!found) {
        const { length, width } = SIZE_M[kind];
        const reach = headlights ? (kind === 'bus' ? 14 : 11) : 0;
        const w = 2 * (length / 2 + reach + 1) + (kind === 'emergency' ? 28 : 0);
        const h = 2 * Math.max(width * 1.2 + 0.5, kind === 'emergency' ? 2.5 + 14 : 0);
        const image = document.createElement('canvas');
        image.width = Math.ceil(w * LOOK_PX);
        image.height = Math.ceil(h * LOOK_PX);
        const g = image.getContext('2d')!;
        g.setTransform(LOOK_PX, 0, 0, LOOK_PX, image.width / 2, image.height / 2);
        paintVehicle(g, kind, paint, headlights, flash);
        found = { image: looks.length, w, h };
        looks.push(image);
        lookOf.set(key, found);
        if (ready) sprites.setImages(looks);
      }
      return found;
    }

    /** One vehicle, heading along +x, centred at the origin, in metres. */
    function paintVehicle(g: CanvasRenderingContext2D, kind: Kind, paint: string, headlights: boolean, flash: number) {
      const { length, width } = SIZE_M[kind];
      if (kind === 'emergency') {
        // Red and blue halos taking turns, added to what is below so they light the street.
        g.globalCompositeOperation = 'lighter';
        for (const [colour, on, side] of [['255 40 40', flash === 0, -1], ['40 90 255', flash === 1, 1]] as const) {
          // Beside the vehicle, one on each side.
          const r = 14 * (on ? 1 : 0.6);
          const cx = 0;
          const cy = side * 2.5;
          const halo = g.createRadialGradient(cx, cy, 0, cx, cy, r);
          halo.addColorStop(0, `rgb(${colour} / ${on ? 0.75 : 0.18})`);
          halo.addColorStop(0.4, `rgb(${colour} / ${on ? 0.25 : 0.05})`);
          halo.addColorStop(1, `rgb(${colour} / 0)`);
          g.fillStyle = halo;
          g.beginPath();
          g.arc(cx, cy, r, 0, Math.PI * 2);
          g.fill();
        }
        g.globalCompositeOperation = 'source-over';
      }
      if (headlights) {
        // Two beams ahead, added to whatever is below so they read as light.
        g.globalCompositeOperation = 'lighter';
        const reach = kind === 'bus' ? 14 : 11;
        const beam = g.createLinearGradient(length / 2, 0, length / 2 + reach, 0);
        beam.addColorStop(0, 'rgb(255 244 214 / 0.45)');
        beam.addColorStop(1, 'rgb(255 244 214 / 0)');
        g.fillStyle = beam;
        g.beginPath();
        g.moveTo(length / 2, -width / 2);
        g.lineTo(length / 2 + reach, -width * 1.2);
        g.lineTo(length / 2 + reach, width * 1.2);
        g.lineTo(length / 2, width / 2);
        g.fill();
        g.globalCompositeOperation = 'source-over';
      }
      g.fillStyle = paint;
      g.beginPath();
      g.roundRect(-length / 2, -width / 2, length, width, kind === 'bus' ? 0.5 : 0.6);
      g.fill();
      if (kind === 'bus') {
        // The window band, seen from above as a dark roof strip.
        g.fillStyle = 'rgb(26 26 46 / 0.85)';
        g.fillRect(-length / 2 + 1, -width / 2 + 0.45, length - 2, width - 0.9);
      } else if (kind === 'taxi') {
        // The roof sign, green when free.
        g.fillStyle = '#00ff88';
        g.fillRect(-0.5, -0.45, 1, 0.9);
      } else if (kind === 'emergency') {
        // The light bar across the roof, half red, half blue.
        g.fillStyle = flash === 0 ? '#ff3333' : '#802020';
        g.fillRect(-0.35, -width / 2 + 0.2, 0.7, width / 2 - 0.2);
        g.fillStyle = flash === 1 ? '#3a6cff' : '#203070';
        g.fillRect(-0.35, 0, 0.7, width / 2 - 0.2);
      }
      g.fillStyle = 'rgb(255 60 50 / 0.95)';
      g.fillRect(-length / 2 - 0.2, -width / 2, 0.6, 0.5);
      g.fillRect(-length / 2 - 0.2, width / 2 - 0.5, 0.6, 0.5);
      if (headlights) {
        g.fillStyle = 'rgb(255 250 230)';
        g.fillRect(length / 2 - 0.4, -width / 2, 0.6, 0.5);
        g.fillRect(length / 2 - 0.4, width / 2 - 0.5, 0.6, 0.5);
      }
    }

    // Every look up front, so the pictures go to the graphics card once.
    let ready = false;
    for (const headlights of [false, true]) {
      for (const paint of PAINTS) look('car', paint, headlights, 0);
      for (const paint of TAXI_PAINTS) look('taxi', paint, headlights, 0);
      for (const paint of BUS_PAINTS) look('bus', paint, headlights, 0);
      for (const flash of [0, 1]) look('emergency', '#f2f4f8', headlights, flash);
    }
    sprites.setImages(looks);
    ready = true;

    let buffer = new Float32Array(0);
    let n = 0;
    function place(v: Vehicle, network: StreetGraph) {
      const { size, headlights } = ctx.params;
      const [x, y] = network.at(v.edge, v.s, LANE_M);
      if (x < -60 || y < -60 || x > ctx.site.extent.width_m + 60 || y > ctx.site.extent.height_m + 60) return;
      const alpha = Math.min(1, v.age / FADE_S, v.leaving === null ? 1 : Math.max(0, v.leaving / FADE_S));
      const { image, w, h } = look(v.kind, v.paint, headlights, v.kind === 'emergency' ? Math.floor(clock * 8) % 2 : 0);
      const o = n++ * SPRITE_FLOATS;
      buffer[o] = x;
      buffer[o + 1] = y;
      buffer[o + 2] = w * size;
      buffer[o + 3] = h * size;
      buffer[o + 4] = v.angle;
      buffer[o + 5] = image;
      buffer[o + 6] = alpha;
    }

    let since = 0;
    ctx.onFrame((frame) => {
      since += frame;
      if (since < FRAME_S) return;
      const dt = Math.min(since, 0.25);
      since = 0;
      clock += dt;
      const metresPerSecond = ctx.params.speed / 3.6;
      for (let i = 0; i < traffic.length; i++) if (!drive(traffic[i]!, roads, metresPerSecond, dt)) traffic[i] = spawnTraffic();
      for (let i = 0; i < buses.length; i++) if (!drive(buses[i]!, busRoads, metresPerSecond, dt)) buses[i] = spawn('bus', busRoads);
      if (siren && !drive(siren, roads, metresPerSecond, dt)) siren = null;
      if (!siren && ctx.params.emergency && roads.edges.length > 0 && (sirenWait -= dt) <= 0) {
        siren = spawn('emergency', roads, false);
        sirenWait = EMERGENCY_GAP_S[0] + random() * (EMERGENCY_GAP_S[1] - EMERGENCY_GAP_S[0]);
      }
      if (siren && !ctx.params.emergency) siren = null;

      const total = traffic.length + buses.length + 1;
      if (buffer.length < total * SPRITE_FLOATS) buffer = new Float32Array(total * SPRITE_FLOATS);
      n = 0;
      for (const v of traffic) place(v, roads);
      for (const v of buses) place(v, busRoads);
      if (siren) place(siren, roads);
      sprites.set(buffer, n);
      ctx.publish({ cars: traffic.length, buses: buses.length, emergency: siren !== null });
    });

    return {
      update(changed) {
        if (changed.includes('opacity')) sprites.setOpacity(ctx.params.opacity);
        if (changed.includes('density') || changed.includes('buses')) resize();
      },
    };
  },
});
