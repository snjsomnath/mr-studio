// Energy community (ECOM, #192): a summer day of the Chalmers campus energy community, ported
// from interactive_map onto the 2.0 SDK as a test of what a code-heavy layer needs.
//
// What it is built from:
//   - the ECOM model as a service (#278): `ecom` in site.json points at the ECOM backend. Its
//     POST /api/mr/layer answers buildings, nodes and flows for a community, the same transform
//     interactive_map's controller used. Without the backend, the day it last exported
//     (data/ecom, copied by tools/ecom_data.py) is shown, and changes are worked out here.
//   - entities (#279): a tap on a building picks it; the controller shows "In the community"
//     and "Solar on the roof" for it, with no code here.
//   - a network (#280): the flows along the streets, as wide and bright as they are busy, from
//     the colour of what they leave: solar, the grid or the battery.
//   - dashboard widgets (#281, #356): gauge, series, balance, compare and list, bound to what
//     this layer publishes, and its own day clock widget (#353).
//   - a controller stage of panels in layer.json (#357): map to pick on (#355), the clock, the
//     hour slider (#354), self-sufficiency and the comparison with going it alone.
import { defineLayer, loadSiteData, networkData, networkLook, readShapes, resolvePalette, tableFrame, withAlpha } from '@mrstudio/sdk';
import type { GeoJsonCollection, LayerManifest, NetworkLook, Rgba, Spot, View } from '@mrstudio/sdk';

import manifest from '../layer.json';
import { dayClock } from './day-clock.ts';

interface Params {
  hour: number;
  play: boolean;
  speed: number;
}

interface Day {
  buildings: GeoJsonCollection;
  nodes: GeoJsonCollection;
  flows: GeoJsonCollection;
  /** What the model said the members would draw from the grid each on their own, if it said. */
  aloneImport?: number;
  /** The community's own grid import from the model, if it said. */
  togetherImport?: number;
}

type Props = Record<string, unknown>;
const HOURS = 24;
const SCENARIO = 'campus_community';
const KIND_COLOUR: Record<string, Rgba> = {
  pv: [255, 200, 69, 1],
  building: [255, 200, 69, 1],
  grid: [255, 107, 92, 1],
  battery: [61, 220, 151, 1],
  charge_point: [120, 170, 255, 1],
};
const GREY: Rgba = [140, 150, 170, 1];
const sum = (list: number[]) => list.reduce((a, b) => a + b, 0);
const hourly = (value: unknown): number[] => (Array.isArray(value) ? value.slice(0, HOURS).map((v) => (typeof v === 'number' ? v : 0)) : new Array(HOURS).fill(0));
const lerp = (a: Rgba, b: Rgba, t: number): Rgba => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, 1];

export default defineLayer<Params>({
  manifest: manifest as unknown as LayerManifest,
  widgets: [dayClock],

  async table(ctx) {
    const frame = tableFrame(ctx.site);
    const palette = resolvePalette(ctx.site.palette);
    // A canvas that follows the map, so the drawing lands where the map puts the table
    // (a decoration covers the whole window, which is larger than the table when it has margins).
    const overlay = ctx.map.addCanvas('ecom');
    const surface = {
      begin: (time: number): View => {
        overlay.clear();
        return { pen: overlay.context, scale: overlay.pixelsPerMetre, time, detail: 1, toPx: (p) => overlay.project(frame.toLonLat(p)) };
      },
    };
    const model = ctx.service('ecom');
    const saved: Day = {
      buildings: await loadSiteData<GeoJsonCollection>(ctx.site, 'ecom_buildings'),
      nodes: await loadSiteData<GeoJsonCollection>(ctx.site, 'ecom_nodes'),
      flows: await loadSiteData<GeoJsonCollection>(ctx.site, 'ecom_flows'),
    };
    const set = (manifest as unknown as LayerManifest).entities![0]!;

    let day = saved;
    let fromModel = false;
    let areas = readShapes(day.buildings, frame, 'id').areas;
    let look: NetworkLook | undefined;
    let spec: Props | undefined;
    let asked = 0;

    /** The entity values of one building: in the community, and its solar as a share of today's. */
    const edit = (id: string) => ctx.entity(set.id, id) as { in: boolean; pv: number };
    const member = (props: Props) => edit(String(props.id)).in !== false;

    /** The flows and their nodes, without the buildings taken out (the model leaves them out itself). */
    const rebuild = () => {
      areas = readShapes(day.buildings, frame, 'id').areas;
      const out = new Set<string>();
      if (!fromModel) for (const f of day.buildings.features) if (!member(f.properties ?? {})) out.add(String((f.properties ?? {}).name ?? ''));
      const shapes = readShapes(day.nodes, frame);
      const spots: Spot[] = shapes.spots.filter((s) => !out.has(String(s.properties?.id)) && !out.has(String(s.properties?.host ?? '')));
      const flows = readShapes({ ...day.flows, features: day.flows.features.filter((f) => !out.has(String(f.properties?.source)) && !out.has(String(f.properties?.target))).map((f, i) => ({ ...f, properties: { ...f.properties, id: `f${i}` } })) }, frame);
      // The flows' hourly arrays as the long series a network reads.
      const series = flows.paths.flatMap((p) => hourly(p.properties?.flow_hourly).map((flow, hour) => ({ id: String(p.properties?.id), hour, flow })));
      const data = networkData(spots, { linkShapes: flows, series }, { flow: 'flow', streets: null });
      for (const problem of data.problems) console.warn(`[ecom] ${problem}`);
      const kinds = spots.map((s) => String(s.properties?.kind ?? 'building'));
      look = networkLook(data, { heads: 2, width_mm: 3.2, speed_mm: 30, rings: true, ring_mm: 10, gauges: false, colour: 'from' }, palette, frame.width / 1000, (i) => KIND_COLOUR[kinds[i]!] ?? GREY);
    };

    /** The day's numbers for the panels, from the buildings in the community. */
    const numbers = () => {
      const demand = new Array(HOURS).fill(0);
      const solar = new Array(HOURS).fill(0);
      const out = new Set<string>();
      const extra = new Array(HOURS).fill(0);
      for (const f of day.buildings.features) {
        const p = f.properties ?? {};
        if (!member(p)) {
          out.add(String(p.name ?? ''));
          continue;
        }
        if (!Array.isArray(p.demand_hourly)) continue;
        // Without the model, a building's solar scales with its slider: more of its own use is covered.
        const scale = fromModel ? 1 : Math.max(0, edit(String(p.id)).pv ?? 100) / 100;
        const d = hourly(p.demand_hourly);
        const s = hourly(p.solar_hourly);
        for (let h = 0; h < HOURS; h++) {
          demand[h] += d[h]!;
          const own = Math.min(d[h]!, s[h]! * scale);
          solar[h] += own;
          extra[h] += own - s[h]!;
        }
      }
      // What moves between members: the grid in, roofs shared with neighbours, and the battery.
      const grid = new Array(HOURS).fill(0);
      const shared = new Array(HOURS).fill(0);
      const battery = new Array(HOURS).fill(0);
      const drawn = new Map<string, number>();
      for (const f of day.flows.features) {
        const p = f.properties ?? {};
        if (out.has(String(p.source)) || out.has(String(p.target))) continue;
        const into = p.kind === 'grid' ? grid : p.kind === 'battery' ? battery : shared;
        hourly(p.flow_hourly).forEach((v, h) => (into[h] += v));
        if (p.kind === 'grid') drawn.set(String(p.target), (drawn.get(String(p.target)) ?? 0) + sum(hourly(p.flow_hourly)));
      }
      // More own solar takes that much less from the grid (worked out here only; the model does it properly).
      for (let h = 0; h < HOURS; h++) grid[h] = Math.max(0, grid[h]! - (fromModel ? 0 : extra[h]!));
      const together = day.togetherImport ?? sum(grid);
      // Alone, what a member got from a neighbour's roof or the shared battery would come from the grid.
      const alone = day.aloneImport ?? together + sum(shared) + sum(battery);
      return {
        demand,
        grid,
        self_sufficiency: sum(demand) > 0 ? Math.max(0, 1 - together / sum(demand)) : null,
        day_use: demand.map(Math.round),
        day_solar: solar.map((v, h) => Math.round(v + shared[h]! + battery[h]!)),
        sources: [
          { label: ctx.say('Own roof'), value: Math.round(sum(solar)), slot: 1 },
          { label: ctx.say('Neighbours'), value: Math.round(sum(shared)), slot: 2 },
          { label: ctx.say('Battery'), value: Math.round(sum(battery)), slot: 3 },
          { label: ctx.say('Grid'), value: Math.round(together), slot: 4 },
        ],
        uses: [{ label: ctx.say('Buildings'), value: Math.round(sum(demand)), slot: 5 }],
        scenarios: [
          { label: ctx.say('Each alone'), value: Math.round(alone), state: 'done' },
          { label: ctx.say('Together'), value: Math.round(together), state: 'done' },
        ],
        importers: [...drawn].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([label, value]) => ({ label, value: Math.round(value) })),
      };
    };

    let summary = numbers();
    const publish = () => {
      summary = numbers();
      const { demand: _d, grid: _g, ...shared } = summary;
      ctx.publish({ ...shared, source: fromModel ? ctx.say('From the ECOM model') : ctx.say('Saved day, worked out here') });
    };

    /** Asks the ECOM model for the community as the visitors left it; keeps the saved day if it can't. */
    const ask = async () => {
      const mine = ++asked;
      ctx.publish({ busy: { label: ctx.say('Asking the energy model') } });
      try {
        spec ??= (await model.get<Props>(`/api/scenarios/${SCENARIO}`)).value;
        const body = withEdits(spec, (name) => {
          const f = saved.buildings.features.find((b) => b.properties?.name === name);
          return f ? edit(String(f.properties!.id)) : { in: true, pv: 100 };
        });
        const answer = await model.post<{ buildings: GeoJsonCollection; nodes: GeoJsonCollection; flows: GeoJsonCollection; kpis?: Props; baseline?: { kpis?: Props } }>('/api/mr/layer?baseline=true', body);
        if (mine !== asked) return;
        const v = answer.value;
        const number = (x: unknown) => (typeof x === 'number' ? x : undefined);
        day = { buildings: v.buildings, nodes: v.nodes, flows: v.flows, togetherImport: number(v.kpis?.total_grid_import), aloneImport: number(v.baseline?.kpis?.total_grid_import) };
        fromModel = true;
      } catch (error) {
        if (mine !== asked) return;
        if (fromModel || asked === 1) console.warn(`[ecom] the energy model is not answering (${(error as Error).message}); showing the saved day`);
        day = saved;
        fromModel = false;
      }
      ctx.publish({ busy: null });
      rebuild();
      publish();
    };

    // The play head: an hour every `speed` seconds while playing, from the hour last chosen.
    let hour = ctx.params.hour;
    let time = 0;
    let shownHour = -1;
    ctx.onFrame((dt) => {
      time += dt;
      if (ctx.params.play) hour = (hour + dt / Math.max(0.5, ctx.params.speed)) % HOURS;
      const whole = Math.floor(hour);
      if (whole !== shownHour) {
        shownHour = whole;
        ctx.publish({ hour: whole, day_now: whole / (HOURS - 1) });
      }
      const view = surface.begin(time);
      const pen = view.pen;
      // The community's share of its own use at this hour colours every member: red is the grid, green the community.
      const h = Math.min(HOURS - 1, whole);
      const d = summary.demand[h] ?? 0;
      const covered = d > 0 ? Math.max(0, 1 - (summary.grid[h] ?? 0) / d) : 0;
      const fill = lerp(KIND_COLOUR.grid!, KIND_COLOUR.battery!, covered);
      for (const area of areas) {
        const p = area.properties as Props;
        const inside = member(p) && Array.isArray(p.demand_hourly);
        const use = inside ? hourly(p.demand_hourly) : [];
        const peak = Math.max(1, ...use);
        const level = inside ? (use[h] ?? 0) / peak : 0;
        pen.beginPath();
        for (const polygon of area.polygons) {
          for (const ring of polygon) {
            ring.forEach((point, i) => {
              const [x, y] = view.toPx(point);
              if (i === 0) pen.moveTo(x, y);
              else pen.lineTo(x, y);
            });
            pen.closePath();
          }
        }
        pen.fillStyle = inside ? withAlpha(rgb(fill), 0.18 + 0.42 * level) : withAlpha(rgb(GREY), 0.1);
        pen.fill('evenodd');
        pen.lineWidth = Math.max(1, view.scale * 0.6);
        pen.strokeStyle = inside ? withAlpha(rgb(fill), 0.9) : withAlpha(rgb(GREY), 0.45);
        pen.setLineDash(inside ? [] : [view.scale * 3, view.scale * 3]);
        pen.stroke();
        pen.setLineDash([]);
      }
      look?.draw(view, time, 1, hour);
    });

    rebuild();
    publish();
    await ask();
    return {
      update(changed) {
        if (changed.includes('hour')) hour = ctx.params.hour;
      },
      // A building was taken out, put back or given more solar: once the slider settles, ask again.
      entities() {
        void ask();
      },
    };
  },
});

function rgb(c: Rgba): string {
  return `#${[c[0], c[1], c[2]].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The ECOM model's community with the visitors' changes: buildings taken out leave with their
 * own solar plants, and a building's solar slider scales the share of its roofs that has panels.
 * The analysis is one day, the first of the scenario's period.
 */
function withEdits(spec: Props, edits: (name: string) => { in: boolean; pv: number }): Props {
  const buildings = (spec.buildings as Props[]) ?? [];
  const out = new Set(buildings.filter((b) => edits(String(b.name)).in === false).map((b) => String(b.name)));
  const plantScale = new Map<string, number>();
  const dropped = new Set<string>();
  for (const b of buildings) {
    for (const plant of (b.pv_plants as string[]) ?? []) {
      if (out.has(String(b.name))) dropped.add(plant);
      else plantScale.set(plant, Math.max(0, edits(String(b.name)).pv ?? 100) / 100);
    }
  }
  const period = (spec.analysis_period as Props) ?? {};
  return {
    ...spec,
    buildings: buildings.filter((b) => !out.has(String(b.name))),
    pv_plants: ((spec.pv_plants as Props[]) ?? []).filter((p) => !dropped.has(String(p.name))).map((p) => {
      const scale = plantScale.get(String(p.name)) ?? 1;
      return scale === 1 ? p : { ...p, percentage: Math.min(100, Number(p.percentage ?? 0) * scale) };
    }),
    analysis_period: { ...period, end_month: period.start_month ?? 6, end_day: period.start_day ?? 1, end_hour: 23 },
  };
}
