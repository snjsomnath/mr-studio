/**
 * Table settings (#73, #62): what belongs to this table only, stored in its site.json.
 *
 * App settings (screens, colour, calibration, updates, keys and outside sources, phones on
 * the network) belong to this computer and live in MR Studio > Settings. A setting is in
 * one of the two places, never both. The welcome line and title are edited here and shown
 * on the controller; the controller page previews them.
 */
import type { Store } from '../store.ts';
import { el } from '../controls.ts';
import { icon } from './icons.ts';
import { addMedia, siteMedia } from './slides.ts';

export interface TableSettingsHost {
  store: Store;
  /** Sends a request to the host; a refusal shows on the status line and resolves to null. */
  send: <T = unknown>(method: string, params: object) => Promise<T | null>;
  /** Opens the setup guide where the place and size are set. */
  place: () => void;
  /** Opens the app settings window (screens, colour, sources), when the app is there. */
  appSettings: (() => void) | null;
}

interface SourcesUsed {
  sources: { source: string; layers: { id: string; name: string }[] }[];
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

export function tableSettings(host: TableSettingsHost): HTMLElement[] {
  const { store, send } = host;
  const site = store.state.site;
  const table = (patch: object) => void send('site.table', patch);
  const tv = (patch: object) => void send('site.tv', { tv: patch });

  // ---- This table ----
  const about = el('section', 'ed-section');
  const name = text(site.name, 60, 'A name for this table', (value) => {
    if (value) table({ name: value });
    else name.value = store.state.site.name;
  });
  const zone = el('select');
  for (const z of zones(site.timezone)) zone.append(Object.assign(el('option'), { value: z, textContent: z.replaceAll('_', ' ') }));
  zone.prepend(Object.assign(el('option'), { value: '', textContent: 'This computer’s time zone' }));
  zone.value = site.timezone ?? '';
  zone.addEventListener('change', () => table({ timezone: zone.value || null }));
  const { width_m, height_m } = site.extent;
  const where = el('div', 'ed-place');
  const scale = site.table?.width_cm ? ` · ${site.table.width_cm} × ${site.table.height_cm} cm table, 1 : ${Math.round((width_m * 100) / site.table.width_cm)}` : '';
  where.append(el('span', undefined, `${width_m} × ${height_m} m around ${site.origin.lat.toFixed(4)}, ${site.origin.lon.toFixed(4)}${scale}`));
  const move = el('button', 'ed-button', 'Change place and size');
  move.type = 'button';
  move.addEventListener('click', () => host.place());
  where.append(move);
  about.append(
    el('h3', undefined, 'This table'),
    field('Name', name),
    field('Time zone', zone, 'The sun study and clocks use it. It is the place’s zone, not this computer’s.'),
    field('Place', where),
  );

  // ---- On the controller ----
  const look = el('section', 'ed-section');
  const b = site.branding;
  const title = text(b.title, 80, site.name, (value) => table({ branding: { title: value } }));
  const welcome = text(b.welcome, 160, 'Choose a layer to bring it to the table.', (value) => table({ branding: { welcome: value } }));
  const logo = logoPicker(b.logo ?? null, (value) => table({ branding: { logo: value } }));
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
  const idle = number(site.tv?.idle_reset_s ?? 180, 0, 3600, 's, 0 never', (s) => tv({ idle_reset_s: s }));
  const loop = number(site.tv?.attract_s ?? 4, 2, 30, 's per layer', (s) => tv({ attract_s: s }));
  look.append(
    el('h3', undefined, 'On the controller'),
    field('Title', title),
    field('Welcome', welcome, 'Under the title when nobody is using the table.'),
    field('Logo', logo, 'Shown above the title on the controller’s welcome screen and on phones.'),
    field('Back home after', idle),
    field('Welcome loop', loop),
  );

  // ---- Languages for visitors (#80) ----
  const speech = el('section', 'ed-section');
  const languages = el('select');
  for (const [value, label] of [
    ['en', 'English only'],
    ['en,sv', 'English and Swedish, starting in English'],
    ['sv,en', 'Swedish and English, starting in Swedish'],
  ] as const) {
    languages.append(Object.assign(el('option'), { value, textContent: label }));
  }
  const offeredNow = (b.languages ?? []).join(',');
  languages.value = ['en,sv', 'sv,en'].includes(offeredNow) ? offeredNow : 'en';
  const words = swedishWords(store, (translations) => table({ branding: { translations: { ...(store.state.site.branding.translations ?? {}), sv: translations } } }));
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

  // ---- Sources ----
  const sources = el('section', 'ed-section');
  const list = el('div', 'ed-sources-used');
  list.append(el('p', 'ed-empty', 'Looking…'));
  void send<SourcesUsed>('site.sources', {}).then((used) => {
    list.replaceChildren();
    if (!used || used.sources.length === 0) {
      list.append(el('p', 'ed-empty', 'This table uses no outside sources. Everything it shows is in its folder or free to use.'));
      return;
    }
    for (const { source, layers } of used.sources) {
      const row = el('div', 'ed-source-row');
      const badge = el('span', 'ed-row-icon');
      badge.append(icon('map', 14));
      const words = el('div');
      words.append(el('strong', undefined, source), el('span', undefined, `Used by ${layers.map((l) => l.name).join(', ')}`));
      row.append(badge, words);
      list.append(row);
    }
  });
  sources.append(el('h3', undefined, 'Sources this table uses'), list);
  if (host.appSettings) {
    const manage = el('button', 'ed-button', 'Keys and sources…');
    manage.type = 'button';
    manage.title = 'Keys and outside sources belong to this computer: they are app settings';
    manage.addEventListener('click', () => host.appSettings?.());
    sources.append(manage);
  }

  // ---- Where the rest is ----
  const elsewhere = el('section', 'ed-section');
  const settingsName = navigator.platform.startsWith('Mac') ? 'MR Studio › Settings…' : 'File › Settings…';
  elsewhere.append(
    el('h3', undefined, 'On this computer'),
    el('p', 'ed-empty', `Screens, colour, calibration, updates, keys and phones on the network are the same for every table on this computer. They are in ${settingsName}`),
  );
  return [about, look, speech, sources, elsewhere];
}
