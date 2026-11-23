import { el } from '../controls.ts';
import { icon } from './icons.ts';
import { PlaceMap } from './place-map.ts';
import { parsePlace } from './place.ts';
import { WIZARD_STEPS, stepList } from './wizard.ts';
import './editor.css';

type Invoke = (command: string, args?: object) => Promise<unknown>;

export { parsePlace } from './place.ts';

/**
 * The first step of the setup wizard, for a table that does not exist yet: its name,
 * where it is and how much ground it covers. The desktop app creates the table and
 * opens it in the editor, where the wizard carries on.
 */
export function newTable(root: HTMLElement): void {
  const invoke = (window as { __TAURI__?: { core?: { invoke?: Invoke } } }).__TAURI__?.core?.invoke;
  const shell = el('div', 'ed is-setup');
  const bar = el('header', 'ed-title');
  const brand = el('div', 'ed-brand');
  brand.append(icon('layers', 18), el('span', undefined, 'MR Studio'));
  const heading = el('div', 'ed-name');
  heading.append(el('strong', undefined, 'New table'));
  bar.append(brand, heading, el('div', 'ed-actions'));

  const panel = el('aside', 'wz');
  const head = el('header', 'wz-head');
  head.append(stepList(WIZARD_STEPS, 0));
  const body = el('form', 'wz-body wz-form');
  body.noValidate = true;
  body.append(el('h2', undefined, 'Name and place'), el('p', 'wz-lead', 'A table shows one piece of the world. Say what it is called, where it is and how much ground it covers.'));

  const field = (label: string, input: HTMLElement, hint?: string) => {
    const row = el('label', 'wz-field');
    row.append(el('span', undefined, label), input);
    if (hint) row.append(el('small', undefined, hint));
    return row;
  };
  const name = el('input');
  Object.assign(name, { type: 'text', maxLength: 60, placeholder: 'Harbour district', required: true });
  const place = el('input');
  Object.assign(place, { type: 'text', placeholder: '57.6898, 11.9742' });
  const width = el('input');
  Object.assign(width, { type: 'number', min: '100', max: '20000', step: '50', value: '1000' });
  const height = el('input');
  Object.assign(height, { type: 'number', min: '100', max: '20000', step: '50', value: '600' });
  const turned = el('input');
  Object.assign(turned, { type: 'number', min: '-180', max: '360', step: '1', value: '0' });
  const size = el('div', 'wz-pair');
  size.append(field('Width, metres', width), field('Height, metres', height));
  body.append(
    field('Name', name),
    field('Centre of the table', place, 'Paste coordinates, or a link copied from Google Maps or OpenStreetMap.'),
    size,
    field('Turned', turned, 'Degrees clockwise from north for the top edge of the table. 0 puts north at the top.'),
    el('p', 'wz-hint', 'The shape should match your table. A 16 to 10 projector suits 1000 by 600 metres or 1600 by 1000.'),
  );
  const problem = el('p', 'wz-problem');
  problem.setAttribute('role', 'alert');
  problem.hidden = true;
  body.append(problem);

  const foot = el('footer', 'wz-foot');
  const cancel = el('button', 'ed-button', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', () => void invoke?.('open_home').catch(() => {}));
  const create = el('button', 'ed-button is-primary', 'Create the table');
  create.type = 'button';
  foot.append(cancel, el('span', 'ed-grow'), create);
  panel.append(head, body, foot);

  // The other half of the window is a map with the table on it: click to place it, drag to scale and turn it.
  const stage = el('main', 'ed-centre');
  const canvas = el('div', 'ed-canvas wz-ground');
  stage.append(canvas);
  const rotation = () => {
    const degrees = Number(turned.value);
    return Number.isFinite(degrees) ? ((degrees % 360) + 360) % 360 : 0;
  };

  const read = () => ({ name: name.value.trim(), at: parsePlace(place.value), width_m: Number(width.value), height_m: Number(height.value) });
  const placement = () => {
    const { at, width_m, height_m } = read();
    return at && width_m >= 100 && height_m >= 100 ? { ...at, width_m, height_m, rotation_deg: rotation() } : null;
  };
  const map = new PlaceMap(placement(), (moved) => {
    place.value = `${moved.lat.toFixed(5)}, ${moved.lon.toFixed(5)}`;
    width.value = String(moved.width_m);
    height.value = String(moved.height_m);
    turned.value = String(moved.rotation_deg);
    if (invoke) say('');
  });
  canvas.append(map.element, el('p', 'wz-hint pm-help', 'Click the map to put the table there. Drag the middle to move it, the corner to cover more or less ground, and the round handle to turn it.'));
  for (const input of [place, width, height, turned]) input.addEventListener('input', () => map.set(placement()));
  for (const input of [name, place, width, height, turned]) input.addEventListener('input', () => invoke && say(''));

  const say = (text: string): void => {
    problem.textContent = text;
    problem.hidden = !text;
  };
  if (!invoke) {
    say('New tables are created from the MR Studio app. In a browser this page only shows what it asks.');
    create.disabled = true;
  }
  create.addEventListener('click', async () => {
    const { name: title, at, width_m, height_m } = read();
    if (!title) return say('Give the table a name.');
    if (!at) return say('Paste the coordinates of the centre of the table, for example 57.6898, 11.9742.');
    if (!(width_m >= 100 && height_m >= 100)) return say('The width and the height must each be at least 100 metres.');
    say('');
    create.disabled = true;
    try {
      const path = await invoke!('create_site', { site: { name: title, lat: at.lat, lon: at.lon, width_m, height_m, rotation_deg: rotation() } });
      await invoke!('open_site', { path, welcome: true });
    } catch (error) {
      say(String(error));
      create.disabled = false;
    }
  });

  const main = el('div', 'ed-body');
  main.append(panel, stage);
  shell.append(bar, main);
  root.append(shell);
  name.focus();
}
