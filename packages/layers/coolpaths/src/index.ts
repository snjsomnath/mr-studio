import { colormaps, defineLayer, formatHour, loadSiteData, paletteHex, sample, siteProjection, tablePalette, zonedTimeToUtc } from '@mrstudio/sdk';
import type { CanvasOverlay, FieldFrame, LayerManifest, TableContext, ToolInput } from '@mrstudio/sdk';

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
      if (!pair) return;
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

      const radius = Math.max(9, 9 * scale);
      g.font = `700 ${Math.round(radius * 1.2)}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      for (const [node, letter] of [[from, 'A'], [to, 'B']] as const) {
        const [x, y] = paths.project(network.nodes[node]!);
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
    let carried = 0;
    ctx.onFrame((dt) => {
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
        const node = snap(network, geometry.coordinates, distance, SNAP_M);
        if (node < 0) return;
        if (input.tool === 'from') from = node;
        else if (input.tool === 'to') to = node;
        else return;
        clock = 0;
        reroute();
      },
    };
  },

  panel(ctx, el) {
    el.innerHTML = `
      <style>
        .coolpaths-panel { display: grid; gap: 12px; font-variant-numeric: tabular-nums; }
        .coolpaths-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
        .coolpaths-clock { font-size: 2rem; font-weight: 600; }
        .coolpaths-verdict { opacity: 0.8; text-align: right; }
        .coolpaths-route { display: grid; grid-template-columns: auto 1fr auto; gap: 4px 10px; align-items: center; }
        .coolpaths-swatch { width: 22px; height: 6px; border-radius: 3px; }
        .coolpaths-bar { grid-column: 1 / -1; height: 10px; border-radius: 5px; background: #38bdf8; overflow: hidden; }
        .coolpaths-bar i { display: block; height: 100%; background: #fb923c; }
        .coolpaths-note { font-size: 0.8rem; opacity: 0.7; }
        .coolpaths-ramp { height: 8px; border-radius: 4px; background: linear-gradient(to right, ${RAMP.join(', ')}); }
        .coolpaths-ticks { display: flex; justify-content: space-between; font-size: 0.8rem; opacity: 0.7; margin-top: 4px; }
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
        <div><div class="coolpaths-ramp"></div><div class="coolpaths-ticks"><span>path in shade</span><span>in sun</span></div></div>
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
      row.querySelector<HTMLElement>('.coolpaths-note')!.textContent = `${value.sun} m in the sun, ${value.length - value.sun} m in shade`;
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
