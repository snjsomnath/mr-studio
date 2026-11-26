import type { LayerManifest, MediaKind, TextControl } from '@mrstudio/sdk';

import { el, layerButton } from '../controls.ts';
import { MEDIA_KINDS, SOURCE_KINDS, mediaItems, onlineSources, onMediaChanged, sizeOf, titleOf, valueOf } from '../media.ts';
import type { MediaItem, SourceItem } from '../media.ts';
import type { Store } from '../store.ts';
import { icon } from './icons.ts';
import { Importer, TARGETS, tableMetres } from './importer.ts';
import { MODEL_ROW, ModelImporter } from './model-import.ts';

/**
 * The ribbon's Media tab (#306): everything the table has to show, in one place. Its datasets,
 * drawings, pictures, video, sounds and 3D model, and the online sources of this computer. Each
 * can be previewed, shows where it is used, and goes on the table as the layer that shows it.
 * Add media brings any file in, and from then on every list of the editor offers it.
 */

export interface MediaTabHost {
  store: Store;
  /** Brings a file in (the editor's Add media). */
  addMedia(kinds?: readonly MediaKind[]): Promise<MediaItem | null>;
  /** Adds the layer `use`, set to these params, and opens it. */
  addLayer(use: string, params: Record<string, unknown>): Promise<void>;
  /** Selects a layer of the table in the editor. */
  openLayer(id: string): void;
  /** Opens the app's Sources window; undefined in a browser. */
  openSources?: () => void;
  /** Holds back the reload a change of data causes (see Importer). */
  hold(on: boolean): void;
  /** Redraws the ribbon, the library and the inspector. */
  changed(): void;
}

/** What the library shows: one kind of thing, or all of them. */
type Filter = 'all' | 'maps' | 'drawing' | 'picture' | 'video' | 'sound' | 'model' | 'online';

const FILTERS: { id: Filter; label: string; icon: string; kinds?: MediaKind[]; tip: string }[] = [
  { id: 'all', label: 'Everything', icon: 'layers', tip: 'Everything this table has, and the online sources of this computer' },
  { id: 'maps', label: 'Map data', icon: 'map', kinds: ['map', 'table', 'raster', 'data'], tip: 'GeoJSON, CSV and GeoTIFF data' },
  { id: 'drawing', label: 'Drawings', icon: 'brush', kinds: ['drawing'], tip: 'SVG plan drawings' },
  { id: 'picture', label: 'Pictures', icon: 'images', kinds: ['picture'], tip: 'PNG, JPEG, WebP and GIF pictures' },
  { id: 'video', label: 'Video', icon: 'video', kinds: ['video'], tip: 'MP4 and WebM video' },
  { id: 'sound', label: 'Sounds', icon: 'sound', kinds: ['sound'], tip: 'WAV, MP3, OGG and M4A sounds' },
  { id: 'model', label: '3D model', icon: 'cube', kinds: ['model'], tip: 'The 3D model of the place' },
  { id: 'online', label: 'Online', icon: 'globe', tip: 'WMS, ArcGIS, map tiles and other online sources set up on this computer' },
];

/**
 * Something in the library: a file of the table, an online source, or one of the files a table
 * is made from (the rows of the guide's Your place) that it does not have yet.
 */
type Entry = { kind: 'file'; item: MediaItem } | { kind: 'source'; source: SourceItem } | { kind: 'place'; target: string; name: string; icon: string; about: string };

const keyOf = (entry: Entry): string => (entry.kind === 'file' ? `file:${entry.item.path}` : entry.kind === 'source' ? `source:${entry.source.id}` : `place:${entry.target}`);

/** The rows of Your place, by the dataset each one brings in, and the 3D model. */
const PLACE = [...TARGETS.map((t) => ({ target: t.target, dataset: t.dataset, name: t.name, icon: t.icon, about: t.about })), { target: MODEL_ROW, dataset: '', name: '3D model', icon: 'cube', about: 'A model of the place, set on the ground and fitted to the buildings. GLB, OBJ or STL.' }];

/** Where a thing is used: the layers whose settings name it, or that need it. */
interface Use {
  id: string;
  name: string;
  how: string;
}

/** A small drawing of a GeoJSON file against the table's outline, kept per file. */
const sketches = new Map<string, Promise<string | null>>();

/** How much the table keeps for offline use (#516), from the host; null when it cannot say (an older host, or not this computer). */
async function keptForOffline(): Promise<{ bytes: number; words: string } | null> {
  try {
    const response = await fetch('/api/kept');
    if (!response.ok) return null;
    const kept = (await response.json()) as { maps?: number; services?: number; words?: string };
    return typeof kept.words === 'string' ? { bytes: (kept.maps ?? 0) + (kept.services ?? 0), words: kept.words } : null;
  } catch {
    return null;
  }
}

export class MediaTab {
  readonly groups: HTMLElement[] = [];
  /** The library, shown in the middle of the window while the tab is open. */
  readonly view = el('section', 'ed-media');
  private items: MediaItem[] = [];
  private sources: SourceItem[] = [];
  private loaded = false;
  private filter: Filter = 'all';
  private search = '';
  private selected: string | null = null;
  private readonly host: MediaTabHost;
  private readonly searchBox = el('input');
  /** The Your place rows (#71, #56), made once and kept, so a file being checked stays. */
  private readonly importers = new Map<string, Importer>();
  private model: ModelImporter | null = null;
  /** What the table keeps for offline use (#516), in words such as "312 MB"; null when the host did not say. */
  private kept: { bytes: number; words: string } | null = null;
  /** True once Clear was pressed and waits for a yes. */
  private clearing = false;

  constructor(host: MediaTabHost) {
    this.host = host;
    this.view.setAttribute('aria-label', 'Media of this table');
    Object.assign(this.searchBox, { type: 'search', placeholder: 'Find by name', ariaLabel: 'Find media by name' });
    this.searchBox.className = 'ed-media-search';
    this.searchBox.addEventListener('input', () => {
      this.search = this.searchBox.value.trim().toLowerCase();
      this.drawView();
    });
    onMediaChanged(() => {
      if (this.loaded) void this.load();
    });
  }

  /** Lists what the table has again, and draws. */
  async load(): Promise<void> {
    const [items, sources, kept] = await Promise.all([mediaItems(), onlineSources(), keptForOffline()]);
    this.kept = kept;
    this.items = items;
    this.sources = sources;
    this.loaded = true;
    if (this.selected && !this.entries().some((e) => keyOf(e) === this.selected)) this.selected = null;
    this.host.changed();
  }

  /** Selects what was just added, once it is listed. */
  select(item: MediaItem): void {
    this.selected = `file:${item.path}`;
    this.filter = 'all';
  }

  private entries(): Entry[] {
    // What the table is made from and does not have yet stands first, ready to bring in, as in the guide's Your place.
    const missing: Entry[] = PLACE.filter((p) => (p.target === MODEL_ROW ? !this.items.some((i) => i.kind === 'model') : !this.items.some((i) => i.name === p.dataset))).map((p) => ({
      kind: 'place' as const,
      target: p.target,
      name: p.name,
      icon: p.icon,
      about: p.about,
    }));
    return [...missing, ...this.items.map((item) => ({ kind: 'file' as const, item })), ...this.sources.map((source) => ({ kind: 'source' as const, source }))];
  }

  /** The Your place row for a target: the same importer as the guide's (#71), kept once made. */
  private placeRow(target: string): HTMLElement {
    if (target === MODEL_ROW) {
      if (!this.model) this.model = new ModelImporter({ site: () => this.host.store.state.site });
      else this.model.render();
      return this.model.element;
    }
    let importer = this.importers.get(target);
    if (!importer) {
      importer = new Importer({ site: () => this.host.store.state.site, hold: (on) => this.host.hold(on) }, target);
      this.importers.set(target, importer);
    } else if (!importer.pending) importer.render();
    return importer.element;
  }

  /** Shows the Your place row of a target, as Add media does for a 3D model. */
  bringIn(target: string): void {
    this.filter = 'all';
    this.search = '';
    this.searchBox.value = '';
    const file = target === MODEL_ROW ? this.items.find((i) => i.kind === 'model') : this.items.find((i) => i.name === PLACE.find((p) => p.target === target)?.dataset);
    this.selected = file ? `file:${file.path}` : `place:${target}`;
    this.host.changed();
  }

  private shown(): Entry[] {
    const filter = FILTERS.find((f) => f.id === this.filter)!;
    return this.entries().filter((entry) => {
      if (entry.kind === 'place') {
        if (this.filter !== 'all' && !(this.filter === 'model' ? entry.target === MODEL_ROW : this.filter === 'maps' && entry.target !== MODEL_ROW)) return false;
        return !this.search || entry.name.toLowerCase().includes(this.search);
      }
      if (this.filter === 'online' && entry.kind !== 'source') return false;
      if (filter.kinds && (entry.kind !== 'file' || !filter.kinds.includes(entry.item.kind))) return false;
      if (!this.search) return true;
      const words = entry.kind === 'file' ? `${titleOf(entry.item)} ${entry.item.path}` : `${entry.source.name} ${entry.source.id} ${SOURCE_KINDS[entry.source.kind] ?? entry.source.kind}`;
      return words.toLowerCase().includes(this.search);
    });
  }

  private count(filter: (typeof FILTERS)[number]): number {
    if (filter.id === 'all') return this.items.length + this.sources.length;
    if (filter.id === 'online') return this.sources.length;
    return this.items.filter((i) => filter.kinds!.includes(i.kind)).length;
  }

  // ---- The ribbon -----------------------------------------------------------

  /** The tab's ribbon groups, drawn again on every change. */
  ribbon(tool: (label: string, iconName: string, large?: boolean) => HTMLButtonElement, group: (name: string, ...children: HTMLElement[]) => HTMLElement, column: (tools: HTMLElement[]) => HTMLElement[]): HTMLElement[] {
    const add = tool('Add media', 'plus', true);
    add.title = 'Bring in any file: GeoJSON, CSV, GeoTIFF, SVG drawings, pictures, video, sounds or a 3D model. Every list in the editor offers it from then on.';
    add.classList.add('is-primary');
    add.addEventListener('click', () => void this.add());

    const filters = FILTERS.map((f) => {
      const node = tool(this.loaded ? `${f.label} (${this.count(f)})` : f.label, f.icon);
      node.title = f.tip;
      node.setAttribute('aria-pressed', String(this.filter === f.id));
      node.classList.toggle('is-pressed', this.filter === f.id);
      node.addEventListener('click', () => {
        this.filter = f.id;
        this.host.changed();
      });
      return node;
    });

    const sources = tool('Set up sources', 'globe', true);
    sources.title = this.host.openSources ? 'Add a WMS or ArcGIS service, map tiles, Mapbox, CARTO, Lantmäteriet or Västtrafik, with its key or login. Keys stay on this computer.' : 'Sources are set up in the MR Studio app';
    sources.disabled = !this.host.openSources;
    sources.addEventListener('click', () => this.host.openSources?.());

    const find = el('div', 'ed-media-find');
    find.append(icon('search', 14), this.searchBox);

    const last = group('Online sources', sources);
    last.classList.add('is-last');
    return [group('Add', add), group('Show', ...column(filters)), group('Find', find), last];
  }

  // ---- Bringing things in ----------------------------------------------------

  private async add(): Promise<void> {
    const item = await this.host.addMedia();
    if (item) this.select(item);
    await this.load();
  }

  // ---- The library ------------------------------------------------------------

  /** Draws the library in the middle. */
  drawView(): void {
    if (!this.loaded) {
      this.view.replaceChildren(el('p', 'ed-media-empty', 'Looking through the table folder…'));
      return;
    }
    const shown = this.shown();
    const nodes: HTMLElement[] = [];
    if (shown.length === 0) {
      const empty = el('div', 'ed-media-empty');
      const words =
        this.search ? `Nothing here is called “${this.searchBox.value.trim()}”.`
        : this.filter === 'online' ? 'No online sources are set up on this computer yet.'
        : 'Nothing of this kind yet.';
      empty.append(el('p', undefined, words));
      if (!this.search) {
        const go = el('button', 'ed-button is-primary', this.filter === 'online' ? 'Set up sources' : 'Add media');
        go.type = 'button';
        go.disabled = this.filter === 'online' && !this.host.openSources;
        go.addEventListener('click', () => (this.filter === 'online' ? this.host.openSources?.() : void this.add()));
        empty.append(go);
      }
      nodes.push(empty);
    }
    // In groups, by kind, as the filters name them.
    const groups = new Map<string, Entry[]>();
    for (const entry of shown) {
      const name = entry.kind === 'source' ? 'Online sources' : entry.kind === 'place' ? 'Your place: not in the table yet' : MEDIA_KINDS[entry.item.kind].plural;
      groups.set(name, [...(groups.get(name) ?? []), entry]);
    }
    for (const [name, entries] of groups) {
      const section = el('section', 'ed-media-group');
      section.append(el('h3', undefined, `${name} · ${entries.length}`));
      const grid = el('div', 'ed-media-grid');
      grid.append(...entries.map((entry) => this.card(entry)));
      section.append(grid);
      nodes.push(section);
    }
    const kept = this.keptLine();
    if (kept) nodes.push(kept);
    this.view.replaceChildren(...nodes);
  }

  /**
   * "Kept for offline use: 312 MB" with Clear (#516): the map tiles, map pictures and service
   * answers the table fetched, which let it run without the internet. Not the table's own files.
   */
  private keptLine(): HTMLElement | null {
    if (!this.kept) return null;
    const line = el('footer', 'ed-media-kept');
    const words = el('p');
    words.append(el('strong', undefined, `Kept for offline use: ${this.kept.words}`));
    words.append(
      el(
        'span',
        undefined,
        this.kept.bytes > 0
          ? ' of map tiles, map pictures and service answers the table has fetched. The oldest are removed by themselves when there are too many.'
          : '. Map tiles, map pictures and service answers are kept here as the table shows them, so it also runs without the internet.',
      ),
    );
    line.append(words);
    if (this.kept.bytes === 0) return line;
    const button = (label: string, className: string, act: () => void) => {
      const b = el('button', className, label);
      b.type = 'button';
      b.addEventListener('click', act);
      return b;
    };
    if (!this.clearing) {
      line.append(
        button('Clear', 'ed-button', () => {
          this.clearing = true;
          this.drawView();
        }),
      );
      return line;
    }
    const ask = el('div', 'ed-media-kept-ask');
    ask.setAttribute('role', 'alert');
    ask.append(
      el('span', undefined, 'The table fetches these again as it shows them, which needs the internet. Your own files stay.'),
      button(`Clear ${this.kept.words}`, 'ed-button is-danger', () => void this.clearKept()),
      button('Keep', 'ed-button', () => {
        this.clearing = false;
        this.drawView();
      }),
    );
    line.append(ask);
    return line;
  }

  private async clearKept(): Promise<void> {
    this.clearing = false;
    try {
      await fetch('/api/kept/clear', { method: 'POST' });
    } catch {
      // The line below says what is still kept.
    }
    this.kept = await keptForOffline();
    this.drawView();
  }

  private card(entry: Entry): HTMLElement {
    const key = keyOf(entry);
    const card = el('button', 'ed-media-card');
    card.type = 'button';
    card.setAttribute('aria-pressed', String(this.selected === key));
    card.dataset.key = key;
    const thumb = el('div', 'ed-media-thumb');
    const title = el('strong', undefined, entry.kind === 'file' ? titleOf(entry.item) : entry.kind === 'source' ? entry.source.name : entry.name);
    const detail = el('span');
    const uses = entry.kind === 'place' ? 0 : this.uses(entry).length;
    if (entry.kind === 'place') {
      card.classList.add('is-wanted');
      thumb.append(icon(entry.icon, 28));
      detail.textContent = 'Not yet · bring it in';
    } else if (entry.kind === 'file') {
      const { item } = entry;
      this.thumbnail(thumb, item);
      detail.textContent = [MEDIA_KINDS[item.kind].label, sizeOf(item.bytes)].filter(Boolean).join(' · ');
      if (item.missing) {
        card.classList.add('is-missing');
        detail.textContent = 'Missing from the table folder';
      }
    } else {
      thumb.append(icon('globe', 28));
      detail.textContent = [SOURCE_KINDS[entry.source.kind] ?? entry.source.kind, entry.source.ready ? '' : 'needs a key'].filter(Boolean).join(' · ');
      if (!entry.source.ready) card.classList.add('is-missing');
    }
    const words = el('span', 'ed-media-words');
    words.append(title, detail);
    card.append(thumb, words);
    if (uses > 0) {
      const badge = el('span', 'ed-media-used', uses === 1 ? 'In use' : `In use ×${uses}`);
      badge.title = this.uses(entry).map((u) => u.name).join(', ');
      card.append(badge);
    }
    card.addEventListener('click', () => {
      this.selected = key;
      this.host.changed();
    });
    return card;
  }

  private thumbnail(thumb: HTMLElement, item: MediaItem): void {
    const url = `/site/${item.path}`;
    if (item.missing) {
      thumb.append(icon('alert', 28));
      return;
    }
    if (item.kind === 'picture' || item.kind === 'drawing') {
      const img = el('img');
      img.loading = 'lazy';
      img.alt = '';
      img.src = url;
      thumb.append(img);
      thumb.classList.add('is-picture');
      return;
    }
    if (item.kind === 'video') {
      const video = el('video');
      Object.assign(video, { muted: true, preload: 'metadata', playsInline: true });
      // A moment in, so the card shows a frame rather than black.
      video.src = `${url}#t=1`;
      thumb.append(video);
      thumb.classList.add('is-picture');
      return;
    }
    thumb.append(icon(MEDIA_KINDS[item.kind].icon, 28));
    if (item.kind === 'map' && (item.bytes ?? 0) < 8 * 1024 * 1024) {
      void this.sketch(item).then((svg) => {
        if (!svg) return;
        thumb.innerHTML = svg;
        thumb.classList.add('is-sketch');
      });
    }
  }

  /** The shapes of a GeoJSON file in table metres, drawn small, with the table's outline. */
  private sketch(item: MediaItem): Promise<string | null> {
    const site = this.host.store.state.site;
    const key = `${item.path}|${item.bytes}|${JSON.stringify(site.origin)}`;
    let found = sketches.get(key);
    if (!found) {
      found = (async () => {
        try {
          const response = await fetch(`/site/${item.path}`, { cache: 'no-store' });
          if (!response.ok) return null;
          const json = (await response.json()) as { features?: { geometry?: { type: string; coordinates: unknown } | null }[] };
          const toTable = tableMetres(site);
          const w = site.extent.width_m / 2;
          const h = site.extent.height_m / 2;
          const paths: string[] = [];
          const dots: string[] = [];
          const ring = (coords: unknown): string => {
            const points = (coords as [number, number][]).map(([lon, lat]) => toTable(lon, lat));
            return points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${(-y).toFixed(1)}`).join('');
          };
          for (const feature of (json.features ?? []).slice(0, 4000)) {
            const g = feature.geometry;
            if (!g) continue;
            const c = g.coordinates as never[];
            if (g.type === 'Point') {
              const [x, y] = toTable(...(c as unknown as [number, number]));
              dots.push(`M${x.toFixed(1)} ${(-y).toFixed(1)}h0`);
            } else if (g.type === 'LineString') paths.push(ring(c));
            else if (g.type === 'MultiLineString' || g.type === 'Polygon') for (const part of c) paths.push(ring(part));
            else if (g.type === 'MultiPolygon') for (const poly of c as unknown as unknown[][]) for (const part of poly) paths.push(ring(part));
          }
          if (paths.length + dots.length === 0) return null;
          const pad = Math.max(w, h) * 0.06;
          const stroke = Math.max(w, h) / 120;
          return `<svg viewBox="${-w - pad} ${-h - pad} ${2 * (w + pad)} ${2 * (h + pad)}" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><rect x="${-w}" y="${-h}" width="${2 * w}" height="${2 * h}" class="ed-media-table" stroke-width="${stroke}"/><path d="${paths.join('')}" class="ed-media-shapes" stroke-width="${stroke}"/><path d="${dots.join('')}" class="ed-media-dots" stroke-width="${stroke * 3}"/></svg>`;
        } catch {
          return null;
        }
      })();
      sketches.set(key, found);
    }
    return found;
  }

  // ---- Where things are used -----------------------------------------------------

  private uses(entry: Entry): Use[] {
    const { store } = this.host;
    const out: Use[] = [];
    if (entry.kind === 'place') return out;
    for (const id of store.state.scene) {
      const state = store.state.layers[id];
      const manifest = state && store.manifest(state.layer);
      if (!state || !manifest) continue;
      const name = layerButton(id, manifest, state).name;
      for (const control of manifest.controls ?? []) {
        if (control.type !== 'text') continue;
        const value = state.params[control.id];
        if (typeof value !== 'string' || !value) continue;
        if (entry.kind === 'source' ? control.sources?.includes(entry.source.kind) && value === entry.source.id : (control as TextControl).media && (value === entry.item.name || value === entry.item.path)) {
          out.push({ id, name, how: control.label });
        }
      }
      if (entry.kind === 'file' && entry.item.name && manifest.requires?.data?.includes(entry.item.name) && !out.some((u) => u.id === id)) {
        out.push({ id, name, how: 'Needs it' });
      }
    }
    return out;
  }

  // ---- The inspector -----------------------------------------------------------

  /** The inspector while the tab is open: the selected thing, or what the tab is for. */
  inspector(): HTMLElement[] {
    const entry = this.entries().find((e) => keyOf(e) === this.selected);
    const header = el('header', 'ed-inspector-head');
    if (!entry) {
      header.append(icon('folder'), el('strong', undefined, 'Media'), el('span', undefined, 'Everything this table can show'));
      const about = el('section', 'ed-section');
      about.append(
        el('p', undefined, 'Every file the table has, and the online sources of this computer. Pick one to see it, where it is used, and to put it on the table.'),
        el('p', 'ed-muted', 'Anything added here is offered in every list of the editor, so names are never typed by hand.'),
      );
      return [header, about];
    }
    if (entry.kind === 'source') return this.sourceDetails(header, entry.source);
    if (entry.kind === 'place') {
      header.append(icon(entry.icon), el('strong', undefined, entry.name), el('span', undefined, 'Not in the table yet'));
      const row = el('section', 'ed-section ed-media-place');
      row.append(this.placeRow(entry.target));
      return [header, row];
    }
    const { item } = entry;
    header.append(icon(MEDIA_KINDS[item.kind].icon), el('strong', undefined, titleOf(item)), el('span', undefined, MEDIA_KINDS[item.kind].label));
    const nodes: HTMLElement[] = [header];

    const preview = el('section', 'ed-section ed-media-preview');
    const url = `/site/${item.path}`;
    if (item.missing) preview.append(el('p', 'wz-issue is-warning', 'This file is named in the table but is not in its folder. Add it again, or choose another in the layers that use it.'));
    else if (item.kind === 'picture' || item.kind === 'drawing') preview.append(Object.assign(el('img'), { src: url, alt: titleOf(item) }));
    else if (item.kind === 'video') preview.append(Object.assign(el('video'), { src: url, controls: true, muted: true, preload: 'metadata' }));
    else if (item.kind === 'sound') preview.append(Object.assign(el('audio'), { src: url, controls: true, preload: 'none' }));
    else {
      const thumb = el('div', 'ed-media-thumb is-large');
      this.thumbnail(thumb, item);
      preview.append(thumb);
    }
    nodes.push(preview);

    const facts = el('dl', 'ed-media-facts');
    const fact = (term: string, value: string) => facts.append(el('dt', undefined, term), el('dd', undefined, value));
    if (item.name) fact('Layers know it as', item.name);
    fact('File', item.path);
    if (item.bytes !== undefined) fact('Size', sizeOf(item.bytes));
    nodes.push(facts);

    nodes.push(this.usedSection(entry));

    // One of the files the table is made from: replace it, or fetch it again, as in the guide's Your place.
    const place = item.kind === 'model' ? PLACE.find((p) => p.target === MODEL_ROW) : PLACE.find((p) => p.dataset && p.dataset === item.name);
    if (place) {
      const row = el('section', 'ed-section ed-media-place');
      row.append(el('h3', undefined, 'Replace or fetch again'), this.placeRow(place.target));
      nodes.push(row);
    }

    const actions = el('section', 'ed-section ed-media-actions');
    for (const action of this.showActions(item)) actions.append(action);
    if (actions.childElementCount) nodes.push(actions);
    return nodes;
  }

  private sourceDetails(header: HTMLElement, source: SourceItem): HTMLElement[] {
    header.append(icon('globe'), el('strong', undefined, source.name), el('span', undefined, SOURCE_KINDS[source.kind] ?? source.kind));
    const facts = el('dl', 'ed-media-facts');
    facts.append(el('dt', undefined, 'Id'), el('dd', undefined, source.id));
    if (source.url) facts.append(el('dt', undefined, 'Address'), el('dd', undefined, source.url));
    facts.append(el('dt', undefined, 'Key or login'), el('dd', undefined, source.ready ? 'Kept on this computer' : 'Not given yet'));
    const nodes: HTMLElement[] = [header, facts, this.usedSection({ kind: 'source', source })];
    const actions = el('section', 'ed-section ed-media-actions');
    if (source.kind === 'wms' || source.kind === 'arcgis' || source.kind === 'lantmateriet') {
      const show = el('button', 'ed-button is-primary', 'Show on the table');
      show.type = 'button';
      show.title = 'Adds a Web map layer that uses this source; pick its layers there';
      show.addEventListener('click', () => void this.host.addLayer('wms', { map: 'custom', service: source.kind === 'arcgis' ? 'arcgis' : 'wms', signin: source.id }));
      actions.append(show);
    }
    if (this.host.openSources) {
      const edit = el('button', 'ed-button', 'Change in Sources…');
      edit.type = 'button';
      edit.addEventListener('click', () => this.host.openSources?.());
      actions.append(edit);
    }
    if (actions.childElementCount) nodes.push(actions);
    return nodes;
  }

  private usedSection(entry: Entry): HTMLElement {
    const section = el('section', 'ed-section');
    const uses = this.uses(entry);
    section.append(el('h3', undefined, 'Used by'));
    if (uses.length === 0) section.append(el('p', 'ed-empty', 'No layer uses this yet.'));
    for (const use of uses) {
      const row = el('button', 'ed-media-use');
      row.type = 'button';
      row.append(el('strong', undefined, use.name), el('span', undefined, use.how));
      row.title = `Open ${use.name}`;
      row.addEventListener('click', () => this.host.openLayer(use.id));
      section.append(row);
    }
    return section;
  }

  /** The layers that show a thing of this kind, as buttons that put it on the table. */
  private showActions(item: MediaItem): HTMLElement[] {
    if (item.missing) return [];
    const offers: { use: string; label: string; tip: string; params: Record<string, unknown> }[] = [];
    const has = (id: string) => this.host.store.manifests.some((m: LayerManifest) => m.id === id);
    if ((item.kind === 'map' || item.kind === 'table') && item.name) offers.push({ use: 'mapdata', label: 'Show on the table', tip: 'Adds a Map data layer that draws this data', params: { dataset: item.name } });
    if (item.kind === 'drawing' && item.name) offers.push({ use: 'plan', label: 'Show as a masterplan', tip: 'Adds a Masterplan layer that reveals the drawing phase by phase', params: { dataset: item.name } });
    if (item.kind === 'picture' || item.kind === 'video') offers.push({ use: 'media', label: 'Show over the table', tip: 'Adds a Picture or video layer that covers the table with it', params: { file: item.path } });
    if (item.kind === 'video') offers.push({ use: 'walkthrough', label: 'Play as a video walk', tip: 'Adds a Video walk that plays it on the controller while a walker moves along a path', params: { video: valueOf(item) } });
    return offers
      .filter((o) => has(o.use))
      .map((o, n) => {
        const node = el('button', n === 0 ? 'ed-button is-primary' : 'ed-button', o.label);
        node.type = 'button';
        node.title = o.tip;
        node.addEventListener('click', () => void this.host.addLayer(o.use, o.params));
        return node;
      });
  }
}
