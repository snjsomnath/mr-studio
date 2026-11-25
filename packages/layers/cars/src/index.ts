import { StreetGraph, defineLayer, seededRandom } from '@mrstudio/sdk';
import type { LayerManifest } from '@mrstudio/sdk';

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

export default defineLayer<Params>({
  manifest: manifest as LayerManifest,

  async table(ctx) {
    const canvas = ctx.map.addDrawing('cars', { opacity: ctx.params.opacity });
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

    function draw(v: Vehicle, network: StreetGraph) {
      const { size, headlights } = ctx.params;
      const g = canvas.ctx;
      const [x, y] = network.at(v.edge, v.s, LANE_M);
      if (x < -60 || y < -60 || x > canvas.width + 60 || y > canvas.height + 60) return;
      const alpha = Math.min(1, v.age / FADE_S, v.leaving === null ? 1 : Math.max(0, v.leaving / FADE_S));
      const { length, width } = SIZE_M[v.kind];
      const flash = Math.floor(clock * 8) % 2;

      g.save();
      g.globalAlpha = alpha;
      g.translate(x, y);
      if (v.kind === 'emergency') {
        // Red and blue halos taking turns, added to what is below so they light the street.
        g.globalCompositeOperation = 'lighter';
        for (const [colour, on, side] of [['255 40 40', flash === 0, -1], ['40 90 255', flash === 1, 1]] as const) {
          const r = 14 * size * (on ? 1 : 0.6);
          const cx = Math.cos(v.angle + Math.PI / 2) * side * 2.5;
          const cy = Math.sin(v.angle + Math.PI / 2) * side * 2.5;
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
      g.rotate(v.angle);
      g.scale(size, size);
      if (headlights) {
        // Two beams ahead, added to whatever is below so they read as light.
        g.globalCompositeOperation = 'lighter';
        const reach = v.kind === 'bus' ? 14 : 11;
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
      g.fillStyle = v.paint;
      g.beginPath();
      g.roundRect(-length / 2, -width / 2, length, width, v.kind === 'bus' ? 0.5 : 0.6);
      g.fill();
      if (v.kind === 'bus') {
        // The window band, seen from above as a dark roof strip.
        g.fillStyle = 'rgb(26 26 46 / 0.85)';
        g.fillRect(-length / 2 + 1, -width / 2 + 0.45, length - 2, width - 0.9);
      } else if (v.kind === 'taxi') {
        // The roof sign, green when free.
        g.fillStyle = '#00ff88';
        g.fillRect(-0.5, -0.45, 1, 0.9);
      } else if (v.kind === 'emergency') {
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
      g.restore();
    }

    ctx.onFrame((dt) => {
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

      canvas.clear();
      for (const v of traffic) draw(v, roads);
      for (const v of buses) draw(v, busRoads);
      if (siren) draw(siren, roads);
      canvas.commit();
      ctx.publish({ cars: traffic.length, buses: buses.length, emergency: siren !== null });
    });

    return {
      update(changed) {
        if (changed.includes('opacity')) canvas.setOpacity(ctx.params.opacity);
        if (changed.includes('density') || changed.includes('buses')) resize();
      },
    };
  },
});
