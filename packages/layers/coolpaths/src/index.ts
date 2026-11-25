import {
  airTemperatureAt,
  clipToTable,
  defineLayer,
  formatHour,
  hasSiteData,
  formatDecimal,
  formatUnit,
  loadSiteField,
  paletteHex,
  petColormap,
  petColour,
  petFeeling,
  quantisePet,
  readSiteMask,
  readWalkNetwork,
  readWalkNetworkPacked,
  sample,
  siteProjection,
  sunPosition,
  sunShadeComfort,
  tableFrame,
  tablePalette,
  zonedTimeToUtc,
} from '@mrstudio/sdk';
import type { CanvasOverlay, FieldFrame, LayerManifest, PointerSample, TableContext, ToolInput } from '@mrstudio/sdk';

import manifest from '../layer.json';
import { coolpathsHero } from './hero.ts';
import { pointAlongRoute, setExposure, setPet, snap } from './network.ts';
import { startRouter } from './route-client.ts';
import type { LonLat, Network, Route, RoutePair } from './network.ts';

interface Params {
  date: string;
  hour: number;
  play: boolean;
  detour: number;
  network: boolean;
  shade: boolean;
  air: number;
  humidity: number;
  wind: number;
}

/** What the controller shows for one walk. */
export interface WalkSummary {
  length: number;
  /** Metres in direct sun. */
  sun: number;
  /** Heat exposure, °C·m. */
  heat: number;
  /** Mean PET, °C. */
  pet: number;
  /** PET along the walk: [metres, °C], thinned for the wire. */
  profile: [number, number][];
}

/** The optional dataset of prepared thermal comfort: a folder of hourly PET (or UTCI) GeoTIFFs, as the Chalmers demo makes. */
const PREPARED = 'pet';

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
/** How much cooler than the shade water feels, °C: it evaporates and stays near the air's temperature (#343). */
const WATER_COOLING_C = 2;
/** Path colours: PET in steps of 2 °C over the demo's range, drawn as one stroke per step. */
const PET_BINS = Array.from({ length: 13 }, (_, i) => 20 + i * 2);

function kernelParams(ctx: TableContext<Params>) {
  return { mode: 'instant', time: zonedTimeToUtc(ctx.params.date, ctx.params.hour, ctx.site.timezone), trees: true };
}

/** Day of the year of an ISO date, 1 to 366. */
function dayOfYear(date: string): number {
  const ms = Date.parse(`${date}T12:00:00Z`);
  if (!Number.isFinite(ms)) return 196;
  const start = Date.UTC(new Date(ms).getUTCFullYear(), 0, 1);
  return Math.floor((ms - start) / 86_400_000) + 1;
}

/** Sun and shade PET for the layer's date, time and weather. */
export function comfortFor(params: Pick<Params, 'date' | 'hour' | 'air' | 'humidity' | 'wind'>, site: Pick<TableContext['site'], 'origin' | 'timezone'>) {
  const utc = Date.parse(zonedTimeToUtc(params.date, params.hour, site.timezone));
  const altitude = sunPosition(utc, site.origin.lat, site.origin.lon).altitude;
  const airC = airTemperatureAt(params.hour, params.air);
  return { airC, altitude, ...sunShadeComfort({ airC, humidity: params.humidity, windMs: params.wind }, altitude, { dayOfYear: dayOfYear(params.date) }) };
}

/** At most `points` points of a profile, keeping its ends. */
function thin(profile: [number, number][], points = 48): [number, number][] {
  if (profile.length <= points) return profile.map(([d, v]) => [Math.round(d), Math.round(v * 10) / 10]);
  const step = (profile.length - 1) / (points - 1);
  return Array.from({ length: points }, (_, i) => profile[Math.round(i * step)]!).map(([d, v]) => [Math.round(d), Math.round(v * 10) / 10]);
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
    // The heat map: PET over the ground, from the prepared study or worked out from the shade.
    const shade = ctx.map.addField('shade', { colormap: petColormap(140), opacity: ctx.params.shade ? 0.75 : 0 });
    const paths = ctx.map.addCanvas('paths');
    const walk = ctx.map.addCanvas('walk');

    // Built in the data worker and kept per file (#484); each start gets its own copy to mark.
    const [read, packedNetwork] = await Promise.all([
      readWalkNetwork(ctx.site, 'walkways', () => ({ exposure: 0, pet: 0 })) as Promise<Network | null>,
      readWalkNetworkPacked(ctx.site, 'walkways'),
    ]);
    if (!read) throw new Error("the 'walkways' dataset could not be read");
    const network = read;
    // The searches across the network run in a worker (#492).
    const router = startRouter(network, packedNetwork);
    ctx.onCleanup(() => router.stop());
    if (network.edges.length === 0) throw new Error("the 'walkways' dataset has no lines");

    let frame: FieldFrame | null = null;
    let from = -1;
    let to = -1;
    let seed = 0;
    let pair: RoutePair | null = null;
    let sunUp = true;
    let comfort = comfortFor(ctx.params, ctx.site);
    /** Prepared PET for the hour on show, when the site has the dataset and a raster for that hour. */
    let prepared: FieldFrame | null = null;
    const preparedByHour = new Map<number, Promise<FieldFrame | null>>();
    let preparedHour = -1;
    let revision = 0;
    let heatCells: Uint8Array | null = null;
    /** Cells under a building, on the site grid: the heat map leaves roofs clear, as the demo does. */
    let roofs: Uint8Array | null = null;
    /** Cells that are water, on the site grid (#343). */
    let water: Uint8Array | null = null;
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

    /** Prepared PET at a point, NaN where the raster has no data. */
    function preparedAt(point: LonLat): number {
      if (!prepared) return Number.NaN;
      const [col, row] = projection.toGrid(point);
      const c = Math.floor((col * prepared.width) / ctx.site.grid.width);
      const r = Math.floor((row * prepared.height) / ctx.site.grid.height);
      if (c < 0 || r < 0 || c >= prepared.width || r >= prepared.height) return Number.NaN;
      return sample(prepared, c, r);
    }

    /** PET of a place from its share of sun, when nothing prepared covers it. */
    const estimate = (exposure: number) => comfort.shade.pet + exposure * (comfort.sun.pet - comfort.shade.pet);

    /** Works out every path's sun and PET, and the heat map, from the shade and the prepared PET. */
    function assess(): void {
      if (!frame) return;
      setExposure(network, lit, ctx.site.grid.cell_m, distance);
      setPet(network, (edge) => estimate(edge.exposure), prepared ? preparedAt : null, ctx.site.grid.cell_m, distance);
      router.heat();
      const source = prepared ?? frame;
      const cells = source.width * source.height;
      if (heatCells?.length !== cells) heatCells = new Uint8Array(cells);
      if (prepared) quantisePet(prepared.data, heatCells);
      else {
        const values = new Float32Array(cells);
        for (let i = 0; i < cells; i++) values[i] = estimate(sample(frame, i % frame.width, Math.floor(i / frame.width)));
        quantisePet(values, heatCells);
      }
      if (water) {
        // Water is cool and evaporating (#343): never the hot ground the shade model makes of it.
        const cool = quantisePet([Math.min(comfort.shade.pet, comfort.airC) - WATER_COOLING_C])[0]!;
        const { width, height } = ctx.site.grid;
        for (let i = 0; i < cells; i++) {
          const col = Math.floor(((i % source.width) * width) / source.width);
          const row = Math.floor((Math.floor(i / source.width) * height) / source.height);
          if (water[row * width + col]) heatCells[i] = cool;
        }
      }
      if (roofs) {
        const { width, height } = ctx.site.grid;
        for (let i = 0; i < cells; i++) {
          const col = Math.floor(((i % source.width) * width) / source.width);
          const row = Math.floor((Math.floor(i / source.width) * height) / source.height);
          if (roofs[row * width + col]) heatCells[i] = 0;
        }
      }
      shade.set({ stream: 0, field: 0, width: source.width, height: source.height, revision: ++revision, min: 0, max: 1, progress: 1, data: heatCells });
    }

    // Roofs: the footprints on the site grid, drawn in the data worker and kept per file (#492).
    if (hasSiteData(ctx.site, 'buildings')) {
      readSiteMask(ctx.site, 'buildings')
        .then((mask) => {
          if (!mask) return;
          roofs = mask;
          assess();
        })
        .catch((error) => console.warn('[coolpaths] footprints not read', error));
    }

    // The scene's water: polygons, or a mask on the site grid.
    if (hasSiteData(ctx.site, 'water')) {
      const path = String(ctx.site.data?.water ?? '');
      const read = /\.tiff?$/i.test(path)
        ? loadSiteField(ctx.site, 'water').then((field) => {
            if (!field) return null;
            const { width, height } = ctx.site.grid;
            const mask = new Uint8Array(width * height);
            for (let i = 0; i < mask.length; i++) {
              const c = Math.floor(((i % width) * field.width) / width);
              const r = Math.floor((Math.floor(i / width) * field.height) / height);
              mask[i] = sample(field, c, r) > 0.5 ? 1 : 0;
            }
            return mask;
          })
        : readSiteMask(ctx.site, 'water');
      read
        .then((mask) => {
          water = mask;
          assess();
        })
        .catch((error) => console.warn('[coolpaths] water not read', error));
    }

    /** Fetches the prepared PET for the hour on show (once per hour), then assesses again. */
    function loadPrepared(): void {
      if (!hasSiteData(ctx.site, PREPARED)) return;
      const hour = Math.floor(ctx.params.hour) % 24;
      if (hour === preparedHour) return;
      preparedHour = hour;
      let pending = preparedByHour.get(hour);
      if (!pending) {
        pending = loadSiteField(ctx.site, PREPARED, hour).catch((error) => {
          console.warn('[coolpaths] prepared PET not read', error);
          return null;
        });
        preparedByHour.set(hour, pending);
      }
      void pending.then((field) => {
        if (preparedHour !== hour) return;
        prepared = field;
        assess();
        reroute();
      });
    }

    // Answers from the worker can come back out of order: only the latest counts.
    let asked = 0;
    function reroute(): void {
      const mine = ++asked;
      void router.route(from, to, ctx.params.detour / 100).then((answer) => {
        if (mine !== asked) return;
        pair = answer;
        rerouted();
      });
    }

    function rerouted(): void {
      pathsDirty = true;
      const summary = (r: Route): WalkSummary => ({
        length: round(r.length),
        sun: round(r.sun),
        heat: round(r.heat),
        pet: r.length > 0 ? Math.round((r.heat / r.length) * 10) / 10 : 0,
        profile: thin(r.profile),
      });
      ctx.publish({
        ready: frame !== null,
        sunUp,
        source: prepared ? 'prepared' : 'estimate',
        air: Math.round(comfort.airC * 10) / 10,
        petSun: Math.round(comfort.sun.pet * 10) / 10,
        petShade: Math.round(comfort.shade.pet * 10) / 10,
        shortest: pair ? summary(pair.shortest) : null,
        coolest: pair ? summary(pair.coolest) : null,
        same: pair ? pair.coolest === pair.shortest : true,
      });
    }

    let picking = 0;
    function pickExample(): void {
      const { width_m, height_m } = ctx.site.extent;
      const span = Math.hypot(width_m, height_m);
      // The example's ends are on the table, where visitors can see them.
      const table2d = tableFrame(ctx.site);
      const onTable = (node: number) => {
        const [x, y] = table2d.toTable(network.nodes[node] as [number, number]);
        return x >= 0 && y >= 0 && x <= width_m && y <= height_m;
      };
      const mine = ++picking;
      void router.example(seed++, span * 0.35, span * 0.8, ctx.params.detour / 100, onTable).then((picked) => {
        if (mine !== picking) return;
        if (picked) [from, to] = picked;
        clock = 0;
        reroute();
      });
    }

    const stream = await ctx.engine.open('sunlight', kernelParams(ctx), ['shadow']);
    stream.on('shadow', (next) => {
      const first = frame === null;
      frame = next;
      assess();
      if (first) pickExample();
      else reroute();
    });
    stream.onStatus((status) => {
      sunUp = status.info.sun.altitude_deg > 0;
    });
    sunUp = comfort.altitude > 0;
    loadPrepared();

    function drawPaths(): void {
      const g = paths.context;
      const scale = paths.pixelsPerMetre;
      paths.clear();
      // The walkways can reach past the table; the drawing stops at its edge, as the other layers do (#203).
      g.save();
      clipToTable(paths, ctx.site);
      g.lineCap = 'round';
      g.lineJoin = 'round';
      if (ctx.params.network) {
        // One stroke per colour keeps a large network cheap to draw.
        g.lineWidth = Math.max(1.5, 1.8 * scale);
        g.globalAlpha = 0.75;
        const bin = (pet: number) => Math.min(PET_BINS.length - 1, Math.max(0, Math.round((pet - PET_BINS[0]!) / 2)));
        PET_BINS.forEach((pet, index) => {
          g.beginPath();
          for (const edge of network.edges) if (bin(edge.pet) === index) trace(paths, edge.coordinates);
          g.strokeStyle = petColour(pet);
          g.stroke();
        });
        g.globalAlpha = 1;
      }
      if (pair) drawRoutes(scale);
      drawEnds();
      g.restore();
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
      g.save();
      clipToTable(walk, ctx.site);
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
      g.restore();
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
        // A walk picked by hand wins over an example still being worked out.
        picking++;
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
        if (['date', 'hour', 'air', 'humidity', 'wind'].some((key) => changed.includes(key as keyof Params))) {
          comfort = comfortFor(ctx.params, ctx.site);
          sunUp = comfort.altitude > 0;
        }
        if (changed.includes('date') || changed.includes('hour')) {
          stream.set(kernelParams(ctx));
          loadPrepared();
        } else if (['air', 'humidity', 'wind'].some((key) => changed.includes(key as keyof Params)) && frame) {
          // Weather moves the estimate only; the shade is the same.
          assess();
          reroute();
        }
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

  // The controller's hero: the time of day, which moves the shade (#76).
  hero: (ctx, el) => coolpathsHero(ctx as never, el),

  // The controller compares the two walks as the Chalmers demo does: distance, mean PET, heat exposure,
  // and PET along each walk.
  panel(ctx, el) {
    el.innerHTML = `
      <style>
        .coolpaths-panel { display: grid; gap: 0.2em; font-size: 0.9em; line-height: 1.1; font-variant-numeric: tabular-nums; min-width: 0; }
        .coolpaths-head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.8em; min-width: 0; }
        .coolpaths-verdict { font-size: 1em; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .coolpaths-source { flex: none; max-width: 45%; font-size: 0.72em; opacity: 0.6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .coolpaths-table { display: grid; grid-template-columns: auto auto auto auto minmax(3em, 1fr); gap: 0.1em 1em; align-items: center; }
        .coolpaths-unit { font-size: 0.7em; font-weight: 400; opacity: 0.7; }
        .coolpaths-table > * { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
        .coolpaths-name { display: flex; align-items: center; gap: 0.45em; }
        .coolpaths-swatch { flex: none; width: 1.1em; height: 0.35em; border-radius: 0.2em; }
        .coolpaths-value { font-size: 1.05em; font-weight: 600; }
        .coolpaths-table [hidden] { display: none; }
        .coolpaths-along { display: block; width: 100%; height: 1em; border-radius: 0.2em; }
      </style>
      <div class="coolpaths-panel">
        <div class="coolpaths-head"><span class="coolpaths-verdict"></span><span class="coolpaths-source"></span></div>
        <div class="coolpaths-table">
          ${(['shortest', 'coolest'] as const)
            .map(
              (name) => `
          <span class="coolpaths-name" data-route="${name}"><span class="coolpaths-swatch" style="background:${name === 'shortest' ? shortColour(ctx.site) : coolColour(ctx.site)}"></span>${name === 'shortest' ? ctx.say('Shortest') : ctx.say('Coolest')}</span>
          <span class="coolpaths-value" data-route="${name}" data-fact="length"></span>
          <span class="coolpaths-value" data-route="${name}" data-fact="pet"></span>
          <span class="coolpaths-value" data-route="${name}" data-fact="heat"></span>
          <svg class="coolpaths-along" data-route="${name}" data-fact="along" viewBox="0 0 300 40" preserveAspectRatio="none" aria-label="${ctx.say(name === 'shortest' ? 'PET along the shortest walk' : 'PET along the coolest walk')}"></svg>`,
            )
            .join('')}
        </div>
      </div>`;
    const verdict = el.querySelector<HTMLElement>('.coolpaths-verdict')!;
    const source = el.querySelector<HTMLElement>('.coolpaths-source')!;
    const walk = (name: 'shortest' | 'coolest') => ctx.shared[name] as WalkSummary | null | undefined;

    /** PET along a walk, on the PET colours, over the longer walk's distance and both walks' range, so the two rows compare. */
    function along(svg: SVGSVGElement, value: WalkSummary, colour: string, scale: { longest: number; lo: number; hi: number }): void {
      const x = (d: number) => (d / scale.longest) * 300;
      const y = (v: number) => 37 - ((v - scale.lo) / Math.max(1, scale.hi - scale.lo)) * 34;
      const points = value.profile.map(([d, v]) => `${x(d).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
      const end = x(value.length).toFixed(1);
      // The area under the line takes the PET colour of each stretch.
      const stops = value.profile.map(([d, v]) => `<stop offset="${(d / Math.max(1, value.length)).toFixed(4)}" stop-color="${petColour(v)}"/>`).join('');
      svg.innerHTML = `
        <defs><linearGradient id="coolpaths-along-${svg.dataset.route}" x1="0" x2="${end}" y1="0" y2="0" gradientUnits="userSpaceOnUse">${stops}</linearGradient></defs>
        <polygon points="0,40 ${points} ${end},40" fill="url(#coolpaths-along-${svg.dataset.route})" opacity="0.45"/>
        <polyline points="${points}" fill="none" stroke="${colour}" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
    }

    function show(name: 'shortest' | 'coolest', hidden: boolean, scale: { longest: number; lo: number; hi: number }): void {
      const value = walk(name);
      el.querySelectorAll<HTMLElement | SVGElement>(`[data-route="${name}"]`).forEach((cell) => cell.toggleAttribute('hidden', hidden || !value));
      if (!value) return;
      const fact = (id: string) => el.querySelector<HTMLElement>(`[data-route="${name}"][data-fact="${id}"]`)!;
      fact('length').textContent = formatUnit(value.length, 'm');
      // Mean PET and heat exposure (PET times metres), as the demo compares them.
      fact('pet').innerHTML = `${formatUnit(value.pet, '°C', 1)} <span class="coolpaths-unit">PET</span>`;
      fact('pet').style.color = petColour(value.pet);
      fact('heat').innerHTML = `${formatDecimal(value.heat / 1000, 1)}k °C·m <span class="coolpaths-unit">${ctx.say('heat')}</span>`;
      along(el.querySelector<SVGSVGElement>(`svg[data-route="${name}"]`)!, value, name === 'shortest' ? shortColour(ctx.site) : coolColour(ctx.site), scale);
    }

    function update() {
      const { ready, sunUp, same } = ctx.shared;
      const shortest = walk('shortest');
      const coolest = walk('coolest');
      const walks = [shortest, coolest].filter((w): w is WalkSummary => !!w);
      const values = walks.flatMap((w) => w.profile.map(([, v]) => v));
      const scale = {
        longest: Math.max(1, ...walks.map((w) => w.length)),
        lo: values.length ? Math.floor(Math.min(...values) - 1) : 20,
        hi: values.length ? Math.ceil(Math.max(...values) + 1) : 44,
      };
      show('shortest', false, scale);
      show('coolest', same === true, scale);
      let text: string;
      if (!ready) text = ctx.say('working out the shade…');
      else if (!shortest || !coolest) text = ctx.say('these two points are not connected');
      else if (same || shortest.heat <= coolest.heat)
        text = sunUp === false ? ctx.say('the sun is down: the shortest walk is the coolest') : ctx.say('the shortest walk is already the coolest');
      else {
        const further = Math.round((coolest.length / shortest.length - 1) * 100);
        const less = Math.round((1 - coolest.heat / shortest.heat) * 100);
        text = further > 0 ? ctx.say('{further}% further, {less}% less heat', { further, less }) : ctx.say('no further, {less}% less heat', { less });
      }
      verdict.textContent = `${formatHour(ctx.params.hour)}: ${text}`;
      // How the shortest walk feels, on the PET scale, for whoever reads the controller up close.
      verdict.title = shortest ? ctx.say('The shortest walk feels {feeling}', { feeling: ctx.say(petFeeling(shortest.pet)) }) : '';
      const air = ctx.shared.air as number | undefined;
      source.textContent =
        ctx.shared.source === 'prepared'
          ? ctx.say('prepared PET')
          : ctx.say('estimated PET, air {air} °C', { air: air ?? '–' });
    }
    update();
    return { update };
  },
});
