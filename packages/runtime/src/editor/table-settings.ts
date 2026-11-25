/**
 * The table's own settings (#73, #62), stored in its site.json, as the two dialogs of the
 * Design tab (#382): Table size and place (with the guide's place form) and Welcome and
 * languages. Each field is tagged with its one home (settings-list.ts, #392).
 *
 * This computer's settings (screens, colour, calibration, quality) are in Present › Screens and
 * calibration…; keys and outside sources in the app's settings. A setting is in one place only.
 */
import type { Store } from '../store.ts';
import { el } from '../controls.ts';
import { icon } from './icons.ts';
import { addMedia, siteMedia } from './slides.ts';
import { setting } from './settings-list.ts';

export interface TableSettingsHost {
  store: Store;
  /** Sends a request to the host; a refusal shows on the status line and resolves to null. */
  send: <T = unknown>(method: string, params: object) => Promise<T | null>;
}

function field(label: string, input: HTMLElement, hint?: string): HTMLElement {
  const row = el('label', 'ed-field');
  row.append(el('span', undefined, label), input);
  if (!hint) return row;
  const wrap = el('div', 'ed-field-wrap');
  wrap.append(row, el('p', 'ed-hint', hint));
  return wrap;
}

/**
 * The table's own words in Swedish (#80): its name, title and welcome line, its About page,
 * the names it gave layer buttons and its slides' titles. Each English text with a box for its
 * Swedish; the layers' own words come with them.
 */
function swedishWords(store: Store, save: (translations: Record<string, string>) => void): HTMLElement {
  const box = el('div', 'ed-translations');
  const site = store.state.site;
  const texts = new Set<string>();
  const add = (text: string | null | undefined) => text?.trim() && texts.add(text.trim());
  add(site.name);
  add(site.branding.title);
  add(site.branding.welcome);
  add(site.tv?.about?.title);
  add(site.tv?.about?.text);
  for (const credit of site.tv?.about?.credits ?? []) {
    add(credit.role);
    add(credit.note);
  }
  for (const id of store.state.scene) {
    const state = store.state.layers[id];
    add(state?.button?.name);
    add(state?.button?.description);
    for (const step of state?.steps?.sequence ?? []) {
      add(step.title);
      add(step.description);
    }
  }
  const saved = { ...(site.branding.translations?.sv ?? {}) };
  const missing = [...texts].filter((english) => !saved[english]).length;
  box.append(el('p', 'ed-hint', missing === 0 ? 'Every text of this table has its Swedish.' : `${missing} of ${texts.size} texts have no Swedish yet. Visitors see those in English.`));
  for (const english of texts) {
    const row = el('label', 'ed-translation');
    const input = el('input');
    Object.assign(input, { type: 'text', maxLength: 2000, placeholder: 'Swedish', value: saved[english] ?? '', lang: 'sv' });
    input.addEventListener('change', () => {
      const value = input.value.trim();
      if (value) saved[english] = value;
      else delete saved[english];
      save(saved);
    });
    row.append(el('span', undefined, english), input);
    box.append(row);
  }
  return box;
}

function text(value: string | null | undefined, maxLength: number, placeholder: string, onChange: (value: string | null) => void): HTMLInputElement {
  const input = el('input');
  Object.assign(input, { type: 'text', maxLength, placeholder, value: value ?? '' });
  input.addEventListener('change', () => onChange(input.value.trim() || null));
  return input;
}

/** Every time zone the browser knows, the table's own first if it is not among them. */
function zones(current: string | null): string[] {
  let list: string[] = [];
  try {
    list = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  } catch {
    // An older browser: the current zone and UTC are offered.
  }
  if (!list.includes('UTC')) list = ['UTC', ...list];
  if (current && !list.includes(current)) list = [current, ...list];
  return list;
}

/** Pictures a logo can be: the table's media that are images. */
const PICTURE = /\.(png|jpe?g|webp|gif|svg)$/i;

/**
 * The logo (#156): a list of the table's pictures, a small preview, and Add a picture,
 * instead of a path to type. Choosing "No logo" takes it off the controller.
 */
function logoPicker(current: string | null, onChange: (path: string | null) => void): HTMLElement {
  const box = el('div', 'ed-logo');
  const preview = el('img', 'ed-logo-preview');
  preview.alt = '';
  const pick = el('select');
  pick.ariaLabel = 'Logo';
  const status = el('span', 'ed-hint');
  let value = current;
  const show = () => {
    preview.hidden = !value;
    if (value) preview.src = `/site/${value.replace(/^\/+/, '')}`;
  };
  const fill = async () => {
    const files = (await siteMedia()).filter((f) => PICTURE.test(f));
    if (value && !files.includes(value)) files.unshift(value);
    const none = Object.assign(el('option', undefined, 'No logo'), { value: '' });
    pick.replaceChildren(none, ...files.map((f) => Object.assign(el('option', undefined, f.replace(/^data\/media\//, '')), { value: f })));
    pick.value = value ?? '';
  };
  const choose = (path: string | null) => {
    value = path;
    show();
    onChange(path);
  };
  pick.addEventListener('change', () => choose(pick.value || null));
  const input = Object.assign(el('input'), { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml,.png,.jpg,.jpeg,.webp,.gif,.svg', hidden: true });
  const upload = el('button', 'ed-button');
  upload.type = 'button';
  upload.append(icon('plus', 14), el('span', undefined, 'Add a picture'));
  upload.title = 'A PNG, JPEG, WebP, GIF or SVG picture, kept in this table';
  upload.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    status.textContent = 'Adding…';
    try {
      const [path] = await addMedia(input.files ?? []);
      status.textContent = '';
      if (path) {
        choose(path);
        await fill();
      }
    } catch (error) {
      status.textContent = (error as Error).message;
    }
    input.value = '';
  });
  show();
  void fill();
  box.append(preview, pick, upload, input, status);
  return box;
}

/** Table size and place, below the place form: the time zone, and how the table stands in the room. */
export function placeSettings(host: TableSettingsHost): HTMLElement[] {
  const { store, send } = host;
  const site = store.state.site;
  const table = (patch: object) => void send('site.table', patch);

  const about = el('section', 'ed-section');
  const zone = setting('table.timezone', 'dialog:place', el('select'));
  for (const z of zones(site.timezone)) zone.append(Object.assign(el('option'), { value: z, textContent: z.replaceAll('_', ' ') }));
  zone.prepend(Object.assign(el('option'), { value: '', textContent: 'This computer’s time zone' }));
  zone.value = site.timezone ?? '';
  zone.addEventListener('change', () => table({ timezone: zone.value || null }));
  about.append(el('h3', undefined, 'Time'), field('Time zone', zone, 'The sun study and clocks use it. It is the place’s zone, not this computer’s.'));

  // ---- The table in the room (#62, #78): where visitors stand, the ribbons ----
  const t = site.table;
  if (!t) return [about];
  const physical = el('section', 'ed-section');
  physical.append(el('h3', undefined, 'In the room'));
  const SIDES = [
    ['bottom', 'Bottom'],
    ['top', 'Top'],
    ['left', 'Left'],
    ['right', 'Right'],
  ] as const;
  const front = setting('table.front', 'dialog:place', el('select'));
  for (const [value, label] of SIDES) front.append(Object.assign(el('option'), { value, textContent: `${label} edge` }));
  front.value = t.front ?? 'bottom';
  front.addEventListener('change', () => table({ table: { front: front.value === 'bottom' ? null : front.value } }));
  physical.append(field('Visitors stand at', front, 'The side of the projected picture nearest the visitors. Ribbons go there first, because the model hides what is behind it.'));
  const ribbons = setting('table.ribbons', 'dialog:place', el('div', 'ed-ribbon-sides'));
  const value = (ribbon: unknown): string => (ribbon === undefined || ribbon === null ? '' : typeof ribbon === 'string' ? ribbon : String((ribbon as { cm: number }).cm));
  for (const [side, label] of SIDES) {
    const pick = el('select');
    pick.ariaLabel = `${label} ribbon`;
    for (const [v, text] of [
      ['', 'Default'],
      ['off', 'Off'],
      ['auto', 'If room'],
      ['6', '6 cm'],
      ['9', '9 cm'],
      ['12', '12 cm'],
      ['15', '15 cm'],
    ]) pick.append(Object.assign(el('option'), { value: v, textContent: text }));
    const now = value((t.ribbons as Record<string, unknown> | undefined)?.[side]);
    if (now && ![...pick.options].some((o) => o.value === now)) pick.append(Object.assign(el('option'), { value: now, textContent: `${now} cm` }));
    pick.value = now;
    pick.addEventListener('change', () => {
      const v = pick.value;
      table({ table: { ribbons: { [side]: v === '' ? null : v === 'off' || v === 'auto' ? v : { cm: Number(v) } } } });
    });
    const row = el('div', 'ed-ribbon-side');
    row.append(el('span', undefined, label), pick);
    ribbons.append(row);
  }
  physical.append(field('Ribbons', ribbons, 'The strips of the projected picture beside the model that show the open layer at a glance. Default puts one at the visitors’ side when there is room; If room tries this side too.'));
  return [about, physical];
}

/** Welcome and languages: what the controller says when nobody is using the table, and in which languages. */
export function welcomeSettings(host: TableSettingsHost): HTMLElement[] {
  const { store, send } = host;
  const site = store.state.site;
  const table = (patch: object) => void send('site.table', patch);
  const tv = (patch: object) => void send('site.tv', { tv: patch });

  const look = el('section', 'ed-section');
  const b = site.branding;
  const title = setting('controller.title', 'dialog:welcome', text(b.title, 80, site.name, (value) => table({ branding: { title: value } })));
  const welcome = setting('controller.welcome', 'dialog:welcome', text(b.welcome, 160, 'Choose a layer to bring it to the table.', (value) => table({ branding: { welcome: value } })));
  const logo = setting('controller.logo', 'dialog:welcome', logoPicker(b.logo ?? null, (value) => table({ branding: { logo: value } })));
  const number = (value: number | undefined, min: number, max: number, unit: string, onChange: (value: number) => void) => {
    const box = el('div', 'ed-number');
    const input = el('input');
    Object.assign(input, { type: 'number', min: String(min), max: String(max), value: value === undefined ? '' : String(value) });
    input.addEventListener('change', () => {
      const n = Number(input.value);
      if (input.value !== '' && Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
    });
    box.append(input, el('span', undefined, unit));
    return box;
  };
  const idle = setting('controller.idle', 'dialog:welcome', number(site.tv?.idle_reset_s ?? 180, 0, 3600, 's, 0 never', (s) => tv({ idle_reset_s: s })));
  const loop = setting('controller.loop', 'dialog:welcome', number(site.tv?.attract_s ?? 4, 2, 30, 's per layer', (s) => tv({ attract_s: s })));
  // Phones turn layers on and off unless the table says not (#335).
  const phones = setting('controller.phones', 'dialog:welcome', el('input'));
  Object.assign(phones, { type: 'checkbox', checked: site.tv?.phone_switch !== false });
  phones.addEventListener('change', () => tv({ phone_switch: phones.checked ? null : false }));
  look.append(
    el('h3', undefined, 'On the controller'),
    field('Title', title),
    field('Welcome', welcome, 'Under the title when nobody is using the table.'),
    field('Logo', logo, 'Shown above the title on the controller’s welcome screen and on phones.'),
    field('Back home after', idle),
    field('Welcome loop', loop),
    field('Phones can switch layers', phones, 'Visitors turn layers on and off from their phones. Never while a slideshow is showing.'),
  );

  // ---- Languages for visitors (#80) ----
  const speech = el('section', 'ed-section');
  const languages = setting('controller.languages', 'dialog:welcome', el('select'));
  for (const [value, label] of [
    ['en', 'English only'],
    ['en,sv', 'English and Swedish, starting in English'],
    ['sv,en', 'Swedish and English, starting in Swedish'],
  ] as const) {
    languages.append(Object.assign(el('option'), { value, textContent: label }));
  }
  const offeredNow = (b.languages ?? []).join(',');
  languages.value = ['en,sv', 'sv,en'].includes(offeredNow) ? offeredNow : 'en';
  const words = setting('controller.translations', 'dialog:welcome', swedishWords(store, (translations) => table({ branding: { translations: { ...(store.state.site.branding.translations ?? {}), sv: translations } } })));
  words.hidden = languages.value === 'en';
  languages.addEventListener('change', () => {
    table({ branding: { languages: languages.value.split(',') } });
    words.hidden = languages.value === 'en';
  });
  speech.append(
    el('h3', undefined, 'Languages for visitors'),
    field('Visitors read', languages, 'With two languages, SV and EN buttons appear on the controller and the phones. The layers bring their own Swedish; the words this table adds are below.'),
    words,
  );
  return [look, speech];
}
