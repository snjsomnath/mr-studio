import { along, defineLayer, geojsonLines, geojsonPoints, readSiteData, nearestAlong, streetLines, tableSpace, traceLine, track, withAlpha } from '@mrstudio/sdk';
import { SPRITE_FLOATS } from '@mrstudio/sdk';
import type { LayerManifest, Stroke, XY, Track } from '@mrstudio/sdk';

import manifest from '../layer.json';

interface Params {
  source: 'simulated' | 'live';
  /** A transit provider from the Sources manager, such as Västtrafik. The host adds its key. */
  provider: string;
  /** Or any address that answers in the feed shape (README). */
  feed: string;
  vehicles: number;
  speed: number;
  routes: boolean;
  stops: boolean;
  labels: boolean;
  trails: boolean;
  size: number;
  opacity: number;
}

type Mode = 'tram' | 'bus' | 'train' | 'ferry';

interface Route {
  line: string;
  mode: Mode;
  colour: string;
  textColour: string;
  track: Track;
  /** Distances along the track where vehicles stop. */
  stops: number[];
}

interface Vehicle {
  x: number;
  y: number;
  angle: number;
  mode: Mode;
  line: string;
  colour: string;
  textColour: string;
  trail: XY[];
  /** Ferries leave a spreading wake instead of a trail. */
  wake: WakePoint[];
}

interface WakePoint {
  x: number;
  y: number;
  /** Seconds on the layer's clock. */
  t: number;
}

interface Simulated extends Vehicle {
  route: Route;
  at: number;
  direction: 1 | -1;
  /** Seconds left at a stop. */
  dwell: number;
  nextStop: number;
}

interface Live extends Vehicle {
  /** Latest reported position. The drawn position glides towards it. */
  targetX: number;
  targetY: number;
  seen: number;
}

/** Colours per mode when the data gives none: Västtrafik blue for buses, gold trams, red trains, teal ferries. */
const MODES: Record<Mode, { colour: string }> = {
  tram: { colour: '#ffd700' },
  bus: { colour: '#00a5e0' },
  train: { colour: '#e31837' },
  ferry: { colour: '#00b4a0' },
};
const STOP_REACH_M = 15;
const DWELL_S = 4;

// The look of the Västtrafik layer on the interactive_map Chalmers table, which drew in projector pixels.
// One of those pixels covered about 0.65 m of the table, so sizes here are those pixels in metres.
// At the default Vehicle size (2) a vehicle is exactly as large as it was there.
const PX = 0.65;
const MARKER_PX = 16;
const GLOW_PX = 28;
const SHADOW_PX = 15;
const TRAIL_PX = 5;
const TRAIL_POINTS = 100;
/** Trail opacity right behind the vehicle; it falls to nothing at the tail. */
const TRAIL_ALPHA = 0.8;
/** The trail is stroked in this many bands of width and opacity, not segment by segment. */
const TRAIL_BANDS = 12;
/** A ferry's wake lasts this long, sampled this often, and spreads to this half-width in metres. */
const WAKE_S = 20;
const WAKE_SAMPLE_S = 0.1;
const WAKE_SPREAD_M = 11;
const POLL_S = 3;
/** A live vehicle that has not been reported for this long is gone. */
const FORGET_S = 30;

const HEX = /^#[0-9a-f]{6}$/i;
const mode = (value: unknown): Mode => (typeof value === 'string' && value.toLowerCase() in MODES ? (value.toLowerCase() as Mode) : 'bus');
const colourOf = (value: unknown, fallback: string) => (typeof value === 'string' && HEX.test(value) ? value : fallback);

/** Dark text on light vehicles, light on dark. */
function inkFor(colour: string): string {
  const n = parseInt(colour.slice(1), 16);
  const luminance = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return luminance > 150 ? '#101418' : '#ffffff';
}

export default defineLayer<Params>({
  manifest: manifest as LayerManifest,

  async table(ctx) {
    // Lines and stops change only with the controls, so they are a drawing; trails, wakes and
    // vehicles move every frame, so the graphics card draws them (#609).
    const canvas = ctx.map.addDrawing('transit', { opacity: ctx.params.opacity });
    const strokes = ctx.map.addStrokes('transit-trails', { opacity: ctx.params.opacity });
    const markers = ctx.map.addSprites('transit-vehicles', [], { opacity: ctx.params.opacity });
    /** Pixels per metre the vehicle pictures are painted at: a 2048-pixel table, as the drawing was. */
    const SCALE = 2048 / ctx.site.extent.width_m;
    const space = tableSpace(ctx.site);
    const data = await readSiteData(ctx.site, 'transit');

    let routes: Route[] = geojsonLines(data, space).map(({ geometry, properties }) => {
      const m = mode(properties.mode);
      const colour = colourOf(properties.colour ?? properties.color, MODES[m].colour);
      return { line: String(properties.line ?? ''), mode: m, colour, textColour: colourOf(properties.textColour, inkFor(colour)), track: track(geometry), stops: [] };
    });
    let stopPoints = geojsonPoints(data, space).map((stop) => stop.geometry);
    const generated = routes.length === 0;
    if (generated) {
      // No network in the site: run a few lines along its longest real streets, if it has any.
      const lines = await streetLines(ctx.site);
      const longest = lines.map((line) => track(line.geometry)).sort((a, b) => b.length - a.length);
      routes = longest.slice(0, 3).map((t, i) => {
        const m: Mode = i === 0 ? 'tram' : 'bus';
        return { line: String(i + 1), mode: m, colour: MODES[m].colour, textColour: inkFor(MODES[m].colour), track: t, stops: [] };
      });
      stopPoints = routes.flatMap((route) => Array.from({ length: Math.floor(route.track.length / 180) }, (_, i) => along(route.track, 90 + i * 180)).map((p): XY => [p.x, p.y]));
    }
    for (const route of routes) {
      route.stops = stopPoints
        .map(([x, y]) => ({ at: nearestAlong(route.track, x, y), x, y }))
        .filter((stop) => {
          const p = along(route.track, stop.at);
          return Math.hypot(p.x - stop.x, p.y - stop.y) <= STOP_REACH_M;
        })
        .map((stop) => stop.at)
        .sort((a, b) => a - b);
    }

    // ---- Simulated vehicles: evenly spaced, running end to end and back.
    let simulated: Simulated[] = [];
    function seed() {
      simulated = routes.flatMap((route) =>
        Array.from({ length: ctx.params.vehicles }, (_, i): Simulated => {
          const lap = ((i + 0.37) / ctx.params.vehicles) * 2;
          const direction = lap < 1 ? 1 : -1;
          const at = (lap < 1 ? lap : 2 - lap) * route.track.length;
          const p = along(route.track, at);
          return { ...p, route, at, direction, dwell: 0, nextStop: -1, mode: route.mode, line: route.line, colour: route.colour, textColour: route.textColour, trail: [], wake: [] };
        }),
      );
    }
    seed();

    function stepSimulated(dt: number) {
      const speed = ctx.params.speed / 3.6;
      for (const v of simulated) {
        if (v.dwell > 0) {
          v.dwell -= dt;
          continue;
        }
        const before = v.at;
        v.at += speed * dt * v.direction;
        // Stop where the step crossed a stop.
        const crossed = v.route.stops.find((stop) => (before < stop && v.at >= stop) || (before > stop && v.at <= stop));
        if (crossed !== undefined) {
          v.at = crossed;
          v.dwell = DWELL_S;
        }
        if (v.at >= v.route.track.length || v.at <= 0) {
          v.at = Math.min(v.route.track.length, Math.max(0, v.at));
          v.direction = v.direction === 1 ? -1 : 1;
          v.dwell = DWELL_S;
        }
        const p = along(v.route.track, v.at);
        v.x = p.x;
        v.y = p.y;
        v.angle = v.direction === 1 ? p.angle : p.angle + Math.PI;
      }
    }

    // ---- Live vehicles: positions from a feed, eased between reports.
    const live = new Map<string, Live>();
    let clock = 0;
    let nextPoll = 0;
    let polling = false;
    let feedState = '';
    let stopped = false;
    ctx.onCleanup(() => (stopped = true));

    /** Where vehicles come from: a provider in Sources, asked through the host, or a feed address. */
    function feedAddress(): string {
      const provider = ctx.params.provider?.trim();
      if (provider) {
        const lons = ctx.site.corners.map((c) => c[0]);
        const lats = ctx.site.corners.map((c) => c[1]);
        const bbox = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)].map((v) => v.toFixed(5)).join(',');
        return `/api/transit/${encodeURIComponent(provider)}/vehicles?bbox=${bbox}`;
      }
      return ctx.params.feed.trim();
    }

    async function poll() {
      const feed = feedAddress();
      if (!feed) {
        feedState = ctx.say('Choose where live data comes from, or enter a feed address');
        return;
      }
      polling = true;
      try {
        const response = await fetch(feed, { cache: 'no-store' });
        if (!response.ok) {
          // The host says why in words (no key yet, the key was refused, the provider is busy).
          const said = await response.json().then((b) => b?.error as string | undefined, () => undefined);
          throw new Error(said ?? `HTTP ${response.status}`);
        }
        const body = await response.json();
        if (stopped || feedAddress() !== feed) return;
        for (const item of Array.isArray(body?.vehicles) ? body.vehicles : []) {
          if (typeof item?.lon !== 'number' || typeof item?.lat !== 'number' || item.id === undefined) continue;
          const [x, y] = space.toTable(item.lon, item.lat);
          const m = mode(item.mode);
          const colour = colourOf(item.colour ?? item.color, MODES[m].colour);
          const textColour = colourOf(item.textColour, inkFor(colour));
          const known = live.get(String(item.id));
          // A ferry that jumps further than it could have sailed starts afresh, rather than gliding across land.
          const jumped = known && m === 'ferry' && Math.hypot(x - known.targetX, y - known.targetY) > Math.max(300, (clock - known.seen) * 22);
          if (known && !jumped) {
            Object.assign(known, { targetX: x, targetY: y, seen: clock, mode: m, line: String(item.line ?? ''), colour, textColour });
          } else {
            live.set(String(item.id), { x, y, targetX: x, targetY: y, angle: 0, seen: clock, mode: m, line: String(item.line ?? ''), colour, textColour, trail: [], wake: [] });
          }
        }
        feedState = '';
      } catch (error) {
        feedState = ctx.say('Live data unavailable: {reason}', { reason: (error as Error).message });
      } finally {
        polling = false;
      }
    }

    function stepLive(dt: number) {
      if (clock >= nextPoll && !polling) {
        nextPoll = clock + POLL_S;
        void poll();
      }
      // The same glide the Gothenburg transit layer used: 8% of the way per frame, most of the way within a second.
      // Ferries drift more slowly, as boats do.
      const ease = 1 - Math.pow(0.92, dt * 60);
      const drift = 1 - Math.exp(-dt / 2);
      for (const [id, v] of live) {
        if (clock - v.seen > FORGET_S) {
          live.delete(id);
          continue;
        }
        const dx = v.targetX - v.x;
        const dy = v.targetY - v.y;
        if (Math.hypot(dx, dy) > 0.5) v.angle = Math.atan2(dy, dx);
        const k = v.mode === 'ferry' ? drift : ease;
        v.x += dx * k;
        v.y += dy * k;
      }
    }

    /** Circle, glow and line number, painted once per look at the canvas's own resolution and reused. */
    const sprites = new Map<string, { image: HTMLCanvasElement; half: number; index: number }>();
    let looks: HTMLCanvasElement[] = [];
    let looksChanged = false;
    function sprite(v: Vehicle, k: number, label: boolean) {
      const text = label ? v.line : '';
      const key = [v.colour, v.textColour, text, k].join('|');
      let found = sprites.get(key);
      if (found) return found;
      if (sprites.size >= 128) {
        sprites.clear();
        looks = [];
      }
      const px = PX * k * SCALE; // picture pixels per old projector pixel
      const radius = MARKER_PX * px;
      const glow = GLOW_PX * px;
      const half = Math.ceil(Math.max(glow, radius + SHADOW_PX * px)) + 2;
      const image = document.createElement('canvas');
      image.width = image.height = half * 2;
      const g = image.getContext('2d')!;
      // A soft glow, added to what is beneath.
      g.globalCompositeOperation = 'lighter';
      const halo = g.createRadialGradient(half, half, 0, half, half, glow);
      halo.addColorStop(0, withAlpha(v.colour, 0x88 / 255));
      halo.addColorStop(0.5, withAlpha(v.colour, 0x44 / 255));
      halo.addColorStop(1, withAlpha(v.colour, 0));
      g.fillStyle = halo;
      g.beginPath();
      g.arc(half, half, glow, 0, Math.PI * 2);
      g.fill();
      // The body: a disc in the line's colour with a shadow of the same colour.
      g.globalCompositeOperation = 'source-over';
      g.fillStyle = v.colour;
      g.shadowColor = v.colour;
      g.shadowBlur = SHADOW_PX * px;
      g.beginPath();
      g.arc(half, half, radius, 0, Math.PI * 2);
      g.fill();
      g.shadowBlur = 0;
      if (text) {
        g.font = `bold ${Math.round(radius * 0.85)}px Inter, system-ui, sans-serif`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillStyle = v.textColour;
        g.fillText(text, half, half + px);
      }
      found = { image, half: half / SCALE, index: looks.length };
      looks.push(image);
      looksChanged = true;
      sprites.set(key, found);
      return found;
    }

    function record(v: Vehicle) {
      if (v.mode === 'ferry') {
        // Fixed-time samples, so the wake does not depend on how often the feed reports.
        const last = v.wake[v.wake.length - 1];
        if (!last || Math.hypot(last.x - v.x, last.y - v.y) > 300) v.wake = [];
        if (!last || clock - last.t >= WAKE_SAMPLE_S) {
          if (!last || Math.hypot(last.x - v.x, last.y - v.y) > 0.15) v.wake.push({ x: v.x, y: v.y, t: clock });
        }
        while (v.wake.length > 0 && clock - v.wake[0]!.t > WAKE_S) v.wake.shift();
        return;
      }
      const last = v.trail[v.trail.length - 1];
      if (!last || Math.hypot(last[0] - v.x, last[1] - v.y) > 0.05) {
        v.trail.push([v.x, v.y]);
        if (v.trail.length > TRAIL_POINTS) v.trail.shift();
      }
    }

    /** A trail that tapers and fades towards its tail, then a solid stroke into the vehicle. */
    function drawTrail(g: CanvasRenderingContext2D, v: Vehicle, k: number) {
      const n = v.trail.length;
      if (n < 2) return;
      const full = TRAIL_PX * PX * k;
      for (let band = 0; band < TRAIL_BANDS; band++) {
        const from = Math.max(1, Math.floor((band * n) / TRAIL_BANDS));
        const to = Math.floor(((band + 1) * n) / TRAIL_BANDS);
        if (to <= from - 1 || from >= n) continue;
        const progress = (from + to) / 2 / n;
        g.strokeStyle = withAlpha(v.colour, TRAIL_ALPHA * progress);
        g.lineWidth = full * (0.3 + 0.7 * progress);
        g.beginPath();
        g.moveTo(...v.trail[from - 1]!);
        for (let i = from; i <= Math.min(to, n - 1); i++) g.lineTo(...v.trail[i]!);
        g.stroke();
      }
      const tail = v.trail[n - 1]!;
      g.strokeStyle = withAlpha(v.colour, 0xcc / 255);
      g.lineWidth = full;
      g.beginPath();
      g.moveTo(...tail);
      g.lineTo(v.x, v.y);
      g.stroke();
    }

    /** A ferry's wake: two spreading arms, a faint ribbon between them and a cross-ripple now and then. */
    function drawWake(g: CanvasRenderingContext2D, v: Vehicle) {
      const samples = v.wake;
      const points = samples.map((p, i) => {
        const a = samples[Math.max(0, i - 1)]!;
        const b = samples[Math.min(samples.length - 1, i + 1)]!;
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        if (length < 0.01) return null;
        const age = Math.max(0, clock - p.t);
        const spread = Math.min(WAKE_SPREAD_M, 0.5 + age * 0.65);
        const nx = -(b.y - a.y) / length;
        const ny = (b.x - a.x) / length;
        return {
          t: p.t,
          alpha: (1 - age / WAKE_S) ** 2,
          center: [p.x, p.y] as XY,
          left: [p.x + nx * spread, p.y + ny * spread] as XY,
          right: [p.x - nx * spread, p.y - ny * spread] as XY,
        };
      }).filter((p) => p !== null);
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1]!;
        const b = points[i]!;
        const alpha = Math.min(a.alpha, b.alpha);
        g.fillStyle = `rgba(168,220,234,${alpha * 0.055})`;
        g.beginPath();
        g.moveTo(...a.left);
        g.lineTo(...b.left);
        g.lineTo(...b.right);
        g.lineTo(...a.right);
        g.closePath();
        g.fill();
        for (const side of ['left', 'right', 'center'] as const) {
          g.strokeStyle = `rgba(213,242,250,${alpha * (side === 'center' ? 0.1 : 0.36)})`;
          g.lineWidth = (side === 'center' ? 0.8 : 1.15) * PX;
          g.beginPath();
          g.moveTo(...a[side]);
          g.lineTo(...b[side]);
          g.stroke();
        }
        if (Math.floor(a.t / 1.4) !== Math.floor(b.t / 1.4)) {
          g.strokeStyle = `rgba(224,245,250,${alpha * 0.18})`;
          g.lineWidth = 0.7 * PX;
          g.beginPath();
          g.moveTo(...b.left);
          g.quadraticCurveTo(b.center[0], b.center[1], b.right[0], b.right[1]);
          g.stroke();
        }
      }
    }

    /** A trail as one tapering line: thin and faint at its tail, full into the vehicle. */
    function trailStroke(v: Vehicle, k: number): Stroke | null {
      const n = v.trail.length;
      if (n < 2) return null;
      const full = TRAIL_PX * PX * k;
      const points: XY[] = [...v.trail, [v.x, v.y]];
      const width = points.map((_, i) => (i >= n ? full : full * (0.3 + 0.7 * (i / n))));
      const alpha = points.map((_, i) => (i >= n ? 0xcc / 255 : TRAIL_ALPHA * (i / n)));
      return { points, colour: v.colour, width, alpha };
    }

    /** A ferry's wake as lines: the ribbon, the two arms, the centre and the cross-ripples. */
    function wakeStrokes(v: Vehicle, into: Stroke[]) {
      const samples = v.wake;
      const points = samples.map((p, i) => {
        const a = samples[Math.max(0, i - 1)]!;
        const b = samples[Math.min(samples.length - 1, i + 1)]!;
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        if (length < 0.01) return null;
        const age = Math.max(0, clock - p.t);
        const spread = Math.min(WAKE_SPREAD_M, 0.5 + age * 0.65);
        const nx = -(b.y - a.y) / length;
        const ny = (b.x - a.x) / length;
        return {
          t: p.t,
          spread,
          alpha: (1 - age / WAKE_S) ** 2,
          center: [p.x, p.y] as XY,
          left: [p.x + nx * spread, p.y + ny * spread] as XY,
          right: [p.x - nx * spread, p.y - ny * spread] as XY,
        };
      }).filter((p) => p !== null);
      if (points.length < 2) return;
      const alpha = points.map((p) => p.alpha);
      into.push({ points: points.map((p) => p.center), colour: 'rgb(168,220,234)', width: points.map((p) => p.spread * 2), alpha: alpha.map((a) => a * 0.055) });
      for (const side of ['left', 'right', 'center'] as const) {
        const centre = side === 'center';
        into.push({ points: points.map((p) => p[side]), colour: 'rgb(213,242,250)', width: (centre ? 0.8 : 1.15) * PX, alpha: alpha.map((a) => a * (centre ? 0.1 : 0.36)) });
      }
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1]!;
        const b = points[i]!;
        if (Math.floor(a.t / 1.4) !== Math.floor(b.t / 1.4)) {
          into.push({ points: [b.left, b.right], colour: 'rgb(224,245,250)', width: 0.7 * PX, alpha: Math.min(a.alpha, b.alpha) * 0.18 });
        }
      }
    }

    /** Lines and stops: redrawn only when the controls or the network change. */
    let networkKey = '';
    function drawNetwork() {
      const key = [ctx.params.routes, ctx.params.stops, ctx.params.source].join('|');
      if (key === networkKey) return;
      networkKey = key;
      canvas.clear();
      paintNetwork(canvas.ctx);
      canvas.commit();
    }

    /** The vehicles last drawn, for a magnifier's sharp picture. */
    let shown: Vehicle[] = [];
    let buffer = new Float32Array(64 * SPRITE_FLOATS);

    function draw(vehicles: Vehicle[]) {
      for (const v of vehicles) record(v);
      shown = vehicles;
      drawNetwork();
      const { size, labels, trails } = ctx.params;
      const k = size / 2;
      const lines: Stroke[] = [];
      if (trails) {
        for (const v of vehicles) {
          if (v.mode === 'ferry') wakeStrokes(v, lines);
          else {
            const line = trailStroke(v, k);
            if (line) lines.push(line);
          }
        }
      }
      strokes.set(lines);
      if (buffer.length < vehicles.length * SPRITE_FLOATS) buffer = new Float32Array(vehicles.length * SPRITE_FLOATS * 2);
      let n = 0;
      for (const v of vehicles) {
        const { half, index } = sprite(v, k, labels);
        buffer.set([v.x, v.y, half * 2, half * 2, 0, index, 1], n * SPRITE_FLOATS);
        n++;
      }
      if (looksChanged) {
        looksChanged = false;
        markers.setImages(looks);
      }
      markers.set(buffer, n);
    }

    /** Draws the lines, stops, trails and vehicles into `g`, in table metres: the table, and a magnifier's sharp picture (#413). */
    function paintNetwork(g: CanvasRenderingContext2D) {
      g.lineCap = 'round';
      g.lineJoin = 'round';
      // Made-up lines are only for simulated vehicles. Under live vehicles they would be streets no real line runs on.
      const network = ctx.params.source === 'live' && generated ? [] : routes;
      if (ctx.params.routes) {
        for (const route of network) {
          g.strokeStyle = withAlpha(route.colour, 0.3);
          g.lineWidth = 2.5;
          g.beginPath();
          traceLine(g, route.track.points);
          g.stroke();
        }
      }
      if (ctx.params.stops) {
        g.lineWidth = 1.2;
        for (const route of network) {
          g.strokeStyle = withAlpha(route.colour, 0.9);
          g.fillStyle = '#0b0e14';
          for (const stop of route.stops) {
            const p = along(route.track, stop);
            g.beginPath();
            g.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
            g.fill();
            g.stroke();
          }
        }
      }
    }

    function paint(g: CanvasRenderingContext2D, vehicles: Vehicle[]) {
      const { size, labels, trails } = ctx.params;
      const k = size / 2;
      paintNetwork(g);
      g.lineCap = 'round';
      g.lineJoin = 'round';
      // Every trail and wake first, then every vehicle, so no trail crosses a vehicle.
      for (const v of vehicles) {
        if (!trails) continue;
        if (v.mode === 'ferry') drawWake(g, v);
        else drawTrail(g, v, k);
      }
      for (const v of vehicles) {
        const { image, half } = sprite(v, k, labels);
        g.drawImage(image, v.x - half, v.y - half, half * 2, half * 2);
      }
    }
    ctx.map.addDetail((g) => {
      g.globalAlpha = ctx.params.opacity;
      paint(g, shown);
    });

    ctx.onFrame((dt) => {
      clock += dt;
      const isLive = ctx.params.source === 'live';
      if (isLive) stepLive(dt);
      else stepSimulated(dt);
      const vehicles = isLive ? [...live.values()] : simulated;
      draw(vehicles);
      ctx.publish({
        vehicles: vehicles.length,
        status: isLive
          ? feedState
          : generated
            ? routes.length > 0
              ? ctx.say('This site has no transit data, so the lines are made up along its streets')
              : ctx.say('This site has no transit data or streets, so there is nothing to show')
            : '',
        lines: (isLive && generated ? [] : routes).map((route) => ({ line: route.line, mode: route.mode, colour: route.colour })),
      });
    });

    return {
      update(changed) {
        if (changed.includes('opacity')) {
          canvas.setOpacity(ctx.params.opacity);
          strokes.setOpacity(ctx.params.opacity);
          markers.setOpacity(ctx.params.opacity);
        }
        if (changed.includes('routes') || changed.includes('stops') || changed.includes('source')) networkKey = '';
        if (changed.includes('vehicles')) seed();
        if (changed.includes('feed') || changed.includes('provider') || changed.includes('source')) {
          live.clear();
          nextPoll = 0;
        }
      },
    };
  },
});
