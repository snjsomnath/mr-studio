/**
 * Export starter pack (#450): the table's basics as files to draw on in QGIS, Illustrator,
 * Photoshop or PowerPoint, with instructions for each and for bringing the result back. The
 * person picks what goes in, sees it, and saves the pack or emails it. The host makes the
 * preview and the pack (`GET /api/starter`, crates/mrs-site/src/starter.rs); the app saves it
 * through a save dialog or attaches it to a new email, as Share by email does (#372).
 */
import { el } from '../controls.ts';

type Invoke = (cmd: string, args?: object) => Promise<unknown>;

export interface StarterOptions {
  features: string[];
  apps: string[];
  canvas: 'table' | 'projection';
  px_per_cm: number;
}

const FEATURES: { id: string; name: string; tip: string }[] = [
  { id: 'table', name: 'Table outline', tip: 'The edge of the model: the frame everything lines up to' },
  { id: 'tiles', name: 'Tile grid', tip: 'The 3D-printed tiles, named A1, B1… like a spreadsheet' },
  { id: 'buildings', name: 'Building footprints', tip: 'The buildings the table has' },
  { id: 'streets', name: 'Street network', tip: 'The streets dataset (roads)' },
  { id: 'projection', name: 'Projection area', tip: 'Where the projector’s image lands around the model' },
  { id: 'glance', name: 'At-a-glance boxes', tip: 'The ribbons in the projector’s blank space, from Table size and place' },
];

const APPS: { id: string; name: string; gets: string }[] = [
  { id: 'qgis', name: 'QGIS', gets: 'GeoJSON layers and a placed picture' },
  { id: 'illustrator', name: 'Illustrator', gets: 'A layered SVG at real size' },
  { id: 'photoshop', name: 'Photoshop', gets: 'One PNG layer per feature' },
  { id: 'powerpoint', name: 'PowerPoint', gets: 'A slide the table’s shape' },
];

const DETAIL = [
  { ppc: 10, name: 'Draft' },
  { ppc: 20, name: 'Good' },
  { ppc: 40, name: 'Print' },
];

const KEY = 'mrs-starter-pack';

const DEFAULTS: StarterOptions = { features: ['table', 'tiles', 'buildings', 'streets'], apps: APPS.map((a) => a.id), canvas: 'table', px_per_cm: 20 };

function remembered(): StarterOptions {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<StarterOptions> | null;
    return { ...DEFAULTS, ...(saved ?? {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

function remember(options: StarterOptions): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(options));
  } catch {
    // A private window: the choice is not kept.
  }
}

/** The query `GET /api/starter` takes. */
export function starterQuery(options: StarterOptions, as: 'json' | 'zip' = 'json'): string {
  const q = new URLSearchParams({ features: options.features.join(','), apps: options.apps.join(','), canvas: options.canvas, ppc: String(options.px_per_cm), as });
  return `/api/starter?${q}`;
}

interface Preview {
  svg?: string;
  notes?: string[];
  table_cm?: [number, number];
  canvas?: [number, number, number, number];
  picture?: { width_px: number; height_px: number; px_per_cm: number };
  projection?: 'projector' | 'table' | 'estimate';
  features?: { id: string; count: number }[];
  error?: string;
}

/** Opens the dialog. `invoke` is the desktop app's, or undefined in a browser, which downloads instead. */
export function openStarterPack(invoke: Invoke | undefined, tableName: string): void {
  const options = remembered();
  const dialog = el('dialog', 'ed-starter');
  dialog.setAttribute('aria-label', 'Export starter pack');
  const head = el('header', 'ed-starter-head');
  head.append(el('h2', undefined, 'Export starter pack'), el('p', undefined, 'The table’s outline and features, ready to draw on in another program. What you make there comes back in place.'));

  const side = el('div', 'ed-starter-side');
  const view = el('div', 'ed-starter-view');
  const frame = el('div', 'ed-starter-frame');
  const facts = el('p', 'ed-starter-facts');
  const notes = el('ul', 'ed-starter-notes');
  view.append(frame, facts, notes);

  const section = (title: string) => {
    const fieldset = el('fieldset', 'ed-starter-group');
    fieldset.append(el('legend', undefined, title));
    side.append(fieldset);
    return fieldset;
  };

  const include = section('Include');
  const counts = new Map<string, HTMLElement>();
  for (const f of FEATURES) {
    const label = el('label', 'ed-starter-check');
    label.title = f.tip;
    const box = el('input');
    box.type = 'checkbox';
    box.checked = options.features.includes(f.id);
    box.addEventListener('change', () => {
      options.features = FEATURES.map((x) => x.id).filter((id) => (id === f.id ? box.checked : options.features.includes(id)));
      if ((f.id === 'projection' || f.id === 'glance') && box.checked && options.canvas === 'table') setCanvas('projection');
      void refresh();
    });
    const count = el('span', 'ed-starter-count');
    counts.set(f.id, count);
    label.append(box, el('span', undefined, f.name), count);
    include.append(label);
  }

  const canvasGroup = section('Canvas');
  const canvasInputs = new Map<string, HTMLInputElement>();
  for (const [id, name, tip] of [
    ['table', 'The table', 'Exactly the table’s frame. A picture or drawing made on it comes back in place.'],
    ['projection', 'Table and projection area', 'Adds the projector’s margins, for at-a-glance art around the model.'],
  ] as const) {
    const label = el('label', 'ed-starter-radio');
    const radio = el('input');
    radio.type = 'radio';
    radio.name = 'ed-starter-canvas';
    radio.checked = options.canvas === id;
    radio.addEventListener('change', () => radio.checked && setCanvas(id));
    canvasInputs.set(id, radio);
    const words = el('span');
    words.append(el('strong', undefined, name), el('small', undefined, tip));
    label.append(radio, words);
    canvasGroup.append(label);
  }
  function setCanvas(id: 'table' | 'projection'): void {
    options.canvas = id;
    const input = canvasInputs.get(id);
    if (input) input.checked = true;
    void refresh();
  }

  const forGroup = section('Prepare files for');
  for (const a of APPS) {
    const label = el('label', 'ed-starter-check');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = options.apps.includes(a.id);
    box.addEventListener('change', () => {
      options.apps = APPS.map((x) => x.id).filter((id) => (id === a.id ? box.checked : options.apps.includes(id)));
      void refresh();
    });
    const words = el('span');
    words.append(el('strong', undefined, a.name), el('small', undefined, a.gets));
    label.append(box, words);
    forGroup.append(label);
  }

  const detailGroup = section('Picture detail');
  const detail = el('select', 'ed-starter-select');
  for (const d of DETAIL) {
    const option = el('option', undefined, `${d.name}, ${d.ppc} px per cm`);
    option.value = String(d.ppc);
    option.selected = d.ppc === options.px_per_cm;
    detail.append(option);
  }
  detail.addEventListener('change', () => {
    options.px_per_cm = Number(detail.value);
    void refresh();
  });
  detailGroup.append(detail);

  const body = el('div', 'ed-starter-body');
  body.append(side, view);

  const foot = el('footer', 'ed-starter-foot');
  const status = el('span', 'ed-starter-status');
  const cancel = el('button', 'ed-button', 'Close');
  cancel.type = 'button';
  const actions: HTMLButtonElement[] = [];
  const action = (label: string, primary: boolean, run: () => Promise<void>) => {
    const button = el('button', `ed-button${primary ? ' is-primary' : ''}`, label);
    button.type = 'button';
    button.addEventListener('click', async () => {
      actions.forEach((b) => (b.disabled = true));
      status.textContent = 'Making the pack…';
      try {
        remember(options);
        await run();
        status.textContent = '';
        close();
      } catch (error) {
        status.textContent = String((error as Error)?.message ?? error);
        actions.forEach((b) => (b.disabled = false));
      }
    });
    actions.push(button);
    return button;
  };
  if (invoke) {
    foot.append(
      status,
      cancel,
      action('Email…', false, async () => void (await invoke('starter_pack', { options, how: 'email' }))),
      action('Save…', true, async () => void (await invoke('starter_pack', { options, how: 'save' }))),
    );
  } else {
    foot.append(
      status,
      cancel,
      action('Download', true, async () => {
        const response = await fetch(starterQuery(options, 'zip'), { cache: 'no-store' });
        if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `The pack could not be made (${response.status})`);
        const url = URL.createObjectURL(await response.blob());
        const link = el('a');
        link.href = url;
        link.download = `${tableName} starter pack.zip`;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      }),
    );
  }
  dialog.append(head, body, foot);

  let asked = 0;
  async function refresh(): Promise<void> {
    const ticket = ++asked;
    const nothing = !options.apps.length ? 'Choose at least one program.' : !options.features.length ? 'Choose at least one thing to include.' : '';
    actions.forEach((b) => (b.disabled = Boolean(nothing)));
    status.textContent = nothing;
    let preview: Preview;
    try {
      const response = await fetch(starterQuery(options), { cache: 'no-store' });
      preview = (await response.json()) as Preview;
    } catch (error) {
      preview = { error: String(error) };
    }
    if (ticket !== asked) return;
    if (preview.error || !preview.svg) {
      frame.textContent = preview.error ?? 'No preview';
      return;
    }
    // The host's own drawing of the table: shapes and tile names, nothing that runs.
    frame.innerHTML = preview.svg.replace(/^<\?xml[^>]*>\s*/, '');
    const svg = frame.querySelector('svg');
    svg?.removeAttribute('width');
    svg?.removeAttribute('height');
    for (const f of FEATURES) {
      const found = preview.features?.find((x) => x.id === f.id);
      const count = counts.get(f.id);
      if (count) count.textContent = found ? (f.id === 'table' || f.id === 'projection' ? '' : String(found.count)) : '';
    }
    const [, , w = 0, h = 0] = preview.canvas ?? [];
    const pic = preview.picture;
    facts.textContent = `Canvas ${w.toFixed(1)} × ${h.toFixed(1)} cm${pic ? `, pictures ${pic.width_px} × ${pic.height_px} px` : ''}.`;
    notes.replaceChildren(...(preview.notes ?? []).map((n) => el('li', undefined, n)));
  }

  const close = () => {
    dialog.close();
    dialog.remove();
  };
  cancel.addEventListener('click', close);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  // Inside the editor, so the dialog takes its colours, type and buttons.
  (document.querySelector('.ed') ?? document.body).append(dialog);
  dialog.showModal();
  void refresh();
}
