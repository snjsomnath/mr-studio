// Networks of nodes and flows driven by time series (#280). The same picture fits an energy
// community, district heating, stormwater pipes and commuter flows: nodes that give and
// take, links whose width and travelling lights follow a series, gauges that fill. The
// drawing pieces existed as blocks (docs/blocks.md, "ECOM, reassembled"); this file is the
// data shape that feeds them and the `network` motion a custom layer uses without code.
//
//   nodes      the look's points: `id` (or `name`), optional `kind`
//   links      a CSV with from,to (and optional id, value), or lines with from/to properties.
//              A link without a line of its own is routed along the streets, or drawn straight.
//   series     optional, long format: id (a node or link id; or from,to for a link), a time
//              column (time, hour, step, date), and one column per named series (flow, level).
//              Without it, a link whose `flow` property is a list of numbers ([3, 5, 2, …], or
//              that list written as text in a CSV) plays that list, one step each (#373).
//              Two optional columns (#338): `note` announces a change at that step ("Kårhuset joins
//              the community"), spotlighting the row's node; `arrivals` sends that many movers
//              along the streets to the row's node during the step (cars coming to charge).
//
// One shared play head walks the series: an hour every `step_s` seconds, looping. Visitors
// can scrub and pause it from the controller (the layer's `network_at` and `network_play`).

import type { Point } from './blocks/geo.ts';
import { distance, measurePath, pointAlong } from './blocks/geo.ts';
import type { MeasuredPath } from './blocks/geo.ts';
import { StreetNetwork } from './blocks/network.ts';
import { clamp01, css } from './blocks/scale.ts';
import type { Rgba } from './blocks/scale.ts';
import { sampleSeries } from './blocks/series.ts';
import type { Shapes, Spot } from './blocks/sources.ts';
import { drawRings } from './blocks/draw.ts';
import type { View } from './blocks/view.ts';
import { timeValue } from './marks.ts';
import { paletteColour, paletteHex } from './palette.ts';
import type { ResolvedPalette } from './palette.ts';
import type { LegendItem } from './types.ts';

type NetworkRow = Record<string, unknown>;

/** The props of a `network` motion block, on a points look (the nodes). */
export interface NetworkProps {
  /** A dataset of links: a CSV with from,to or lines with from/to properties. */
  links: string | null;
  /** A CSV dataset of series, long format. Without it every link carries its `value` (or 1). */
  series: string | null;
  /** A dataset of lines that links without a line of their own follow; null draws them straight. */
  streets: string | null;
  /**
   * The series column a link's flow comes from. Positive flows from `from` to `to`. On a link
   * itself the property may hold a whole list, one value per step (#373), such as `flow_hourly`.
   */
  flow: string;
  /** The series column a node's gauge comes from (0 to 1, or rescaled to its own top). */
  gauge: string;
  /** Seconds each step of the series takes on the table. */
  step_s: number;
  /** Link width at the busiest flow, in table mm; quiet links are thinner. */
  width_mm: number;
  /** Lights travelling on each link; 0 for none. Speed and brightness follow the flow. */
  heads: number;
  /** Table mm per second a light travels at the busiest flow. */
  speed_mm: number;
  /** Rings travel out of a node that gives and into one that takes. */
  rings: boolean;
  /** How far the rings reach, in table mm. */
  ring_mm: number;
  /** A gauge around each node that has a `gauge` series. */
  gauges: boolean;
  /** The flow's colour: `from` takes the colour of the node it leaves (solar flows in the solar colour), else a palette slot or #hex. */
  colour: string;
  /** Colours of the rings and gauges: palette slots or #hex. */
  giving: string;
  taking: string;
  gauge_colour: string;
  /** The series column whose text announces a change at a step (#338): a spotlight on its node, the words on the controller. */
  note: string;
  /** Seconds a change's spotlight stays on the table. */
  note_s: number;
  /** The series column with how many movers reach a node in a step (#338), along the streets. Empty for none. */
  arrivals: string;
  /** A mover's size on the table, in millimetres. */
  mover_mm: number;
  mover_colour: string;
}

export const NETWORK_DEFAULTS: NetworkProps = {
  links: null,
  series: null,
  streets: 'roads',
  flow: 'flow',
  gauge: 'level',
  step_s: 2,
  width_mm: 5,
  heads: 2,
  speed_mm: 40,
  rings: true,
  ring_mm: 18,
  gauges: true,
  colour: 'from',
  giving: '@warm',
  taking: '@cool',
  gauge_colour: '@green',
  note: '',
  note_s: 4,
  arrivals: 'arrivals',
  mover_mm: 4,
  mover_colour: '@focus',
};

/** A node of the network. */
export interface NetworkNode {
  id: string;
  kind: string | null;
  /** Table metres. */
  point: Point;
  /** The node's gauge per step (0 to 1), or null without one. */
  gauge: number[] | null;
}

/** A link between two nodes, with its flow per step. */
export interface NetworkLink {
  id: string;
  from: number;
  to: number;
  path: MeasuredPath;
  /** Where its line came from. */
  route: 'own' | 'streets' | 'straight';
  values: number[];
}

/** A change announced at a step (#338): words for the controller, nodes for the spotlight. */
export interface NetworkNote {
  text: string;
  nodes: number[];
}

/** A network ready to draw: nodes, links, the steps of its series and what went wrong. */
export interface NetworkData {
  nodes: NetworkNode[];
  links: NetworkLink[];
  /** The number of steps in the series (1 without one). */
  steps: number;
  /** The time of each step as the series wrote it, for the controller. */
  labels: string[];
  /** The busiest flow on any link at any step. */
  peak: number;
  /** Problems an author should see: a link naming a node that is not there, a series row with no time. */
  problems: string[];
  /** Per step, the change it announces, or null (#338). */
  notes: (NetworkNote | null)[];
  /** Per node, how many movers reach it in each step, or null for a node without any (#338). */
  arrivals: (number[] | null)[];
  /** The streets movers drive along, when there are any. */
  streets: StreetNetwork | null;
}

export interface NetworkInputs {
  /** Links as lines (with from/to properties). */
  linkShapes?: Shapes | null;
  /** Links as a table. */
  linkRows?: NetworkRow[] | null;
  series?: NetworkRow[] | null;
  /** Streets that links without a line follow. */
  streets?: Shapes | null;
}

const lower = (keys: Iterable<string>) => new Map([...keys].map((k) => [k.toLowerCase(), k]));
function findKey(row: NetworkRow | undefined, names: readonly string[]): string | null {
  const keys = lower(Object.keys(row ?? {}));
  for (const name of names) {
    const hit = keys.get(name);
    if (hit) return hit;
  }
  return null;
}
const text = (v: unknown) => (v === undefined || v === null ? '' : String(v).trim());
const number = (v: unknown) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
/** A list of numbers held on a link (#373): an array, or one written as text ("[3, 5, 2]"). Null otherwise. */
function numberList(v: unknown): number[] | null {
  let list = v;
  if (typeof v === 'string' && v.trim().startsWith('[')) {
    try {
      list = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(list) || list.length < 2) return null;
  const values = list.map(number);
  return values.every((x) => x !== null) ? (values as number[]) : null;
}

/** A step's time for ordering: a number, a date, or a clock time (07:30) in minutes. */
function stepTime(value: string): number {
  const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]) + Number(clock[3] ?? 0) / 60;
  return timeValue(value);
}

/** The id of a node: its `id` column, else its `name`, else its position in the file. */
export function nodeId(spot: Pick<Spot, 'properties'>, index: number): string {
  const p = (spot.properties ?? {}) as NetworkRow;
  const key = findKey(p, ['id', 'node', 'name']);
  const value = key ? text(p[key]) : '';
  return value || String(index);
}

/**
 * Reads a network: the look's points are its nodes; `inputs` hold its links, series and
 * streets. Everything is matched by id, case and spacing as written.
 */
export function networkData(spots: readonly Spot[], inputs: NetworkInputs, props: Partial<NetworkProps> = {}): NetworkData {
  const o = { ...NETWORK_DEFAULTS, ...props };
  const problems: string[] = [];
  const nodes: NetworkNode[] = spots.map((spot, i) => {
    const p = (spot.properties ?? {}) as NetworkRow;
    const kindKey = findKey(p, ['kind', 'type', 'category']);
    return { id: nodeId(spot, i), kind: kindKey ? text(p[kindKey]) || null : null, point: spot.point, gauge: null };
  });
  const byId = new Map<string, number>();
  nodes.forEach((n, i) => {
    if (byId.has(n.id)) problems.push(`Two nodes are called '${n.id}'; links go to the first.`);
    else byId.set(n.id, i);
  });

  // ---- Links ----
  type Raw = { id: string; from: string; to: string; line: MeasuredPath | null; value: number | null; values: number[] | null };
  const raw: Raw[] = [];
  for (const path of inputs.linkShapes?.paths ?? []) {
    const p = (path.properties ?? {}) as NetworkRow;
    const fromKey = findKey(p, ['from', 'source', 'start']);
    const toKey = findKey(p, ['to', 'target', 'end']);
    const idKey = findKey(p, ['id', 'link', 'name']);
    const valueKey = findKey(p, [o.flow.toLowerCase(), 'value', 'volume']);
    if (!fromKey || !toKey) continue;
    const values = valueKey ? numberList(p[valueKey]) : null;
    raw.push({ id: idKey ? text(p[idKey]) : '', from: text(p[fromKey]), to: text(p[toKey]), line: path.points.length >= 2 ? measurePath(path.points) : null, value: valueKey && !values ? number(p[valueKey]) : null, values });
  }
  const linkRows = inputs.linkRows ?? [];
  const head = linkRows[0];
  const fromKey = findKey(head, ['from', 'source', 'start']);
  const toKey = findKey(head, ['to', 'target', 'end']);
  if (linkRows.length > 0 && (!fromKey || !toKey)) problems.push('The links table needs from and to columns.');
  if (fromKey && toKey) {
    const idKey = findKey(head, ['id', 'link', 'name']);
    const valueKey = findKey(head, [o.flow.toLowerCase(), 'value', 'volume']);
    for (const row of linkRows) {
      const values = valueKey ? numberList(row[valueKey]) : null;
      raw.push({ id: idKey ? text(row[idKey]) : '', from: text(row[fromKey]), to: text(row[toKey]), line: null, value: valueKey && !values ? number(row[valueKey]) : null, values });
    }
  }
  let streets: StreetNetwork | null = null;
  const streetLines = (inputs.streets?.paths ?? []).map((p) => p.points);
  if (o.streets && streetLines.length > 0) streets = new StreetNetwork(streetLines);
  const links: NetworkLink[] = [];
  const linkIndex = new Map<string, number>();
  const missing = new Set<string>();
  for (const r of raw) {
    const from = byId.get(r.from);
    const to = byId.get(r.to);
    if (from === undefined || to === undefined) {
      for (const name of [r.from, r.to]) if (!byId.has(name)) missing.add(name);
      continue;
    }
    if (from === to) continue;
    const a = nodes[from]!.point;
    const b = nodes[to]!.point;
    let path = r.line;
    let route: NetworkLink['route'] = 'own';
    if (!path) {
      const routed = streets?.route(a, b) ?? null;
      // A route far longer than the crow flies is a detour round a gap in the streets: go straight.
      if (routed && routed.length <= 3 * distance(a, b) + 50) {
        path = distance(routed.points[routed.points.length - 1]!, b) > 0.01 ? measurePath([...routed.points, b]) : routed;
        route = 'streets';
      } else {
        path = measurePath([a, b]);
        route = 'straight';
      }
    }
    const id = r.id || `${r.from}>${r.to}`;
    linkIndex.set(id, links.length);
    linkIndex.set(`${r.from}>${r.to}`, links.length);
    links.push({ id, from, to, path, route, values: r.values ?? [r.value ?? 1] });
  }
  if (missing.size > 0) problems.push(`Links name nodes that are not there: ${[...missing].slice(0, 5).join(', ')}${missing.size > 5 ? '…' : ''}.`);

  // ---- Series ----
  let notes: (NetworkNote | null)[] = [null];
  const arrivals: (number[] | null)[] = nodes.map(() => null);
  let steps = 1;
  let labels: string[] = [''];
  // Links that carry their own lists (#373) set the steps when there is no series table: step 0, 1, 2…
  const listed = Math.max(0, ...links.map((link) => (link.values.length > 1 ? link.values.length : 0)));
  if (listed > 1) {
    steps = listed;
    labels = Array.from({ length: listed }, (_, i) => String(i));
    for (const link of links) {
      const own = link.values;
      link.values = Array.from({ length: listed }, (_, i) => (own.length > 1 ? own[i % own.length]! : own[0] ?? 1));
    }
  }
  const series = inputs.series ?? [];
  if (series.length > 0) {
    // Columns from the first rows together, so a row that leaves a column out still counts.
    const first: NetworkRow = Object.assign({}, ...series.slice(0, 50));
    const timeKey = findKey(first, ['time', 'hour', 'step', 't', 'date', 'datetime', 'timestamp']);
    const idKey = findKey(first, ['id', 'node', 'link', 'name', 'place']);
    const sFrom = findKey(first, ['from', 'source']);
    const sTo = findKey(first, ['to', 'target']);
    const flowKey = findKey(first, [o.flow.toLowerCase(), 'value']);
    const gaugeKey = findKey(first, [o.gauge.toLowerCase()]);
    const noteKey = o.note ? findKey(first, [o.note.toLowerCase()]) : null;
    const arrivalsKey = o.arrivals ? findKey(first, [o.arrivals.toLowerCase()]) : null;
    if (!timeKey) problems.push('The series needs a time column (time, hour, step or date).');
    else {
      // Steps are the distinct times in order: numbers as numbers, dates as dates, else as written.
      const distinct = [...new Set(series.map((row) => text(row[timeKey])).filter(Boolean))];
      const order = distinct.map((t) => ({ t, v: stepTime(t) }));
      if (order.every((x) => Number.isFinite(x.v))) order.sort((x, y) => x.v - y.v);
      labels = order.map((x) => x.t);
      steps = Math.max(1, labels.length);
      const stepOf = new Map(labels.map((t, i) => [t, i]));
      const linkSeries = links.map(() => new Array<number>(steps).fill(NaN));
      const gauges = nodes.map(() => new Array<number>(steps).fill(NaN));
      notes = new Array<NetworkNote | null>(steps).fill(null);
      const unknown = new Set<string>();
      for (const row of series) {
        const step = stepOf.get(text(row[timeKey]));
        if (step === undefined) continue;
        const id = idKey ? text(row[idKey]) : '';
        // A note and arrivals ride on any row: its node, if it names one, is where they happen.
        const at = byId.get(id);
        const said = noteKey ? text(row[noteKey]) : '';
        if (said) {
          const note = (notes[step] ??= { text: said, nodes: [] });
          if (note.text !== said && !note.text.split(' · ').includes(said)) note.text = `${note.text} · ${said}`;
          if (at !== undefined && !note.nodes.includes(at)) note.nodes.push(at);
        }
        const count = arrivalsKey ? number(row[arrivalsKey]) : null;
        if (count !== null && count > 0 && at !== undefined) {
          const list = (arrivals[at] ??= new Array<number>(steps).fill(0));
          list[step] = Math.min(50, Math.round(count));
        }
        const linkKey = sFrom && sTo && text(row[sFrom]) ? `${text(row[sFrom])}>${text(row[sTo])}` : id;
        const link = linkIndex.get(linkKey);
        const node = byId.get(id);
        if (link !== undefined && flowKey) {
          const v = number(row[flowKey]);
          if (v !== null) linkSeries[link]![step] = v;
        } else if (node !== undefined && gaugeKey) {
          const v = number(row[gaugeKey]);
          if (v !== null) gauges[node]![step] = v;
        } else if (linkKey && link === undefined && node === undefined && !said && count === null) unknown.add(linkKey);
      }
      // A gap takes the step before it, so a sparse series still plays.
      const fill = (values: number[], start: number) => {
        let last = start;
        return values.map((v) => (Number.isFinite(v) ? (last = v) : last));
      };
      links.forEach((link, i) => {
        if (linkSeries[i]!.some(Number.isFinite)) link.values = fill(linkSeries[i]!, 0);
        else link.values = new Array<number>(steps).fill(link.values[0] ?? 1);
      });
      nodes.forEach((node, i) => {
        if (!gauges[i]!.some(Number.isFinite)) return;
        const values = fill(gauges[i]!, 0);
        const top = Math.max(...values);
        // Shares as they are; anything else (kWh stored) against the node's own fullest step.
        node.gauge = top > 1 ? values.map((v) => clamp01(v / top)) : values.map(clamp01);
      });
      if (unknown.size > 0) problems.push(`The series names ids that are neither a node nor a link: ${[...unknown].slice(0, 5).join(', ')}${unknown.size > 5 ? '…' : ''}.`);
    }
  }
  let peak = 0;
  for (const link of links) for (const v of link.values) peak = Math.max(peak, Math.abs(v));
  if (notes.length !== steps) notes = new Array<NetworkNote | null>(steps).fill(null);
  return { nodes, links, steps, labels, peak, problems, notes, arrivals, streets };
}

/** What leaves node `node` less what arrives, at a decimal step. Positive is giving. */
export function networkBalance(data: Pick<NetworkData, 'links'>, node: number, position: number): number {
  let net = 0;
  for (const link of data.links) {
    if (link.from !== node && link.to !== node) continue;
    const v = sampleSeries(link.values, position, { wrap: true });
    net += link.from === node ? v : -v;
  }
  return net;
}

/** The play head: a decimal step, looping over the series. */
export function networkPosition(steps: number, seconds: number, step_s: number): number {
  const n = Math.max(1, steps);
  const p = seconds / Math.max(0.05, step_s);
  return ((p % n) + n) % n;
}

/** The drawing of a network motion, for compileLook. */
export interface NetworkLook {
  data: NetworkData;
  legend: LegendItem[];
  /** Draws the network at a decimal step of its series. */
  draw(view: View, time: number, alpha: number, position: number): void;
}

export function networkLook(data: NetworkData, props: Partial<NetworkProps>, palette: ResolvedPalette, mm: number, nodeColour?: (node: number) => Rgba): NetworkLook {
  const o = { ...NETWORK_DEFAULTS, ...props };
  const byNode = o.colour === 'from' && nodeColour !== undefined;
  const fixedFlow = paletteColour(o.colour === 'from' ? '@warm' : o.colour, palette, 'warm');
  const flowColours = data.links.map((link) => (byNode ? nodeColour!(link.from) : fixedFlow));
  const giving = paletteColour(o.giving, palette, 'warm');
  const taking = paletteColour(o.taking, palette, 'cool');
  const gaugeColour = paletteColour(o.gauge_colour, palette, 'green');
  const quiet: Rgba = [255, 255, 255, 1];
  // Each node's busiest balance over the series, so its rings read against its own day.
  const nodePeak = data.nodes.map((_, i) => {
    let top = 0;
    for (let s = 0; s < data.steps; s++) top = Math.max(top, Math.abs(networkBalance(data, i, s)));
    return top;
  });
  // Lights travel by integrating speed, so a link speeding up never jumps.
  const phases = data.links.map((_, i) => (i * 0.37) % 1);
  let last: number | null = null;
  const moverColour = paletteColour(o.mover_colour, palette, 'focus');
  const movers = moverRoutes(data);
  // The spotlight of the change announced last (#338): which step, and when it started.
  let noted = -1;
  let noteStart = -Infinity;

  const legend: LegendItem[] = [];
  if (data.links.length && !byNode) legend.push({ id: 'network-flow', label: 'Flow', color: paletteHex(o.colour, palette), shape: 'line' });
  if (o.rings && data.links.length) {
    legend.push({ id: 'network-giving', label: 'Giving', color: paletteHex(o.giving, palette), shape: 'point' });
    legend.push({ id: 'network-taking', label: 'Taking', color: paletteHex(o.taking, palette), shape: 'point' });
  }
  if (o.gauges && data.nodes.some((n) => n.gauge)) legend.push({ id: 'network-gauge', label: 'Level', color: paletteHex(o.gauge_colour, palette), shape: 'point' });

  return {
    data,
    legend,
    draw(view, time, alpha, position) {
      let dt = last === null ? 0 : time - last;
      last = time;
      if (dt < 0 || dt > 0.5) dt = 0.016;
      const pen = view.pen;
      const px = (millimetres: number) => millimetres * mm * view.scale;
      const peak = data.peak || 1;
      pen.save();
      pen.lineCap = 'round';
      pen.lineJoin = 'round';
      // A change announced at this step (#338): the table dims round its nodes for a few seconds.
      const step = Math.floor(position) % Math.max(1, data.steps);
      if (step !== noted) {
        noted = step;
        if (data.notes[step]?.nodes.length) noteStart = time;
        else if (data.notes[step] === null && time - noteStart > o.note_s) noteStart = -Infinity;
      }
      const spot = data.notes[noted]?.nodes.length ? spotlight(time - noteStart, o.note_s) : 0;
      if (spot > 0) {
        const holes = data.notes[noted]!.nodes.map((n) => data.nodes[n]!.point);
        const r = Math.max(12, px(o.ring_mm * 1.6));
        pen.beginPath();
        // Larger than any surface; the canvas clips it.
        pen.rect(-1e5, -1e5, 2e5, 2e5);
        for (const point of holes) {
          const [x, y] = view.toPx(point);
          pen.moveTo(x + r, y);
          pen.arc(x, y, r, 0, Math.PI * 2);
        }
        pen.fillStyle = `rgb(4 6 12 / ${(0.62 * spot * alpha).toFixed(3)})`;
        pen.fill('evenodd');
        // A pool of light in each hole, so the spotlight reads on a dark table as well as a light one.
        for (const point of holes) {
          const [x, y] = view.toPx(point);
          const pool = pen.createRadialGradient(x, y, 0, x, y, r);
          pool.addColorStop(0, css(quiet, 0.22 * spot * alpha));
          pool.addColorStop(1, css(quiet, 0));
          pen.fillStyle = pool;
          pen.beginPath();
          pen.arc(x, y, r, 0, Math.PI * 2);
          pen.fill();
        }
        // A ring that tightens onto each node as the spotlight opens.
        const open = clamp01((time - noteStart) / 0.9);
        for (const point of holes) {
          const [x, y] = view.toPx(point);
          pen.strokeStyle = css(quiet, alpha * spot * (0.4 + 0.6 * (1 - open)));
          pen.lineWidth = Math.max(1.5, px(0.8));
          pen.beginPath();
          pen.arc(x, y, r * (1 + 1.4 * (1 - open)), 0, Math.PI * 2);
          pen.stroke();
        }
      }
      const trace = (path: MeasuredPath) => {
        pen.beginPath();
        path.points.forEach((p, i) => {
          const [x, y] = view.toPx(p);
          if (i === 0) pen.moveTo(x, y);
          else pen.lineTo(x, y);
        });
      };
      // Links: a faint track always, the flow on top as wide and bright as it is busy.
      const values = data.links.map((link) => sampleSeries(link.values, position, { wrap: true }));
      data.links.forEach((link, i) => {
        const share = clamp01(Math.abs(values[i]!) / peak);
        trace(link.path);
        pen.strokeStyle = css(quiet, alpha * 0.12);
        pen.lineWidth = Math.max(1, px(0.5));
        pen.stroke();
        if (share < 0.01) return;
        const width = Math.max(1, px(0.4 + (o.width_mm - 0.4) * Math.sqrt(share)));
        const flowColour = flowColours[i]!;
        pen.strokeStyle = css(flowColour, alpha * 0.22 * share);
        pen.lineWidth = width * 3;
        pen.stroke();
        pen.strokeStyle = css(flowColour, alpha * (0.45 + 0.55 * share));
        pen.lineWidth = width;
        pen.stroke();
      });
      // Lights: faster and brighter on busier links, going the way the flow goes.
      if (o.heads > 0) {
        pen.globalCompositeOperation = 'lighter';
        data.links.forEach((link, i) => {
          const v = values[i]!;
          const share = clamp01(Math.abs(v) / peak);
          if (share < 0.01 || link.path.length <= 0) return;
          const speed = o.speed_mm * mm * (0.25 + 0.75 * share);
          phases[i] = (phases[i]! + (dt * speed) / link.path.length) % 1;
          const count = Math.max(1, Math.round(o.heads));
          for (let k = 0; k < count; k++) {
            const t = (phases[i]! + k / count) % 1;
            const at = pointAlong(link.path, v >= 0 ? t : 1 - t);
            const [x, y] = view.toPx(at.point);
            // Lights fade in as they leave and flare as they land.
            const fade = alpha * Math.min(1, t / 0.08) * (t > 0.92 ? 1 - (t - 0.92) / 0.08 : 1) * (0.4 + 0.6 * share);
            const r = Math.max(1.5, px(1.4 + 1.6 * share));
            const glow = pen.createRadialGradient(x, y, 0, x, y, r * 3);
            glow.addColorStop(0, css(flowColours[i]!, fade * 0.7));
            glow.addColorStop(1, css(flowColours[i]!, 0));
            pen.fillStyle = glow;
            pen.beginPath();
            pen.arc(x, y, r * 3, 0, Math.PI * 2);
            pen.fill();
            pen.fillStyle = css(quiet, fade * 0.85);
            pen.beginPath();
            pen.arc(x, y, r * 0.5, 0, Math.PI * 2);
            pen.fill();
          }
        });
        pen.globalCompositeOperation = 'source-over';
      }
      // Rings: out of a node that gives, into one that takes, against its own busiest step.
      if (o.rings) {
        data.nodes.forEach((node, i) => {
          const top = nodePeak[i]!;
          if (top <= 0) return;
          const net = networkBalance(data, i, position);
          const level = clamp01(Math.abs(net) / top);
          if (level < 0.03) return;
          drawRings(view, node.point, { colour: net > 0 ? giving : taking, radius_m: o.ring_mm * mm, direction: net > 0 ? 1 : -1, level: alpha * (0.3 + 0.7 * level), count: 2, period: 2.2, width: Math.max(1.2, px(0.5)) }, (i * 0.29) % 1);
        });
      }
      // Movers (#338): they leave a step before they are due and arrive across their step, then wait a moment.
      if (movers.length) {
        pen.globalCompositeOperation = 'lighter';
        const n = Math.max(1, data.steps);
        const r = Math.max(1.5, px(o.mover_mm / 2));
        for (const mover of movers) {
          // How far into its trip the play head is, the right way round the loop.
          let t = (((position - (mover.due - 1)) % n) + n) % n;
          if (t > 1.6) continue;
          const parked = t > 1;
          t = Math.min(1, t);
          const at = pointAlong(mover.path, t).point;
          const [x, y] = view.toPx(at);
          const fade = alpha * Math.min(1, t / 0.1) * (parked ? 1 - (Math.min(1.6, t + (position % 1)) - 1) / 0.6 : 1);
          const glow = pen.createRadialGradient(x, y, 0, x, y, r * 3.5);
          glow.addColorStop(0, css(moverColour, fade * 0.55));
          glow.addColorStop(1, css(moverColour, 0));
          pen.fillStyle = glow;
          pen.beginPath();
          pen.arc(x, y, r * 3.5, 0, Math.PI * 2);
          pen.fill();
          pen.fillStyle = css(moverColour, fade);
          pen.beginPath();
          pen.arc(x, y, r, 0, Math.PI * 2);
          pen.fill();
        }
        pen.globalCompositeOperation = 'source-over';
      }
      // Gauges: an arc round the node, filling clockwise from the top.
      if (o.gauges) {
        for (const node of data.nodes) {
          if (!node.gauge) continue;
          const level = clamp01(sampleSeries(node.gauge, position, { wrap: true }));
          const [x, y] = view.toPx(node.point);
          const r = Math.max(5, px(8));
          pen.lineWidth = Math.max(2, px(2));
          pen.strokeStyle = css(quiet, alpha * 0.16);
          pen.beginPath();
          pen.arc(x, y, r, 0, Math.PI * 2);
          pen.stroke();
          if (level <= 0.005) continue;
          pen.strokeStyle = css(gaugeColour, alpha);
          pen.beginPath();
          pen.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + level * Math.PI * 2);
          pen.stroke();
        }
      }
      pen.restore();
    },
  };
}

/** How bright a change's spotlight is `age` seconds after its step began: in fast, held, out over the last second. */
export function spotlight(age: number, seconds: number): number {
  if (!(age >= 0) || age > seconds) return 0;
  return Math.min(1, age / 0.4, (seconds - age) / 1);
}

/** One mover: the way it comes, and the decimal step it reaches the node. */
export interface Mover {
  node: number;
  due: number;
  path: MeasuredPath;
}

/** Ways in to a node: the streets from about this far away, or straight lines across. */
const MOVER_FROM_M = 320;
const MOVER_WAYS = 6;

/** Every mover of the series, with its way to its node (#338). Each node gets a few ways in, shared by its movers. */
export function moverRoutes(data: Pick<NetworkData, 'nodes' | 'arrivals' | 'streets' | 'steps'>): Mover[] {
  const out: Mover[] = [];
  data.arrivals.forEach((counts, node) => {
    if (!counts || !counts.some((c) => c > 0)) return;
    const end = data.nodes[node]!.point;
    const ways: MeasuredPath[] = [];
    if (data.streets && data.streets.size > 1) {
      const tree = data.streets.treeTo(end);
      // Starts about MOVER_FROM_M away along the streets, spread round the node.
      const far = data.streets.reachable(tree).filter((n) => tree.cost[n]! >= MOVER_FROM_M * 0.6 && tree.cost[n]! <= MOVER_FROM_M * 1.5);
      const byAngle = far.map((n) => ({ n, a: Math.atan2(data.streets!.nodes[n]![1] - end[1], data.streets!.nodes[n]![0] - end[0]) })).sort((x, y) => x.a - y.a);
      for (let k = 0; k < MOVER_WAYS && byAngle.length; k++) {
        const pick = byAngle[Math.floor(((k + 0.5) / MOVER_WAYS) * byAngle.length)]!;
        const path = data.streets.follow(tree, pick.n, end);
        if (path) ways.push(path);
      }
    }
    if (!ways.length) {
      for (let k = 0; k < MOVER_WAYS; k++) {
        const a = (k / MOVER_WAYS) * Math.PI * 2 + node;
        ways.push(measurePath([[end[0] + Math.cos(a) * MOVER_FROM_M, end[1] + Math.sin(a) * MOVER_FROM_M], end]));
      }
    }
    let k = node;
    counts.forEach((count, step) => {
      for (let i = 0; i < count; i++) out.push({ node, due: step + (i + 0.5) / count, path: ways[k++ % ways.length]! });
    });
  });
  return out;
}

/** The files a network motion reads, by role, for whoever loads them. */
export function networkFiles(props: Partial<NetworkProps>): { links?: string; series?: string; streets?: string } {
  const o = { ...NETWORK_DEFAULTS, ...props };
  const out: { links?: string; series?: string; streets?: string } = {};
  if (o.links) out.links = o.links;
  if (o.series) out.series = o.series;
  if (o.streets) out.streets = o.streets;
  return out;
}
