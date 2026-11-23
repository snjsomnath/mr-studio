import { DEFAULT_TRANSITION, MAX_TRANSITION_S, readSiteData } from '@mrstudio/sdk';
import type { LayerManifest, LayerState, SequenceStep, Steps, StepTransitionKind } from '@mrstudio/sdk';

import { el, isAmbient, layerButton } from '../controls.ts';
import type { Store } from '../store.ts';
import { icon } from './icons.ts';

/** What the slides section needs from the editor. */
export interface SlidesHost {
  readonly store: Store;
  send(method: string, params: object): Promise<any>;
  /** Opens a slide's own settings under the list: one of the slideshow's items. */
  select(item: string | null): void;
  /** Goes to a layer of the table that a slide shows. */
  open(layer: string): void;
  /** Calls back whenever the slideshow's state changes. */
  watch(callback: (state: LayerState) => void): void;
  /** The item whose settings are open. */
  readonly selected: string | null;
}

/** The legacy slideshow controls: a slideshow of layers moves with the controller's ◀ ▶ instead. */
export const LEGACY_CONTROLS = ['slide', 'previous', 'next', 'play', 'seconds', 'captions'];

/** What a slide can be made from besides the table's own layers. */
const NEW_SLIDES: { use: string; label: string }[] = [
  { use: 'media', label: 'Picture or video' },
  { use: 'wms', label: 'Web map (WMS)' },
  { use: 'mapdata', label: 'Map data from this site' },
];

function segmented<T extends string>(label: string, options: [T, string][], onPick: (value: T) => void): { element: HTMLElement; set(value: T): void } {
  const element = el('div', 'segmented');
  element.setAttribute('role', 'radiogroup');
  element.setAttribute('aria-label', label);
  const buttons = options.map(([value, text]) => {
    const option = el('button', undefined, text);
    option.type = 'button';
    option.setAttribute('role', 'radio');
    option.addEventListener('click', () => onPick(value));
    element.append(option);
    return [value, option] as const;
  });
  return { element, set: (value) => buttons.forEach(([v, b]) => b.setAttribute('aria-checked', String(v === value))) };
}

/** How a slide comes in: the words the editor uses for each transition. */
const TRANSITIONS: [StepTransitionKind, string][] = [
  ['fade', 'Cross-fade'],
  ['dip', 'Fade through the map'],
  ['cut', 'Cut'],
];

/** The site's pictures and video, as paths inside the site (`data/media/x.png`). */
async function siteMedia(): Promise<string[]> {
  const answer = (await fetch('/api/data/media').then((r) => r.json()).catch(() => ({ media: [] }))) as { media?: string[] };
  return answer.media ?? [];
}

/** Keeps pictures or video in the table; answers their paths, or throws with the host's reason. */
async function addMedia(files: Iterable<File>): Promise<string[]> {
  const paths: string[] = [];
  for (const file of files) {
    const response = await fetch(`/api/data/media?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
    const answer = (await response.json().catch(() => ({}))) as { path?: string; error?: string };
    if (!response.ok || !answer.path) throw new Error(`${file.name}: ${answer.error ?? `HTTP ${response.status}`}`);
    paths.push(answer.path);
  }
  return paths;
}

/** A file's name as a slide title: "satellite_current.png" reads "Satellite current". */
function titleOf(path: string): string {
  const stem = (path.split('/').pop() ?? path).replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
  return stem.charAt(0).toUpperCase() + stem.slice(1);
}

/** A slide of the earlier app's `slideshow.json` (see the slideshow layer's README). */
interface OldSlide {
  type: string;
  media?: string;
  duration?: number;
  fitMode?: string;
  rotation?: number;
  enabled?: boolean;
  wms?: { url?: string; layers?: string };
  metadata?: { title?: string; description?: string; source?: string };
}

function field(label: string, input: HTMLElement): HTMLElement {
  const row = el('div', 'ed-field');
  row.append(el('span', undefined, label), input);
  return row;
}

function small(label: string, iconName: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', 'ed-slide-tool');
  b.type = 'button';
  b.ariaLabel = label;
  b.title = label;
  b.append(icon(iconName, 14));
  b.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return b;
}

/**
 * The slideshow's slides (#43): a sequence of layers, each a layer of the table or one of
 * the slideshow's own items (a WMS map, a dataset of the site). Manual or timed, and what
 * the controller's Next does on each slide, as in the Chalmers campus demo.
 */
export function slidesSection(host: SlidesHost, id: string): HTMLElement {
  const { store } = host;
  const section = el('section', 'ed-section ed-slides');
  section.dataset.slides = id;
  const steps = (): Steps => store.state.layers[id]?.steps ?? {};
  const save = async (patch: Partial<Steps>) => {
    const next: Steps = { ...steps(), ...patch };
    const first = !steps().sequence?.length && (next.sequence?.length ?? 0) > 0;
    await host.send('scene.set', { layer: id, steps: next });
    // The old slide controls give way to the controller's ◀ ▶ once the slideshow is made of layers.
    if (first) {
      const hide = [...new Set([...(store.state.layers[id]?.hide ?? []), ...LEGACY_CONTROLS])];
      await host.send('scene.set', { layer: id, hide });
    }
  };
  const setSequence = (sequence: SequenceStep[]) => save({ sequence });

  const mode = segmented<'manual' | 'timed'>('How the slides move on', [['manual', 'Manual'], ['timed', 'Timed']], (value) => void save({ mode: value }));
  const end = segmented<'loop' | 'stop'>('After the last slide', [['loop', 'Start again'], ['stop', 'Stop']], (value) => void save({ loop: value === 'loop' }));
  const reveal = segmented<'then-next' | 'stop'>(
    'What Next does after the last category',
    [['then-next', 'Next slide'], ['stop', 'Stays']],
    (value) => void save({ reveal: value }),
  );

  const transition = segmented<StepTransitionKind>('How each slide comes in', TRANSITIONS, (value) => void save({ transition: value }));
  const fadeFor = el('input');
  Object.assign(fadeFor, { type: 'number', min: '0', max: String(MAX_TRANSITION_S), step: '0.1', placeholder: String(DEFAULT_TRANSITION.seconds) });
  fadeFor.ariaLabel = 'Seconds each transition takes';
  fadeFor.addEventListener('change', () => {
    const value = Number(fadeFor.value);
    void save({ transition_s: fadeFor.value === '' || !Number.isFinite(value) ? undefined : Math.min(MAX_TRANSITION_S, Math.max(0, value)) });
  });
  const fadeWrap = el('label', 'ed-slide-seconds');
  fadeWrap.append(fadeFor, el('span', undefined, 's'));
  const transitionRow = el('div', 'ed-slide-transition');
  transitionRow.append(transition.element, fadeWrap);

  const list = el('ol', 'ed-slide-list');
  const add = el('select', 'ed-slide-add');
  add.ariaLabel = 'Add a slide';
  add.addEventListener('change', () => {
    const value = add.value;
    add.value = '';
    void addSlide(value);
  });

  async function addSlide(value: string): Promise<void> {
    const sequence = [...(steps().sequence ?? [])];
    if (value.startsWith('layer:')) {
      sequence.push({ layer: value.slice(6) });
      await setSequence(sequence);
      return;
    }
    if (value.startsWith('map:')) {
      // A map that comes with MR Studio (#200): a Web map slide with that map chosen, titled by it.
      const map = value.slice(4);
      const result = await host.send('scene.add', { use: 'wms', parent: id });
      if (!result?.id) return;
      await host.send('scene.set', { layer: result.id, params: { map } });
      sequence.push({ layer: result.id, title: builtInMaps().find((o) => o.value === map)?.label });
      await setSequence(sequence);
      host.select(result.id);
      return;
    }
    if (value.startsWith('new:')) {
      const result = await host.send('scene.add', { use: value.slice(4), parent: id });
      if (!result?.id) return;
      sequence.push({ layer: result.id });
      await setSequence(sequence);
      host.select(result.id);
    }
  }

  const help = el(
    'p',
    'ed-hint',
    'Next comes from the controller, a phone, the arrow keys or a clicker. On a slide whose map reveals its categories one by one, Next reveals the next one first. Shift+Next or a long press always goes on to the next slide.',
  );

  // Try Next as visitors will: on the map in the editor and on the table.
  const tryNext = el('button', 'ed-slide-try');
  tryNext.type = 'button';
  tryNext.append(icon('play', 14), el('span', undefined, 'Try Next'));
  tryNext.title = 'Press Next as a visitor would, and watch the map';
  tryNext.addEventListener('click', async () => {
    if (!store.state.layers[id]?.active) await host.send('layer.activate', { layer: id, active: true });
    else await host.send('layer.step', { layer: id, to: 'next' });
  });
  const position = el('span', 'ed-slide-position');
  const heading = el('div', 'ed-slides-head');
  heading.append(el('h3', undefined, 'Slides'), position, tryNext);

  section.append(
    heading,
    list,
    add,
    field('Moves on', mode.element),
    field('Transition', transitionRow),
    field('At the end', end.element),
    field('After the last category', reveal.element),
    help,
  );

  /** The maps the Web map layer comes with: its `map` choices other than a service of one's own. */
  const builtInMaps = (): { value: string; label: string }[] => {
    const control = store.manifest('wms')?.controls?.find((c) => c.id === 'map');
    return control?.type === 'select' ? control.options.filter((o) => o.value !== 'custom') : [];
  };

  const nameOf = (layer: string): { name: string; icon?: string; item: boolean } => {
    const state = store.state.layers[layer];
    const manifest = state && store.manifest(state.layer);
    if (!state || !manifest) return { name: layer, item: false };
    return { name: state.parent ? manifest.name : layerButton(layer, manifest, state).name, icon: manifest.icon, item: state.parent === id };
  };

  function mediaPicker(step: SequenceStep, n: number, change: (patch: Partial<SequenceStep>) => void): HTMLElement {
    const box = el('div', 'ed-slide-media');
    const current = String(store.state.layers[step.layer]?.params?.file ?? '');
    const pick = el('select');
    pick.ariaLabel = `Picture or video of slide ${n + 1}`;
    const status = el('span', 'ed-hint');
    const choose = async (file: string) => {
      await host.send('scene.set', { layer: step.layer, params: { file } });
      if (!step.title) change({ title: titleOf(file) });
    };
    const fill = async () => {
      const files = await siteMedia();
      if (current && !files.includes(current)) files.unshift(current);
      const none = el('option', undefined, files.length ? 'Choose a picture or video…' : 'No pictures or video in this table yet');
      none.value = '';
      pick.replaceChildren(none, ...files.map((f) => Object.assign(el('option', undefined, f.replace(/^data\/media\//, '')), { value: f })));
      pick.value = current;
    };
    pick.addEventListener('change', () => pick.value && void choose(pick.value));
    const input = Object.assign(el('input'), { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,.png,.jpg,.jpeg,.webp,.gif,.mp4,.webm', hidden: true });
    const upload = el('button', 'ed-slide-try');
    upload.type = 'button';
    upload.append(icon('plus', 14), el('span', undefined, 'Add a file'));
    upload.title = 'A PNG, JPEG, WebP or GIF picture, or an MP4 or WebM video, kept in this table as it is';
    upload.addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
      status.textContent = 'Adding…';
      try {
        const [path] = await addMedia(input.files ?? []);
        status.textContent = '';
        if (path) await choose(path);
      } catch (error) {
        status.textContent = (error as Error).message;
      }
      input.value = '';
    });
    void fill();
    box.append(pick, upload, input, status);
    return box;
  }

  /** Makes the earlier app's slides (`slideshow.json`) into steps: pictures, video and web maps (#197). */
  async function bringInOldSlides(): Promise<string> {
    const site = store.state.site;
    const path = site.data?.slideshow;
    const config = await readSiteData<{ slides?: OldSlide[]; settings?: { loop?: boolean; autoAdvance?: boolean } }>(site, 'slideshow');
    if (!path || !config) return 'This table has no slideshow.json to bring in.';
    const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
    const datasets = Object.entries(site.data ?? {});
    const sequence = [...(steps().sequence ?? [])];
    let skipped = 0;
    for (const slide of config.slides ?? []) {
      if (slide.enabled === false) continue;
      const about = { title: slide.metadata?.title?.slice(0, 80), description: slide.metadata?.description?.slice(0, 300), source: slide.metadata?.source?.slice(0, 200) };
      const timing = { duration_s: slide.duration ? slide.duration / 1000 : undefined, transition: 'fade' as const };
      let use = '';
      let params: Record<string, unknown> = {};
      if ((slide.type === 'image' || slide.type === 'video') && slide.media) {
        use = 'media';
        params = { file: folder + slide.media, fit: ['contain', 'cover'].includes(slide.fitMode ?? '') ? slide.fitMode : 'stretch', rotation: String(((Math.round((slide.rotation ?? 0) / 90) * 90) % 360 + 360) % 360) };
      } else if (slide.type === 'wms' && slide.wms?.url && slide.wms.layers) {
        use = 'wms';
        params = { url: slide.wms.url, layers: slide.wms.layers };
      } else if (slide.type === 'geojson' && slide.media) {
        // Map data shows a dataset of the site: the file must be one already.
        const dataset = datasets.find(([, p]) => p === folder + slide.media)?.[0];
        if (dataset) [use, params] = ['mapdata', { dataset }];
      }
      if (!use || !store.manifest(use)) {
        skipped++;
        continue;
      }
      const result = await host.send('scene.add', { use, parent: id });
      if (!result?.id) continue;
      await host.send('scene.set', { layer: result.id, params });
      const step: SequenceStep = { layer: result.id, ...timing, ...about };
      for (const key of Object.keys(step) as (keyof SequenceStep)[]) if (step[key] === undefined || step[key] === '') delete step[key];
      sequence.push(step);
    }
    await save({ sequence, ...(config.settings?.autoAdvance === false ? { mode: 'manual' as const } : {}), ...(config.settings?.loop === false ? { loop: false } : {}) });
    return skipped ? `${skipped} slides could not be brought in: map data slides need their file added to the table as a dataset first.` : '';
  }

  const legacy = el('div', 'ed-slide-legacy');
  const legacyButton = el('button', 'ed-slide-try');
  legacyButton.type = 'button';
  legacyButton.append(icon('images', 14), el('span', undefined, 'Bring in the slides of slideshow.json'));
  const legacyNote = el('p', 'ed-hint');
  legacyButton.addEventListener('click', async () => {
    legacyButton.disabled = true;
    legacyNote.textContent = 'Bringing in the slides…';
    try {
      legacyNote.textContent = await bringInOldSlides();
    } catch (error) {
      legacyNote.textContent = (error as Error).message;
    }
    legacyButton.disabled = false;
  });
  legacy.append(legacyButton, legacyNote);
  list.after(legacy);

  function draw(): void {
    const current = steps();
    const sequence = current.sequence ?? [];
    legacy.hidden = sequence.length > 0 || !store.state.site.data?.slideshow;
    const timed = current.mode === 'timed';
    mode.set(timed ? 'timed' : 'manual');
    const live = store.state.layers[id]?.step;
    position.textContent = live ? `Showing ${live.index + 1} of ${live.count}${live.sub ? `, ${live.sub.index} of ${live.sub.count} revealed` : ''}` : '';
    end.set(current.loop === false ? 'stop' : 'loop');
    reveal.set(current.reveal === 'stop' ? 'stop' : 'then-next');
    transition.set(current.transition ?? DEFAULT_TRANSITION.kind);
    fadeWrap.hidden = current.transition === 'cut';
    if (document.activeElement !== fadeFor) fadeFor.value = current.transition_s === undefined ? '' : String(current.transition_s);

    const rows = sequence.map((step, n) => {
      const { name, icon: iconName, item } = nameOf(step.layer);
      const row = el('li', 'ed-slide');
      row.dataset.layer = step.layer;
      row.setAttribute('aria-current', String(item && host.selected === step.layer));
      row.classList.toggle('is-live', live?.index === n && Boolean(store.state.layers[id]?.active));
      const head = el('button', 'ed-slide-head');
      head.type = 'button';
      head.title = item ? 'Open this slide’s settings' : 'Go to this layer';
      head.append(el('span', 'ed-slide-number', String(n + 1)), icon(iconName), el('span', 'ed-slide-name', step.title || name));
      head.addEventListener('click', () => {
        // The map in the editor follows: it shows this slide.
        if (store.state.layers[id]?.active) void host.send('layer.step', { layer: id, to: n }).catch(() => {});
        if (item) host.select(host.selected === step.layer ? null : step.layer);
        else host.open(step.layer);
      });
      const change = (patch: Partial<SequenceStep>) => {
        const next = sequence.map((s, i) => (i === n ? { ...s, ...patch } : s));
        for (const s of next) for (const key of Object.keys(s) as (keyof SequenceStep)[]) if (s[key] === undefined || s[key] === '') delete s[key];
        void setSequence(next);
      };
      const move = (by: number) => {
        const next = [...sequence];
        const [moved] = next.splice(n, 1);
        next.splice(n + by, 0, moved!);
        void setSequence(next);
      };
      const tools = el('span', 'ed-slide-tools');
      const up = small('Earlier', 'up', () => move(-1));
      up.disabled = n === 0;
      const down = small('Later', 'down', () => move(1));
      down.disabled = n === sequence.length - 1;
      tools.append(
        up,
        down,
        small('Remove this slide', 'trash', async () => {
          await setSequence(sequence.filter((_, i) => i !== n));
          // A slide made for this slideshow goes with it; a layer of the table stays.
          if (item && !sequence.some((s, i) => i !== n && s.layer === step.layer)) await host.send('scene.remove', { layer: step.layer });
        }),
      );
      head.append(tools);

      const title = el('input');
      Object.assign(title, { type: 'text', maxLength: 80, placeholder: `Title on the controller (${name})`, value: step.title ?? '' });
      title.ariaLabel = `Title of slide ${n + 1}`;
      title.addEventListener('change', () => change({ title: title.value.trim() || undefined }));
      const details = el('div', 'ed-slide-details');
      details.append(title);
      if (timed) {
        const seconds = el('input');
        Object.assign(seconds, { type: 'number', min: '1', max: '600', step: '1', placeholder: '8', value: step.duration_s ? String(step.duration_s) : '' });
        seconds.ariaLabel = `Seconds on slide ${n + 1}`;
        seconds.addEventListener('change', () => {
          const value = Number(seconds.value);
          change({ duration_s: value > 0 ? Math.min(600, value) : undefined });
        });
        const wrap = el('label', 'ed-slide-seconds');
        wrap.append(seconds, el('span', undefined, 's'));
        details.append(wrap);
      }
      const next = el('select');
      next.ariaLabel = `What Next does on slide ${n + 1}`;
      for (const [value, text] of [
        ['', 'Next: as set below'],
        ['then-next', 'Next: categories, then next slide'],
        ['stop', 'Next: categories, then stays'],
      ]) {
        const option = el('option', undefined, text);
        option.value = value!;
        next.append(option);
      }
      next.value = step.next ?? '';
      next.addEventListener('change', () => change({ next: (next.value || undefined) as SequenceStep['next'] }));
      details.append(next);

      // How this slide comes in: the slideshow's transition unless it has its own.
      const comes = el('select', 'ed-slide-comes');
      comes.ariaLabel = `How slide ${n + 1} comes in`;
      const shared = TRANSITIONS.find(([k]) => k === (current.transition ?? DEFAULT_TRANSITION.kind))![1];
      for (const [value, text] of [['', `Comes in: as set below (${shared.toLowerCase()})`], ...TRANSITIONS.map(([k, t]) => [k, `Comes in: ${t.toLowerCase()}`])]) {
        const option = el('option', undefined, text);
        option.value = value!;
        comes.append(option);
      }
      comes.value = step.transition ?? '';
      comes.addEventListener('change', () => change({ transition: (comes.value || undefined) as SequenceStep['transition'] }));
      details.append(comes);
      if ((step.transition ?? current.transition) !== 'cut') {
        const fade = el('input');
        Object.assign(fade, { type: 'number', min: '0', max: String(MAX_TRANSITION_S), step: '0.1', placeholder: String(current.transition_s ?? DEFAULT_TRANSITION.seconds), value: step.transition_s === undefined ? '' : String(step.transition_s) });
        fade.ariaLabel = `Seconds slide ${n + 1} takes to come in`;
        fade.title = 'Seconds the transition takes';
        fade.addEventListener('change', () => {
          const value = Number(fade.value);
          change({ transition_s: fade.value === '' || !Number.isFinite(value) ? undefined : Math.min(MAX_TRANSITION_S, Math.max(0, value)) });
        });
        const wrap = el('label', 'ed-slide-seconds');
        wrap.append(fade, el('span', undefined, 's'));
        details.append(wrap);
      }

      // A picture or video slide picks its file here: one of the table's, or a new one.
      if (store.state.layers[step.layer]?.layer === 'media') details.append(mediaPicker(step, n, change));
      row.append(head, details);
      return row;
    });
    if (rows.length === 0) list.replaceChildren(el('li', 'ed-empty', 'No slides yet. Add layers of this table, a web map or a dataset of the site, in the order they are shown.'));
    else list.replaceChildren(...rows);

    // What a slide can show: the table's own layers (they keep their buttons), or something new made for this slideshow.
    const placeholder = el('option', undefined, '+ Add a slide…');
    placeholder.value = '';
    const own = el('optgroup');
    own.label = 'A layer of this table';
    for (const layer of store.state.scene) {
      const state = store.state.layers[layer];
      const manifest: LayerManifest | undefined = state && store.manifest(state.layer);
      if (!state || !manifest || state.parent || layer === id || isAmbient(manifest) || manifest.sequence) continue;
      const option = el('option', undefined, layerButton(layer, manifest, state).name);
      option.value = `layer:${layer}`;
      own.append(option);
    }
    const made = el('optgroup');
    made.label = 'New, only in this slideshow';
    for (const { use, label } of NEW_SLIDES) {
      if (!store.manifest(use)) continue;
      const option = el('option', undefined, label);
      option.value = `new:${use}`;
      made.append(option);
    }
    const maps = el('optgroup');
    maps.label = 'Open maps of Sweden (via SLU)';
    for (const { value, label } of builtInMaps()) {
      const option = el('option', undefined, label);
      option.value = `map:${value}`;
      maps.append(option);
    }
    add.replaceChildren(placeholder, ...(own.children.length ? [own] : []), ...(made.children.length ? [made] : []), ...(maps.children.length ? [maps] : []));
    add.value = '';
  }

  draw();
  host.watch(() => {
    // Keep a title being typed.
    if (section.contains(document.activeElement) && document.activeElement?.tagName === 'INPUT') return;
    draw();
  });
  return section;
}
