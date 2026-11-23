import { colormaps, defineLayer, formatHour, loadSiteData, paletteHex, sample, siteProjection, tableFrame, tablePalette, zonedTimeToUtc } from '@mrstudio/sdk';
import type { CanvasOverlay, FieldFrame, LayerManifest, PointerSample, TableContext, ToolInput } from '@mrstudio/sdk';

import manifest from '../layer.json';
import { buildNetwork, exampleWalk, pointAlongRoute, route, setExposure, snap } from './network.ts';
import type { LonLat, Network, Route, RoutePair } from './network.ts';

interface Params {
  date: string;
  hour: number;
  play: boolean;
  detour: number;
  network: boolean;
  shade: boolean;
}

/** Hours of the day that pass per second while animating. */
const PLAY_HOURS_PER_SECOND = 1.5;
const HOUR_STEP = 0.25;
/** A tool point further than this from any path is ignored. */
const SNAP_M = 120;
/** The walkers cover this many metres of route per second, so a walk takes seconds, not minutes. */
const WALKER_M_PER_S = 45;
const PAUSE_S = 2;
/** While A or B is dragged, the routes are worked out again at most this often, and the pick is sent on at most this often. */
const REROUTE_S = 0.08;
const SEND_MS = 60;
/** A press this close to A or B, in marker radii, picks the marker up instead of placing a new end. */
const GRAB_RADII = 1.8;

type End = 'from' | 'to';

/** The coolest walk is green (vegetation, shade) and the shortest is the focus colour, both from the table's palette (#93). */
const coolColour = (site: TableContext['site']) => paletteHex('@green', tablePalette(site));
const shortColour = (site: TableContext['site']) => paletteHex('@focus', tablePalette(site));
/** Path colours from shade to full sun. */
const RAMP = ['#38bdf8', '#7dd3fc', '#fde68a', '#fbbf24', '#fb923c', '#ef4444'];

function kernelParams(ctx: TableContext<Params>) {
  return { mode: 'instant', time: zonedTimeToUtc(ctx.params.date, ctx.params.hour, ctx.site.timezone), trees: true };
}

function trace(overlay: CanvasOverlay, coordinates: LonLat[]): void {
  const g = overlay.context;
  coordinates.forEach((point, i) => {
    const [x, y] = overlay.project(point);
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  });
}

const round = (value: number) => Math.round(value);

export default defineLayer<Params>({
  manifest: manifest as LayerManifest,

  async table(ctx) {
    const projection = siteProjection(ctx.site);
    const distance = projection.distance;
    const shade = ctx.map.addField('shade', { colormap: colormaps.daylight, opacity: ctx.params.shade ? 0.75 : 0 });
    const paths = ctx.map.addCanvas('paths');
    const walk = ctx.map.addCanvas('walk');

    const network: Network = buildNetwork(await loadSiteData(ctx.site, 'walkways'), distance);
    if (network.edges.length === 0) throw new Error("the 'walkways' dataset has no lines");

    let frame: FieldFrame | null = null;
    let from = -1;
    let to = -1;
    let seed = 0;
    let pair: RoutePair | null = null;
    let sunUp = true;
    let pathsDrawn = -1;
    let pathsDirty = true;
    let clock = 0;
    /** The routes wait for the next frame, so a stream of picks costs one search per frame at most. */
    let routeDirty = false;
    let sinceRoute = Infinity;

    /** 1 where the ground at a point is in direct sun. Points off the grid count as the nearest cell. */
    function lit(point: LonLat): number {
      if (!frame) return 0;
      const [col, row] = projection.toGrid(point);
      const c = Math.min(frame.width - 1, Math.max(0, Math.floor((col * frame.width) / ctx.site.grid.width)));
      const r = Math.min(frame.height - 1, Math.max(0, Math.floor((row * frame.height) / ctx.site.grid.height)));
      return sample(frame, c, r);
    }

    function reroute(): void {
      pair = route(network, from, to, ctx.params.detour / 100);
      pathsDirty = true;
      const summary = (r: Route) => ({ length: round(r.length), sun: round(r.sun) });
      ctx.publish({
        ready: frame !== null,
        sunUp,
        shortest: pair ? summary(pair.shortest) : null,
        coolest: pair ? summary(pair.coolest) : null,
        same: pair ? pair.coolest === pair.shortest : true,
      });
    }

    function pickExample(): void {
      const { width_m, height_m } = ctx.site.extent;
      const span = Math.hypot(width_m, height_m);
      const picked = exampleWalk(network, seed++, span * 0.35, span * 0.8, ctx.params.detour / 100);
      if (picked) [from, to] = picked;
      clock = 0;
      reroute();
    }

    const stream = await ctx.engine.open('sunlight', kernelParams(ctx), ['shadow']);
    stream.on('shadow', (next) => {
      const first = frame === null;
      frame = next;
      shade.set(next);
      setExposure(network, lit, ctx.site.grid.cell_m, distance);
      if (first) pickExample();
      else reroute();
    });
    stream.onStatus((status) => {
      sunUp = status.info.sun.altitude_deg > 0;
    });

    function drawPaths(): void {
      const g = paths.context;
      const scale = paths.pixelsPerMetre;
      paths.clear();
      g.lineCap = 'round';
      g.lineJoin = 'round';
      if (ctx.params.network) {
        // One stroke per colour keeps a large network cheap to draw.
        g.lineWidth = Math.max(1.5, 1.8 * scale);
        g.globalAlpha = 0.75;
        RAMP.forEach((colour, bin) => {
          g.beginPath();
          for (const edge of network.edges) {
            if (Math.min(RAMP.length - 1, Math.floor(edge.exposure * RAMP.length)) === bin) trace(paths, edge.coordinates);
          }
          g.strokeStyle = colour;
          g.stroke();
        });
        g.globalAlpha = 1;
      }
      if (pair) drawRoutes(scale);
      drawEnds();
    }

    function drawRoutes(scale: number): void {
      if (!pair) return;
      const g = paths.context;
      const width = Math.max(4, 5 * scale);
      const stroke = (r: Route, colour: string, lineWidth: number, dash: number[]) => {
        g.beginPath();
        trace(paths, r.coordinates);
        g.setLineDash(dash);
        g.lineWidth = lineWidth;
        g.strokeStyle = colour;
        g.stroke();
        g.setLineDash([]);
      };
      // A dark casing keeps the routes readable over the coloured network.
      stroke(pair.shortest, '#0b0e14', width + 4, []);
      if (pair.coolest !== pair.shortest) {
        stroke(pair.coolest, '#0b0e14', width + 4, []);
        stroke(pair.coolest, coolColour(ctx.site), width, []);
      }
      stroke(pair.shortest, shortColour(ctx.site), width * 0.6, pair.coolest === pair.shortest ? [] : [width * 1.2, width * 1.6]);
    }

    /** The marker radius in CSS pixels, the same for drawing and for picking a marker up. */
    const markerRadius = () => Math.max(9, 9 * paths.pixelsPerMetre);

    /** A and B. The one under the mouse, or being dragged, wears a ring. */
    function drawEnds(): void {
      const g = paths.context;
      const radius = markerRadius();
      g.font = `700 ${Math.round(radius * 1.2)}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      for (const [node, letter, end] of [[from, 'A', 'from'], [to, 'B', 'to']] as const) {
        if (node < 0) continue;
        const [x, y] = paths.project(network.nodes[node]!);
        if (drag?.end === end || hover === end) {
          g.beginPath();
          g.arc(x, y, radius * 1.65, 0, Math.PI * 2);
          g.fillStyle = 'rgba(255, 255, 255, 0.18)';
          g.fill();
          g.lineWidth = Math.max(1.5, radius * 0.14);
          g.strokeStyle = '#ffffff';
          g.stroke();
        }
        g.beginPath();
        g.arc(x, y, radius, 0, Math.PI * 2);
        g.fillStyle = '#0b0e14';
        g.fill();
        g.lineWidth = Math.max(2, radius * 0.22);
        g.strokeStyle = '#ffffff';
        g.stroke();
        g.fillStyle = '#ffffff';
        g.fillText(letter, x, y + 1);
      }
    }

    /** Two walkers leave A together: the gap that opens between them is the cost of the cool route. */
    function drawWalkers(): void {
      const g = walk.context;
      walk.clear();
      if (!pair) return;
      const longest = pair.coolest.length;
      const metres = Math.min(clock, longest / WALKER_M_PER_S) * WALKER_M_PER_S;
      const radius = Math.max(5, 5 * walk.pixelsPerMetre);
      const [cool, short] = [coolColour(ctx.site), shortColour(ctx.site)];
      const routes: [Route, string][] = pair.coolest === pair.shortest ? [[pair.shortest, short]] : [[pair.shortest, short], [pair.coolest, cool]];
      for (const [r, colour] of routes) {
        const [x, y] = walk.project(pointAlongRoute(r.coordinates, metres, distance));
        g.beginPath();
        g.arc(x, y, radius, 0, Math.PI * 2);
        g.fillStyle = colour;
        g.fill();
        g.lineWidth = Math.max(1.5, radius * 0.35);
        g.strokeStyle = '#0b0e14';
        g.stroke();
      }
    }

    let drawnPalette: ReturnType<typeof tablePalette> | null = null;

    // ---- Picking A and B with a mouse, a finger or a pen on the table ----
    // A press sets the next end (A, then B, then A again) or, on A or B, picks that one up.
    // The pick goes through the host, so every view of the table (projector, editor) follows.
    const frame2d = tableFrame(ctx.site);
    let nextEnd: End = 'from';
    let drag: { pointer: string; end: End } | null = null;
    let hover: End | null = null;
    let lastSent = -Infinity;
    let trailing: ReturnType<typeof setTimeout> | undefined;
    let unsent: { end: End; lonLat: [number, number] } | null = null;

    function flush(): void {
      clearTimeout(trailing);
      trailing = undefined;
      if (!unsent) return;
      const { end, lonLat } = unsent;
      unsent = null;
      lastSent = performance.now();
      const coordinates = lonLat.map((value) => Math.round(value * 1e7) / 1e7);
      ctx.sendTool(end, { type: 'Point', coordinates: coordinates as [number, number] }).catch((error) => console.warn('[coolpaths] pick not sent', error));
    }

    function send(end: End, lonLat: [number, number]): void {
      unsent = { end, lonLat };
      const wait = lastSent + SEND_MS - performance.now();
      if (wait <= 0) flush();
      else trailing ??= setTimeout(flush, wait);
    }
    ctx.onCleanup(() => clearTimeout(trailing));

    /** Moves an end to the path nearest `lonLat`. Returns false when no path is near enough. */
    function place(end: End, lonLat: readonly number[]): boolean {
      const node = snap(network, lonLat, distance, SNAP_M);
      if (node < 0) return false;
      if ((end === 'from' ? from : to) !== node) {
        if (end === 'from') from = node;
        else to = node;
        clock = 0;
        routeDirty = true;
        pathsDirty = true;
      }
      return true;
    }

    /** The end whose marker is under a point in table metres, if any. */
    function endAt(point: [number, number]): End | null {
      const reach = (markerRadius() * GRAB_RADII) / paths.pixelsPerMetre;
      let best: End | null = null;
      let bestDistance = reach;
      for (const [node, end] of [[from, 'from'], [to, 'to']] as const) {
        if (node < 0) continue;
        const [x, y] = frame2d.toTable(network.nodes[node] as [number, number]);
        const d = Math.hypot(x - point[0], y - point[1]);
        if (d <= bestDistance) {
          best = end;
          bestDistance = d;
        }
      }
      return best;
    }

    ctx.pointer.on((sample: PointerSample) => {
      if (drag && drag.pointer === sample.id) {
        if (sample.phase === 'move' && sample.pressed) {
          if (place(drag.end, sample.lonLat)) send(drag.end, sample.lonLat);
          return;
        }
        if (sample.phase === 'up' || sample.phase === 'leave' || !sample.pressed) {
          flush();
          drag = null;
          pathsDirty = true;
        }
        return;
      }
      if (sample.phase === 'down') {
        const grabbed = endAt(sample.point);
        const end = grabbed ?? nextEnd;
        if (!grabbed && !place(end, sample.lonLat)) return;
        if (!grabbed) {
          nextEnd = end === 'from' ? 'to' : 'from';
          send(end, sample.lonLat);
        }
        drag = { pointer: sample.id, end };
        hover = end;
        pathsDirty = true;
        return;
      }
      // A mouse hovering over A or B shows that it can be picked up.
      if (sample.source === 'mouse' && (sample.phase === 'move' || sample.phase === 'leave')) {
        const over = sample.phase === 'move' ? endAt(sample.point) : null;
        if (over !== hover) {
          hover = over;
          pathsDirty = true;
        }
      }
    });

    let carried = 0;
    ctx.onFrame((dt) => {
      sinceRoute += dt;
      if (routeDirty && sinceRoute >= REROUTE_S) {
        routeDirty = false;
        sinceRoute = 0;
        reroute();
      }
      if (ctx.params.play) {
        carried += dt * PLAY_HOURS_PER_SECOND;
        const steps = Math.floor(carried / HOUR_STEP);
        if (steps > 0) {
          carried -= steps * HOUR_STEP;
          ctx.setParams({ hour: (ctx.params.hour + steps * HOUR_STEP) % 24 });
        }
      }
      // The table's palette changed: draw the routes again in its colours.
      const palette = tablePalette(ctx.site);
      if (palette !== drawnPalette) {
        drawnPalette = palette;
        pathsDirty = true;
      }
      if (pathsDirty || pathsDrawn !== paths.revision) {
        drawPaths();
        pathsDirty = false;
        pathsDrawn = paths.revision;
      }
      if (pair) {
        clock += dt;
        if (clock > pair.coolest.length / WALKER_M_PER_S + PAUSE_S) clock = 0;
      }
      drawWalkers();
    });

    return {
      update(changed) {
        if (changed.includes('shade')) shade.setStyle({ opacity: ctx.params.shade ? 0.75 : 0 });
        if (changed.includes('network')) pathsDirty = true;
        if (changed.includes('detour')) reroute();
        if (changed.includes('date') || changed.includes('hour')) stream.set(kernelParams(ctx));
      },
      action(id) {
        if (id === 'example' && frame) pickExample();
      },
      tool(input: ToolInput) {
        const geometry = input.geometry as { type?: string; coordinates?: number[] } | null;
        if (geometry?.type !== 'Point' || !Array.isArray(geometry.coordinates)) return;
        if (input.tool !== 'from' && input.tool !== 'to') return;
        // The end being dragged here follows the pointer; the host's echo of it is older than that.
        if (drag?.end === input.tool) return;
        place(input.tool, geometry.coordinates);
      },
    };
  },

  panel(ctx, el) {
    el.innerHTML = `
      <style>
        .coolpaths-panel { display: grid; grid-template-columns: 1fr 1fr; gap: 0.4em 1.2em; font-size: 0.9em; line-height: 1.2; font-variant-numeric: tabular-nums; }
        .coolpaths-head { grid-column: 1 / -1; display: flex; justify-content: space-between; align-items: baseline; gap: 0.6em; min-width: 0; }
        .coolpaths-clock { font-size: 1.3em; font-weight: 600; line-height: 1.1; }
        .coolpaths-verdict { opacity: 0.8; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .coolpaths-route { display: grid; grid-template-columns: auto 1fr auto; gap: 0.2em 0.5em; align-items: center; min-width: 0; }
        .coolpaths-route[hidden] { display: none; }
        .coolpaths-swatch { width: 1.2em; height: 0.35em; border-radius: 0.2em; }
        .coolpaths-bar { grid-column: 1 / -1; height: 0.5em; border-radius: 0.25em; background: #38bdf8; overflow: hidden; }
        .coolpaths-bar i { display: block; height: 100%; background: #fb923c; }
        .coolpaths-note { font-size: 0.8em; opacity: 0.7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .coolpaths-key { grid-column: 1 / -1; }
        .coolpaths-ramp { height: 0.4em; border-radius: 0.2em; background: linear-gradient(to right, ${RAMP.join(', ')}); }
        .coolpaths-ticks { display: flex; justify-content: space-between; font-size: 0.8em; opacity: 0.7; margin-top: 0.2em; }
      </style>
      <div class="coolpaths-panel">
        <div class="coolpaths-head"><span class="coolpaths-clock"></span><span class="coolpaths-verdict"></span></div>
        <div class="coolpaths-route" data-route="shortest">
          <span class="coolpaths-swatch" style="background:${shortColour(ctx.site)}"></span><span>Shortest walk</span><span class="coolpaths-length"></span>
          <div class="coolpaths-bar"><i></i></div><span class="coolpaths-note" style="grid-column:1/-1"></span>
        </div>
        <div class="coolpaths-route" data-route="coolest">
          <span class="coolpaths-swatch" style="background:${coolColour(ctx.site)}"></span><span>Coolest walk</span><span class="coolpaths-length"></span>
          <div class="coolpaths-bar"><i></i></div><span class="coolpaths-note" style="grid-column:1/-1"></span>
        </div>
        <div class="coolpaths-key"><div class="coolpaths-ramp"></div><div class="coolpaths-ticks"><span>path in shade</span><span>in sun</span></div></div>
      </div>`;
    const clock = el.querySelector<HTMLElement>('.coolpaths-clock')!;
    const verdict = el.querySelector<HTMLElement>('.coolpaths-verdict')!;

    function show(name: 'shortest' | 'coolest', longest: number): void {
      const row = el.querySelector<HTMLElement>(`[data-route="${name}"]`)!;
      const value = ctx.shared[name] as { length: number; sun: number } | null | undefined;
      row.hidden = !value;
      if (!value) return;
      row.querySelector<HTMLElement>('.coolpaths-length')!.textContent = `${value.length} m`;
      // The bar's width is the walk's length and its orange part the metres in sun.
      const bar = row.querySelector<HTMLElement>('.coolpaths-bar')!;
      bar.style.width = `${(value.length / longest) * 100}%`;
      bar.querySelector<HTMLElement>('i')!.style.width = `${value.length > 0 ? (value.sun / value.length) * 100 : 0}%`;
      row.querySelector<HTMLElement>('.coolpaths-note')!.textContent = `${value.sun} m sun, ${value.length - value.sun} m shade`;
    }

    function update() {
      const { ready, sunUp, same } = ctx.shared;
      const shortest = ctx.shared.shortest as { length: number; sun: number } | null | undefined;
      const coolest = ctx.shared.coolest as { length: number; sun: number } | null | undefined;
      clock.textContent = formatHour(ctx.params.hour);
      const longest = Math.max(shortest?.length ?? 1, coolest?.length ?? 1);
      show('shortest', longest);
      show('coolest', longest);
      if (!ready) verdict.textContent = 'working out the shade…';
      else if (!shortest || !coolest) verdict.textContent = 'these two points are not connected';
      else if (sunUp === false) verdict.textContent = 'the sun is down: every path is in shade';
      else if (same || shortest.sun === 0) verdict.textContent = 'the shortest walk is already the coolest';
      else {
        const further = Math.round((coolest.length / shortest.length - 1) * 100);
        const less = Math.round((1 - coolest.sun / shortest.sun) * 100);
        verdict.textContent = `${further > 0 ? `${further}% further` : 'no further'}, ${less}% less sun`;
      }
    }
    update();
    return { update };
  },
});
