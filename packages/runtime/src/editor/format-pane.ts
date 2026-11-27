// The editor's Format pane (#540, part 3): the right-hand inspector of the selected layer, item or
// piece of map life, with its button, its settings generated from the manifest, its items and its
// trouble. Moved from editor.ts as functions of the one editor state; no change in behaviour.
import { isVisible } from '@mrstudio/sdk';
import type { Control, LayerManifest, LayerState } from '@mrstudio/sdk';
import { clock, defaultSideOf, el, isAmbient, isAtRest, layerButton, visibleControls, widget } from '../controls.ts';
import type { Widget } from '../controls.ts';
import { paramSender } from '../layer-manager.ts';
import { builderSection } from './builder.ts';
import { LAYER_ICONS, icon } from './icons.ts';
import { setting } from './settings-list.ts';
import { slidesSection } from './slides.ts';
import { AT_REST } from './wizard.ts';
import type { Editor } from './editor.ts';
import { renderCanvas } from './canvas.ts';
import { button, openHelp, troubleText } from './editor.ts';
import { treeRow } from './layer-rows.ts';

/**
 * How a layer is offered on the controller: its name, a line of description, an icon
 * and the side its button sits on. Empty fields fall back to the layer package's own.
 */
export function buttonSection(ed: Editor, id: string, manifest: LayerManifest): HTMLElement {
  const section = el('section', 'ed-section');
  const set = (button: object) => void ed.send('scene.set', { layer: id, button });
  const field = (label: string, input: HTMLElement) => {
    const row = el('label', 'ed-field');
    row.append(el('span', undefined, label), input);
    return row;
  };

  const name = setting('button.words', 'format:button', el('input'));
  Object.assign(name, { type: 'text', maxLength: 40, placeholder: manifest.name });
  name.addEventListener('change', () => set({ name: name.value.trim() || null }));
  const description = setting('button.words', 'format:button', el('textarea'));
  Object.assign(description, { rows: 3, maxLength: 200, placeholder: manifest.description ?? 'One line about what this layer shows' });
  description.addEventListener('change', () => set({ description: description.value.trim() || null }));

  // The group of buttons it sits in on its rail. The groups already in use are offered.
  const group = setting('button.words', 'format:button', el('input'));
  const known = el('datalist');
  known.id = `ed-groups-${id}`;
  Object.assign(group, { type: 'text', maxLength: 40, placeholder: 'None, for example Simulations' });
  group.setAttribute('list', known.id);
  group.addEventListener('focus', () => {
    const names = new Set(Object.values(ed.store.state.layers).flatMap((l) => (l.button?.group ? [l.button.group] : [])));
    known.replaceChildren(...[...names].sort().map((n) => Object.assign(el('option'), { value: n })));
  });
  group.addEventListener('change', () => set({ group: group.value.trim() || null }));

  // Who made what the layer shows (#659), under its words on the controller.
  const credit = setting('button.credit', 'format:button', el('input'));
  Object.assign(credit, { type: 'text', maxLength: 200, placeholder: 'None, for example Artwork by …' });
  credit.addEventListener('change', () => set({ credit: credit.value.trim() || null }));

  // How much of the legend the controller shows (#660).
  const legend = setting('button.legend', 'format:button', el('select'));
  for (const [value, label] of [
    ['auto', 'Fit the screen (smaller when long)'],
    ['full', 'Full size, one under the other'],
    ['compact', 'Small, in columns'],
    ['off', 'No legend'],
  ] as const) legend.append(Object.assign(el('option', undefined, label), { value }));
  legend.addEventListener('change', () => set({ legend: legend.value === 'auto' ? null : legend.value }));

  const side = setting('button.side', 'format:button', el('div', 'segmented'));
  side.setAttribute('role', 'radiogroup');
  side.setAttribute('aria-label', 'Side of the controller');
  const sides = (['left', 'right'] as const).map((value) => {
    const option = el('button', undefined, value === 'left' ? 'Left' : 'Right');
    option.type = 'button';
    option.setAttribute('role', 'radio');
    option.addEventListener('click', () => set({ side: value }));
    side.append(option);
    return [value, option] as const;
  });

  const icons = setting('button.icon', 'format:button', el('div', 'ed-icons'));
  icons.setAttribute('role', 'radiogroup');
  icons.setAttribute('aria-label', 'Icon');
  const names = LAYER_ICONS.includes(manifest.icon ?? '') || !manifest.icon ? LAYER_ICONS : [manifest.icon, ...LAYER_ICONS];
  const choices = names.map((value) => {
    const option = el('button', 'ed-icon-choice');
    option.type = 'button';
    option.setAttribute('role', 'radio');
    option.ariaLabel = value;
    option.title = value;
    option.append(icon(value));
    option.addEventListener('click', () => set({ icon: value === manifest.icon ? null : value }));
    icons.append(option);
    return [value, option] as const;
  });

  const row = el('div', 'ed-field');
  row.append(el('span', undefined, 'Side'), side);
  const iconRow = el('div', 'ed-field is-tall');
  iconRow.append(el('span', undefined, 'Icon'), icons);
  // The button as visitors will see it, as the fields change (#64).
  const preview = el('div', 'ed-button-preview');
  preview.setAttribute('aria-hidden', 'true');
  const previewIcon = el('span', 'ed-button-preview-icon');
  const previewText = el('span', 'ed-button-preview-text');
  const previewName = el('strong');
  const previewWords = el('span');
  previewText.append(previewName, previewWords);
  preview.append(previewIcon, previewText);
  // The section folds away, and stays as it was left (#64).
  const fold = el('details', 'ed-fold');
  fold.open = opened(ed, 'button');
  fold.addEventListener('toggle', () => opened(ed, 'button', fold.open));
  const summary = el('summary', undefined, 'Button on the controller');
  fold.append(summary, preview, field('Name', name), field('Description', description), field('Credit line', credit), field('Group', group), known, field('Legend', legend), row, iconRow);
  section.append(fold);

  const previous = ed.sync.get(id);
  const seen: Record<'name' | 'description' | 'group' | 'credit', string> = { name: '', description: '', group: '', credit: '' };
  ed.sync.set(id, (state) => {
    previous?.(state);
    const button = layerButton(id, manifest, state, defaultSideOf(ed.store, id));
    // A field being typed in is never overwritten (#396): a change from elsewhere is offered instead.
    for (const [input, key, label] of [
      [name, 'name', 'name'],
      [description, 'description', 'description'],
      [group, 'group', 'group'],
      [credit, 'credit', 'credit line'],
    ] as const) {
      const theirs = state.button?.[key] ?? '';
      if (document.activeElement !== input) {
        input.value = theirs;
        input.dataset.synced = theirs;
      }
      else if (theirs !== seen[key] && theirs !== input.value) {
        ed.history.offer(`The button’s ${label} was changed elsewhere to “${theirs || 'nothing'}” while you were typing.`, 'Yours is kept when you finish.', 'Use theirs', () => {
          input.value = theirs;
          input.dispatchEvent(new Event('change'));
        });
      }
      seen[key] = theirs;
      input.dataset.synced = theirs;
    }
    legend.value = state.button?.legend ?? 'auto';
    for (const [value, option] of sides) option.setAttribute('aria-checked', String(value === button.side));
    for (const [value, option] of choices) option.setAttribute('aria-checked', String(value === button.icon));
    previewIcon.replaceChildren(icon(button.icon, 18));
    previewName.textContent = button.name;
    previewWords.textContent = button.description;
    preview.dataset.side = button.side;
    preview.classList.toggle('is-hidden', Boolean(state.button?.hidden));
    // The headings that show the layer's name follow it.
    ed.inspector.querySelector('.ed-inspector-head strong')!.textContent = button.name;
    ed.inspector.querySelector('.ed-inspector-head svg')!.replaceWith(icon(button.icon));
    if (ed.context.kind === 'layer' && ed.context.id === id) renderCanvas(ed, ed.instances());
  });
  return section;
}

/** The settings form of one scene instance, generated from its manifest. */
export function settings(ed: Editor, id: string, manifest: LayerManifest, title = 'Settings'): HTMLElement {
  const section = el('section', 'ed-section');
  const parentState = ed.store.state.layers[ed.store.state.layers[id]?.parent ?? ''];
  const item = Boolean(parentState);
  // A slide comes on when the slideshow reaches it, so it has no switch of its own.
  const slide = Boolean(parentState && ed.store.manifest(parentState.layer)?.sequence);
  const shown = el('div', 'control control-toggle');
  const label = el('label', 'control-label', item ? 'Comes on with the layer' : 'Shown on the map');
  // A layer is opened by its button and map life by its eye in the list, so only a layer's items have this switch.
  shown.hidden = !item || slide;
  const power = setting('item.on', 'format:layer', el('input'));
  Object.assign(power, { type: 'checkbox', className: 'switch', id: `shown-${id}` });
  label.htmlFor = power.id;
  power.addEventListener('change', () => {
    if (item) ed.itemOn.set(id, power.checked);
    void ed.send('scene.set', { layer: id, active: power.checked });
  });
  shown.append(label, power);
  // Which stack an item of a glass or a reveal line is in (#606).
  const reveals = Boolean(parentState && ed.store.manifest(parentState.layer)?.reveals);
  const stackRow = el('div', 'control control-select');
  stackRow.hidden = !reveals;
  if (reveals) {
    const swipe = parentState!.layer === 'swipe';
    const pick = el('select');
    pick.id = `stack-${id}`;
    const choices: [string, string][] = [
      ['1', `Stack 1: the surface, ${swipe ? 'on the other side of the line' : 'around the glass'}`],
      ['2', `Stack 2: underneath, ${swipe ? 'on the revealed side' : 'inside the glass'}`],
    ];
    for (const [value, text] of choices) pick.append(Object.assign(el('option'), { value, textContent: text }));
    pick.value = ed.store.state.layers[id]?.stack === 1 ? '1' : '2';
    pick.addEventListener('change', () => void ed.send('scene.set', { layer: id, stack: Number(pick.value) }));
    const stackLabel = el('label', 'control-label', 'Stack');
    stackLabel.htmlFor = pick.id;
    stackRow.append(stackLabel, pick);
  }

  const send = paramSender(ed.connection, id, { method: 'scene.set' });
  const widgets: Widget[] = visibleControls(manifest.controls).map((control) =>
    widget(
      control,
      (value) => send({ [control.id]: value }),
      () => void ed.connection.request('layer.action', { layer: id, action: control.id }).catch(() => {}),
      { exact: true },
    ),
  );
  // Each control has a screen: switched off, the controller and phones leave the control out. It stays here.
  const offered = !isAmbient(manifest) && !item;
  const defaults = new Map(visibleControls(manifest.controls).flatMap((c) => ('default' in c ? [[c.id, c.default as unknown]] : [])));
  const rows = widgets.map((w) => {
    const row = setting('layer.settings', 'format:layer', el('div', 'ed-setting'));
    row.dataset.control = w.control.id;
    // Back to the layer's own value (#64): on hover, or Alt-click (Option-click) the control's name.
    const reset = el('button', 'ed-reset');
    reset.type = 'button';
    reset.append(icon('reset', 12));
    const fallback = defaults.get(w.control.id);
    reset.title = `Back to ${describe(ed, w.control, fallback)}`;
    reset.ariaLabel = `Reset ${w.control.label}`;
    reset.addEventListener('click', () => send({ [w.control.id]: fallback }));
    w.row.querySelector('.control-label')?.addEventListener('click', (event) => {
      if (!(event as MouseEvent).altKey || fallback === undefined) return;
      event.preventDefault();
      send({ [w.control.id]: fallback });
    });
    const eye = el('button', 'ed-eye');
    eye.type = 'button';
    eye.setAttribute('role', 'switch');
    eye.ariaLabel = `Show ${w.control.label} on the controller`;
    eye.addEventListener('click', () => {
      const hide = new Set(ed.store.state.layers[id]?.hide ?? []);
      if (hide.has(w.control.id)) hide.delete(w.control.id);
      else hide.add(w.control.id);
      void ed.send('scene.set', { layer: id, hide: [...hide] });
    });
    row.append(w.row);
    if (fallback !== undefined) row.append(reset);
    if (offered) row.append(eye);
    return { row, eye, reset, w, fallback };
  });
  // Long lists are split as the controller splits them: the main settings, then "More settings" (#64).
  // Settings that need room live in a dialog of their own (#644), opened from one button here.
  const dialogs = manifest.dialogs ?? [];
  const inDialog = new Set(dialogs.flatMap((d) => d.controls));
  const main = rows.filter((r) => !inDialog.has(r.w.control.id) && r.w.control.tier !== 'more' && r.w.control.tier !== 'state');
  const more = rows.filter((r) => !inDialog.has(r.w.control.id) && r.w.control.tier === 'more');
  const controls = el('div', 'controls');
  controls.append(shown, stackRow, ...main.map((r) => r.row));
  const previews: (() => void)[] = [];
  for (const spec of dialogs) {
    const open = button('ed-dialog-open', `${spec.label}\u2026`, spec.preview === 'phone-spot' ? 'phone' : 'settings');
    open.dataset.dialog = spec.id;
    const box = el('dialog', `ed-dialog is-layer-dialog is-${spec.id}`);
    box.ariaLabel = spec.label;
    const head = el('header', 'ed-dialog-head');
    const close = el('button', 'ed-icon-button', '\u00d7');
    close.type = 'button';
    close.ariaLabel = 'Close';
    close.addEventListener('click', () => box.close());
    const words = el('div');
    words.append(el('h2', undefined, spec.label));
    if (spec.lead) words.append(el('p', 'wz-lead', spec.lead));
    head.append(words, close);
    const body = el('div', 'ed-dialog-body ed-layer-dialog');
    body.dataset.home = `dialog:${id}:${spec.id}`;
    const list = el('div', 'controls');
    for (const cid of spec.controls) {
      const r = rows.find((x) => x.w.control.id === cid);
      if (r) list.append(r.row);
    }
    const side = el('div', 'ed-layer-dialog-main');
    side.append(list);
    const labels = new Map((manifest.actions ?? []).map((a) => [a.id, a.label ?? a.id]));
    if (spec.actions?.length) {
      const bar = el('div', 'ed-layer-dialog-actions');
      const said = el('p', 'ed-layer-dialog-said');
      said.setAttribute('role', 'status');
      for (const aid of spec.actions) {
        const act = button('ed-button', labels.get(aid) ?? aid, aid === 'save' ? 'save' : undefined);
        act.dataset.action = aid;
        act.addEventListener('click', async () => {
          act.disabled = true;
          said.textContent = 'Working\u2026';
          try {
            const answer = await ed.connection.request<{ saved?: string; summary?: string } | null>('layer.action', { layer: id, action: aid });
            said.textContent = answer?.saved ? `Saved as ${answer.saved}${answer.summary ? `: ${answer.summary}` : ''}.` : 'Done.';
          } catch (error) {
            said.textContent = (error as Error).message;
          } finally {
            act.disabled = false;
          }
        });
        bar.append(act);
      }
      bar.append(said);
      side.append(bar);
    }
    body.append(side);
    if (spec.preview === 'phone-spot') {
      const frame = el('figure', 'ed-phone-preview');
      const screen = el('div', 'ed-phone-screen');
      frame.append(screen, el('figcaption', undefined, 'What a visitor\u2019s phone shows'));
      body.append(frame);
      let last = '';
      const draw = () => {
        const site = ed.store.state.site;
        const params = ed.store.state.layers[id]?.params;
        const key = JSON.stringify(params ?? {});
        if (!box.open || !site || key === last) return;
        last = key;
        void import('../field-phone.ts').then(({ spotPreview }) => screen.replaceChildren(spotPreview(site, params)));
      };
      previews.push(draw);
      box.addEventListener('close', () => (last = ''));
    }
    box.addEventListener('cancel', (event) => {
      event.preventDefault();
      box.close();
    });
    box.append(head, body);
    open.addEventListener('click', () => {
      box.showModal();
      for (const draw of previews) draw();
    });
    controls.append(open, box);
  }
  const heading = el('h3', 'ed-settings-head', title);
  const tools = el('span', 'ed-settings-tools');
  if (rows.some((r) => r.fallback !== undefined)) {
    const resetAll = button('ed-help-link', 'Reset', 'reset', 14);
    resetAll.title = `Put every setting of ${manifest.name} back to its own value. Undo brings yours back.`;
    resetAll.addEventListener('click', () => void resetLayer(ed, id));
    tools.append(resetAll);
  }
  // A core layer has a page of its own in the Help window (#291).
  if (!manifest.custom && manifest.id) {
    const help = button('ed-help-link', 'How to use it', 'info', 14);
    help.title = `How to use ${manifest.name ?? 'this layer'}: what it needs, each setting and tips`;
    help.ariaLabel = help.title;
    help.addEventListener('click', () => openHelp(`layer-${manifest.id}`));
    tools.append(help);
  }
  heading.append(tools);
  section.append(heading);
  // The screen column says once what it is, rather than an unexplained icon on every row (#64).
  if (offered && rows.length > 0) {
    const columns = el('div', 'ed-settings-cols');
    columns.append(el('span', undefined, 'On the controller'), icon('tv', 12));
    columns.title = 'Switch a setting off here and visitors do not get it on the controller or their phones. It stays here for you.';
    section.append(columns);
  }
  section.append(controls);
  if (more.length > 0) {
    const extra = el('details', 'ed-more');
    extra.open = opened(ed, 'more');
    extra.addEventListener('toggle', () => opened(ed, 'more', extra.open));
    const summary = el('summary', undefined, 'More settings');
    summary.title = 'On the controller these wait behind "More settings" too';
    const list = el('div', 'controls');
    list.append(...more.map((r) => r.row));
    extra.append(summary, list);
    section.append(extra);
  }

  const previous = ed.sync.get(id);
  ed.sync.set(id, (state) => {
    previous?.(state);
    power.checked = item ? comesOn(ed, id) : state.active;
    for (const draw of previews) draw();
    for (const { row, eye, reset, w, fallback } of rows) {
      row.hidden = !isVisible(w.control, state.params);
      const value = state.params[w.control.id];
      w.sync(value, state.params);
      reset.hidden = fallback === undefined || JSON.stringify(value ?? fallback) === JSON.stringify(fallback);
      const hidden = Boolean(state.hide?.includes(w.control.id));
      eye.setAttribute('aria-checked', String(!hidden));
      eye.title = hidden ? 'Not on the controller or phones. Click to give it to visitors.' : 'On the controller and phones. Click to keep it for yourself.';
      eye.replaceChildren(icon(hidden ? 'tv-off' : 'tv', 14));
      row.classList.toggle('is-hidden', hidden);
    }
  });
  return section;
}

/** A control's value in words, for a tooltip: "12:00", "5 m/s", "Ribbons", "on". */
export function describe(ed: Editor, control: Control, value: unknown): string {
  if (value === undefined) return 'its own value';
  if (control.type === 'range' && typeof value === 'number') return control.unit === 'h' && control.max <= 24 ? clock(value) : `${value}${control.unit ? ` ${control.unit}` : ''}`;
  if (control.type === 'select') return control.options.find((o) => o.value === value)?.label ?? String(value);
  if (control.type === 'toggle') return value ? 'on' : 'off';
  return String(value) || 'empty';
}

/** Every setting of a layer back to the layer's own, as one change (#64). */
export async function resetLayer(ed: Editor, id: string): Promise<void> {
  const state = ed.store.state.layers[id];
  const manifest = state && ed.store.manifest(state.layer);
  if (!state || !manifest) return;
  const params: Record<string, unknown> = {};
  for (const control of visibleControls(manifest.controls)) if ('default' in control && control.tier !== 'state') params[control.id] = control.default;
  if (Object.keys(params).length === 0) return;
  const done = await ed.send('scene.set', { layer: id, params });
  if (done) ed.history.undoable(`Reset ${layerButton(id, manifest, state).name}`, 'Every setting is back to its own value.');
}

/** Whether a part of the inspector that folds is open, remembered on this computer (#64). */
export function opened(ed: Editor, key: string, open?: boolean): boolean {
  const name = `mrs-inspector-${key}`;
  try {
    if (open === undefined) return localStorage.getItem(name) !== 'closed';
    localStorage.setItem(name, open ? 'open' : 'closed');
  } catch {
    // Storage off: everything starts open.
  }
  return open ?? true;
}

/** Whether an item is set to come on when its layer opens, as saved in the table. */
export function comesOn(ed: Editor, id: string): boolean {
  const state = ed.store.state.layers[id];
  if (!state?.parent) return Boolean(state?.active);
  // While the layer is open the item's state says it; while it is closed, the saved choice is not sent, so ask the layer.
  const layer = ed.store.state.layers[state.parent];
  if (layer?.active) ed.itemOn.set(id, state.active);
  return ed.itemOn.get(id) ?? true;
}

/** What a layer holds: the items that show while it is open, with a way to add more. */
export function itemsSection(ed: Editor, layer: string, name: string, instances: { id: string; manifest: LayerManifest; state: LayerState }[]): HTMLElement {
  const section = el('section', 'ed-section');
  section.dataset.items = layer;
  section.append(el('h3', undefined, 'In this layer'));
  const items = instances.filter((i) => i.state.parent === layer);
  // Add inside… (#453) is the way in; the empty state says what goes inside this kind of layer.
  const kind = ed.store.state.layers[layer]?.layer;
  const what =
    kind === 'lens'
      ? `What the X-ray glass shows. Put a plan, a picture or a map inside, and set The glass shows to X-ray.`
      : kind === 'swipe'
        ? `What shows on one side of the line. Put a plan, a picture or a map inside.`
        : `Layers inside ${name} come on with it and go with it: traffic, trees or lights, a plan, a picture.`;
  if (items.length === 0) section.append(el('p', 'ed-empty', `Nothing yet. ${what}`));
  const addInside = button('ed-button', 'Add inside…', 'plus');
  addInside.dataset.command = 'dialog.inside';
  addInside.addEventListener('click', () => void ed.handlers['dialog.inside'].run(layer));
  // A glass or a reveal line holds two stacks (#606): the surface, shown around the glass or on
  // the far side of the line, and what is underneath, shown through it. Each row can move across.
  const parentManifest = kind ? ed.store.manifest(kind) : undefined;
  const stacked = Boolean(parentManifest?.reveals) && items.length > 0;
  const where = kind === 'swipe' ? (['on the other side of the line', 'on the revealed side'] as const) : (['around the glass', 'inside the glass'] as const);
  const ordered = stacked ? [...items.filter((i) => i.state.stack === 1), ...items.filter((i) => i.state.stack !== 1)] : items;
  let heading: number | null = null;
  for (const { id, manifest, state } of ordered) {
    const stack = state.stack === 1 ? 1 : 2;
    if (stacked && heading !== stack) {
      heading = stack;
      const head = el('div', 'ed-stack-head');
      head.append(el('strong', undefined, stack === 1 ? 'Stack 1 · the surface' : 'Stack 2 · underneath'), el('span', 'ed-hint', where[stack - 1]));
      section.append(head);
    }
    const row = treeRow(ed, manifest.name, '', manifest.icon, ed.layerItem === id, () => {
      ed.layerItem = ed.layerItem === id ? null : id;
      ed.render();
    });
    row.dataset.layer = id;
    row.classList.toggle('is-off', !comesOn(ed, id));
    const previous = ed.sync.get(id);
    ed.sync.set(id, (next) => {
      previous?.(next);
      row.classList.toggle('is-off', !comesOn(ed, id));
    });
    section.append(row);
  }
  // Only the stack underneath so far: a line says how to make a surface.
  if (stacked && !items.some((i) => i.state.stack === 1)) section.append(el('p', 'ed-hint', 'Select a layer here and choose Stack 1 to keep it on the surface, around what is revealed.'));
  section.append(addInside);
  return section;
}

/**
 * Why a layer is not running and a Retry button (#259), shown at the top of its settings while
 * it is in trouble. Hidden otherwise; it follows the layer as the table reports.
 */
export function troubleBox(ed: Editor, id: string): HTMLElement {
  const box = el('section', 'ed-trouble');
  box.setAttribute('role', 'status');
  const text = el('p', 'ed-trouble-text');
  const retry = button('ed-button', 'Retry', 'reset');
  retry.title = 'Start the layer again now';
  retry.addEventListener('click', () => void ed.connection.request('layer.retry', { layer: id }).catch(() => {}));
  const words = el('div', 'ed-trouble-words');
  words.append(el('strong', undefined, 'This layer is not running'), text);
  box.append(icon('alert', 16), words, retry);
  const show = (state: LayerState | undefined) => {
    const health = state?.health;
    box.hidden = !health;
    if (health) text.textContent = troubleText(health).replace(/^Not running: /, '').replace(/^./, (c) => c.toUpperCase());
  };
  show(ed.store.state.layers[id]);
  const previous = ed.sync.get(id);
  ed.sync.set(id, (next) => {
    previous?.(next);
    show(next);
  });
  return box;
}

export function renderInspector(ed: Editor, instances: { id: string; manifest: LayerManifest; state: LayerState }[]): void {
  const { context } = ed;
  const nodes: HTMLElement[] = [];
  const head = (iconName: string | undefined, title: string, detail: string) => {
    const header = el('header', 'ed-inspector-head');
    header.append(icon(iconName), el('strong', undefined, title), el('span', undefined, detail));
    return header;
  };

  if (context.kind === 'home') {
    const ambient = instances.filter((i) => isAtRest(i.manifest, i.state) && !i.state.parent);
    const open = ambient.find((i) => i.id === ed.homeItem);
    if (open) {
      nodes.push(head(open.manifest.icon, layerButton(open.id, open.manifest).name, `${AT_REST}: when no layer is open`));
      nodes.push(troubleBox(ed, open.id), settings(ed, open.id, open.manifest));
    } else {
      nodes.push(head('moon', AT_REST, 'When no layer is open'));
      nodes.push(
        el(
          'p',
          'ed-empty',
          ambient.length === 0
            ? 'Nothing shows when no layer is open. Insert › New layer › Map life adds a base map and some life.'
            : 'What the map shows when nobody is using the table. Select one under At rest on the left to change it; its eye turns it on or off.',
        ),
      );
    }
  } else if (context.kind === 'layer') {
    const layer = instances.find((i) => i.id === context.id)!;
    const as = layerButton(layer.id, layer.manifest, layer.state);
    nodes.push(head(as.icon, as.name, layer.manifest.custom ? 'Custom layer' : 'Layer'));
    nodes.push(troubleBox(ed, layer.id));
    // A custom layer is styled here: data, look, motion and interaction, with its button as the last tab.
    if (layer.manifest.custom) nodes.push(builderSection(ed.builderHost(), layer.manifest, buttonSection(ed, layer.id, layer.manifest)));
    else nodes.push(buttonSection(ed, layer.id, layer.manifest));
    // A slideshow's slides come before its settings: they are what the author works on.
    if (!layer.manifest.sequence && (layer.manifest.controls?.length ?? 0) + (layer.manifest.custom ? 0 : 1) > 0) nodes.push(settings(ed, layer.id, layer.manifest));
    if (layer.manifest.sequence) {
      nodes.push(
        slidesSection(
          {
            store: ed.store,
            send: (method, params) => ed.send(method, params),
            select: (item) => {
              ed.layerItem = item;
              ed.render();
            },
            open: (other) => ed.go({ kind: 'layer', id: other }),
            watch: (callback) => {
              const previous = ed.sync.get(layer.id);
              ed.sync.set(layer.id, (next) => {
                previous?.(next);
                callback(next);
              });
            },
            selected: ed.layerItem,
          },
          layer.id,
        ),
      );
      nodes.push(settings(ed, layer.id, layer.manifest));
    } else nodes.push(itemsSection(ed, layer.id, as.name, instances));
    const open = instances.find((i) => i.id === ed.layerItem && i.state.parent === layer.id);
    if (open) nodes.push(settings(ed, open.id, open.manifest, open.manifest.name));
  } else {
    nodes.push(head(context.kind === 'controller' ? 'tv' : 'phone', context.kind === 'controller' ? 'Controller' : 'Phones', ''));
    nodes.push(
      el(
        'p',
        'ed-empty',
        context.kind === 'controller'
          ? 'This is the controller as visitors see it, live. Press a button to try it. To change a button, choose its layer on the left.'
          : `Visitors join with the code ${ed.store.state.session.code}. Choosing what phones may control comes later.`,
      ),
    );
  }
  // Several rows selected (#399): say so, and which of them the settings below belong to.
  if (ed.also.size && context.kind === 'layer') {
    const first = layerButton(context.id, ed.store.manifest(ed.store.state.layers[context.id]!.layer)!, ed.store.state.layers[context.id]).name;
    const note = el('p', 'ed-inspector-many', `${ed.also.size + 1} layers selected. Show, Hide and Remove act on all of them; the settings below are ${first}’s.`);
    nodes.splice(1, 0, note);
  }
  const kept = keepTyping(ed);
  ed.inspector.replaceChildren(...nodes);
  kept();
}

/**
 * The field being typed in survives a rebuild of the pane (#396): a change from elsewhere redraws
 * the Format pane, and the author's field is carried into the new one, with its text, focus and
 * caret. When the change was to that very field, the other value is offered instead.
 */
export function keepTyping(ed: Editor): () => void {
  const focused = document.activeElement;
  if (!(focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) || !ed.inspector.contains(focused)) return () => {};
  const fields = () => [...ed.inspector.querySelectorAll<HTMLElement>('input, textarea, select')];
  const index = fields().indexOf(focused);
  const label = (node: Element) => node.closest('label')?.firstElementChild?.textContent ?? '';
  const name = label(focused);
  const [start, end] = [focused.selectionStart, focused.selectionEnd];
  // Taking a focused field out of the page blurs it, and a blur sends its change: not yet.
  let held = false;
  const hold = (event: Event) => {
    held ||= event.type === 'change';
    event.stopImmediatePropagation();
  };
  focused.addEventListener('change', hold, true);
  focused.addEventListener('blur', hold, true);
  return () => {
    queueMicrotask(() => {
      focused.removeEventListener('change', hold, true);
      focused.removeEventListener('blur', hold, true);
      // The browser counts the held change as sent: send it when the author really leaves the field.
      if (held) focused.addEventListener('blur', () => focused.dispatchEvent(new Event('change')), { once: true });
    });
    const fresh = fields()[index];
    if (!fresh || fresh.tagName !== focused.tagName || label(fresh) !== name) return;
    const before = focused.dataset.synced;
    fresh.replaceWith(focused);
    focused.focus();
    if (start !== null && end !== null) focused.setSelectionRange(start, end);
    // The new field is filled by the sync that follows the rebuild: compare after it.
    queueMicrotask(() => {
      const theirs = (fresh as HTMLInputElement).value;
      if (before !== undefined && theirs !== before && theirs !== focused.value) {
        ed.history.offer(`${name || 'This field'} was changed elsewhere to “${theirs || 'nothing'}” while you were typing.`, 'Yours is kept when you finish.', 'Use theirs', () => {
          focused.value = theirs;
          focused.dispatchEvent(new Event('change'));
        });
      }
      focused.dataset.synced = theirs;
    });
  };
}
