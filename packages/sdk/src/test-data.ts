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

export type TestDataKind = 'points' | 'places' | 'lines' | 'areas';

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
  { kind: 'lines', label: 'Random lines', about: '24 wandering lines with a kind, a value and a year: flows, particles and draw-in.', geometry: 'lines', dataset: 'test-lines' },
  { kind: 'areas', label: 'Random areas', about: '15 zones with population, green share, noise and a use: colour areas by data.', geometry: 'fill', dataset: 'test-areas' },
];

/** One file to bring into the table: `suffix` is added to the dataset name (`-activity`). */
export interface TestFile {
  suffix: '' | '-activity' | '-flows' | '-links';
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
