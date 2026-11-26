import { setting } from './settings-list.ts';
import { THEMES } from '@mrstudio/dashboard';
import type { LayerManifest, LayerState } from '@mrstudio/sdk';
import { el } from '../controls.ts';
import type { Store } from '../store.ts';
import { icon } from './icons.ts';
import { FetchAll } from './fetch-all.ts';
import { Importer, TARGETS, targetFor } from './importer.ts';
import { ModelImporter } from './model-import.ts';
import { type Detail, detailOf, ScaleFields } from './place-scale.ts';
import { PlaceMap } from './place-map.ts';
import type { Placement } from './place-map.ts';
import { parsePlace } from './place.ts';
import { STARTERS } from './starters.ts';
import type { Starter } from './starters.ts';

/** What the wizard needs from the editor around it. */
export interface WizardHost {
  store: Store;
  /** A request to the host; resolves to null when it is refused. */
  send(method: string, params: object): Promise<any>;
  /** Adds a layer to the scene, in the place its kind belongs. */
  add(manifest: LayerManifest): Promise<string | null>;
  /** Shows one layer on the map and closes the others; null shows the map at rest. */
  show(id: string | null): void;
  /** Puts the live controller in the middle of the window instead of the map. */
  controller(shown: boolean): void;
  present(): void;
  close(): void;
  /** Called before the table is moved, so the guide comes back at `step` once every surface has reloaded. */
  resumeAt(step: number): void;
  /** Holds back the reload that a change of site causes, until released. */
  hold(on: boolean): void;
  /** For a panel: takes the author to the place to bring in `target`, outside the panel. */
  bringIn?(target: string): void;
}

/** One name for the table when no layer is open, used everywhere in the editor and the guide. */
export const AT_REST = 'At rest';

/** Three steps to a working table (#390), like PowerPoint's new-presentation screen. Then the editor. */
export const WIZARD_STEPS = ['Name and place', 'Data', 'Start from…'] as const;
export const WHERE = 0;
const PLACE = 1;
export const START = 2;

/** Degrees as a bearing from 0 up to 360, so -93 and 267 are the same turn. */
const turn = (degrees: number) => ((degrees % 360) + 360) % 360;

/** How a dataset a layer needs is named to an author. */
function dataName(dataset: string): string {
  const known = targetFor(dataset);
  return known ? `${known.name.toLowerCase()} data` : `${dataset} data`;
}

/**
 * The list of steps down the side of the wizard. Steps before `current` are ticked, except those
 * in `unfinished`: passed, but with nothing in them yet (#581).
 */
export function stepList(names: readonly string[], current: number, go?: (index: number) => void, unfinished: readonly number[] = []): HTMLElement {
  const list = el('ol', 'wz-steps');
  names.forEach((name, index) => {
    const item = el('li', 'wz-step');
    const press = el('button', undefined);
    press.type = 'button';
    const dot = el('span', 'wz-dot');
    if (index < current && !unfinished.includes(index)) dot.append(icon('check', 12));
    else dot.textContent = String(index + 1);
    if (index < current && unfinished.includes(index)) item.classList.add('is-unfinished');
    press.append(dot, el('span', undefined, name));
    if (index === current) press.setAttribute('aria-current', 'step');
    press.disabled = !go;
    if (go) press.addEventListener('click', () => go(index));
    item.append(press);
    list.append(item);
  });
  return list;
}

/** A theme drawn small (#126): its background, a filled, outlined, frosted or bare panel, its accent and data colours. */
export function themeSwatch(theme: (typeof THEMES)[number]): HTMLElement {
  const t = theme.tokens;
  const swatch = el('span', 'wz-theme-swatch');
  swatch.style.background = t['color.background']!;
  const panel = el('span', 'wz-theme-panel');
  const surface = t['density'] === 'minimal' ? 'none' : (t['panel.style'] ?? 'filled');
  panel.dataset.surface = surface;
  panel.style.background = surface === 'filled' ? t['color.panel']! : surface === 'glass' ? `color-mix(in srgb, ${t['color.panel']} 55%, transparent)` : 'transparent';
  panel.style.borderColor = surface === 'none' ? 'transparent' : surface === 'glass' ? `color-mix(in srgb, ${t['color.text']} 18%, transparent)` : t['color.line']!;
  if (surface === 'glass') swatch.style.background = `radial-gradient(90% 120% at 15% 0%, color-mix(in srgb, ${t['color.accent']} 35%, transparent), transparent 70%), ${t['color.background']}`;
  const accent = el('span', 'wz-theme-accent');
  accent.style.background = t['color.accent']!;
  const data = el('span', 'wz-theme-data');
  for (const n of [1, 2, 3, 4]) {
    const dot = el('i');
    dot.style.background = t[`data.${n}`]!;
    data.append(dot);
  }
  const line = el('span', 'wz-theme-line');
  line.style.background = t['color.text']!;
  panel.append(line, accent, data);
  swatch.append(panel);
  return swatch;
}

/** The `site.tv` change that picks a theme. The first is the core default, so choosing it clears the site's theme. */
export function themeChoice(index: number): { tv: object } {
  const theme = THEMES[index]!;
  return { tv: index === 0 ? { theme: null, theme_name: null } : { theme: theme.tokens, theme_name: theme.id } };
}

/** The theme a site uses, or null for a theme written by hand. */
export function chosenTheme(tv: { theme?: unknown; theme_name?: string | null } | null | undefined): string | null {
  return tv?.theme_name ?? (tv?.theme ? null : THEMES[0]!.id);
}

/**
 * The setup wizard: the guided way through a new table. It works on the live scene
 * with the same requests as the rest of the editor, so it can be opened again at
 * any time and always shows the table as it is.
 */
export class Wizard {
  readonly element = el('aside', 'wz');
  step: number;
  /** One importer per row of "Your place", kept across redraws so a file being checked stays. */
  private importers = new Map<string, Importer>();
  private model: ModelImporter | null = null;
  /** "Fetch everything from open data" (#310), made once so a fetch under way stays. */
  private fetchAll: FetchAll | null = null;
  private readonly host: WizardHost;
  /** The row of "Your place" that a layer needing data sent the author to. */
  private wanted: string | null = null;
  /** The "Name and place" form as the author left it, kept across redraws. */
  private where: { name: string; centre: string; width: string; height: string; rotation: string; table: string; tile: string; detail: Detail } | null = null;
  private scaleFields: ScaleFields | null = null;
  /** The map in "Name and place", made once: it keeps its view across redraws. */
  private placeMap: PlaceMap | null = null;
  /** The tile grid's step in metres of ground, for the place map; null for none. */
  private tileM: number | null = null;
  private moving = false;
  private problem = '';
  /**
   * One step on its own, as a panel beside the map under a ribbon tab (#311, #312, #313):
   * the same questions and the same requests, without the list of steps or Back and Next.
   */
  private readonly panel: boolean;
  /** A panel only draws while its tab is open, so a closed one never moves the map. */
  private shown = true;

  constructor(host: WizardHost, options: { created?: boolean; step?: number; panel?: boolean } = {}) {
    this.host = host;
    this.panel = options.panel ?? false;
    // Someone who has just named and placed the table goes on to what it is made of.
    this.step = options.step ?? (options.created ? PLACE : WHERE);
    if (this.panel) {
      this.element.classList.add('is-panel');
      this.element.classList.toggle('is-place', this.step === WHERE);
      this.shown = false;
    }
    host.store.onScene(() => this.render());
    host.store.onTv(() => this.shown && this.step === START && this.render());
    this.render();
  }

  /** Opens or closes a panel. Opening shows the map the way its step does. */
  setShown(shown: boolean): void {
    if (!this.panel || shown === this.shown) return;
    this.shown = shown;
    if (!shown) return;
    this.problem = '';
    this.render(true);
  }

  /** Whether the Name and place panel holds a change that has not moved the table yet. */
  get pending(): boolean {
    return this.step === WHERE && this.placeChanged();
  }

  /** Moves the table to the place the Name and place panel describes. */
  moveTable(): void {
    if (this.pending && !this.moving) void this.move(WHERE);
  }

  /** Forgets the edits in Name and place, back to where the table is. */
  putBack(): void {
    this.where = null;
    this.problem = '';
    this.placeMap?.set(this.placement());
    this.render();
    this.onPending();
  }

  /** Told when the Name and place panel gains or loses a change, so the ribbon can follow. */
  onPending: () => void = () => {};

  private go(step: number): void {
    const next = Math.max(0, Math.min(WIZARD_STEPS.length - 1, step));
    // Leaving "Name and place" with a change moves the table first; the guide comes back at the step asked for.
    if (this.step === WHERE && next !== WHERE && this.placeChanged()) {
      void this.move(next);
      return;
    }
    this.step = next;
    this.problem = '';
    if (next !== PLACE) {
      this.wanted = null;
      this.returnTo = null;
      try {
        sessionStorage.removeItem('mrs-setup-return');
      } catch {
        // As above.
      }
    }
    this.render();
  }

  private instances(): { id: string; manifest: LayerManifest; state: LayerState }[] {
    const { store } = this.host;
    const list = [];
    for (const id of [...store.state.scene].reverse()) {
      const state = store.state.layers[id];
      const manifest = state && store.manifest(state.layer);
      // The guide works with the table's own layers; a layer's items are edited in the editor.
      if (manifest && !state.parent) list.push({ id, manifest, state });
    }
    return list;
  }


  private render(opening = false): void {
    if (!this.shown) return;
    const { host } = this;
    // A panel moves the map only when its tab opens, not every time the scene changes under it.
    const real = { show: (id: string | null) => void ((!this.panel || opening) && host.show(id)) };
    const body = el('div', 'wz-body');
    const title = (text: string, lead: string) => body.append(el('h2', undefined, text), el('p', 'wz-lead', lead));
    if (this.step === WHERE) {
      real.show(null);
      title('Name and place', 'What the table is called, where it is and how much ground it covers. Moving the table keeps the data you brought in; whatever lies inside the new outline is shown.');
      body.append(this.whereForm());
      if (this.panel) body.append(this.moveNotes());
    } else if (this.step === PLACE) {
      host.show(null);
      title('Data', 'What the table is made of. Fetch the open data for the whole place in one go, or bring in your own files: they are copied into the table and stay on this computer. Buildings matter most; the rest can come later.');
      if (!this.fetchAll) this.fetchAll = new FetchAll({ site: () => this.host.store.state.site, hold: (on) => this.host.hold(on) });
      else this.fetchAll.render();
      body.append(this.fetchAll.element);
      for (const item of TARGETS) {
        body.append(this.importer(item.target).element);
        // The 3D model sits under the buildings: it gives them their heights.
        if (item.target === 'buildings') body.append(this.modelRow().element);
      }
      if (this.returnTo !== null && this.returnTo !== PLACE) {
        const to = this.returnTo;
        const back = el('button', 'ed-button', `Back to ${WIZARD_STEPS[to]}`);
        back.type = 'button';
        back.addEventListener('click', () => this.go(to));
        const line = el('p', 'wz-hint wz-return', 'When the file is in, go back to where you were.');
        line.append(back);
        body.append(line);
      }
      const wanted = this.wanted && body.querySelector<HTMLElement>(`.wz-place[data-target="${this.wanted}"]`);
      if (wanted) {
        wanted.classList.add('is-wanted');
        requestAnimationFrame(() => wanted.scrollIntoView({ block: 'nearest' }));
      }
    } else {
      real.show(null);
      title('Start from…', 'Pick a starting point. Each one adds its layers, a little life on the map at rest and a controller theme. Everything can be changed in the editor afterwards.');
      body.append(this.starters());
      const leftOut = this.leftOutNote();
      if (leftOut) body.append(leftOut);
    }

    if (this.panel) {
      const parts: HTMLElement[] = [body];
      if (this.step === WHERE) {
        const foot = el('footer', 'wz-foot');
        const back = el('button', 'ed-button', 'Put back');
        back.type = 'button';
        back.title = 'Forget these changes and show where the table is now';
        back.disabled = !this.placeChanged() || this.moving;
        back.addEventListener('click', () => this.putBack());
        const move = el('button', 'ed-button is-primary', 'Move the table');
        move.type = 'button';
        move.disabled = !this.placeChanged() || this.moving;
        move.addEventListener('click', () => this.moveTable());
        foot.append(back, move);
        parts.push(foot);
      }
      this.element.replaceChildren(...parts);
      return;
    }

    const foot = el('footer', 'wz-foot');
    const back = el('button', 'ed-button', 'Back');
    back.type = 'button';
    back.disabled = this.step === WHERE || this.moving;
    back.addEventListener('click', () => this.go(this.step - 1));
    const skip = el('button', 'wz-skip', 'Skip the guide');
    skip.type = 'button';
    skip.addEventListener('click', () => host.close());
    foot.append(back, skip);
    if (this.step < WIZARD_STEPS.length - 1) {
      const next = el('button', 'ed-button is-primary', this.step === WHERE && this.placeChanged() ? 'Move the table' : 'Next');
      next.type = 'button';
      next.disabled = this.moving;
      next.addEventListener('click', () => this.go(this.step + 1));
      foot.append(next);
    } else {
      // The last step hands over to the editor, where Present › Ready to present? says what is left.
      const done = el('button', 'ed-button is-primary', 'Open the editor');
      done.type = 'button';
      done.disabled = this.starting;
      done.addEventListener('click', () => host.close());
      foot.append(done);
    }

    const head = el('header', 'wz-head');
    // Data is ticked only when something more than the ground came in (#581): with every OpenStreetMap
    // fetch failed, the map is empty and the step is not done.
    const data = Object.keys(this.host.store.state.site.data ?? {}).filter((name) => !targetFor(name)?.elevation);
    head.append(stepList(WIZARD_STEPS, this.step, (index) => this.go(index), data.length ? [] : [PLACE]));
    // Typing in a field must survive a redraw caused by someone else's change.
    this.element.replaceChildren(head, body, foot);
  }

  /** The importer for one row of "Your place", made once and redrawn with the table. */
  private importer(target: string): Importer {
    let importer = this.importers.get(target);
    if (!importer) {
      importer = new Importer({ site: () => this.host.store.state.site, hold: (on) => this.host.hold(on) }, target);
      this.importers.set(target, importer);
    } else importer.render();
    importer.element.classList.remove('is-wanted');
    return importer;
  }

  /** The "3D model" row of "Your place" (#56), made once and redrawn with the table. */
  private modelRow(): ModelImporter {
    if (!this.model) this.model = new ModelImporter({ site: () => this.host.store.state.site });
    else this.model.render();
    return this.model;
  }

  /** Opens "Your place" at one row. After the file is in, Next returns to `from`. */
  bringIn(target: string, from = this.step): void {
    this.returnTo = from === PLACE ? null : from;
    try {
      if (this.returnTo === null) sessionStorage.removeItem('mrs-setup-return');
      else sessionStorage.setItem('mrs-setup-return', String(this.returnTo));
    } catch {
      // No session storage: the way back is lost after a reload, and Next still goes on.
    }
    this.step = PLACE;
    this.wanted = target;
    this.render();
  }

  /** The step a "Bring in" came from, offered again once the file is in. */
  private returnTo: number | null = (() => {
    try {
      const kept = sessionStorage.getItem('mrs-setup-return');
      return kept === null ? null : Number(kept);
    } catch {
      return null;
    }
  })();

  /** The site's name and place as the form would write them. */
  private placeValues(): { name: string; centre: string; width: string; height: string; rotation: string; table: string; tile: string; detail: Detail } {
    const { site } = this.host.store.state;
    return (
      this.where ?? {
        name: site.name,
        centre: `${site.origin.lat.toFixed(5)}, ${site.origin.lon.toFixed(5)}`,
        width: String(Math.round(site.extent.width_m)),
        height: String(Math.round(site.extent.height_m)),
        rotation: String(Math.round(site.extent.rotation_deg ?? 0)),
        table: String(site.table?.width_cm ?? 100),
        tile: String(site.table?.tile_cm ?? ''),
        detail: detailOf(site.extent.width_m, site.extent.height_m, site.grid.cell_m),
      }
    );
  }

  private placeChanged(): boolean {
    if (!this.where) return false;
    const { site } = this.host.store.state;
    const at = parsePlace(this.where.centre);
    return (
      this.where.name.trim() !== site.name ||
      !at ||
      Math.abs(at.lat - site.origin.lat) > 1e-6 ||
      Math.abs(at.lon - site.origin.lon) > 1e-6 ||
      Number(this.where.width) !== Math.round(site.extent.width_m) ||
      Number(this.where.height) !== Math.round(site.extent.height_m) ||
      turn(Number(this.where.rotation)) !== turn(Math.round(site.extent.rotation_deg ?? 0)) ||
      Number(this.where.table) !== (site.table?.width_cm ?? 100) ||
      Number(this.where.tile || 0) !== (site.table?.tile_cm ?? 0) ||
      this.where.detail !== detailOf(site.extent.width_m, site.extent.height_m, site.grid.cell_m)
    );
  }

  /** "Name and place" for a table that exists: the same questions as the new-table page, written to the site when the author moves on. */
  private whereForm(): HTMLElement {
    const values = this.placeValues();
    const form = el('div', 'wz-form');
    const field = (label: string, input: HTMLElement, hint?: string) => {
      const row = el('label', 'wz-field');
      row.append(el('span', undefined, label), input);
      if (hint) row.append(el('small', undefined, hint));
      return row;
    };
    const input = (key: keyof typeof values, attributes: object) => {
      const node = el('input');
      Object.assign(node, attributes, { value: values[key] });
      node.name = key;
      node.addEventListener('input', () => {
        this.where = { ...this.placeValues(), [key]: node.value };
        this.problem = '';
        this.placeMap?.set(this.placement());
        this.scaleFields?.refresh();
        this.nextWords();
      });
      return node;
    };
    // The physical table and the model scale: the ground and the table follow each other at the scale.
    this.scaleFields = new ScaleFields(
      () => {
        const v = this.placeValues();
        return { width_m: Number(v.width), height_m: Number(v.height), table_cm: Number(v.table), tile_cm: v.tile ? Number(v.tile) : null, detail: v.detail };
      },
      (ground) => {
        this.where = { ...this.placeValues(), width: String(ground.width_m), height: String(ground.height_m), table: String(ground.table_cm), tile: ground.tile_cm ? String(ground.tile_cm) : '', detail: ground.detail ?? this.placeValues().detail };
        for (const key of ['width', 'height'] as const) {
          const field = this.element.querySelector<HTMLInputElement>(`.wz-form input[name="${key}"]`);
          if (field) field.value = this.where[key];
        }
        this.problem = '';
        this.placeMap?.set(this.placement());
        this.nextWords();
      },
      (tile_m) => {
        this.tileM = tile_m;
        this.placeMap?.tiles(tile_m);
      },
    );
    // The map comes right after the centre, so the place is seen before it is fine-tuned.
    const mapSlot = el('div', 'wz-map-slot');
    const size = el('div', 'wz-pair');
    size.append(
      field('Width, metres', input('width', { type: 'number', min: '100', max: '20000', step: '50' })),
      field('Height, metres', input('height', { type: 'number', min: '100', max: '20000', step: '50' })),
    );
    // The same form is the guide's first step and Design › Table size and place… (rule 9): one home for these settings.
    form.append(
      field('Name', setting('table.name', 'dialog:place', input('name', { type: 'text', maxLength: 60 }))),
      field('Centre of the table', setting('table.place', 'dialog:place', input('centre', { type: 'text', placeholder: '57.6898, 11.9742' })), 'Paste coordinates, or a link copied from Google Maps or OpenStreetMap.'),
      setting('table.place', 'dialog:place', mapSlot),
      setting('table.size', 'dialog:place', this.scaleFields.element),
      setting('table.place', 'dialog:place', size),
      field('Turned', setting('table.place', 'dialog:place', input('rotation', { type: 'number', min: '-180', max: '360', step: '1' })), 'Turns the map under the table, in degrees clockwise from north. 0 puts north at the top. The table itself stays as it stands.'),
    );
    // The table on a map: click or drag to move it, drag the corner to scale it, the top handle to turn it.
    if (!this.placeMap) {
      const buildings = this.host.store.state.site.data?.buildings;
      this.placeMap = new PlaceMap(this.placement(), (place) => {
        const values = this.placeValues();
        this.where = {
          ...values,
          centre: `${place.lat.toFixed(5)}, ${place.lon.toFixed(5)}`,
          width: String(place.width_m),
          height: String(place.height_m),
          rotation: String(place.rotation_deg),
        };
        this.scaleFields?.refresh();
        for (const key of ['centre', 'width', 'height', 'rotation'] as const) {
          const field = this.element.querySelector<HTMLInputElement>(`.wz-form input[name="${key}"]`);
          if (field) field.value = this.where[key];
        }
        this.problem = '';
        this.nextWords();
      }, { data: buildings ? `/site/${buildings}` : undefined });
    }
    this.placeMap.tiles(this.tileM);
    mapSlot.append(this.placeMap.element, el('p', 'wz-hint', 'Click the map or drag the middle to move the table, and drag its corner to cover more or less ground. Turn the map with the right mouse button, Ctrl and drag, or the arrows; the table stays upright, as it stands in the room.'));
    if (this.moving) form.append(el('p', 'wz-hint', 'Moving the table and rebuilding what it shows…'));
    if (this.problem) {
      const problem = el('p', 'wz-problem', this.problem);
      problem.setAttribute('role', 'alert');
      form.append(problem);
    }
    return form;
  }

  /**
   * What moving the table does, said before it happens (#313). Nothing is fetched again by
   * itself: the files brought in stay as they are, and the layers stay on the table.
   */
  private moveNotes(): HTMLElement {
    const box = el('section', 'wz-notes');
    box.append(el('h3', undefined, 'When the table moves'));
    const data = Object.keys(this.host.store.state.site.data ?? {});
    const names = data.map((name) => targetFor(name)?.name.toLowerCase() ?? name.replace(/[_-]/g, ' '));
    const list = el('ul', 'wz-facts');
    list.append(
      el('li', undefined, data.length ? `The data you brought in stays: ${names.join(', ')}. Whatever of it lies inside the new outline is shown.` : 'This table has no data yet.'),
      el('li', undefined, 'Every layer and its settings stay. Layers that work things out from the place, such as the sun, do it again for the new one.'),
      el('li', undefined, 'Map pictures, such as the base map, are fetched again for the new outline when the internet is there.'),
      el('li', undefined, 'If the new outline goes past what your files cover, bring them in again under Your place. OpenStreetMap data can be fetched again there in one click.'),
      el('li', undefined, 'Undo puts the table back where it was.'),
    );
    box.append(list);
    return box;
  }

  /** The placement the form describes, or null while the centre cannot be read. */
  private placement(): Placement | null {
    const values = this.placeValues();
    const at = parsePlace(values.centre);
    const [width_m, height_m, rotation_deg] = [Number(values.width), Number(values.height), Number(values.rotation)];
    if (!at || !(width_m > 0 && height_m > 0) || !Number.isFinite(rotation_deg)) return null;
    return { ...at, width_m, height_m, rotation_deg: ((rotation_deg % 360) + 360) % 360 };
  }

  /** Only the footer's words change while the place is edited, so a field keeps its focus. */
  private nextWords(): void {
    const changed = this.placeChanged();
    if (this.panel) {
      for (const button of this.element.querySelectorAll<HTMLButtonElement>('.wz-foot button')) button.disabled = !changed || this.moving;
      this.onPending();
      return;
    }
    const next = this.element.querySelector<HTMLButtonElement>('.wz-foot .is-primary');
    if (next) next.textContent = changed ? 'Move the table' : 'Next';
  }

  /** Writes the new name and place, then carries on at `next` once every surface has reloaded. */
  private async move(next: number): Promise<void> {
    const values = this.placeValues();
    const at = parsePlace(values.centre);
    const [width_m, height_m, rotation_deg] = [Number(values.width), Number(values.height), Number(values.rotation)];
    const say = (text: string) => {
      this.problem = text;
      this.render();
    };
    if (!values.name.trim()) return say('Give the table a name.');
    if (!at) return say('Paste the coordinates of the centre of the table, for example 57.6898, 11.9742.');
    if (!(width_m >= 100 && height_m >= 100 && width_m <= 20000 && height_m <= 20000)) return say('The width and the height must each be between 100 and 20 000 metres.');
    if (!Number.isFinite(rotation_deg)) return say('Turned is a number of degrees, such as 0 or 30.');
    const tiles = this.scaleFields?.problem();
    if (tiles) return say(tiles);
    this.moving = true;
    say('');
    this.host.resumeAt(next);
    // The detail goes only when it was changed, so a cell set by hand survives a new name.
    const now = this.host.store.state.site;
    const was = detailOf(now.extent.width_m, now.extent.height_m, now.grid.cell_m);
    try {
      const response = await fetch('/api/site/place', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: values.name.trim(), origin: { lat: at.lat, lon: at.lon }, extent: { width_m, height_m, rotation_deg }, table_width_cm: Number(values.table), tile_cm: values.tile ? Number(values.tile) : 0, ...(values.detail !== was ? { detail: values.detail } : {}) }),
      });
      if (!response.ok) {
        const answer = await response.json().catch(() => null);
        throw new Error(answer?.error ?? `The table refused the change (${response.status}).`);
      }
      // The host tells every surface the site changed; the editor reloads into `next`.
    } catch (error) {
      this.host.resumeAt(-1);
      this.moving = false;
      say(`The table could not be moved: ${(error as Error).message}`);
    }
  }


  /** The starter picked in this guide, and the layers it added, so another pick replaces them. */
  private chosen: string | null = null;
  private addedByStarter: string[] = [];
  private starting = false;
  /** The picked starter's layers that could not be put on the table, with what they need (#581). */
  private leftOut: { name: string; needs: string[] }[] = [];

  /** Start from… (#390): a card per starter table. Picking one sets its layers, map life and theme. */
  private starters(): HTMLElement {
    const { host } = this;
    const list = el('div', 'wz-starters');
    list.setAttribute('role', 'radiogroup');
    list.setAttribute('aria-label', 'Start from');
    const data = host.store.state.site.data ?? {};
    for (const starter of STARTERS) {
      const card = el('button', 'wz-starter');
      card.type = 'button';
      card.dataset.starter = starter.id;
      card.setAttribute('role', 'radio');
      card.setAttribute('aria-checked', String(this.chosen === starter.id));
      card.disabled = this.starting;
      const theme = THEMES.find((t) => t.id === starter.theme) ?? THEMES[0]!;
      const badge = el('span', 'wz-badge');
      badge.append(icon(starter.icon, 20));
      const head = el('span', 'wz-starter-head');
      head.append(badge, el('strong', undefined, starter.name));
      const names = (ids: string[]) => ids.map((id) => host.store.manifest(id)?.name).filter((n): n is string => Boolean(n));
      const parts = el('ul', 'wz-starter-parts');
      const buttons = names(starter.layers);
      const life = names(starter.rest);
      parts.append(el('li', undefined, buttons.length ? `Buttons: ${buttons.join(', ')}` : 'No buttons yet'));
      if (life.length) parts.append(el('li', undefined, `At rest: ${life.join(', ')}`));
      parts.append(el('li', undefined, `Theme: ${theme.name}`));
      // A layer without its data shows little or nothing; the card says so before it is picked.
      const lacking = [...starter.rest, ...starter.layers].flatMap((id) => host.store.manifest(id)?.requires?.data ?? []).filter((d, i, all) => !(d in data) && all.indexOf(d) === i);
      if (lacking.length) parts.append(el('li', 'wz-starter-lacking', `Needs ${lacking.map(dataName).join(', ')} to show everything`));
      card.append(head, el('p', undefined, starter.about), parts, themeSwatch(theme));
      card.addEventListener('click', () => void this.start(starter));
      list.append(card);
    }
    return list;
  }

  /** What the picked starter could not add, said under the cards, so nothing goes missing quietly (#581). */
  private leftOutNote(): HTMLElement | null {
    if (!this.leftOut.length) return null;
    const starter = STARTERS.find((s) => s.id === this.chosen);
    const note = el('div', 'wz-left-out');
    note.setAttribute('role', 'status');
    note.append(el('strong', undefined, `Left out of ${starter?.name ?? 'the starter'}`));
    const list = el('ul', 'wz-facts');
    for (const { name, needs } of this.leftOut) list.append(el('li', undefined, needs.length ? `${name}: needs ${needs.map(dataName).join(' and ')}` : `${name}: could not be added`));
    const back = el('button', 'ed-button', 'Fetch data');
    back.type = 'button';
    back.addEventListener('click', () => this.go(PLACE));
    note.append(list, el('p', 'wz-hint', 'Fetch what is missing on the Data step, then pick the starter again to add these.'), back);
    return note;
  }

  /** Puts a starter on the table: what an earlier pick added goes, the author's own layers stay. */
  private async start(starter: Starter): Promise<void> {
    if (this.starting || (this.chosen === starter.id && !this.leftOut.length)) return;
    const { host } = this;
    this.starting = true;
    this.render();
    try {
      for (const id of this.addedByStarter) await host.send('scene.remove', { layer: id });
      this.addedByStarter = [];
      const have = new Set(this.instances().map((i) => i.manifest.id));
      const data = host.store.state.site.data ?? {};
      this.leftOut = [];
      for (const pkg of [...starter.rest, ...starter.layers]) {
        const manifest = host.store.manifest(pkg);
        if (!manifest || have.has(pkg)) continue;
        const id = await host.add(manifest);
        if (id) this.addedByStarter.push(id);
        else this.leftOut.push({ name: manifest.name, needs: (manifest.requires?.data ?? []).filter((d) => !(d in data)) });
      }
      const index = THEMES.findIndex((t) => t.id === starter.theme);
      await host.send('site.tv', themeChoice(Math.max(0, index)));
      this.chosen = starter.id;
    } finally {
      this.starting = false;
      this.render();
    }
  }

}
