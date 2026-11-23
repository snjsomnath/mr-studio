import type { SiteInfo } from '@mrstudio/sdk';

import { el } from '../controls.ts';
import { icon } from './icons.ts';

/**
 * One way into a table for every file: the wizard's "Your place" rows and the
 * editor's Add data dialog both use it (#71). It takes a file or an OpenStreetMap
 * fetch, shows what the host makes of it with its one-click fixes, draws it against
 * the table's outline (offering to move the table to the data), and brings it in.
 */

/** What the host says about a file before and after it is brought into the table (see session.md). */
export interface ImportReport {
  ok: boolean;
  target?: string;
  summary: string;
  count?: number;
  inside?: number;
  outside?: number;
  crs?: { code: string; guessed: boolean };
  issues: { code: string; severity: 'blocker' | 'warning' | 'note'; message: string; fix?: 'crop' | 'swap' }[];
  preview?: { type: 'FeatureCollection'; features: { geometry: { type: string; coordinates: unknown } | null }[] };
  path?: string;
}

/** A kind of data a table is made from, and how it is brought in. */
export interface ImportTarget {
  /** What `/api/data/*` is asked for. */
  target: string;
  /** The dataset name layers know it by. */
  dataset: string;
  name: string;
  icon: string;
  about: string;
  accept: string;
  /** Whether OpenStreetMap can provide it. */
  osm: boolean;
  /** What a good file looks like, for the "?" beside the row. */
  example: string;
}

export const TARGETS: ImportTarget[] = [
  {
    target: 'buildings',
    dataset: 'buildings',
    name: 'Buildings',
    icon: 'blocks',
    about: 'Footprints with heights. They cast the shadows and shape the wind. GeoJSON.',
    accept: '.geojson,.json',
    osm: true,
    example:
      'GeoJSON polygons, one per building, with a height in metres (height, höjd) or a number of storeys (building:levels, våningar). WGS84 or SWEREF99 are both fine.\n\n{ "type": "Feature",\n  "properties": { "height": 18 },\n  "geometry": { "type": "Polygon", "coordinates": [[[11.970, 57.690], …]] } }',
  },
  {
    target: 'terrain',
    dataset: 'terrain',
    name: 'Ground',
    icon: 'map',
    about: 'The height of the land, so hills shade and shelter as they do outside. A GeoTIFF.',
    accept: '.tif,.tiff',
    osm: false,
    example: 'A GeoTIFF of ground heights in metres, such as a Lantmäteriet elevation model. It may be larger than the table and on a national grid; if it does not say which, you will be asked for its EPSG code (3006 for SWEREF99 TM).',
  },
  {
    target: 'trees',
    dataset: 'trees',
    name: 'Trees',
    icon: 'tree',
    about: 'Where the trees stand. GeoJSON points, or a CSV with coordinates.',
    accept: '.geojson,.json,.csv',
    osm: true,
    example: 'GeoJSON points, or a CSV with a row per tree: lat and lon (or x and y, or latitud and longitud), and a height if you have one.\n\nlat;lon;höjd\n57,7001;11,9701;9,5',
  },
  {
    target: 'data:roads',
    dataset: 'roads',
    name: 'Streets',
    icon: 'car',
    about: 'The street network, as lines. Traffic drives along it. GeoJSON.',
    accept: '.geojson,.json',
    osm: true,
    example: 'GeoJSON lines along the middle of each street. An optional width in metres and a kind (street, primary…) help traffic look right.\n\n{ "type": "Feature",\n  "properties": { "width": 8 },\n  "geometry": { "type": "LineString", "coordinates": [[11.970, 57.690], [11.972, 57.691]] } }',
  },
  {
    target: 'walkways',
    dataset: 'walkways',
    name: 'Walking paths',
    icon: 'footprints',
    about: 'Lines people can walk along. Cool paths needs them. GeoJSON.',
    accept: '.geojson,.json',
    osm: true,
    example: 'GeoJSON lines along footpaths, pavements and squares people cross. Cool paths finds the shadiest way along them.',
  },
  {
    target: 'trips',
    dataset: 'trips',
    name: 'Trips',
    icon: 'route',
    about: 'Journeys through the day. Mobility needs them. A trips.json file.',
    accept: '.json',
    osm: false,
    example: 'The mobility layer\'s trips.json: a list of journeys, each a mode and a path of [lon, lat, seconds after midnight] points. See packages/layers/mobility/README.md.',
  },
];

export function targetFor(dataset: string): ImportTarget | undefined {
  return TARGETS.find((item) => item.dataset === dataset);
}

/** What the importer needs from the window around it. */
export interface ImporterHost {
  site(): SiteInfo;
  /** Holds back the reload that `site.changed` causes, until released, so that two changes can land as one. */
  hold(on: boolean): void;
  /** Called when the author closes the importer without bringing anything in. */
  cancel?(): void;
}

type Source = { kind: 'file'; file: File } | { kind: 'osm' };

/** Turns lon/lat into metres on the table: x to the right, y up, from its centre. */
export function tableMetres(site: SiteInfo): (lon: number, lat: number) => [number, number] {
  const { lon: lon0, lat: lat0 } = site.origin;
  const r = ((site.extent.rotation_deg ?? 0) * Math.PI) / 180;
  const east = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const north = 110_540;
  return (lon, lat) => {
    const e = (lon - lon0) * east;
    const n = (lat - lat0) * north;
    return [e * Math.cos(r) - n * Math.sin(r), e * Math.sin(r) + n * Math.cos(r)];
  };
}

/** Every coordinate pair in a GeoJSON geometry. */
function positions(coordinates: unknown, out: [number, number][] = []): [number, number][] {
  if (Array.isArray(coordinates) && typeof coordinates[0] === 'number') out.push([coordinates[0] as number, coordinates[1] as number]);
  else if (Array.isArray(coordinates)) for (const inner of coordinates) positions(inner, out);
  return out;
}

const SVG = 'http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

/** The file drawn against the table's outline, so an author sees where it lies. */
export function previewMap(site: SiteInfo, report: ImportReport): SVGSVGElement | null {
  const features = report.preview?.features ?? [];
  if (features.length === 0) return null;
  const metres = tableMetres(site);
  const w = site.extent.width_m / 2;
  const h = site.extent.height_m / 2;
  let [minX, minY, maxX, maxY] = [-w, -h, w, h];
  const shapes: { type: string; rings: [number, number][][] }[] = [];
  for (const feature of features) {
    const geometry = feature.geometry;
    if (!geometry) continue;
    const parts: unknown[] =
      geometry.type === 'Polygon' || geometry.type === 'MultiLineString'
        ? (geometry.coordinates as unknown[])
        : geometry.type === 'MultiPolygon'
          ? (geometry.coordinates as unknown[][]).flat()
          : geometry.type === 'MultiPoint'
            ? (geometry.coordinates as unknown[]).map((p) => [p])
            : [geometry.type === 'Point' ? [geometry.coordinates] : geometry.coordinates];
    const rings = parts.map((part) => positions(part).map(([lon, lat]) => metres(lon, lat)));
    for (const ring of rings)
      for (const [x, y] of ring) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    shapes.push({ type: geometry.type, rings });
  }
  const pad = Math.max(maxX - minX, maxY - minY) * 0.04;
  const [vx, vy, vw, vh] = [minX - pad, -(maxY + pad), maxX - minX + 2 * pad, maxY - minY + 2 * pad];
  const map = svg('svg', { viewBox: `${vx} ${vy} ${vw} ${vh}`, class: 'im-map', role: 'img', 'aria-label': 'Where the file lies against the table' });
  const unit = Math.max(vw, vh) / 400;
  map.append(svg('rect', { x: vx, y: vy, width: vw, height: vh, class: 'im-map-ground' }));
  const data = svg('g', { class: 'im-map-data', 'stroke-width': unit });
  for (const { type, rings } of shapes) {
    if (type.endsWith('Point')) {
      for (const ring of rings) for (const [x, y] of ring) data.append(svg('circle', { cx: x, cy: -y, r: unit * 1.6 }));
      continue;
    }
    const d = rings.map((ring) => ring.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${(-y).toFixed(1)}`).join('') + (type.endsWith('Polygon') ? 'Z' : '')).join('');
    data.append(svg('path', { d, class: type.endsWith('Polygon') ? 'is-area' : 'is-line' }));
  }
  map.append(data, svg('rect', { x: -w, y: -h, width: 2 * w, height: 2 * h, class: 'im-map-table', 'stroke-width': unit * 2 }));
  const label = svg('text', { x: -w + unit * 6, y: -h + unit * 14, class: 'im-map-label', 'font-size': unit * 11 });
  label.textContent = 'Your table';
  map.append(label);
  return map;
}

/** The size of the features of a report on the table's own axes, in metres. */
function spread(site: SiteInfo, report: ImportReport): { width_m: number; height_m: number } {
  const metres = tableMetres(site);
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const feature of report.preview?.features ?? []) {
    for (const [lon, lat] of positions(feature.geometry?.coordinates)) {
      const [x, y] = metres(lon, lat);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  return { width_m: Math.max(0, maxX - minX), height_m: Math.max(0, maxY - minY) };
}

/** The middle of the features of a report, in lon/lat, or null. */
function middle(report: ImportReport): { lon: number; lat: number } | null {
  let [minLon, minLat, maxLon, maxLat] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const feature of report.preview?.features ?? []) {
    for (const [lon, lat] of positions(feature.geometry?.coordinates)) {
      minLon = Math.min(minLon, lon);
      maxLon = Math.max(maxLon, lon);
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
    }
  }
  return Number.isFinite(minLon) ? { lon: (minLon + maxLon) / 2, lat: (minLat + maxLat) / 2 } : null;
}

/**
 * The importer. With `target` it is one row of "Your place"; without, the author
 * picks what the file is (or names a dataset of its own), as in Add data.
 */
export class Importer {
  readonly element = el('div', 'wz-place im');
  private source: Source | null = null;
  private options = new Set<'crop' | 'swap'>();
  /** `EPSG:<code>`, named by the author when the file does not say and the host cannot tell. */
  private crs?: string;
  private report?: ImportReport;
  private busy = false;
  private failed?: string;
  private help = false;
  /** In Add data: what the file is, and the name of a dataset of the author's own. */
  private chosen: string;
  private ownName = '';
  private readonly fixed: boolean;
  private readonly host: ImporterHost;

  constructor(host: ImporterHost, target?: string) {
    this.host = host;
    this.fixed = target !== undefined;
    this.chosen = target ?? 'buildings';
    this.render();
  }

  /** Whether the author has a file or fetch under way, which a redraw of the page around must keep. */
  get pending(): boolean {
    return this.source !== null;
  }

  private item(): ImportTarget | undefined {
    return TARGETS.find((item) => item.target === this.chosen);
  }

  /** The target sent to the host: a fixed kind, or `data:<name>` for the author's own. */
  private target(): string | null {
    if (this.chosen !== 'own') return this.chosen;
    const name = this.ownName.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    return name ? `data:${name}` : null;
  }

  render(): void {
    const { host } = this;
    const item = this.item();
    const data = host.site().data ?? {};
    this.element.dataset.target = this.fixed ? this.chosen : '';
    const nodes: HTMLElement[] = [];

    if (this.fixed && item) {
      const has = item.dataset in data;
      const row = el('div', 'wz-choice');
      const badge = el('span', 'wz-badge');
      badge.append(icon(item.icon, 20));
      const words = el('div');
      const name = el('strong', undefined, item.name);
      const ask = el('button', 'im-help');
      ask.type = 'button';
      ask.textContent = '?';
      ask.ariaLabel = `What a ${item.name.toLowerCase()} file looks like`;
      ask.setAttribute('aria-expanded', String(this.help));
      ask.addEventListener('click', () => {
        this.help = !this.help;
        this.render();
      });
      name.append(ask);
      words.append(name, el('p', undefined, item.about));
      const state = el('span', has ? 'wz-state is-have' : 'wz-state', has ? 'On the table' : 'Not yet');
      if (has) state.prepend(icon('check', 12));
      const actions = el('div', 'im-actions');
      actions.append(...this.sourceButtons(item, has));
      words.append(actions);
      row.append(badge, words, state);
      nodes.push(row);
      if (this.help) nodes.push(el('pre', 'im-example', item.example));
    } else {
      // Add data: what the file is, then where it comes from.
      const kind = el('div', 'im-kind');
      const select = el('select');
      select.ariaLabel = 'What the file holds';
      for (const option of TARGETS) select.append(new Option(option.name, option.target, false, option.target === this.chosen));
      select.append(new Option('Something else, by a name of its own', 'own', false, this.chosen === 'own'));
      select.addEventListener('change', () => {
        this.chosen = select.value;
        this.reset();
      });
      const label = el('label', 'wz-field');
      label.append(el('span', undefined, 'The file holds'), select);
      kind.append(label);
      if (this.chosen === 'own') {
        const own = el('input');
        Object.assign(own, { type: 'text', placeholder: 'bus-stops', value: this.ownName, ariaLabel: 'Name of the dataset' });
        own.addEventListener('input', () => (this.ownName = own.value));
        const field = el('label', 'wz-field');
        field.append(el('span', undefined, 'Its name'), own, el('small', undefined, 'Layers ask for data by this name. Lowercase letters, digits and dashes.'));
        kind.append(field);
      }
      nodes.push(kind);
      if (item) nodes.push(el('p', 'im-about', item.about), el('pre', 'im-example', item.example));
      const buttons = el('div', 'wz-report-actions');
      buttons.append(...this.sourceButtons(item, false));
      nodes.push(buttons);
    }

    if (this.source) nodes.push(this.reportBox());
    this.element.replaceChildren(...nodes);
  }

  private sourceButtons(item: ImportTarget | undefined, has: boolean): HTMLElement[] {
    const input = el('input');
    Object.assign(input, { type: 'file', accept: item?.accept ?? '.geojson,.json,.csv', hidden: true, ariaLabel: `File for ${item?.name ?? 'the dataset'}` });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) this.start({ kind: 'file', file });
    });
    const choose = el('button', 'ed-button', has ? 'Replace' : 'Choose a file');
    choose.type = 'button';
    choose.addEventListener('click', () => {
      if (this.chosen === 'own' && !this.target()) return this.say('Give the dataset a name first.');
      input.click();
    });
    const buttons: HTMLElement[] = [choose, input];
    if (item?.osm) {
      const fetchOsm = el('button', 'ed-button', 'From OpenStreetMap');
      fetchOsm.type = 'button';
      fetchOsm.title = `Fetch ${item.name.toLowerCase()} around the table from OpenStreetMap. Needs the internet.`;
      fetchOsm.addEventListener('click', () => this.start({ kind: 'osm' }));
      buttons.push(fetchOsm);
    }
    return buttons;
  }

  private say(text: string): void {
    this.source = this.source ?? { kind: 'osm' };
    this.report = undefined;
    this.failed = text;
    this.busy = false;
    this.render();
  }

  private reset(): void {
    this.source = null;
    this.options.clear();
    this.crs = undefined;
    this.report = undefined;
    this.failed = undefined;
    this.busy = false;
    this.render();
  }

  private start(source: Source): void {
    this.reset();
    this.source = source;
    void this.check(false);
  }

  private reportBox(): HTMLElement {
    const report = el('div', 'wz-report');
    const what = this.source?.kind === 'file' ? this.source.file.name : 'OpenStreetMap';
    if (this.busy) report.append(el('p', undefined, this.source?.kind === 'osm' ? 'Asking OpenStreetMap…' : `Reading ${what}…`));
    else if (this.failed) report.append(el('p', 'wz-issue is-blocker', this.failed));
    else if (this.report) {
      const answer = this.report;
      report.append(el('p', 'wz-summary', answer.summary));
      for (const issue of answer.issues) {
        const line = el('p', `wz-issue is-${issue.severity}`, issue.message);
        const fix = issue.fix;
        if (fix && !this.options.has(fix)) {
          const apply = el('button', 'ed-button', fix === 'crop' ? 'Leave out what is off the table' : 'Swap latitude and longitude');
          apply.type = 'button';
          apply.addEventListener('click', () => {
            this.options.add(fix);
            void this.check(false);
          });
          line.append(apply);
        }
        if (issue.code === 'coords.unknown' || (this.crs && issue.code === 'extent.outside_all')) {
          // The file does not say where it is; the author names its coordinate system and it is read again.
          const code = el('input');
          Object.assign(code, { type: 'text', inputMode: 'numeric', placeholder: 'EPSG code, such as 3006', ariaLabel: 'EPSG code of the file', value: this.crs?.replace('EPSG:', '') ?? '' });
          const again = el('button', 'ed-button', 'Read it again');
          again.type = 'button';
          const retry = (): void => {
            const digits = code.value.replace(/\D/g, '');
            if (!digits) return;
            this.crs = `EPSG:${digits}`;
            void this.check(false);
          };
          again.addEventListener('click', retry);
          code.addEventListener('keydown', (event) => event.key === 'Enter' && retry());
          const ask = el('span', 'wz-crs');
          ask.append(code, again);
          line.append(ask);
        }
        report.append(line);
      }
      const map = previewMap(this.host.site(), answer);
      if (map) {
        const box = el('div', 'im-preview');
        box.append(map);
        report.append(box);
      }
      // Data that lies elsewhere: the table can go to it, rather than the data being cut.
      const away = (answer.outside ?? 0) > (answer.inside ?? 0) || answer.issues.some((i) => i.code === 'extent.outside_all');
      const centre = away ? middle(answer) : null;
      if (centre && this.source?.kind === 'file') {
        const move = el('button', 'ed-button', 'Move the table here');
        move.type = 'button';
        move.title = `Centre the table on the data (${centre.lat.toFixed(4)}, ${centre.lon.toFixed(4)}) and bring it in. The table keeps its size.`;
        move.addEventListener('click', () => void this.moveHere(centre));
        // Or the table can take the size of the data too, keeping its shape.
        const site = this.host.site();
        const { width_m, height_m } = spread(site, answer);
        const scale = Math.max(width_m / site.extent.width_m, height_m / site.extent.height_m) * 1.1;
        const fitted = { width_m: Math.round(Math.max(100, site.extent.width_m * scale) / 10) * 10, height_m: Math.round(Math.max(100, site.extent.height_m * scale) / 10) * 10 };
        const fit = el('button', 'ed-button', 'Fit the table to this');
        fit.type = 'button';
        fit.title = `Centre the table on the data and make it ${fitted.width_m} by ${fitted.height_m} m, the same shape as now, then bring it in.`;
        fit.addEventListener('click', () => void this.moveHere(centre, fitted));
        const line = el('p', 'wz-issue is-note im-move', 'Most of this lies off the table.');
        line.append(move, fit);
        report.append(line);
      }
    }
    const actions = el('div', 'wz-report-actions');
    const add = el('button', 'ed-button is-primary', 'Add to the table');
    add.type = 'button';
    add.disabled = this.busy || !this.report?.ok;
    add.addEventListener('click', () => void this.check(true));
    const cancel = el('button', 'ed-button', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => {
      this.reset();
      this.host.cancel?.();
    });
    actions.append(add, cancel);
    report.append(actions);
    if (this.report?.issues.some((i) => i.code === 'source.osm')) report.append(el('p', 'im-credit', '© OpenStreetMap contributors. The credit is kept with the data and shown with the table.'));
    return report;
  }

  private query(): URLSearchParams | null {
    const target = this.target();
    if (!target) return null;
    const query = new URLSearchParams({ target });
    for (const option of this.options) query.set(option, '1');
    if (this.crs) query.set('crs', this.crs);
    if (this.source?.kind === 'osm') query.set('source', 'osm');
    return query;
  }

  /** Sends the file (or the fetch) to the host: to be checked, or with `write` to be brought into the table. */
  private async check(write: boolean): Promise<boolean> {
    const query = this.query();
    if (!query || !this.source) {
      this.say('Give the dataset a name first.');
      return false;
    }
    this.busy = true;
    this.failed = undefined;
    this.render();
    let done = false;
    try {
      const file = this.source.kind === 'file' ? this.source.file : null;
      const response = await fetch(`/api/data/${write ? 'import' : 'inspect'}?${query}`, {
        method: 'POST',
        headers: file ? { 'X-Filename': encodeURIComponent(file.name) } : {},
        body: file ?? '',
      });
      // 200 and 422 both carry the report; anything else is a plain message.
      if (response.status === 200 || response.status === 422) this.report = (await response.json()) as ImportReport;
      else this.failed = (await response.text()) || `The table refused the file (${response.status}).`;
      done = write && response.status === 200;
    } catch (error) {
      this.failed = `The file could not be sent: ${(error as Error).message}`;
    }
    this.busy = false;
    // After a successful import the host tells every surface the site changed, and the page reloads.
    if (done) this.source = null;
    this.render();
    return done;
  }

  /** Centres the table on the data, then brings the file in, as one change: the page reloads once both are done. */
  private async moveHere(centre: { lon: number; lat: number }, size?: { width_m: number; height_m: number }): Promise<void> {
    const site = this.host.site();
    this.host.hold(true);
    this.busy = true;
    this.render();
    try {
      const response = await fetch('/api/site/place', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin: centre, extent: { ...site.extent, ...size } }),
      });
      if (!response.ok) {
        const answer = await response.json().catch(() => null);
        throw new Error(answer?.error ?? `The table refused to move (${response.status}).`);
      }
      this.options.delete('crop');
      if (!(await this.check(true))) throw new Error(this.failed ?? this.report?.issues.find((i) => i.severity === 'blocker')?.message ?? 'The file was not brought in.');
    } catch (error) {
      this.busy = false;
      this.failed = `The table could not be moved: ${(error as Error).message}`;
      this.render();
    } finally {
      this.host.hold(false);
    }
  }
}
