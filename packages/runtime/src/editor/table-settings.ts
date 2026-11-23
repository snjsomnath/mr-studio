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
  const logo = text(b.logo, 200, 'A picture in the table’s folder, such as media/logo.png', (value) => table({ branding: { logo: value } }));
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
    field('Logo', logo),
    field('Back home after', idle),
    field('Welcome loop', loop),
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
  return [about, look, sources, elsewhere];
}
