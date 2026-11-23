import type { LayerManifest, LayerState } from '@mrstudio/sdk';
import { defaultSideOf, el, isAmbient, isOffered, layerButton } from '../controls.ts';
import type { Store } from '../store.ts';
import { icon } from './icons.ts';
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
}

/** One name for the table when no layer is open, used everywhere in the editor and the guide. */
export const AT_REST = 'At rest';

export const WIZARD_STEPS = ['Name and place', 'Your place', AT_REST, 'Layers', 'Buttons', 'Ready'] as const;
const WHERE = 0;
const PLACE = 1;
const REST = 2;
const LAYERS = 3;
const BUTTONS = 4;

/** What the host says about a file before and after it is brought into the table (see session.md). */
interface ImportReport {
  ok: boolean;
  summary: string;
  issues: { code: string; severity: 'blocker' | 'warning' | 'note'; message: string; fix?: 'crop' | 'swap' }[];
}

/** The files a table is made from. Each is brought in on its own. */
const PLACE_DATA: { target: string; dataset: string; name: string; icon: string; about: string; accept: string }[] = [
  { target: 'buildings', dataset: 'buildings', name: 'Buildings', icon: 'blocks', about: 'Footprints with heights. They cast the shadows and shape the wind. GeoJSON.', accept: '.geojson,.json' },
  { target: 'terrain', dataset: 'terrain', name: 'Ground', icon: 'map', about: 'The height of the land, so hills shade and shelter as they do outside. A GeoTIFF.', accept: '.tif,.tiff' },
  { target: 'trees', dataset: 'trees', name: 'Trees', icon: 'tree', about: 'Where the trees stand. GeoJSON points, or a CSV with coordinates.', accept: '.geojson,.json,.csv' },
  { target: 'data:roads', dataset: 'roads', name: 'Streets', icon: 'car', about: 'The street network, as lines. Traffic drives along it. GeoJSON.', accept: '.geojson,.json' },
  { target: 'walkways', dataset: 'walkways', name: 'Walking paths', icon: 'footprints', about: 'Lines people can walk along. Cool paths needs them. GeoJSON.', accept: '.geojson,.json' },
  { target: 'trips', dataset: 'trips', name: 'Trips', icon: 'route', about: 'Journeys through the day. Mobility needs them. A trips.json file.', accept: '.json' },
];

/** How a dataset a layer needs is named to an author. */
function dataName(dataset: string): string {
  const known = PLACE_DATA.find((item) => item.dataset === dataset);
  return known ? `${known.name.toLowerCase()} data` : `${dataset} data`;
}

interface Pending {
  file: File;
  options: Set<'crop' | 'swap'>;
  /** `EPSG:<code>`, named by the author when the file does not say and the host cannot tell. */
  crs?: string;
  report?: ImportReport;
  busy: boolean;
  failed?: string;
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
  /** Files chosen in "Your place" that are being checked or await a yes. */
  private pending = new Map<string, Pending>();
  private readonly host: WizardHost;
  /** The row of "Your place" that a layer needing data sent the author to. */
  private wanted: string | null = null;
  /** The "Name and place" form as the author left it, kept across redraws. */
  private where: { name: string; centre: string; width: string; height: string; rotation: string } | null = null;
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
      if (manifest) list.push({ id, manifest, state });
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
      for (const item of PLACE_DATA) body.append(this.placeRow(item));
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

  /** One kind of data in "Your place": whether the table has it, a file picker, and what the host says about the chosen file. */
  private placeRow(item: (typeof PLACE_DATA)[number]): HTMLElement {
    const { host } = this;
    const has = item.dataset in (host.store.state.site.data ?? {});
    const pending = this.pending.get(item.target);
    const box = el('div', 'wz-place');
    box.dataset.target = item.target;
    const row = el('div', 'wz-choice');
    const badge = el('span', 'wz-badge');
    badge.append(icon(item.icon, 20));
    const words = el('div');
    words.append(el('strong', undefined, item.name), el('p', undefined, item.about));
    const state = el('span', has ? 'wz-state is-have' : 'wz-state', has ? 'On the table' : 'Not yet');
    if (has) state.prepend(icon('check', 12));
    const input = el('input');
    Object.assign(input, { type: 'file', accept: item.accept, hidden: true, ariaLabel: `File for ${item.name}` });
    const choose = el('button', 'ed-button', has ? 'Replace' : 'Choose a file');
    choose.type = 'button';
    choose.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      this.pending.set(item.target, { file, options: new Set(), busy: true });
      void this.check(item.target, false);
    });
    row.append(badge, words, state, choose, input);
    box.append(row);

    if (pending) {
      const report = el('div', 'wz-report');
      if (pending.busy) report.append(el('p', undefined, `Reading ${pending.file.name}…`));
      else if (pending.failed) report.append(el('p', 'wz-issue is-blocker', pending.failed));
      else if (pending.report) {
        report.append(el('p', 'wz-summary', pending.report.summary));
        for (const issue of pending.report.issues) {
          const line = el('p', `wz-issue is-${issue.severity}`, issue.message);
          const fix = issue.fix;
          if (fix && !pending.options.has(fix)) {
            const apply = el('button', 'ed-button', fix === 'crop' ? 'Leave out what is off the table' : 'Swap latitude and longitude');
            apply.type = 'button';
            apply.addEventListener('click', () => {
              pending.options.add(fix);
              void this.check(item.target, false);
            });
            line.append(apply);
          }
          if (issue.code === 'coords.unknown' || (pending.crs && issue.code === 'extent.outside_all')) {
            // The file does not say where it is; the author names its coordinate system and it is read again.
            // A system that puts the file off the table can be changed for another.
            const code = el('input');
            Object.assign(code, { type: 'text', inputMode: 'numeric', placeholder: 'EPSG code, such as 3006', ariaLabel: 'EPSG code of the file', value: pending.crs?.replace('EPSG:', '') ?? '' });
            const again = el('button', 'ed-button', 'Read it again');
            again.type = 'button';
            const retry = (): void => {
              const digits = code.value.replace(/\D/g, '');
              if (!digits) return;
              pending.crs = `EPSG:${digits}`;
              void this.check(item.target, false);
            };
            again.addEventListener('click', retry);
            code.addEventListener('keydown', (event) => event.key === 'Enter' && retry());
            const ask = el('span', 'wz-crs');
            ask.append(code, again);
            line.append(ask);
          }
          report.append(line);
        }
      }
      const actions = el('div', 'wz-report-actions');
      const add = el('button', 'ed-button is-primary', 'Add to the table');
      add.type = 'button';
      add.disabled = pending.busy || !pending.report?.ok;
      add.addEventListener('click', () => void this.check(item.target, true));
      const cancel = el('button', 'ed-button', 'Cancel');
      cancel.type = 'button';
      cancel.addEventListener('click', () => {
        this.pending.delete(item.target);
        this.render();
      });
      actions.append(add, cancel);
      report.append(actions);
      box.append(report);
    }
    return box;
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
  private placeValues(): { name: string; centre: string; width: string; height: string; rotation: string } {
    const { site } = this.host.store.state;
    return (
      this.where ?? {
        name: site.name,
        centre: `${site.origin.lat.toFixed(5)}, ${site.origin.lon.toFixed(5)}`,
        width: String(Math.round(site.extent.width_m)),
        height: String(Math.round(site.extent.height_m)),
        rotation: String(Math.round(site.extent.rotation_deg ?? 0)),
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
      Number(this.where.rotation) !== Math.round(site.extent.rotation_deg ?? 0)
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
      node.addEventListener('input', () => {
        this.where = { ...this.placeValues(), [key]: node.value };
        this.problem = '';
        // Only the footer's words change while typing, so the field keeps its focus.
        const next = this.element.querySelector<HTMLButtonElement>('.wz-foot .is-primary');
        if (next) next.textContent = this.placeChanged() ? 'Move the table' : 'Next';
      });
      return node;
    };
    const size = el('div', 'wz-pair');
    size.append(
      field('Width, metres', input('width', { type: 'number', min: '100', max: '20000', step: '50' })),
      field('Height, metres', input('height', { type: 'number', min: '100', max: '20000', step: '50' })),
    );
    form.append(
      field('Name', input('name', { type: 'text', maxLength: 60 })),
      field('Centre of the table', input('centre', { type: 'text', placeholder: '57.6898, 11.9742' }), 'Paste coordinates, or a link copied from Google Maps or OpenStreetMap.'),
      size,
      field('Turned', input('rotation', { type: 'number', min: '-180', max: '360', step: '1' }), 'Degrees clockwise from north for the top edge of the table. 0 puts north at the top.'),
    );
    if (this.moving) form.append(el('p', 'wz-hint', 'Moving the table and rebuilding what it shows…'));
    if (this.problem) {
      const problem = el('p', 'wz-problem', this.problem);
      problem.setAttribute('role', 'alert');
      form.append(problem);
    }
    return form;
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
        body: JSON.stringify({ name: values.name.trim(), origin: { lat: at.lat, lon: at.lon }, extent: { width_m, height_m, rotation_deg } }),
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

  /** Sends the chosen file to the host: to be checked, or with `write` to be brought into the table. */
  private async check(target: string, write: boolean): Promise<void> {
    const pending = this.pending.get(target);
    if (!pending) return;
    pending.busy = true;
    pending.failed = undefined;
    this.render();
    const query = new URLSearchParams({ target });
    for (const option of pending.options) query.set(option, '1');
    if (pending.crs) query.set('crs', pending.crs);
    try {
      const response = await fetch(`/api/data/${write ? 'import' : 'inspect'}?${query}`, { method: 'POST', headers: { 'X-Filename': encodeURIComponent(pending.file.name) }, body: pending.file });
      // 200 and 422 both carry the report; anything else is a plain message.
      if (response.status === 200 || response.status === 422) pending.report = (await response.json()) as ImportReport;
      else pending.failed = (await response.text()) || `The table refused the file (${response.status}).`;
      // After a successful import the host tells every surface the site changed, and the editor reloads into this step.
      if (write && response.status === 200) this.pending.delete(target);
    } catch (error) {
      pending.failed = `The file could not be sent: ${(error as Error).message}`;
    }
    pending.busy = false;
    this.render();
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
      const lacking = missing.length > 0 && mine.length === 0;
      const about = lacking ? `Needs ${missing.map(dataName).join(' and ')}, which this table does not have yet.` : (manifest.description ?? '');
      if (about) words.append(el('p', undefined, about));
      // A layer that needs data offers the way to it, and the guide comes back here afterwards.
      const source = lacking ? PLACE_DATA.find((item) => item.dataset === missing[0]) : undefined;
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
