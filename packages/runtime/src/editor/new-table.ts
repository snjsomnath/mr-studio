import { el } from '../controls.ts';
import { icon } from './icons.ts';
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
  const size = el('div', 'wz-pair');
  size.append(field('Width, metres', width), field('Height, metres', height));
  body.append(
    field('Name', name),
    field('Centre of the table', place, 'Paste coordinates, or a link copied from Google Maps or OpenStreetMap.'),
    size,
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

  // The other half of the window draws the ground the table will cover.
  const stage = el('main', 'ed-centre');
  const canvas = el('div', 'ed-canvas wz-ground');
  const ground = el('div', 'wz-ground-shape');
  const caption = el('div', 'wz-ground-caption');
  ground.append(caption);
  canvas.append(ground);
  stage.append(canvas);

  const read = () => ({ name: name.value.trim(), at: parsePlace(place.value), width_m: Number(width.value), height_m: Number(height.value) });
  const draw = (): void => {
    const { name: title, at, width_m, height_m } = read();
    const sized = width_m >= 100 && height_m >= 100;
    ground.style.aspectRatio = sized ? `${width_m} / ${height_m}` : '5 / 3';
    ground.style.setProperty('--aspect', String(sized ? width_m / height_m : 5 / 3));
    caption.replaceChildren(
      el('strong', undefined, title || 'Your table'),
      el('span', undefined, sized ? `${Math.round(width_m)} by ${Math.round(height_m)} metres` : 'Give a width and a height'),
      el('span', undefined, at ? `Centred on ${at.lat.toFixed(4)}, ${at.lon.toFixed(4)}` : 'No place yet'),
    );
  };
  for (const input of [name, place, width, height]) {
    input.addEventListener('input', draw);
    input.addEventListener('input', () => invoke && say(''));
  }
  draw();

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
      const path = await invoke!('create_site', { site: { name: title, lat: at.lat, lon: at.lon, width_m, height_m } });
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
