import type { LayerManifest, LayerState } from '@mrstudio/sdk';
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
}

/** One name for the table when no layer is open, used everywhere in the editor and the guide. */
export const AT_REST = 'At rest';

export const WIZARD_STEPS = ['Name and place', 'Your place', AT_REST, 'Layers', 'Buttons', 'Ready'] as const;
const WHERE = 0;
const PLACE = 1;
const REST = 2;
const LAYERS = 3;
const BUTTONS = 4;

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
  private where: { name: string; centre: string; width: string; height: string; rotation: string; table: string } | null = null;
  private scaleFields: ScaleFields | null = null;
  /** The map in "Name and place", made once: it keeps its view across redraws. */
  private placeMap: PlaceMap | null = null;
  private moving = false;
  private problem = '';

  constructor(host: WizardHost, options: { created?: boolean; step?: number } = {}) {
    this.host = host;
    // Someone who has just named and placed the table goes on to what it is made of.
    this.step = options.step ?? (options.created ? PLACE : WHERE);
    host.store.onScene(() => this.render());
    host.store.onLayer(() => this.step === BUTTONS && this.syncButtons());
    this.render();
  }

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

  private syncButtons: () => void = () => {};
  /** The layer package just switched on, shown on the map as soon as the scene has it. */
  private fresh: string | null = null;

  private render(): void {
    const { host } = this;
    const body = el('div', 'wz-body');
    const title = (text: string, lead: string) => body.append(el('h2', undefined, text), el('p', 'wz-lead', lead));
    const instances = this.instances();
    const layers = instances.filter((i) => !isAmbient(i.manifest));
    this.syncButtons = () => {};
    host.controller(this.step === BUTTONS);

    if (this.step === WHERE) {
      host.show(null);
      title('Name and place', 'What the table is called, where it is and how much ground it covers. Moving the table keeps the data you brought in; whatever lies inside the new outline is shown.');
      body.append(this.whereForm());
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
      host.show(null);
      title(AT_REST, 'What the map shows when no layer is open, and nobody is using the table. Pick a base map and some life to make it feel like a place.');
      body.append(this.choices(host.store.manifests.filter((m) => isAmbient(m) && isOffered(m)), instances, false));
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
      host.show(layers[0]?.id ?? null);
      title('Buttons', 'Give each button words a visitor understands, and choose its side of the controller. The controller on the right is live.');
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
  private placeValues(): { name: string; centre: string; width: string; height: string; rotation: string; table: string } {
    const { site } = this.host.store.state;
    return (
      this.where ?? {
        name: site.name,
        centre: `${site.origin.lat.toFixed(5)}, ${site.origin.lon.toFixed(5)}`,
        width: String(Math.round(site.extent.width_m)),
        height: String(Math.round(site.extent.height_m)),
        rotation: String(Math.round(site.extent.rotation_deg ?? 0)),
        table: String(site.table?.width_cm ?? 100),
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
      Number(this.where.table) !== (site.table?.width_cm ?? 100)
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
    // The physical table and the model scale: a scale sets the ground's size, keeping its shape.
    this.scaleFields = new ScaleFields(
      () => {
        const v = this.placeValues();
        return { width_m: Number(v.width), height_m: Number(v.height), table_cm: Number(v.table) };
      },
      (ground) => {
        this.where = { ...this.placeValues(), width: String(ground.width_m), height: String(ground.height_m), table: String(ground.table_cm) };
        for (const key of ['width', 'height'] as const) {
          const field = this.element.querySelector<HTMLInputElement>(`.wz-form input[name="${key}"]`);
          if (field) field.value = this.where[key];
        }
        this.problem = '';
        this.placeMap?.set(this.placement());
        this.nextWords();
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
    mapSlot.append(this.placeMap.element, el('p', 'wz-hint', 'Click the map or drag the middle to move the table, and drag its corner to cover more or less ground. Turn the map with the right mouse button, Ctrl and drag, or the arrows; the table stays upright, as it stands in the room.'));
    if (this.moving) form.append(el('p', 'wz-hint', 'Moving the table and rebuilding what it shows…'));
    if (this.problem) {
      const problem = el('p', 'wz-problem', this.problem);
      problem.setAttribute('role', 'alert');
      form.append(problem);
    }
    return form;
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
    const next = this.element.querySelector<HTMLButtonElement>('.wz-foot .is-primary');
    if (next) next.textContent = this.placeChanged() ? 'Move the table' : 'Next';
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
    this.moving = true;
    say('');
    this.host.resumeAt(next);
    try {
      const response = await fetch('/api/site/place', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: values.name.trim(), origin: { lat: at.lat, lon: at.lon }, extent: { width_m, height_m, rotation_deg }, table_width_cm: Number(values.table) }),
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
          this.bringIn(source.target, this.step);
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
    }
    return list;
  }
}
