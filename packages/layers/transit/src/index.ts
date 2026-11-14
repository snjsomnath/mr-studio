import { along, defineLayer, geojsonLines, geojsonPoints, readSiteData, nearestAlong, streetLines, tableSpace, traceLine, track, withAlpha } from '@mrstudio/sdk';
import type { LayerManifest, XY, Track } from '@mrstudio/sdk';

import manifest from '../layer.json';

interface Params {
  source: 'simulated' | 'live';
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

/** Colours per mode when the data gives none, and the length of a vehicle in metres. */
const MODES: Record<Mode, { colour: string; length: number }> = {
  tram: { colour: '#ffd700', length: 22 },
  bus: { colour: '#00a5e0', length: 11 },
  train: { colour: '#e31837', length: 40 },
  ferry: { colour: '#00b4a0', length: 18 },
};
const STOP_REACH_M = 15;
const DWELL_S = 4;
const TRAIL_POINTS = 60;
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
    const canvas = ctx.map.addDrawing('transit', { opacity: ctx.params.opacity });
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
      // No network in the site: run a few lines along its longest streets.
      const { lines } = await streetLines(ctx.site);
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
          return { ...p, route, at, direction, dwell: 0, nextStop: -1, mode: route.mode, line: route.line, colour: route.colour, textColour: route.textColour, trail: [] };
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
          v.trail = [];
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

    async function poll() {
      const feed = ctx.params.feed.trim();
      if (!feed) {
        feedState = 'Enter a feed address';
        return;
      }
      polling = true;
      try {
        const response = await fetch(feed, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json();
        if (stopped || ctx.params.feed.trim() !== feed) return;
        for (const item of Array.isArray(body?.vehicles) ? body.vehicles : []) {
          if (typeof item?.lon !== 'number' || typeof item?.lat !== 'number' || item.id === undefined) continue;
          const [x, y] = space.toTable(item.lon, item.lat);
          const m = mode(item.mode);
          const colour = colourOf(item.colour ?? item.color, MODES[m].colour);
          const known = live.get(String(item.id));
          if (known) {
            Object.assign(known, { targetX: x, targetY: y, seen: clock, mode: m, line: String(item.line ?? ''), colour });
          } else {
            live.set(String(item.id), {
              x, y, targetX: x, targetY: y, angle: 0, seen: clock, mode: m,
              line: String(item.line ?? ''), colour, textColour: colourOf(item.textColour, inkFor(colour)), trail: [],
            });
          }
        }
        feedState = '';
      } catch (error) {
        feedState = `Feed unavailable (${(error as Error).message})`;
      } finally {
        polling = false;
      }
    }

    function stepLive(dt: number) {
      if (clock >= nextPoll && !polling) {
        nextPoll = clock + POLL_S;
        void poll();
      }
      // The same glide the Gothenburg transit layer used: most of the way there within a second.
      const ease = 1 - Math.pow(0.92, dt * 60);
      for (const [id, v] of live) {
        if (clock - v.seen > FORGET_S) {
          live.delete(id);
          continue;
        }
        const dx = v.targetX - v.x;
        const dy = v.targetY - v.y;
        if (Math.hypot(dx, dy) > 0.5) v.angle = Math.atan2(dy, dx);
        v.x += dx * ease;
        v.y += dy * ease;
      }
    }

    function draw(vehicles: Iterable<Vehicle>) {
      const g = canvas.ctx;
      const { size, labels, trails } = ctx.params;
      canvas.clear();
      g.lineCap = 'round';
      g.lineJoin = 'round';
      if (ctx.params.routes) {
        for (const route of routes) {
          g.strokeStyle = withAlpha(route.colour, 0.3);
          g.lineWidth = 2.5;
          g.beginPath();
          traceLine(g, route.track.points);
          g.stroke();
        }
      }
      if (ctx.params.stops) {
        g.lineWidth = 1.2;
        for (const route of routes) {
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
      for (const v of vehicles) {
        const last = v.trail[v.trail.length - 1];
        if (!last || Math.hypot(last[0] - v.x, last[1] - v.y) > 2) {
          v.trail.push([v.x, v.y]);
          if (v.trail.length > TRAIL_POINTS) v.trail.shift();
        }
        if (trails) {
          // The trail fades towards its tail.
          g.lineWidth = 2.2 * size;
          for (let i = 1; i < v.trail.length; i++) {
            g.strokeStyle = withAlpha(v.colour, 0.5 * (i / v.trail.length) ** 2);
            g.beginPath();
            g.moveTo(...v.trail[i - 1]!);
            g.lineTo(...v.trail[i]!);
            g.stroke();
          }
        }
        const length = MODES[v.mode].length * size * 0.6;
        const width = 3.2 * size;
        g.globalCompositeOperation = 'lighter';
        const glow = g.createRadialGradient(v.x, v.y, 0, v.x, v.y, length);
        glow.addColorStop(0, withAlpha(v.colour, 0.45));
        glow.addColorStop(1, withAlpha(v.colour, 0));
        g.fillStyle = glow;
        g.fillRect(v.x - length, v.y - length, length * 2, length * 2);
        g.globalCompositeOperation = 'source-over';
        g.save();
        g.translate(v.x, v.y);
        g.rotate(v.angle);
        g.fillStyle = v.colour;
        g.beginPath();
        g.roundRect(-length / 2, -width / 2, length, width, width / 2.5);
        g.fill();
        g.restore();
        if (labels && v.line) {
          g.fillStyle = v.textColour;
          g.font = `600 ${width * 0.85}px Inter, system-ui, sans-serif`;
          g.textAlign = 'center';
          g.textBaseline = 'middle';
          g.fillText(v.line, v.x, v.y + width * 0.05);
        }
      }
      canvas.commit();
    }

    ctx.onFrame((dt) => {
      clock += dt;
      const isLive = ctx.params.source === 'live';
      if (isLive) stepLive(dt);
      else stepSimulated(dt);
      const vehicles = isLive ? [...live.values()] : simulated;
      draw(vehicles);
      ctx.publish({
        vehicles: vehicles.length,
        status: isLive ? feedState : generated ? 'This site has no transit data, so the lines are made up' : '',
        lines: routes.map((route) => ({ line: route.line, mode: route.mode, colour: route.colour })),
      });
    });

    return {
      update(changed) {
        if (changed.includes('opacity')) canvas.setOpacity(ctx.params.opacity);
        if (changed.includes('vehicles')) seed();
        if (changed.includes('feed') || changed.includes('source')) {
          live.clear();
          nextPoll = 0;
        }
      },
    };
  },
});
