// Test data for the layer builder (#308): random points, places, lines or areas that land
// inside the table, with a few columns to colour, size and animate by. Places follow the
// place data standard (#160) and come with activity, flows and links tables, so every place
// motion (#161-163) can be tried on them without preparing anything.
//
// Names, kinds and columns follow the sample kit (samples/kit): places.geojson, zones.geojson
// and tables/activity.csv, flows.csv, links.csv.

import type { Point } from './blocks/geo.ts';
import { tableFrame } from './blocks/geo.ts';
import { seeded } from './blocks/motion.ts';
import type { GeometryKind } from './recipe.ts';
import type { SiteInfo } from './types.ts';

export type TestDataKind = 'points' | 'places' | 'network' | 'lines' | 'areas';

export interface TestDataDef {
  kind: TestDataKind;
  label: string;
  about: string;
  /** The look the layer starts with. */
  geometry: GeometryKind;
  /** The dataset name it is brought in as (a free one is picked when taken). */
  dataset: string;
}

export const TEST_DATA: readonly TestDataDef[] = [
  { kind: 'points', label: 'Random points', about: '60 points with a kind, a value and a year: colour, size and timeline by data.', geometry: 'points', dataset: 'test-points' },
  { kind: 'places', label: 'Random places', about: '12 named places with weight, category and a day of activity, flows and links: try every place motion.', geometry: 'points', dataset: 'test-places' },
  { kind: 'network', label: 'Energy network', about: 'A small energy community: grid, battery, solar roofs and homes, with links and a day of hourly flows and battery level. Try the network motion.', geometry: 'points', dataset: 'test-network' },
  { kind: 'lines', label: 'Random lines', about: '24 wandering lines with a kind, a value and a year: flows, particles and draw-in.', geometry: 'lines', dataset: 'test-lines' },
  { kind: 'areas', label: 'Random areas', about: '15 zones with population, green share, noise and a use: colour areas by data.', geometry: 'fill', dataset: 'test-areas' },
];

/** One file to bring into the table: `suffix` is added to the dataset name (`-activity`). */
export interface TestFile {
  suffix: '' | '-activity' | '-flows' | '-links' | '-series';
  filename: string;
  text: string;
}

type Rand = () => number;
const pick = <T>(r: Rand, list: readonly T[]): T => list[Math.floor(r() * list.length)]!;
const round = (v: number, d = 0) => Math.round(v * 10 ** d) / 10 ** d;
const between = (r: Rand, a: number, b: number) => a + r() * (b - a);

/** The sample kit's places and more, with the hours each is busiest (activity.csv). */
const PLACES: readonly { name: string; kind: string; category: string; peaks: [number, number][] }[] = [
  { name: 'School', kind: 'school', category: 'learning', peaks: [[8, 1], [15, 0.6]] },
  { name: 'Library', kind: 'library', category: 'learning', peaks: [[11, 0.6], [17, 0.9]] },
  { name: 'Café', kind: 'cafe', category: 'everyday', peaks: [[8, 0.5], [12.5, 1], [16, 0.6]] },
  { name: 'Clinic', kind: 'clinic', category: 'care', peaks: [[10, 0.8], [14, 0.7]] },
  { name: 'Playground', kind: 'playground', category: 'everyday', peaks: [[15.5, 1], [17, 0.7]] },
  { name: 'Tram stop', kind: 'stop', category: 'transport', peaks: [[7.5, 1], [16.5, 1], [12, 0.4]] },
  { name: 'Market', kind: 'market', category: 'everyday', peaks: [[10, 0.7], [13, 1]] },
  { name: 'Museum', kind: 'museum', category: 'culture', peaks: [[13, 0.8], [15, 0.9]] },
  { name: 'Concert hall', kind: 'venue', category: 'culture', peaks: [[19.5, 1]] },
  { name: 'Sports hall', kind: 'sports', category: 'leisure', peaks: [[18, 1], [7, 0.4]] },
  { name: 'Park', kind: 'park', category: 'leisure', peaks: [[12, 0.7], [17.5, 0.8]] },
  { name: 'Bus stop', kind: 'stop', category: 'transport', peaks: [[8, 0.9], [17, 0.9]] },
];

/** Positions spread over the table with a margin, kept apart so points do not pile up. */
function scatter(r: Rand, width: number, height: number, count: number, apart: number): Point[] {
  const margin = Math.min(width, height) * 0.06;
  const out: Point[] = [];
  for (let tries = 0; out.length < count && tries < count * 60; tries++) {
    const p: Point = [between(r, margin, width - margin), between(r, margin, height - margin)];
    if (out.every((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) >= apart)) out.push(p);
  }
  while (out.length < count) out.push([between(r, margin, width - margin), between(r, margin, height - margin)]);
  return out;
}

function collection(features: object[]): string {
  return JSON.stringify({ type: 'FeatureCollection', features });
}

/**
 * The files for one kind of test data on a table, in WGS84 so they go through the normal
 * import. Every position lies inside the table's extent.
 */
export function makeTestData(kind: TestDataKind, site: Pick<SiteInfo, 'origin' | 'extent'>, seed = Date.now()): TestFile[] {
  const r = seeded(seed);
  const frame = tableFrame(site);
  const { width, height } = frame;
  const span = Math.min(width, height);
  const ll = (p: Point) => frame.toLonLat(p).map((v) => round(v, 7));
  const margin = span * 0.04;
  const inside = (p: Point): Point => [Math.min(width - margin, Math.max(margin, p[0])), Math.min(height - margin, Math.max(margin, p[1]))];

  if (kind === 'points') {
    const kinds = ['bench', 'kiosk', 'sensor', 'bike stand', 'fountain'];
    const points = scatter(r, width, height, 60, span * 0.03);
    return [{
      suffix: '',
      filename: 'test-points.geojson',
      text: collection(points.map((p, i) => ({
        type: 'Feature',
        properties: { id: `P${i + 1}`, kind: pick(r, kinds), value: round(Math.pow(r(), 1.6) * 100), year: 1990 + Math.floor(r() * 36) },
        geometry: { type: 'Point', coordinates: ll(p) },
      }))),
    }];
  }

  if (kind === 'places') {
    const points = scatter(r, width, height, PLACES.length, span * 0.14);
    const weights = PLACES.map((p) => (p.kind === 'stop' ? round(between(r, 0.8, 1), 2) : round(between(r, 0.25, 0.95), 2)));
    const places = collection(PLACES.map((p, i) => ({
      type: 'Feature',
      properties: { name: p.name, kind: p.kind, category: p.category, weight: weights[i], heading: Math.floor(r() * 360) },
      geometry: { type: 'Point', coordinates: ll(points[i]!) },
    })));
    // A weekday from 06:00 to 22:00, every half hour, with a little noise on each place's peaks.
    const day = new Date().toISOString().slice(0, 10);
    const activity = ['place,time,activity'];
    for (const p of PLACES) {
      const shift = between(r, -0.5, 0.5);
      for (let step = 0; step <= 32; step++) {
        const h = 6 + step / 2;
        const v = 0.05 + p.peaks.reduce((sum, [at, a]) => sum + a * Math.exp(-(((h - at - shift) / 1.1) ** 2)), 0) + between(r, -0.04, 0.04);
        activity.push(`${p.name},${day}T${String(Math.floor(h)).padStart(2, '0')}:${h % 1 ? '30' : '00'},${round(Math.min(1, Math.max(0, v)), 2)}`);
      }
    }
    // Flows: most trips start or end at a stop, the rest between random pairs, each pair once.
    const flows = ['from,to,volume'];
    const seen = new Set<string>();
    const stops = PLACES.filter((p) => p.kind === 'stop');
    for (let tries = 0; seen.size < 18 && tries < 400; tries++) {
      const a = tries % 3 === 2 ? pick(r, PLACES) : pick(r, stops);
      const b = pick(r, PLACES);
      const key = `${a.name}>${b.name}`;
      if (a === b || seen.has(key)) continue;
      seen.add(key);
      const flip = r() < 0.4;
      flows.push(`${flip ? b.name : a.name},${flip ? a.name : b.name},${Math.round(between(r, 40, 480))}`);
    }
    // Links: each place to its two nearest, so the constellations read as a network.
    const links = ['from,to'];
    const linked = new Set<string>();
    PLACES.forEach((p, i) => {
      const near = points
        .map((q, j) => ({ j, d: Math.hypot(q[0] - points[i]![0], q[1] - points[i]![1]) }))
        .filter((n) => n.j !== i)
        .sort((x, y) => x.d - y.d)
        .slice(0, 2);
      for (const { j } of near) {
        const key = [i, j].sort((x, y) => x - y).join('-');
        if (linked.has(key)) continue;
        linked.add(key);
        links.push(`${p.name},${PLACES[j]!.name}`);
      }
    });
    return [
      { suffix: '', filename: 'test-places.geojson', text: places },
      { suffix: '-activity', filename: 'test-places-activity.csv', text: `${activity.join('\n')}\n` },
      { suffix: '-flows', filename: 'test-places-flows.csv', text: `${flows.join('\n')}\n` },
      { suffix: '-links', filename: 'test-places-links.csv', text: `${links.join('\n')}\n` },
    ];
  }

  if (kind === 'network') return energyNetwork(r, width, height, span, ll);

  if (kind === 'lines') {
    const kinds = ['street', 'path', 'cycleway'];
    const starts = scatter(r, width, height, 24, span * 0.05);
    return [{
      suffix: '',
      filename: 'test-lines.geojson',
      text: collection(starts.map((start, i) => {
        // A wandering line: steady steps, the heading turning a little each time.
        let heading = r() * Math.PI * 2;
        const step = span * between(r, 0.04, 0.08);
        const line: Point[] = [start];
        for (let n = 0, count = 5 + Math.floor(r() * 6); n < count; n++) {
          heading += between(r, -0.6, 0.6);
          const last = line[line.length - 1]!;
          let next: Point = [last[0] + Math.cos(heading) * step, last[1] + Math.sin(heading) * step];
          // Turn back from the edge rather than leave the table.
          if (next[0] < margin || next[0] > width - margin || next[1] < margin || next[1] > height - margin) {
            heading += Math.PI * 0.75;
            next = inside([last[0] + Math.cos(heading) * step, last[1] + Math.sin(heading) * step]);
          }
          line.push(next);
        }
        return {
          type: 'Feature',
          properties: { id: `L${i + 1}`, kind: pick(r, kinds), value: round(r() * 100), year: 1990 + Math.floor(r() * 36) },
          geometry: { type: 'LineString', coordinates: line.map(ll) },
        };
      })),
    }];
  }

  // Areas: a 5 by 3 grid of cells over the table, each holding one irregular zone.
  const uses = ['housing', 'offices', 'park', 'school', 'mixed'];
  const cols = 5;
  const rows = 3;
  const cw = (width - margin * 2) / cols;
  const ch = (height - margin * 2) / rows;
  const features: object[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cx = margin + cw * (col + 0.5) + between(r, -0.08, 0.08) * cw;
      const cy = margin + ch * (row + 0.5) + between(r, -0.08, 0.08) * ch;
      const corners = 6 + Math.floor(r() * 4);
      const turn = r() * Math.PI * 2;
      const ring: Point[] = [];
      for (let k = 0; k < corners; k++) {
        const a = turn + (k / corners) * Math.PI * 2;
        const reach = between(r, 0.3, 0.46);
        ring.push(inside([cx + Math.cos(a) * cw * reach, cy + Math.sin(a) * ch * reach]));
      }
      ring.push(ring[0]!);
      const use = pick(r, uses);
      features.push({
        type: 'Feature',
        properties: {
          zone: `Z${features.length + 1}`,
          use,
          population: use === 'park' ? Math.floor(between(r, 0, 120)) : Math.floor(between(r, 300, 2400)),
          green_share: round(use === 'park' ? between(r, 0.6, 0.95) : between(r, 0.05, 0.45), 2),
          noise_db: Math.floor(between(r, 45, 70)),
        },
        geometry: { type: 'Polygon', coordinates: [ring.map(ll)] },
      });
    }
  }
  return [{ suffix: '', filename: 'test-areas.geojson', text: collection(features) }];
}

/**
 * A small energy community for the network motion (#280): the grid, a battery, solar roofs and
 * homes. Solar feeds its home and charges the battery by day; the battery gives in the evening;
 * the grid covers the rest. Hourly flows over a day, and the battery's level for its gauge.
 * A car charger opens in the morning (a `note`) and cars arrive at it (`arrivals`, #338).
 */
function energyNetwork(r: Rand, width: number, height: number, span: number, ll: (p: Point) => number[]): TestFile[] {
  const homes = 6;
  const solar = 3;
  const points = scatter(r, width, height, 3 + homes + solar, span * 0.12);
  const nodes = [
    { name: 'Grid', kind: 'grid' },
    { name: 'Battery', kind: 'battery' },
    ...Array.from({ length: homes }, (_, i) => ({ name: `Home ${i + 1}`, kind: 'home' })),
    ...Array.from({ length: solar }, (_, i) => ({ name: `Solar ${i + 1}`, kind: 'solar' })),
    { name: 'Charger', kind: 'charger' },
  ];
  const text = collection(nodes.map((n, i) => ({ type: 'Feature', properties: { id: n.name, name: n.name, kind: n.kind }, geometry: { type: 'Point', coordinates: ll(points[i]!) } })));
  const links = ['from,to'];
  const pairs: [string, string][] = [];
  const add = (a: string, b: string) => {
    pairs.push([a, b]);
    links.push(`${a},${b}`);
  };
  for (let h = 1; h <= homes; h++) add('Grid', `Home ${h}`);
  for (let s = 1; s <= solar; s++) {
    add(`Solar ${s}`, `Home ${s}`);
    add(`Solar ${s}`, 'Battery');
  }
  for (let h = solar + 1; h <= homes; h++) add('Battery', `Home ${h}`);
  add('Grid', 'Charger');
  // Cars that come to charge, by hour: commuters in the morning, more in the evening. Each charges three hours at 7 kW.
  const cars: Record<number, number> = { 8: 2, 9: 1, 13: 1, 17: 3, 18: 4, 19: 2 };
  const charging = (h: number) => [0, 1, 2].reduce((sum, back) => sum + (h - back >= 8 ? cars[h - back] ?? 0 : 0), 0);
  // Hourly, kW. Demand peaks in the morning and the evening; the sun peaks at one o'clock.
  const sun = (h: number) => Math.max(0, Math.sin((Math.PI * (h - 6)) / 14));
  const demand = Array.from({ length: homes }, () => {
    const base = between(r, 0.4, 0.8);
    const scale = between(r, 0.8, 1.4);
    return (h: number) => scale * (base + 1.6 * Math.exp(-(((h - 7.5) / 1.3) ** 2)) + 2.4 * Math.exp(-(((h - 19) / 2) ** 2)));
  });
  const size = Array.from({ length: solar }, () => between(r, 5, 8));
  const series = ['time,id,from,to,flow,level,arrivals,note'];
  let stored = 4;
  const capacity = 24;
  for (let h = 0; h < 24; h++) {
    const time = `${String(h).padStart(2, '0')}:00`;
    const flow = new Map<string, number>();
    let charge = 0;
    for (let s = 0; s < solar; s++) {
      const made = size[s]! * sun(h);
      const own = Math.min(made, demand[s]!(h));
      flow.set(`Solar ${s + 1}>Home ${s + 1}`, own);
      const spare = made - own;
      const into = Math.min(spare, Math.max(0, capacity - stored - charge));
      flow.set(`Solar ${s + 1}>Battery`, into);
      charge += into;
    }
    stored += charge;
    // The battery gives to the homes without solar in the evening and at night, while it has charge.
    const evening = h >= 17 || h < 6;
    for (let k = solar; k < homes; k++) {
      const give = evening ? Math.min(demand[k]!(h) * 0.45, Math.max(0, stored - 1)) : 0;
      stored -= give;
      flow.set(`Battery>Home ${k + 1}`, give);
    }
    for (let k = 0; k < homes; k++) {
      const covered = (flow.get(`Solar ${k + 1}>Home ${k + 1}`) ?? 0) + (flow.get(`Battery>Home ${k + 1}`) ?? 0);
      flow.set(`Grid>Home ${k + 1}`, Math.max(0, demand[k]!(h) - covered));
    }
    flow.set('Grid>Charger', charging(h) * 7);
    for (const [a, b] of pairs) series.push(`${time},,${a},${b},${round(flow.get(`${a}>${b}`) ?? 0, 2)},,,`);
    series.push(`${time},Battery,,,,${round(stored / capacity, 2)},,`);
    if (cars[h] || h === 8) series.push(`${time},Charger,,,,,${cars[h] ?? 0},${h === 8 ? 'The car chargers open' : ''}`);
  }
  return [
    { suffix: '', filename: 'test-network.geojson', text },
    { suffix: '-links', filename: 'test-network-links.csv', text: `${links.join('\n')}\n` },
    { suffix: '-series', filename: 'test-network-series.csv', text: `${series.join('\n')}\n` },
  ];
}
