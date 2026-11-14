import type { LayerManifest, LayerState } from '@mrstudio/sdk';
import { defaultSide, el, isAmbient, layerButton } from '../controls.ts';
import type { Store } from '../store.ts';
import { icon } from './icons.ts';

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
}

export const WIZARD_STEPS = ['Welcome', 'The map at rest', 'Layers', 'Buttons', 'Ready'] as const;

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
  private step: number;
  private readonly host: WizardHost;
  /** Whether a "Name and place" step came before this one, in the app's new-table page. */
  private readonly created: boolean;

  constructor(host: WizardHost, options: { created?: boolean } = {}) {
    this.host = host;
    this.created = options.created ?? false;
    // Someone who has just named and placed the table has had the welcome.
    this.step = this.created ? 1 : 0;
    host.store.onScene(() => this.render());
    host.store.onLayer(() => this.step === 3 && this.syncButtons());
    this.render();
  }

  private names(): string[] {
    return this.created ? ['Name and place', ...WIZARD_STEPS.slice(1)] : [...WIZARD_STEPS];
  }

  private go(step: number): void {
    this.step = Math.max(0, Math.min(WIZARD_STEPS.length - 1, step));
    if (this.created && this.step === 0) this.step = 1;
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
    host.controller(this.step === 3);

    if (this.step === 0) {
      host.show(null);
      title(`Set up ${host.store.state.site.name}`, 'A table has three surfaces. You set them up in a few steps and can change everything later.');
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
    } else if (this.step === 1) {
      host.show(null);
      title('The map at rest', 'What the table shows when nobody is using it. Pick a base map and some life to make it feel like a place.');
      body.append(this.choices(host.store.manifests.filter(isAmbient), instances, false));
    } else if (this.step === 2) {
      title('Layers', 'Each layer answers one question, such as where the sun falls. Every layer you pick becomes a button on the controller.');
      body.append(this.choices(host.store.manifests.filter((m) => !isAmbient(m)), instances, true));
      const added = layers.find((i) => i.manifest.id === this.fresh);
      if (added) {
        this.fresh = null;
        host.show(added.id);
      }
      if (layers.length === 0) body.append(el('p', 'wz-hint', 'Pick at least one layer to give the table something to show.'));
    } else if (this.step === 3) {
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
          const button = layerButton(id, manifest, state, defaultSide(host.store));
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
    back.disabled = this.step === (this.created ? 1 : 0);
    back.addEventListener('click', () => this.go(this.step - 1));
    const skip = el('button', 'wz-skip', 'Skip the guide');
    skip.type = 'button';
    skip.addEventListener('click', () => host.close());
    foot.append(back, skip);
    if (this.step < WIZARD_STEPS.length - 1) {
      const next = el('button', 'ed-button is-primary', this.step === 0 ? 'Start' : 'Next');
      next.type = 'button';
      next.addEventListener('click', () => this.go(this.step + 1));
      foot.append(next);
    }

    const head = el('header', 'wz-head');
    head.append(stepList(this.names(), this.step, (index) => this.go(index)));
    // Typing in a field must survive a redraw caused by someone else's change.
    this.element.replaceChildren(head, body, foot);
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
      const about = missing.length > 0 && mine.length === 0 ? `Needs ${missing.join(' and ')} data, which this table does not have yet.` : (manifest.description ?? '');
      if (about) words.append(el('p', undefined, about));
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
