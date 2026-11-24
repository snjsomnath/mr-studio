import { THEMES } from '@mrstudio/dashboard';
import type { LayerManifest, LayerState, SelectControl } from '@mrstudio/sdk';
import { defaultSideOf, el, isAmbient, isOffered, layerButton } from '../controls.ts';
import type { Store } from '../store.ts';
import { icon } from './icons.ts';
import { Importer, TARGETS, targetFor } from './importer.ts';
import { ModelImporter } from './model-import.ts';
import { ScaleFields } from './place-scale.ts';
import { PlaceMap } from './place-map.ts';
import type { Placement } from './place-map.ts';
import { parsePlace } from './place.ts';

/** What the wizard needs from the editor around it. */
export interface WizardHost {
  store: Store;
  /** A request to the host; resolves to null when it is refused. */
  send(method: string, params: object): Promise<any>;
  /** Adds a layer to the scene, in the place its kind belongs. */
  add(manifest: LayerManifest): Promise<void>;
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

export const WIZARD_STEPS = ['Name and place', 'Your place', AT_REST, 'Layers', 'Buttons', 'Ready'] as const;
export const WHERE = 0;
const PLACE = 1;
export const REST = 2;
const LAYERS = 3;
export const BUTTONS = 4;

/** Degrees as a bearing from 0 up to 360, so -93 and 267 are the same turn. */
const turn = (degrees: number) => ((degrees % 360) + 360) % 360;

/** How a dataset a layer needs is named to an author. */
function dataName(dataset: string): string {
  const known = targetFor(dataset);
  return known ? `${known.name.toLowerCase()} data` : `${dataset} data`;
}

/** The list of steps down the side of the wizard. `done` steps before `current` are ticked. */
export function stepList(names: readonly string[], current: number, go?: (index: number) => void): HTMLElement {
  const list = el('ol', 'wz-steps');
  names.forEach((name, index) => {
    const item = el('li', 'wz-step');
    const press = el('button', undefined);
    press.type = 'button';
    const dot = el('span', 'wz-dot');
    if (index < current) dot.append(icon('check', 12));
    else dot.textContent = String(index + 1);
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
  private readonly host: WizardHost;
  /** The row of "Your place" that a layer needing data sent the author to. */
  private wanted: string | null = null;
  /** The "Name and place" form as the author left it, kept across redraws. */
  private where: { name: string; centre: string; width: string; height: string; rotation: string; table: string; tile: string } | null = null;
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
    host.store.onLayer(() => this.shown && (this.step === BUTTONS || this.step === REST) && this.syncButtons());
    host.store.onTv(() => this.shown && this.step === BUTTONS && this.syncLook());
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

  /**
   * The controller's look (#126): a built-in theme, shown as swatch cards, and the rail style.
   * A pick is saved to site.json and every screen, the live preview too, restyles at once.
   */
  private lookPicker(): HTMLElement {
    const { host } = this;
    const box = el('section', 'wz-look');
    box.append(el('h3', undefined, 'Look'));
    const themes = el('div', 'wz-themes');
    themes.setAttribute('role', 'radiogroup');
    themes.setAttribute('aria-label', 'Controller theme');
    const cards = THEMES.map((theme, index) => {
      const card = el('button', 'wz-theme');
      card.type = 'button';
      card.setAttribute('role', 'radio');
      card.title = theme.description;
      card.append(themeSwatch(theme), el('span', 'wz-theme-name', theme.name));
      card.addEventListener('click', () => void host.send('site.tv', themeChoice(index)));
      themes.append(card);
      return [theme.id, card] as const;
    });
    const style = el('div', 'segmented');
    style.setAttribute('role', 'radiogroup');
    style.setAttribute('aria-label', 'Button style');
    const styles = (['icons', 'labelled'] as const).map((value) => {
      const option = el('button', undefined, value === 'icons' ? 'Icons' : 'Icons and names');
      option.type = 'button';
      option.setAttribute('role', 'radio');
      option.addEventListener('click', () => void host.send('site.tv', { tv: { rail_style: value === 'icons' ? null : value } }));
      style.append(option);
      return [value, option] as const;
    });
    const row = el('div', 'wz-look-row');
    row.append(el('span', 'wz-hint', 'Buttons'), style);
    box.append(themes, row);
    const sync = () => {
      const tv = host.store.state.site.tv;
      // A theme written by hand, not one of these, leaves every card unticked.
      const chosen = chosenTheme(tv);
      for (const [id, card] of cards) card.setAttribute('aria-checked', String(id === chosen));
      for (const [value, option] of styles) option.setAttribute('aria-checked', String(value === (tv?.rail_style ?? 'icons')));
    };
    sync();
    this.syncLook = sync;
    return box;
  }

  private syncLook: () => void = () => {};

  private syncButtons: () => void = () => {};
  /** The layer package just switched on, shown on the map as soon as the scene has it. */
  private fresh: string | null = null;

  private render(opening = false): void {
    if (!this.shown) return;
    const { host } = this;
    // A panel moves the map only when its tab opens, not every time the scene changes under it.
    const real = { show: (id: string | null) => void ((!this.panel || opening) && host.show(id)) };
    const body = el('div', 'wz-body');
    const title = (text: string, lead: string) => body.append(el('h2', undefined, text), el('p', 'wz-lead', lead));
    const instances = this.instances();
    const layers = instances.filter((i) => !isAmbient(i.manifest));
    this.syncButtons = () => {};
    if (!this.panel) host.controller(this.step === BUTTONS);

    if (this.step === WHERE) {
      real.show(null);
      title('Name and place', 'What the table is called, where it is and how much ground it covers. Moving the table keeps the data you brought in; whatever lies inside the new outline is shown.');
      body.append(this.whereForm());
      if (this.panel) body.append(this.moveNotes());
    } else if (this.step === PLACE) {
      host.show(null);
      title('Your place', 'Bring in the files your table is made from. They are copied into the table and stay on this computer. Buildings matter most; the rest can come later.');
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
    } else if (this.step === REST) {
      real.show(null);
      title(AT_REST, 'What the map shows when no layer is open, and nobody is using the table. Pick a base map and some life to make it feel like a place.');
      body.append(this.choices(host.store.manifests.filter((m) => isAmbient(m) && isOffered(m)), instances, false));
      this.syncButtons();
    } else if (this.step === LAYERS) {
      title('Layers', 'Each layer answers one question, such as where the sun falls. Every layer you pick becomes a button on the controller.');
      body.append(this.choices(host.store.manifests.filter((m) => !isAmbient(m) && (isOffered(m) || instances.some((i) => i.manifest.id === m.id))), instances, true));
      const added = layers.find((i) => i.manifest.id === this.fresh);
      if (added) {
        this.fresh = null;
        host.show(added.id);
      }
      if (layers.length === 0) body.append(el('p', 'wz-hint', 'Pick at least one layer to give the table something to show.'));
    } else if (this.step === BUTTONS) {
      real.show(layers[0]?.id ?? null);
      if (this.panel) title('Buttons', 'Give each button words a visitor understands, and choose its side. The theme and button style are on the ribbon above; the controller beside the map is live.');
      else {
        title('Buttons', 'Pick how the controller looks, give each button words a visitor understands, and choose its side. The controller on the right is live.');
        body.append(this.lookPicker());
      }
      if (layers.length === 0) body.append(el('p', 'wz-hint', 'There are no layers yet. Go back a step and pick one.'));
      const syncs: (() => void)[] = [];
      for (const { id, manifest } of layers) {
        const card = el('div', 'wz-button');
        const set = (button: object) => void host.send('scene.set', { layer: id, button });
        const badge = el('span', 'wz-badge');
        const name = el('input');
        Object.assign(name, { type: 'text', maxLength: 40, placeholder: manifest.name, ariaLabel: `Name of ${manifest.name}` });
        name.addEventListener('change', () => set({ name: name.value.trim() || null }));
        name.addEventListener('focus', () => host.show(id));
        const description = el('input');
        Object.assign(description, { type: 'text', maxLength: 200, placeholder: manifest.description ?? 'One line about what it shows', ariaLabel: `Description of ${manifest.name}` });
        description.addEventListener('change', () => set({ description: description.value.trim() || null }));
        description.addEventListener('focus', () => host.show(id));
        const side = el('div', 'segmented');
        side.setAttribute('role', 'radiogroup');
        side.setAttribute('aria-label', `Side of ${manifest.name}`);
        const sides = (['left', 'right'] as const).map((value) => {
          const option = el('button', undefined, value === 'left' ? 'Left' : 'Right');
          option.type = 'button';
          option.setAttribute('role', 'radio');
          option.addEventListener('click', () => set({ side: value }));
          side.append(option);
          return [value, option] as const;
        });
        const fields = el('div', 'wz-button-fields');
        fields.append(name, description);
        card.append(badge, fields, side);
        body.append(card);
        let shown: string | undefined | null = null;
        syncs.push(() => {
          const state = host.store.state.layers[id];
          if (!state) return;
          const button = layerButton(id, manifest, state, defaultSideOf(host.store, id));
          if (shown !== button.icon) badge.replaceChildren(icon(button.icon, 20));
          shown = button.icon;
          if (document.activeElement !== name) name.value = state.button?.name ?? '';
          if (document.activeElement !== description) description.value = state.button?.description ?? '';
          for (const [value, option] of sides) option.setAttribute('aria-checked', String(value === button.side));
        });
      }
      this.syncButtons = () => syncs.forEach((sync) => sync());
      this.syncButtons();
    } else {
      host.show(null);
      title('Ready', 'The table is set up. Present puts the map on the projector and the controller on its screen.');
      // The three surfaces, as a visitor meets them.
      const surfaces: [string, string, string][] = [
        ['table', 'The map', 'Projected on the table. Light and movement, almost no words.'],
        ['tv', 'The controller', 'The screen beside the table. A button for each layer, with its words and controls.'],
        ['phone', 'Phones', 'Visitors join with a code and get their own controls.'],
      ];
      const cards = el('div', 'wz-surfaces');
      for (const [iconName, name, text] of surfaces) {
        const card = el('div', 'wz-surface');
        const badge = el('span', 'wz-badge');
        badge.append(icon(iconName, 20));
        const words = el('div');
        words.append(el('strong', undefined, name), el('p', undefined, text));
        card.append(badge, words);
        cards.append(card);
      }
      body.append(cards);
      const facts = el('ul', 'wz-facts');
      const ambient = instances.length - layers.length;
      facts.append(
        el('li', undefined, `${ambient} ${ambient === 1 ? 'thing' : 'things'} on the map at rest`),
        el('li', undefined, `${layers.length} ${layers.length === 1 ? 'layer' : 'layers'}, each a button on the controller`),
        el('li', undefined, `Phones join with the code ${host.store.state.session.code}`),
      );
      body.append(facts);
      const present = el('button', 'ed-button is-primary wz-big');
      present.type = 'button';
      present.append(icon('tv', 16), el('span', undefined, 'Present'));
      present.addEventListener('click', () => host.present());
      const tune = el('button', 'ed-button wz-big', 'Fine-tune in the editor');
      tune.type = 'button';
      tune.addEventListener('click', () => host.close());
      body.append(present, tune, el('p', 'wz-hint', 'In the editor you can change every setting of a layer, reorder things and add more. This guide stays one click away, under Setup guide.'));
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
    }

    const head = el('header', 'wz-head');
    head.append(stepList(WIZARD_STEPS, this.step, (index) => this.go(index)));
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
  private placeValues(): { name: string; centre: string; width: string; height: string; rotation: string; table: string; tile: string } {
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
      Number(this.where.tile || 0) !== (site.table?.tile_cm ?? 0)
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
        return { width_m: Number(v.width), height_m: Number(v.height), table_cm: Number(v.table), tile_cm: v.tile ? Number(v.tile) : null };
      },
      (ground) => {
        this.where = { ...this.placeValues(), width: String(ground.width_m), height: String(ground.height_m), table: String(ground.table_cm), tile: ground.tile_cm ? String(ground.tile_cm) : '' };
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
    form.append(
      field('Name', input('name', { type: 'text', maxLength: 60 })),
      field('Centre of the table', input('centre', { type: 'text', placeholder: '57.6898, 11.9742' }), 'Paste coordinates, or a link copied from Google Maps or OpenStreetMap.'),
      mapSlot,
      this.scaleFields.element,
      size,
      field('Turned', input('rotation', { type: 'number', min: '-180', max: '360', step: '1' }), 'Turns the map under the table, in degrees clockwise from north. 0 puts north at the top. The table itself stays as it stands.'),
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
    try {
      const response = await fetch('/api/site/place', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: values.name.trim(), origin: { lat: at.lat, lon: at.lon }, extent: { width_m, height_m, rotation_deg }, table_width_cm: Number(values.table), tile_cm: values.tile ? Number(values.tile) : 0 }),
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

  /** A layer's style as a dropdown, with the credit its map asks for; the map beside shows it live. */
  private stylePicker(id: string, control: SelectControl): HTMLElement {
    const { host } = this;
    const box = el('div', 'wz-style');
    const select = el('select');
    select.name = `${id}-style`;
    for (const option of control.options) select.append(new Option(option.label, option.value));
    const credit = el('p', 'wz-hint wz-credit');
    const note = el('p', 'wz-hint');
    const field = el('label', 'wz-field');
    field.append(el('span', undefined, control.label), select);
    box.append(field, credit, note);
    select.addEventListener('change', () => void host.send('scene.set', { layer: id, params: { [control.id]: select.value } }));
    const sync = (): void => {
      const state = host.store.state.layers[id];
      if (!state) return;
      const value = String(state.params[control.id] ?? control.default);
      if (document.activeElement !== select) select.value = value;
      const source = typeof state.shared.source === 'string' ? state.shared.source : '';
      credit.textContent = source ? `Map: ${source}` : '';
      note.textContent = typeof state.shared.note === 'string' ? state.shared.note : '';
    };
    const before = this.syncButtons;
    this.syncButtons = () => {
      before();
      sync();
    };
    return box;
  }

  /** One row per layer package with a switch: on means the table has it. */
  private choices(manifests: LayerManifest[], instances: { id: string; manifest: LayerManifest }[], preview: boolean): HTMLElement {
    const { host } = this;
    const list = el('div', 'wz-choices');
    const data = host.store.state.site.data ?? {};
    for (const manifest of manifests) {
      const mine = instances.filter((i) => i.manifest.id === manifest.id);
      const missing = (manifest.requires?.data ?? []).filter((name) => !(name in data));
      const row = el('label', 'wz-choice');
      const badge = el('span', 'wz-badge');
      badge.append(icon(manifest.icon, 20));
      const words = el('div');
      words.append(el('strong', undefined, manifest.name));
      // Switched on without its data, a layer shows nothing; it says so, and offers the data, either way.
      const lacking = missing.length > 0;
      const needs = missing.map(dataName).join(' and ');
      const about = !lacking ? (manifest.description ?? '') : mine.length > 0 ? `Shows nothing until this table has ${needs}.` : `Needs ${needs}, which this table does not have yet.`;
      if (about) words.append(el('p', undefined, about));
      // A layer that needs data offers the way to it, and the guide comes back here afterwards.
      const source = lacking ? targetFor(missing[0]!) : undefined;
      if (source) {
        const bring = el('button', 'ed-button wz-bring', `Bring in ${source.name.toLowerCase()}`);
        bring.type = 'button';
        bring.addEventListener('click', (event) => {
          event.preventDefault();
          if (this.panel && host.bringIn) host.bringIn(source.target);
          else this.bringIn(source.target, this.step);
        });
        words.append(bring);
      }
      const power = el('input');
      Object.assign(power, { type: 'checkbox', className: 'switch', checked: mine.length > 0, disabled: missing.length > 0 && mine.length === 0 });
      power.dataset.layer = manifest.id;
      row.classList.toggle('is-unavailable', power.disabled);
      power.addEventListener('change', async () => {
        power.disabled = true;
        if (power.checked) {
          this.fresh = manifest.id;
          await host.add(manifest);
        }
        else for (const { id } of mine) await host.send('scene.remove', { layer: id });
      });
      if (preview && mine[0]) row.addEventListener('pointerenter', () => host.show(mine[0]!.id));
      row.append(badge, words, power);
      list.append(row);
      // A layer with a style to pick (the base map) offers it right under its row, at rest.
      const style = manifest.controls?.find((c): c is SelectControl => c.id === 'style' && c.type === 'select');
      if (!preview && style && mine[0]) list.append(this.stylePicker(mine[0].id, style));
    }
    return list;
  }
}
