import { classBreaks, columnNumbers, paintScale, profileColumns, rampColour, siteDataUrl, STRAY_REACH, tablePalette, tableReach, tableSpace } from '@mrstudio/sdk';
import type { GeometryKind, PaintBy, Paint, SiteInfo } from '@mrstudio/sdk';

import { el } from '../controls.ts';
import { icon } from './icons.ts';
import { dataFormat } from '../data-formats.ts';

/** What a good file looks like, from the one list the MCP server and the guide read too (#36). */
function formatExample(dataset: string): string {
  return dataFormat(dataset)?.example ?? '';
}

/**
 * The "?" box: what a good file looks like, and a small example file to download, made around
 * this table's centre so it shows on the table when it is brought back in (#36).
 */
export function exampleBox(dataset: string, site: SiteInfo): HTMLElement {
  const box = el('div', 'im-help-box');
  box.append(el('pre', 'im-example', formatExample(dataset)));
  const sample = dataFormat(dataset)?.sample(site.origin);
  if (sample) {
    const link = el('a', 'im-download');
    link.href = URL.createObjectURL(new Blob([sample.text], { type: sample.type }));
    link.download = sample.name;
    link.append(icon('file', 14), el('span', undefined, `Download an example (${sample.name})`));
    link.title = 'A small file of this kind around this table, to open and see its shape, or bring back in to try';
    box.append(link);
  }
  return box;
}

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
  preview?: { type: 'FeatureCollection'; features: { geometry: { type: string; coordinates: unknown } | null; properties?: Record<string, unknown> | null }[] };
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
  /** Whether the free elevation service can provide it (the ground). */
  elevation?: boolean;
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
    example: formatExample('buildings'),
  },
  {
    target: 'terrain',
    dataset: 'terrain',
    name: 'Ground',
    icon: 'map',
    about: 'The height of the land, so hills shade and shelter as they do outside. A GeoTIFF.',
    accept: '.tif,.tiff',
    osm: false,
    elevation: true,
    example: formatExample('terrain'),
  },
  {
    target: 'trees',
    dataset: 'trees',
    name: 'Trees',
    icon: 'tree',
    about: 'Where the trees stand. GeoJSON points, or a CSV with coordinates.',
    accept: '.geojson,.json,.csv',
    osm: true,
    example: formatExample('trees'),
  },
  {
    target: 'data:roads',
    dataset: 'roads',
    name: 'Streets',
    icon: 'car',
    about: 'The street network, as lines. Traffic drives along it. GeoJSON.',
    accept: '.geojson,.json',
    osm: true,
    example: formatExample('roads'),
  },
  {
    target: 'walkways',
    dataset: 'walkways',
    name: 'Walking paths',
    icon: 'footprints',
    about: 'Lines people can walk along. Cool paths needs them. GeoJSON.',
    accept: '.geojson,.json',
    osm: true,
    example: formatExample('walkways'),
  },
  {
    target: 'trips',
    dataset: 'trips',
    name: 'Trips',
    icon: 'route',
    about: 'Journeys through the day. Mobility needs them. A trips.json file.',
    accept: '.json',
    osm: false,
    example: formatExample('trips'),
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
  /**
   * Makes a layer of a dataset just brought in, coloured as the author chose in the import (#94).
   * Without it the importer offers no colouring.
   */
  showAs?(layer: { dataset: string; kind: GeometryKind; paint: Paint }): Promise<void>;
  /** Puts a plan drawing just brought in on the table as a Masterplan layer, revealed phase by phase (#193). */
  showPlan?(dataset: string): Promise<void>;
  /** Puts a video just brought in on the table as a Video walk layer (#194). */
  showVideo?(dataset: string): Promise<void>;
}

/** How the author wants an imported dataset shown: no layer, one colour, or coloured by a column. */
type ShowAs = { column: null | ''; classes?: undefined } | { column: string; classes: NonNullable<PaintBy['classes']> };

type Source = { kind: 'file'; file: File } | { kind: 'osm' } | { kind: 'elevation' };

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

/**
 * How much of the table a dataset reaches (see `tableReach`), kept per file and per place of the table.
 * Data stays where it is in the world when a table moves, so a table moved or started from another
 * place can keep data that lies beside it and shows as a scrap at one edge (#180).
 */
const reaches = new Map<string, Promise<number | null>>();
export function reach(site: SiteInfo, dataset: string): Promise<number | null> {
  const url = siteDataUrl(site, dataset);
  if (!url || !/\.(geo)?json$/i.test(url)) return Promise.resolve(null);
  const key = `${url}|${JSON.stringify(site.corners)}`;
  let found = reaches.get(key);
  if (!found) {
    found = (async () => {
      try {
        const response = await fetch(url, { cache: 'no-cache' });
        if (!response.ok) return null;
        const document = await response.json();
        const space = tableSpace(site);
        const lines: [number, number][][] = [];
        for (const feature of document?.features ?? []) {
          const geometry = feature?.geometry;
          // Lines are followed along their length; every other shape counts by its corners.
          const parts = geometry?.type === 'LineString' ? [geometry.coordinates] : geometry?.type === 'MultiLineString' ? geometry.coordinates : null;
          if (parts) for (const part of parts) lines.push(positions(part).map(([lon, lat]) => space.toTable(lon, lat)));
          else for (const [lon, lat] of positions(geometry?.coordinates)) lines.push([space.toTable(lon, lat)]);
        }
        return lines.length ? tableReach(lines, space) : null;
      } catch {
        return null;
      }
    })();
    reaches.set(key, found);
  }
  return found;
}

/** Words for a dataset that reaches only a corner of the table, or null when it covers it. */
export function reachWords(share: number | null, plural: string): string | null {
  if (share === null || share >= STRAY_REACH) return null;
  const fix = `They may be from another place. Replace them with a file${['buildings', 'streets', 'trees'].includes(plural) ? ', or from OpenStreetMap' : ''}.`;
  if (share === 0) return `None of these ${plural} are on the table. ${fix}`;
  return `These ${plural} reach only ${Math.round(share * 100)}% of the table, a scrap at one edge. ${fix}`;
}

const SVG = 'http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

/** The file drawn against the table's outline, so an author sees where it lies. */
export function previewMap(site: SiteInfo, report: ImportReport, colourOf?: (properties: Record<string, unknown>) => string): SVGSVGElement | null {
  const features = report.preview?.features ?? [];
  if (features.length === 0) return null;
  const metres = tableMetres(site);
  const w = site.extent.width_m / 2;
  const h = site.extent.height_m / 2;
  let [minX, minY, maxX, maxY] = [-w, -h, w, h];
  const shapes: { type: string; rings: [number, number][][]; colour?: string }[] = [];
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
    shapes.push({ type: geometry.type, rings, colour: colourOf?.(feature.properties ?? {}) });
  }
  const pad = Math.max(maxX - minX, maxY - minY) * 0.04;
  const [vx, vy, vw, vh] = [minX - pad, -(maxY + pad), maxX - minX + 2 * pad, maxY - minY + 2 * pad];
  const map = svg('svg', { viewBox: `${vx} ${vy} ${vw} ${vh}`, class: 'im-map', role: 'img', 'aria-label': 'Where the file lies against the table' });
  const unit = Math.max(vw, vh) / 400;
  map.append(svg('rect', { x: vx, y: vy, width: vw, height: vh, class: 'im-map-ground' }));
  const data = svg('g', { class: 'im-map-data', 'stroke-width': unit });
  for (const { type, rings, colour } of shapes) {
    // A chosen colour (#94) shows in the preview as it will on the table.
    const paint = colour ? (type.endsWith('Polygon') ? `fill:${colour};fill-opacity:0.75;stroke:${colour}` : type.endsWith('Point') ? `fill:${colour};stroke:none` : `stroke:${colour}`) : null;
    if (type.endsWith('Point')) {
      for (const ring of rings) for (const [x, y] of ring) data.append(svg('circle', { cx: x, cy: -y, r: unit * (colour ? 2.4 : 1.6), ...(paint ? { style: paint } : {}) }));
      continue;
    }
    const d = rings.map((ring) => ring.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${(-y).toFixed(1)}`).join('') + (type.endsWith('Polygon') ? 'Z' : '')).join('');
    data.append(svg('path', { d, class: type.endsWith('Polygon') ? 'is-area' : 'is-line', ...(paint ? { style: paint } : {}) }));
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
  /** When the work in hand began, and whether it writes, for the progress line. */
  private busySince = 0;
  private writing = false;
  private failed?: string;
  private help = false;
  /** In Add data: what the file is, and the name of a dataset of the author's own. */
  private chosen: string;
  private ownName = '';
  /** The colouring chosen for an own dataset, offered once its report is in (#94). One colour by default. */
  private showAs: ShowAs = { column: '' };
  private readonly fixed: boolean;
  private readonly host: ImporterHost;

  constructor(host: ImporterHost, target?: string) {
    this.host = host;
    this.fixed = target !== undefined;
    this.chosen = target ?? 'buildings';
    this.render();
  }

  /**
   * Starts with a file already chosen (Add media, #306). What it holds is guessed from its name,
   * buildings.geojson as Buildings and anything else as a dataset named after the file, and the
   * author can still change it before it is brought in.
   */
  takeFile(file: File): void {
    if (!this.fixed) {
      const stem = file.name.replace(/\.[^.]+$/, '').toLowerCase();
      const known = TARGETS.find((t) => t.dataset === stem || t.name.toLowerCase() === stem);
      const accepts = known?.accept.split(',').some((a) => file.name.toLowerCase().endsWith(a));
      if (known && accepts) this.chosen = known.target;
      else {
        this.chosen = 'own';
        this.ownName = stem.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'data';
      }
    }
    this.start({ kind: 'file', file });
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
      // Data from another place: a dataset that lies mostly beside the table says so (#180).
      const off = el('p', 'wz-issue is-warning im-off');
      off.hidden = true;
      off.setAttribute('role', 'status');
      if (has) {
        void reach(host.site(), item.dataset).then((share) => {
          const words = reachWords(share, item.name.toLowerCase());
          if (!words) return;
          state.className = 'wz-state is-off';
          state.textContent = 'Off the table';
          off.textContent = words;
          off.hidden = false;
        });
      }
      const actions = el('div', 'im-actions');
      actions.append(...this.sourceButtons(item, has));
      words.append(off, actions);
      row.append(badge, words, state);
      nodes.push(row);
      if (this.help) nodes.push(exampleBox(item.dataset, host.site()));
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
        kind.append(el('p', 'im-about', 'GeoJSON, or a CSV with lat and lon columns. A CSV without positions, such as activity through the day or flows and links between places, is kept as a table that place motions join to places by name or id. An SVG plan drawing covers the table, and its layers are revealed one phase at a time. A video (MP4, MOV or WebM) plays on the controller as a Video walk, with the walker moving along a path on the table.'));
      }
      nodes.push(kind);
      if (item) nodes.push(el('p', 'im-about', item.about), exampleBox(item.dataset, this.host.site()));
      const buttons = el('div', 'wz-report-actions');
      buttons.append(...this.sourceButtons(item, false));
      nodes.push(buttons);
    }

    if (this.source) nodes.push(this.reportBox());
    this.element.replaceChildren(...nodes);
  }

  private sourceButtons(item: ImportTarget | undefined, has: boolean): HTMLElement[] {
    const input = el('input');
    Object.assign(input, { type: 'file', accept: item?.accept ?? '.geojson,.json,.csv,.svg,.mp4,.mov,.webm', hidden: true, ariaLabel: `File for ${item?.name ?? 'the dataset'}` });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) this.start({ kind: 'file', file });
    });
    const choose = el('button', 'ed-button', has ? 'Replace' : 'Choose a file');
    choose.type = 'button';
    choose.disabled = this.busy;
    choose.addEventListener('click', () => {
      if (this.chosen === 'own' && !this.target()) return this.say('Give the dataset a name first.');
      input.click();
    });
    const buttons: HTMLElement[] = [choose, input];
    if (item?.osm) {
      const fetchOsm = el('button', 'ed-button', 'From OpenStreetMap');
      fetchOsm.type = 'button';
      fetchOsm.disabled = this.busy;
      fetchOsm.title = `Fetch ${item.name.toLowerCase()} around the table from OpenStreetMap. Needs the internet.`;
      fetchOsm.addEventListener('click', () => this.start({ kind: 'osm' }));
      buttons.push(fetchOsm);
    }
    if (item?.elevation) {
      const fetchHeights = el('button', 'ed-button', 'Download free elevation');
      fetchHeights.type = 'button';
      fetchHeights.disabled = this.busy;
      fetchHeights.title = 'Fetch ground heights around the table from free, worldwide elevation data (about 30 m detail). Needs the internet.';
      fetchHeights.addEventListener('click', () => this.start({ kind: 'elevation' }));
      buttons.push(fetchHeights);
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

  /** A spinner and a line that says what is happening and for how long, updated every second (#124). */
  private progress(what: string): HTMLElement {
    const line = el('p', 'im-busy');
    line.setAttribute('role', 'status');
    const spinner = el('span', 'im-spinner');
    spinner.setAttribute('aria-hidden', 'true');
    const words = el('span');
    line.append(spinner, words);
    const osm = this.source?.kind === 'osm';
    const heights = this.source?.kind === 'elevation';
    const say = () => {
      const seconds = Math.floor((Date.now() - this.busySince) / 1000);
      const time = seconds >= 2 ? ` ${seconds} s` : '';
      if (this.writing) words.textContent = `Bringing it into the table and rebuilding what it shows…${time}`;
      else if (heights) words.textContent = seconds < 15 ? `Downloading free elevation…${time}` : `The elevation service is slow, so this can take a minute. It tries each piece again if it has to…${time}`;
      else if (!osm) words.textContent = `Reading ${what}…${time}`;
      else if (seconds < 15) words.textContent = `Asking OpenStreetMap…${time}`;
      else words.textContent = `OpenStreetMap is busy, so this can take a minute. It tries again, on other servers if it has to…${time}`;
    };
    say();
    const timer = setInterval(() => {
      if (!line.isConnected || !this.busy) clearInterval(timer);
      else say();
    }, 1000);
    return line;
  }

  private reportBox(): HTMLElement {
    const report = el('div', 'wz-report');
    const what = this.source?.kind === 'file' ? this.source.file.name : this.source?.kind === 'elevation' ? 'free elevation' : 'OpenStreetMap';
    if (this.busy) report.append(this.progress(what));
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
      const colouring = this.colouring(answer);
      const map = previewMap(this.host.site(), answer, colouring?.colourOf);
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
    const colouring = this.report && !this.busy && !this.failed ? this.colouring(this.report) : null;
    if (colouring) report.append(colouring.element);
    // A plan drawing (#193) is shown as a Masterplan layer as it comes in.
    const plan = Boolean(this.report?.issues.some((i) => i.code === 'plan.cover') && this.host.showPlan);
    // So is a video (#194), as a Video walk.
    const walk = Boolean(this.report?.issues.some((i) => i.code === 'video.walk') && this.host.showVideo);
    const actions = el('div', 'wz-report-actions');
    const add = el('button', 'ed-button is-primary', plan || walk || (colouring && this.showAs.column !== null) ? 'Add and show on the table' : 'Add to the table');
    add.type = 'button';
    add.disabled = this.busy || !this.report?.ok;
    add.addEventListener('click', () => void (plan ? this.addPlan('showPlan') : walk ? this.addPlan('showVideo') : colouring && this.showAs.column !== null ? this.addAndShow(colouring.kind, colouring.paint) : this.check(true)));
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
    if (this.source?.kind === 'elevation') query.set('source', 'elevation');
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
    this.busySince = Date.now();
    this.writing = write;
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

  /**
   * "Colour it" (#94): for a dataset of the author's own, pick a column and see the file
   * coloured by it in the preview, with its legend and, for numbers, a histogram with the
   * class edges. Null when there is nothing to colour or nowhere to show it.
   */
  private colouring(report: ImportReport): { element: HTMLElement; kind: GeometryKind; paint: Paint; colourOf?: (p: Record<string, unknown>) => string } | null {
    if (!this.host.showAs || this.chosen !== 'own' || !report.ok) return null;
    const features = (report.preview?.features ?? []).filter((f) => f.geometry);
    if (features.length === 0) return null;
    const counts = { fill: 0, lines: 0, points: 0 };
    for (const f of features) {
      const type = f.geometry!.type;
      counts[type.endsWith('Polygon') ? 'fill' : type.endsWith('LineString') ? 'lines' : 'points']++;
    }
    const kind = (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]![0]) as GeometryKind;
    const rows = features.map((f) => f.properties ?? {});
    const columns = profileColumns(rows).filter((c) => c.kind === 'number' || c.distinct <= 40);
    const palette = tablePalette(this.host.site());
    if (this.showAs.column && !columns.some((c) => c.name === this.showAs.column)) this.showAs = { column: '' };
    const chosen = this.showAs.column ? columns.find((c) => c.name === this.showAs.column)! : null;
    const paint: Paint = chosen ? (chosen.kind === 'number' ? { by: chosen.name, kind: 'number', ramp: 'sun', classes: this.showAs.classes ?? 'natural', count: 5 } : { by: chosen.name, kind: 'category' }) : '@accent';
    const scale = paintScale(paint, rows, palette);
    const hex = ([r, g, b, a]: readonly number[]) => `rgb(${Math.round(r!)} ${Math.round(g!)} ${Math.round(b!)}${a !== undefined && a < 1 ? ` / ${a}` : ''})`;
    const colourOf = this.showAs.column === null ? undefined : (p: Record<string, unknown>) => hex(scale.colour(p));

    const box = el('div', 'im-colour');
    box.append(el('h3', undefined, 'Show it on the table'));
    const select = el('select');
    select.ariaLabel = 'Colour by';
    select.append(new Option('In one colour', '', false, this.showAs.column === ''));
    for (const c of columns) select.append(new Option(`By ${c.name} (${c.kind === 'number' ? 'a value' : `${c.distinct} kinds`})`, c.name, false, c.name === this.showAs.column));
    select.append(new Option('Not yet: only add the data', '\u0000', false, this.showAs.column === null));
    select.addEventListener('change', () => {
      const value = select.value;
      this.showAs = value === '\u0000' ? { column: null } : value === '' ? { column: '' } : { column: value, classes: this.showAs.classes ?? 'natural' };
      this.render();
    });
    const field = el('label', 'wz-field');
    field.append(el('span', undefined, 'Colour'), select);
    box.append(field);
    if (chosen?.kind === 'number') {
      const classes = el('div', 'im-classes');
      classes.setAttribute('role', 'radiogroup');
      classes.ariaLabel = 'Classes';
      for (const [value, label] of [['natural', 'Natural breaks'], ['quantile', 'Quantile'], ['equal', 'Equal'], ['continuous', 'Smooth']] as const) {
        const b = el('button', 'ed-button', label);
        b.type = 'button';
        b.setAttribute('aria-pressed', String((this.showAs.classes ?? 'natural') === value));
        b.addEventListener('click', () => {
          this.showAs = { column: chosen.name, classes: value };
          this.render();
        });
        classes.append(b);
      }
      box.append(classes, histogram(columnNumbers(rows, chosen.name), this.showAs.classes ?? 'natural', palette.ramps.sun ?? []));
    }
    if (scale.legend.length) {
      const legend = el('ul', 'im-legend');
      legend.ariaLabel = 'Legend on the controller';
      for (const row of scale.legend) {
        const item = el('li');
        const swatch = el('i');
        swatch.style.background = row.color;
        item.append(swatch, el('span', undefined, row.label));
        legend.append(item);
      }
      box.append(legend);
    }
    if (this.showAs.column !== null) box.append(el('p', 'im-note', 'It becomes a layer of its own. Change its look any time in the layer builder.'));
    return { element: box, kind, paint, colourOf };
  }

  /** Brings the file in, then makes its layer, as one change: the page reloads once, after both. */
  private async addAndShow(kind: GeometryKind, paint: Paint): Promise<void> {
    const dataset = this.target()?.replace(/^data:/, '');
    if (!dataset || !this.host.showAs) return void this.check(true);
    this.host.hold(true);
    try {
      if (await this.check(true)) await this.host.showAs({ dataset, kind, paint });
    } finally {
      this.host.hold(false);
    }
  }

  /** Brings a plan drawing or a video in, then puts it on the table as its layer, as one change. */
  private async addPlan(hook: 'showPlan' | 'showVideo'): Promise<void> {
    const dataset = this.target()?.replace(/^data:/, '');
    const show = this.host[hook];
    if (!dataset || !show) return void this.check(true);
    this.host.hold(true);
    try {
      if (await this.check(true)) await show.call(this.host, dataset);
    } finally {
      this.host.hold(false);
    }
  }

  /** Centres the table on the data, then brings the file in, as one change: the page reloads once both are done. */
  private async moveHere(centre: { lon: number; lat: number }, size?: { width_m: number; height_m: number }): Promise<void> {
    const site = this.host.site();
    this.host.hold(true);
    this.busy = true;
    this.busySince = Date.now();
    this.writing = true;
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

/**
 * A histogram of a column's values with its class edges marked (#94, as in kepler.gl), so an
 * author sees where natural breaks or quantiles cut the data.
 */
function histogram(values: number[], classes: NonNullable<PaintBy['classes']>, ramp: readonly string[]): SVGSVGElement {
  const W = 300;
  const H = 64;
  const chart = svg('svg', { viewBox: `0 0 ${W} ${H + 14}`, class: 'im-histogram', role: 'img', 'aria-label': 'How the values spread, with the class edges' });
  if (values.length === 0) return chart;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const bins = 30;
  const counts = new Array<number>(bins).fill(0);
  const binOf = (v: number) => (hi > lo ? Math.min(bins - 1, Math.floor(((v - lo) / (hi - lo)) * bins)) : 0);
  for (const v of values) counts[binOf(v)]!++;
  const most = Math.max(...counts);
  const breaks = classes === 'continuous' ? [] : classBreaks(values, classes, 5);
  const share = (v: number) => (hi > lo ? (v - lo) / (hi - lo) : 0);
  const classOf = (v: number) => breaks.filter((b) => v >= b).length;
  counts.forEach((count, i) => {
    const mid = lo + ((i + 0.5) / bins) * (hi - lo);
    const t = classes === 'continuous' ? share(mid) : breaks.length ? classOf(mid) / breaks.length : 0;
    const [r, g, b] = rampColour(ramp, t);
    const h = most ? (count / most) * H : 0;
    chart.append(svg('rect', { x: (i * W) / bins + 0.5, y: H - h, width: W / bins - 1, height: h, fill: `rgb(${Math.round(r)} ${Math.round(g)} ${Math.round(b)})` }));
  });
  for (const edge of breaks) {
    const x = share(edge) * W;
    chart.append(svg('line', { x1: x, x2: x, y1: 0, y2: H, class: 'im-histogram-edge' }));
  }
  const format = (v: number) => (Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : Number(v.toPrecision(3)).toString());
  const left = svg('text', { x: 0, y: H + 12, class: 'im-histogram-label' });
  left.textContent = format(lo);
  const right = svg('text', { x: W, y: H + 12, class: 'im-histogram-label', 'text-anchor': 'end' });
  right.textContent = format(hi);
  chart.append(left, right);
  return chart;
}
