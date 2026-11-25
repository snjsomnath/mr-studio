// The New layer gallery (#59): the one place a layer is made. Cards with a picture, a line on
// what each layer is for and what it still needs, in sections that follow the layer model (#38):
// from your data, analysis, story, your own, and map life. The ribbon's New layer, the tree's +
// and an empty layer list all open it.

import type { LayerManifest, Shapes } from '@mrstudio/sdk';

import { el, isAmbient, isOffered } from '../controls.ts';
import type { Store } from '../store.ts';
import { icon } from './icons.ts';
import { targetFor } from './importer.ts';

export type GallerySection = 'data' | 'analysis' | 'story' | 'own' | 'life';

export const SECTIONS: { id: GallerySection; title: string; about: string }[] = [
  { id: 'data', title: 'From your data', about: 'A layer made from a dataset of this table, a file or a map service.' },
  { id: 'analysis', title: 'Analysis', about: 'Layers that work something out about the place: sun, wind, heat, water, movement.' },
  { id: 'story', title: 'Story', about: 'Pictures, plans, video and drawing, shown on the table one after another.' },
  { id: 'own', title: 'Make your own', about: 'A layer you design from data: its look, its motion and what visitors can do with it.' },
  { id: 'life', title: 'Map life', about: 'Always on, with no button: it goes onto the map at rest, or into the layer that is open.' },
];

/** Where each core layer sits in the gallery. Anything not listed goes by its category. */
const PLACE: Record<string, GallerySection> = {
  mapdata: 'data',
  wms: 'data',
  sunlight: 'analysis',
  wind: 'analysis',
  coolpaths: 'analysis',
  mobility: 'analysis',
  stormwater: 'analysis',
  isovist: 'analysis',
  lens: 'analysis',
  swipe: 'analysis',
  grid: 'analysis',
  slideshow: 'story',
  plan: 'story',
  media: 'story',
  walkthrough: 'story',
  sketch: 'story',
};

/** The order of cards inside a section: the layers most tables want first. */
const ORDER = ['sunlight', 'wind', 'coolpaths', 'mobility', 'stormwater', 'isovist', 'lens', 'swipe', 'grid', 'slideshow', 'plan', 'media', 'walkthrough', 'sketch', 'mapdata', 'wms'];

export function sectionOf(manifest: LayerManifest): GallerySection {
  if (manifest.custom) return 'own';
  if (isAmbient(manifest)) return 'life';
  return PLACE[manifest.id] ?? (manifest.category === 'media' ? 'story' : 'analysis');
}

/** The data a layer needs that this table does not have yet, with the row of Your place that brings it in. */
export function missingData(store: Store, manifest: LayerManifest): { names: string[]; target?: string; label?: string } {
  const data = store.state.site.data ?? {};
  const names = (manifest.requires?.data ?? []).filter((name) => !(name in data));
  const found = names.map((name) => targetFor(name)).find(Boolean);
  return { names, target: found?.target, label: found?.name };
}

/** Words for a list of dataset names: "walkways", "roads or trees". */
function needWords(names: string[]): string {
  const words = names.map((name) => targetFor(name)?.name.toLowerCase() ?? name);
  return words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/** What the gallery needs from the editor. */
export interface GalleryHost {
  store: Store;
  shell: HTMLElement;
  /** Adds the layer (asking first when the table has one already), selects it and opens it. */
  add(manifest: LayerManifest, parent?: string): Promise<void>;
  /** Where map life goes: the layer that is open, or the map at rest (undefined). */
  lifeInto(): { id?: string; name: string };
  /** Opens Your place at the row that brings in `target`. */
  bringIn(target: string): void;
  addData(): void;
  newCustom(): void;
  /** Makes a custom layer from one of the table's datasets and opens it in the builder. */
  fromDataset(name: string): Promise<void>;
  /** The table's vector datasets, for From your data. */
  datasets(): { name: string; path: string }[];
  /** A dataset's shapes in table metres, to draw its card; null when it has none. */
  shapes(name: string): Promise<Shapes | null>;
  describe(shapes: Shapes): string;
  /** The table's size in metres. */
  extent(): { width: number; height: number };
}

const SVG = 'http://www.w3.org/2000/svg';

/**
 * A dataset drawn small, as it lies on the table: areas filled, lines stroked, points as dots.
 * At most a few thousand vertices, so a big file still draws at once.
 */
export function shapesThumbnail(shapes: Shapes, extent: { width: number; height: number }): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${extent.width} ${extent.height}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
  svg.setAttribute('class', 'lg-shapes');
  svg.setAttribute('aria-hidden', 'true');
  const unit = Math.max(extent.width, extent.height) / 240;
  const path = (d: string, cls: string) => {
    const node = document.createElementNS(SVG, 'path');
    node.setAttribute('d', d);
    node.setAttribute('class', cls);
    svg.append(node);
  };
  let budget = 6000;
  const ring = (points: readonly (readonly number[])[]) => {
    const step = Math.max(1, Math.ceil(points.length / 60));
    let d = '';
    for (let i = 0; i < points.length; i += step) {
      const p = points[i]!;
      d += `${i === 0 ? 'M' : 'L'}${p[0]!.toFixed(1)} ${p[1]!.toFixed(1)}`;
      budget--;
    }
    return d;
  };
  let areas = '';
  for (const area of shapes.areas) {
    if (budget <= 0) break;
    for (const polygon of area.polygons) areas += `${ring(polygon[0] ?? [])}Z`;
  }
  if (areas) path(areas, 'is-area');
  let lines = '';
  for (const line of shapes.paths) {
    if (budget <= 0) break;
    lines += ring(line.points);
  }
  if (lines) {
    path(lines, 'is-line');
    svg.lastElementChild!.setAttribute('stroke-width', String(unit * 1.2));
  }
  let dots = '';
  const r = unit * 2.2;
  for (const spot of shapes.spots.slice(0, 1500)) {
    const [x, y] = spot.point;
    dots += `M${(x - r).toFixed(1)} ${y.toFixed(1)}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
  }
  if (dots) path(dots, 'is-dot');
  return svg;
}

/** The picture on a card: the layer's preview (made by scripts/layer-previews.cjs), or its icon on a soft tile. */
function picture(id: string | null, iconName: string | undefined, tone: GallerySection, drawing?: Promise<SVGSVGElement | null>): HTMLElement {
  const box = el('span', `lg-picture is-${tone}`);
  void drawing?.then((svg) => {
    if (!svg) return;
    box.append(svg);
    box.classList.add('has-picture');
  });
  const fallback = el('span', 'lg-picture-icon');
  fallback.append(icon(iconName, 30));
  box.append(fallback);
  if (id) {
    const img = el('img');
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('load', () => box.classList.add('has-picture'));
    img.addEventListener('error', () => img.remove());
    img.src = `/previews/${id}.webp`;
    box.append(img);
  }
  return box;
}

interface Card {
  section: GallerySection;
  element: HTMLElement;
  words: string;
}

/**
 * Opens the gallery. `start` picks the section it opens at; by default the first. Picking a
 * card adds the layer and closes the gallery.
 */
export function openGallery(host: GalleryHost, start?: GallerySection): void {
  document.querySelector('.lg-gallery')?.remove();
  const { store } = host;
  const dialog = el('dialog', 'im-dialog lg-gallery');
  dialog.ariaLabel = 'New layer';
  const head = el('header', 'im-dialog-head lg-head');
  const title = el('h2', undefined, 'New layer');
  const search = el('input', 'lg-search');
  search.type = 'search';
  search.placeholder = 'Find a layer';
  search.ariaLabel = 'Find a layer';
  const close = el('button', 'ed-icon-button', '×');
  close.type = 'button';
  close.ariaLabel = 'Close';
  close.addEventListener('click', () => dialog.close());
  head.append(title, search, close);

  const nav = el('nav', 'lg-nav');
  nav.ariaLabel = 'Sections';
  const body = el('div', 'lg-body');
  const cards: Card[] = [];
  const sectionNodes = new Map<GallerySection, HTMLElement>();
  const navButtons = new Map<GallerySection, HTMLButtonElement>();

  const done = () => dialog.close();
  const card = (options: {
    section: GallerySection;
    title: string;
    about: string;
    preview: string | null;
    drawing?: Promise<SVGSVGElement | null>;
    small?: boolean;
    iconName?: string;
    tag?: string;
    need?: { text: string; action?: { label: string; run(): void } };
    onPick?: () => void | Promise<void>;
    layer?: string;
  }): HTMLElement => {
    const node = el('article', options.small ? 'lg-card is-small' : 'lg-card');
    if (options.layer) node.dataset.layer = options.layer;
    const pick = el('button', 'lg-pick');
    pick.type = 'button';
    pick.append(picture(options.preview, options.iconName, options.section, options.drawing));
    const words = el('span', 'lg-words');
    const name = el('strong', 'lg-name', options.title);
    if (options.tag) name.append(el('span', 'lg-tag', options.tag));
    words.append(name, el('span', 'lg-about', options.about));
    pick.append(words);
    node.append(pick);
    if (options.onPick) {
      pick.addEventListener('click', async () => {
        done();
        await options.onPick!();
      });
    } else pick.disabled = true;
    if (options.need) {
      const need = el('p', 'lg-need');
      need.append(icon('alert', 13), el('span', undefined, options.need.text));
      if (options.need.action) {
        const action = options.need.action;
        const go = el('button', 'lg-need-action', `${action.label} →`);
        go.type = 'button';
        go.addEventListener('click', () => {
          done();
          action.run();
        });
        need.append(go);
      }
      node.classList.add('is-needs');
      node.append(need);
    }
    cards.push({ section: options.section, element: node, words: `${options.title} ${options.about} ${options.tag ?? ''}`.toLowerCase() });
    return node;
  };

  const lists = new Map<GallerySection, HTMLElement>();
  for (const section of SECTIONS) {
    const part = el('section', 'lg-section');
    part.dataset.section = section.id;
    part.append(el('h3', 'lg-section-title', section.title), el('p', 'lg-section-about', section.about));
    const list = el('div', 'lg-cards');
    part.append(list);
    lists.set(section.id, list);
    sectionNodes.set(section.id, part);
    body.append(part);
    const to = el('button', 'lg-nav-item', section.title);
    to.type = 'button';
    to.addEventListener('click', () => {
      search.value = '';
      filter();
      part.scrollIntoView({ block: 'start', behavior: 'smooth' });
      mark(section.id);
    });
    navButtons.set(section.id, to);
    nav.append(to);
  }
  const mark = (id: GallerySection) => {
    for (const [key, b] of navButtons) b.setAttribute('aria-current', String(key === id));
  };

  // ---- From your data: a file first, then the core layers that show data (added below), then
  // a layer from each dataset of the table, drawn as it lies.
  const data = lists.get('data')!;
  data.append(
    card({
      section: 'data',
      title: 'Bring in a file',
      about: 'GeoJSON, CSV, a picture or a GeoTIFF, or data fetched from OpenStreetMap. Colour it as it comes in.',
      preview: null,
      iconName: 'plus',
      onPick: () => host.addData(),
    }),
  );
  const datasets = host.datasets();
  const own = el('div', 'lg-cards is-small');
  if (datasets.length > 0) {
    const part = sectionNodes.get('data')!;
    part.append(el('h4', 'lg-sub', 'Or start from a dataset of this table'), own);
  }
  for (const { name } of datasets) {
    const target = targetFor(name);
    const shapes = host.shapes(name);
    const title = target?.name ?? name.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
    const node = card({
      section: 'data',
      small: true,
      title,
      about: 'Reading…',
      preview: null,
      drawing: shapes.then((s) => (s ? shapesThumbnail(s, host.extent()) : null)),
      iconName: target?.icon ?? 'layers',
      onPick: () => host.fromDataset(name),
    });
    node.dataset.dataset = name;
    own.append(node);
    void shapes.then((s) => {
      const about = node.querySelector('.lg-about')!;
      if (!s) {
        // Not a map dataset (a slideshow list, a table without positions): not a layer of its own.
        node.remove();
        const entry = cards.find((c) => c.element === node);
        if (entry) cards.splice(cards.indexOf(entry), 1);
        return;
      }
      about.textContent = host.describe(s);
      const entry = cards.find((c) => c.element === node);
      if (entry) entry.words += ` ${about.textContent.toLowerCase()}`;
    });
  }

  // ---- Core layers and saved custom layers, each in its section.
  const offered = store.manifests.filter(isOffered).sort((a, b) => {
    const rank = (m: LayerManifest) => (ORDER.indexOf(m.id) + 1 || ORDER.length + 1);
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });
  const life = host.lifeInto();
  // Make your own starts with the builder, before the layers already made with it.
  lists.get('own')!.append(
    card({
      section: 'own',
      title: 'Custom layer',
      about: 'Choose data, then its look, motion and interaction, with the table showing it live. Test data to try it on is there too.',
      preview: null,
      iconName: 'brush',
      tag: 'Builder',
      onPick: () => host.newCustom(),
    }),
  );
  for (const manifest of offered) {
    // A base map is offered only to a table without one: it is where a removed one comes back (#382).
    if (manifest.category === 'base' && Object.values(store.state.layers).some((l) => l.layer === manifest.id)) continue;
    const section = sectionOf(manifest);
    const missing = missingData(store, manifest);
    const needs = missing.names.length > 0;
    const parent = section === 'life' ? life.id : undefined;
    lists.get(section)!.append(
      card({
        section,
        layer: manifest.id,
        title: manifest.name,
        about: manifest.description ?? '',
        preview: manifest.custom ? null : manifest.id,
        iconName: manifest.icon,
        tag: manifest.custom ? 'Yours' : undefined,
        need: needs
          ? {
              text: `Needs ${needWords(missing.names)}.`,
              action: missing.target ? { label: `Bring ${missing.names.length > 1 ? 'them' : 'it'} in`, run: () => host.bringIn(missing.target!) } : undefined,
            }
          : undefined,
        onPick: needs ? (missing.target ? () => host.bringIn(missing.target!) : undefined) : () => host.add(manifest, parent),
      }),
    );
  }
  sectionNodes.get('life')!.querySelector('.lg-section-about')!.textContent = `Always on, with no button. These go into ${life.name}.`;

  const empty = el('p', 'ed-empty lg-none', 'No layer matches. Try another word, or make your own.');
  empty.hidden = true;
  body.append(empty);
  const filter = () => {
    const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const c of cards) {
      const on = words.every((w) => c.words.includes(w));
      c.element.hidden = !on;
      if (on) shown++;
    }
    for (const [id, part] of sectionNodes) part.hidden = cards.every((c) => c.section !== id || c.element.hidden);
    empty.hidden = shown > 0;
  };
  search.addEventListener('input', filter);
  // The nav follows the scroll, so it always says where the author is.
  body.addEventListener('scroll', () => {
    const top = body.getBoundingClientRect().top;
    let current: GallerySection = 'data';
    for (const [id, part] of sectionNodes) if (!part.hidden && part.getBoundingClientRect().top - top < 80) current = id;
    mark(current);
  });

  const frame = el('div', 'lg-frame');
  frame.append(nav, body);
  dialog.append(head, frame);
  dialog.addEventListener('close', () => dialog.remove());
  host.shell.append(dialog);
  dialog.showModal();
  const first = start ?? 'data';
  mark(first);
  if (start) sectionNodes.get(start)?.scrollIntoView({ block: 'start' });
  search.focus();
}
