// The playback room (#526, #527): a recorded session played back on the table and controller
// pages that run live, side by side, with a timeline, an event list and the organiser's notes.
// It is not the editor: nothing here changes the table or the recording, except the notes.
import type { Connection } from '@mrstudio/sdk';

import { clock } from './record.ts';
import type { Store } from './store.ts';

type Event = { t: number; kind: string; who: string | null; slot: number | null; text: string };
type Note = { id: string; t: number; text: string };
type Info = {
  recording: { id: string; name: string; date: string; facilitator?: string; chapters: { t: number; title?: string }[]; app_version?: string };
  length: number;
  at: number;
  events: Event[];
  notes: Note[];
};

const SPEEDS = [0.5, 1, 2, 4, 8];
const KINDS: [string, string][] = [
  ['layers', 'Layers'],
  ['sketches', 'Sketches'],
  ['people', 'Phones joining'],
  ['settings', 'Settings'],
  ['chapters', 'Chapters'],
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, className = 'pb-button'): HTMLButtonElement {
  const node = el('button', className, label);
  node.type = 'button';
  return node;
}

function whoOf(e: Event): string {
  if (e.who === 'phone' && e.slot !== null) return `phone-${e.slot}`;
  return e.who ?? 'someone';
}

function whoName(key: string): string {
  if (key.startsWith('phone-')) return `Phone ${Number(key.slice(6)) + 1}`;
  return { tv: 'Controller', guide: 'Guide', dev: 'Operator', table: 'Table' }[key] ?? 'Someone';
}

/** Saves text as a file in the browser's downloads. */
function download(name: string, type: string, text: string) {
  const link = el('a');
  link.href = URL.createObjectURL(new Blob([text], { type }));
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

export async function playbackRoom(app: HTMLElement, store: Store, connection: Connection): Promise<void> {
  document.body.dataset.role = 'playback';
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', 'light');
  const info = await connection.request<Info>('playback.info');
  const { recording, length, events } = info;
  let notes = info.notes ?? [];
  document.title = `${recording.name} · Recorded session`;
  const site = store.state.site;

  // The banner: what this is, plainly.
  const banner = el('header', 'pb-banner');
  banner.append(
    el('span', 'pb-badge', 'Recorded session, read only'),
    el('b', '', recording.name),
    el('span', 'pb-muted', [recording.date, recording.facilitator].filter(Boolean).join(' · ')),
  );
  if (recording.app_version) banner.append(el('span', 'pb-muted', `Made with MR Studio ${recording.app_version}`));

  // The three views: the table, the controller, and what the phones did.
  const views = el('div', 'pb-views');
  const tableBox = el('figure', 'pb-table');
  const table = el('iframe');
  table.src = '/table?intro=0';
  table.title = 'The table';
  tableBox.style.aspectRatio = `${site.extent.width_m} / ${site.extent.height_m}`;
  tableBox.append(table, el('figcaption', '', 'Table'));
  const side = el('div', 'pb-side');
  const tvBox = el('figure', 'pb-tv');
  const tv = el('iframe');
  tv.src = '/tv';
  tv.title = 'The controller';
  tvBox.append(tv, el('figcaption', '', 'Controller'));
  // The controller is laid out for a 1920 × 1080 screen: drawn at that size, then shrunk to fit.
  new ResizeObserver(() => (tv.style.transform = `scale(${tvBox.clientWidth / 1920})`)).observe(tvBox);

  // The event list (#527): every event in words, filtered by who and by kind; a click jumps there.
  const list = el('section', 'pb-events');
  const filters = el('div', 'pb-filters');
  const whoSelect = el('select');
  whoSelect.setAttribute('aria-label', 'Show events from');
  const whos = [...new Set(events.map(whoOf))].filter((w) => w !== 'table');
  whoSelect.append(new Option('Everyone', ''), ...whos.map((w) => new Option(whoName(w), w)));
  const kinds = new Set(KINDS.map(([k]) => k));
  const kindBoxes = KINDS.map(([kind, label]) => {
    const box = el('input');
    box.type = 'checkbox';
    box.checked = true;
    box.addEventListener('change', () => {
      if (box.checked) kinds.add(kind);
      else kinds.delete(kind);
      drawEvents();
      drawTicks();
    });
    const row = el('label', 'pb-kind');
    row.append(box, el('span', '', label));
    return row;
  });
  whoSelect.addEventListener('change', () => {
    drawEvents();
    drawTicks();
  });
  filters.append(whoSelect, ...kindBoxes);
  const items = el('ol', 'pb-list');
  list.append(el('h2', '', 'What happened'), filters, items);

  // Organiser notes (#527): pinned to a time, kept with the recording.
  const notesBox = el('section', 'pb-notes');
  const noteText = el('textarea');
  noteText.rows = 2;
  noteText.placeholder = 'A note at this moment';
  const addNote = button('Add a note here', 'pb-button is-primary');
  const noteList = el('ol', 'pb-list');
  const exportRow = el('div', 'pb-export');
  const asText = button('Save notes and events as text');
  const asCsv = button('Save as CSV');
  exportRow.append(asText, asCsv);
  notesBox.append(el('h2', '', 'Notes'), noteText, addNote, noteList, exportRow);

  side.append(tvBox, list, notesBox);
  views.append(tableBox, side);

  // The timeline: play, speed, time, the track with chapters, event ticks and notes.
  const bar = el('footer', 'pb-timeline');
  const play = button('Play', 'pb-button is-primary pb-play');
  const speed = el('select');
  speed.setAttribute('aria-label', 'Speed');
  speed.append(...SPEEDS.map((s) => new Option(`${s}×`, String(s))));
  speed.value = '1';
  const prev = button('◀ Chapter');
  prev.title = 'The chapter before';
  const next = button('Chapter ▶');
  next.title = 'The next chapter';
  const time = el('span', 'pb-time');
  const track = el('div', 'pb-track');
  const ticks = el('div', 'pb-ticks');
  const marks = el('div', 'pb-marks');
  const head = el('div', 'pb-head');
  const range = el('input', 'pb-range');
  range.type = 'range';
  range.min = '0';
  range.max = String(length);
  range.step = '100';
  range.setAttribute('aria-label', 'Where in the recording');
  track.append(ticks, marks, head, range);
  bar.append(play, speed, prev, next, time, track);

  // Play on the table (#528): in the app, the recording goes on the projector and the TV chosen
  // in the Display tab, with this computer's calibration, while the timeline stays here.
  type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  const invoke = (window as { __TAURI__?: { core?: { invoke?: Invoke } } }).__TAURI__?.core?.invoke;
  if (invoke) {
    let showing = false;
    const onTable = button('Play on the table', 'pb-button pb-on-table');
    onTable.title = 'Show this recording on the projector and the TV. Phones cannot join a replay.';
    onTable.addEventListener('click', async () => {
      onTable.disabled = true;
      try {
        await invoke(showing ? 'stop_presenting' : 'present');
        showing = !showing;
        onTable.textContent = showing ? 'Stop playing on the table' : 'Play on the table';
      } catch (error) {
        onTable.title = String(error);
        onTable.textContent = 'Could not reach the screens';
      } finally {
        onTable.disabled = false;
      }
    });
    bar.append(onTable);
  }

  app.replaceChildren(banner, views, bar);

  // ---- Time --------------------------------------------------------------------------------
  let at = 0;
  let playing = false;
  let last = 0;
  let sending = false;
  let wanted: number | null = null;
  const send = async () => {
    if (sending) return;
    sending = true;
    while (wanted !== null) {
      const t = wanted;
      wanted = null;
      await connection.request('playback.seek', { t: Math.round(t) }).catch(() => {});
    }
    sending = false;
  };
  const go = (t: number, push = true) => {
    at = Math.max(0, Math.min(length, t));
    range.value = String(at);
    head.style.left = `${(at / Math.max(1, length)) * 100}%`;
    time.textContent = `${clock(at)} / ${clock(length)}`;
    for (const item of items.children) item.classList.toggle('is-past', Number((item as HTMLElement).dataset.t) <= at);
    if (push) {
      wanted = at;
      void send();
    }
  };
  const frame = (now: number) => {
    if (!playing) return;
    const step = (now - last) * Number(speed.value);
    last = now;
    go(at + step);
    if (at >= length) setPlaying(false);
    else requestAnimationFrame(frame);
  };
  const setPlaying = (on: boolean) => {
    playing = on && at < length;
    play.textContent = playing ? 'Pause' : 'Play';
    if (playing) {
      last = performance.now();
      requestAnimationFrame(frame);
    }
  };
  play.addEventListener('click', () => setPlaying(!playing));
  range.addEventListener('input', () => go(Number(range.value)));
  const chapters = recording.chapters.map((c) => c.t).sort((a, b) => a - b);
  prev.addEventListener('click', () => go([...chapters].reverse().find((t) => t < at - 1000) ?? 0));
  next.addEventListener('click', () => go(chapters.find((t) => t > at + 1) ?? length));
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.key === ' ') setPlaying(!playing);
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const forward = e.key === 'ArrowRight';
      if (e.shiftKey) {
        const shown = visible().map((ev) => ev.t);
        go(forward ? (shown.find((t) => t > at + 1) ?? length) : ([...shown].reverse().find((t) => t < at - 1) ?? 0));
      } else go(at + (forward ? 5000 : -5000));
    } else return;
    e.preventDefault();
  });

  // ---- Events, ticks, chapters and notes ---------------------------------------------------
  const visible = () =>
    events.filter((e) => e.who !== 'table' && kinds.has(e.kind) && (!whoSelect.value || whoOf(e) === whoSelect.value || e.kind === 'chapters'));
  const pct = (t: number) => `${(t / Math.max(1, length)) * 100}%`;
  function drawTicks() {
    const one = whoSelect.value;
    ticks.replaceChildren(
      ...visible().map((e) => {
        const tick = el('span', `pb-tick is-${e.kind}${one && whoOf(e) === one ? ' is-chosen' : ''}`);
        tick.style.left = pct(e.t);
        tick.title = `${clock(e.t)}  ${e.text}`;
        return tick;
      }),
    );
  }
  function drawEvents() {
    items.replaceChildren(
      ...visible().map((e) => {
        const item = el('li', `pb-item is-${e.kind}`);
        item.dataset.t = String(e.t);
        const jump = button('', 'pb-jump');
        jump.append(el('span', 'pb-at', clock(e.t)), el('span', '', e.text));
        jump.addEventListener('click', () => go(e.t));
        item.append(jump);
        item.classList.toggle('is-past', e.t <= at);
        return item;
      }),
    );
  }
  function drawMarks() {
    marks.replaceChildren(
      ...recording.chapters.map((c) => {
        const mark = button(c.title ?? 'Chapter', 'pb-chapter');
        mark.style.left = pct(c.t);
        mark.title = `${clock(c.t)}  ${c.title ?? 'Chapter'}`;
        mark.addEventListener('click', () => go(c.t));
        return mark;
      }),
      ...notes.map((n) => {
        const mark = button('', 'pb-note-mark');
        mark.style.left = pct(n.t);
        mark.title = `${clock(n.t)}  ${n.text}`;
        mark.setAttribute('aria-label', `Note at ${clock(n.t)}: ${n.text}`);
        mark.addEventListener('click', () => go(n.t));
        return mark;
      }),
    );
  }
  function drawNotes() {
    noteList.replaceChildren(
      ...[...notes]
        .sort((a, b) => a.t - b.t)
        .map((n) => {
          const item = el('li', 'pb-item is-note');
          const jump = button('', 'pb-jump');
          jump.append(el('span', 'pb-at', clock(n.t)), el('span', '', n.text));
          jump.addEventListener('click', () => go(n.t));
          const edit = button('Edit', 'pb-small');
          edit.addEventListener('click', () => {
            // Edited in place: the app's windows do not all show the browser's own prompts.
            const box = el('textarea', 'pb-note-edit');
            box.value = n.text;
            box.rows = 2;
            const save = button('Save', 'pb-small');
            save.addEventListener('click', async () => {
              const text = box.value.trim();
              if (!text) return box.focus();
              notes = (await connection.request<{ notes: Note[] }>('playback.note', { id: n.id, text })).notes;
              drawNotes();
            });
            item.replaceChildren(box, save);
            box.focus();
          });
          const remove = button('Delete', 'pb-small');
          remove.addEventListener('click', async () => {
            notes = (await connection.request<{ notes: Note[] }>('playback.note', { id: n.id, remove: true })).notes;
            drawNotes();
          });
          item.append(jump, edit, remove);
          return item;
        }),
    );
    drawMarks();
  }
  addNote.addEventListener('click', async () => {
    const text = noteText.value.trim();
    if (!text) return noteText.focus();
    notes = (await connection.request<{ notes: Note[] }>('playback.note', { t: Math.round(at), text })).notes;
    noteText.value = '';
    drawNotes();
  });

  // Take the review away (#527): notes, chapters and events, with their times.
  const rows = () =>
    [
      ...notes.map((n) => ({ t: n.t, kind: 'note', who: 'Organiser', text: n.text })),
      ...recording.chapters.map((c) => ({ t: c.t, kind: 'chapter', who: '', text: c.title ?? 'Chapter' })),
      ...visible()
        .filter((e) => e.kind !== 'chapters')
        .map((e) => ({ t: e.t, kind: e.kind, who: whoName(whoOf(e)), text: e.text })),
    ].sort((a, b) => a.t - b.t);
  const fileName = recording.name.replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'recording';
  asText.addEventListener('click', () =>
    download(`${fileName}.txt`, 'text/plain', [`${recording.name} (${recording.date})`, '', ...rows().map((r) => `${clock(r.t)}\t${r.kind}\t${r.text}`)].join('\n')),
  );
  asCsv.addEventListener('click', () => {
    const quote = (v: string) => `"${v.replace(/"/g, '""')}"`;
    download(`${fileName}.csv`, 'text/csv', ['time,seconds,kind,who,text', ...rows().map((r) => [clock(r.t), (r.t / 1000).toFixed(1), r.kind, quote(r.who), quote(r.text)].join(','))].join('\n'));
  });

  drawEvents();
  drawTicks();
  drawNotes();
  go(info.at ?? 0, false);
  connection.on('playback.at', (p: { at: number }) => {
    if (!playing && Math.abs(p.at - at) > 500) go(p.at, false);
  });
}
