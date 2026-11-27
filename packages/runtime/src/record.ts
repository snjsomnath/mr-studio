// Record this session (#522): the operator's switch, the catalogue form, chapter marks and the
// wrap-up, on the Developer window beside Phones. The controller shows a red dot while a
// recording runs (recordingDot); the table and the phones show nothing.
import type { Connection } from '@mrstudio/sdk';

import { t } from './i18n.ts';
import type { Store } from './store.ts';

type Recording = { id: string; name: string; started: number; chapters: { t: number; title?: string }[] };
type Catalogue = Recording & {
  date: string;
  facilitator: string;
  purpose: string;
  notes: string;
  tags: string[];
  length: number;
  events: number;
  finished: boolean;
  wrapped: boolean;
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 1:05:09 or 5:09. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const [h, m, sec] = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60];
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

function field(label: string, input: HTMLInputElement | HTMLTextAreaElement): HTMLLabelElement {
  const row = el('label', 'record-field');
  row.append(el('span', '', label), input);
  return row;
}

function input(value = '', placeholder = ''): HTMLInputElement {
  const node = el('input');
  node.value = value;
  node.placeholder = placeholder;
  return node;
}

function area(value = '', placeholder = ''): HTMLTextAreaElement {
  const node = el('textarea');
  node.rows = 3;
  node.value = value;
  node.placeholder = placeholder;
  return node;
}

function button(label: string, className = 'action'): HTMLButtonElement {
  const node = el('button', className, label);
  node.type = 'button';
  return node;
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The operator's Record panel (#522). */
export function recordPanel(store: Store, connection: Connection): HTMLElement {
  const panel = el('section', 'record-panel');
  const body = el('div', 'record-body');
  const problem = el('p', 'record-problem');
  problem.hidden = true;
  panel.append(el('h2', '', 'Record this session'), body, problem);
  let wrapping: Catalogue | null = null;
  let timer = 0;

  const fail = (error: unknown) => {
    problem.textContent = error instanceof Error ? error.message : String(error);
    problem.hidden = false;
  };
  const ask = async <T>(method: string, params: Record<string, unknown> = {}): Promise<T | null> => {
    problem.hidden = true;
    try {
      return await connection.request<T>(method, params);
    } catch (error) {
      fail(error);
      return null;
    }
  };

  /** Not recording: a switch that opens the catalogue form. */
  const idle = () => {
    const start = button('Record this session…', 'action record-start');
    start.addEventListener('click', form);
    body.replaceChildren(el('p', 'record-hint', 'Keeps what happens at the table, to review afterwards. Only the controller shows that it is on.'), start);
    void offerUnfinished();
  };

  /** The catalogue form: only the name is needed, and it is filled in. */
  const form = () => {
    const name = input(`${store.state.site.name} ${today()}`);
    const date = input(today());
    date.type = 'date';
    const facilitator = input('', 'Who leads the session');
    const purpose = input('', 'What the session is for');
    const notes = area('', 'Anything to know when it is watched again');
    const go = button('Start recording', 'action is-primary');
    const cancel = button('Cancel');
    cancel.addEventListener('click', idle);
    go.addEventListener('click', async () => {
      go.disabled = true;
      const answer = await ask('recording.start', {
        name: name.value,
        date: date.value,
        facilitator: facilitator.value,
        purpose: purpose.value,
        notes: notes.value,
      });
      go.disabled = false;
      if (answer) show();
    });
    const row = el('div', 'record-row');
    row.append(go, cancel);
    body.replaceChildren(
      field('Name', name),
      field('Date', date),
      field('Facilitator', facilitator),
      field('Purpose', purpose),
      field('Context notes', notes),
      row,
    );
    name.focus();
  };

  /** Recording: the time, a chapter mark with an optional title, and Stop. */
  const running = (recording: Recording) => {
    const time = el('span', 'record-time');
    const tick = () => (time.textContent = clock(Date.now() - recording.started));
    tick();
    clearInterval(timer);
    timer = window.setInterval(tick, 1000);
    const line = el('p', 'record-on');
    line.append(el('span', 'record-dot'), el('span', '', 'Recording '), time);
    const title = input('', 'Chapter title (optional)');
    const chapter = button('Mark a chapter');
    chapter.addEventListener('click', async () => {
      if (await ask('recording.chapter', { title: title.value })) title.value = '';
    });
    title.addEventListener('keydown', (e) => e.key === 'Enter' && chapter.click());
    const stop = button('Stop recording', 'action is-danger');
    stop.addEventListener('click', async () => {
      const answer = await ask<{ recording: Catalogue }>('recording.stop');
      if (answer) wrapUp(answer.recording);
    });
    const chapters = el('ol', 'record-chapters');
    chapters.append(...recording.chapters.map((c) => el('li', '', `${clock(c.t)}  ${c.title ?? 'Chapter'}`)));
    const row = el('div', 'record-row');
    row.append(title, chapter);
    body.replaceChildren(line, el('p', 'record-hint', recording.name), chapters, row, stop);
  };

  /** After Stop: notes, tags and the chapters, then Save; or Discard, pressed twice. */
  const wrapUp = (catalogue: Catalogue) => {
    clearInterval(timer);
    wrapping = catalogue;
    const notes = area(catalogue.notes, 'What happened, what to look at again');
    const tags = input(catalogue.tags.join(', '), 'workshop, Lindholmen, round 2');
    const chapters = el('ol', 'record-chapters is-editing');
    const rows = catalogue.chapters.map((c) => {
      const row = el('li');
      const name = input(c.title ?? '', 'Chapter');
      const remove = button('×', 'record-remove');
      remove.setAttribute('aria-label', `Remove the chapter at ${clock(c.t)}`);
      remove.addEventListener('click', () => row.remove());
      row.append(el('span', 'record-at', clock(c.t)), name, remove);
      return { row, t: c.t, name };
    });
    chapters.append(...rows.map((r) => r.row));
    const save = button('Save the recording', 'action is-primary');
    save.addEventListener('click', async () => {
      const kept = rows.filter((r) => r.row.isConnected).map((r) => ({ t: r.t, ...(r.name.value.trim() ? { title: r.name.value.trim() } : {}) }));
      const answer = await ask('recording.wrapup', {
        id: catalogue.id,
        notes: notes.value,
        tags: tags.value.split(',').map((s) => s.trim()).filter(Boolean),
        chapters: kept,
      });
      if (answer) {
        wrapping = null;
        body.replaceChildren(el('p', 'record-saved', `Saved “${catalogue.name}”, ${clock(catalogue.length)} long.`));
        window.setTimeout(() => wrapping === null && idle(), 4000);
      }
    });
    const discard = button('Discard');
    let armed = 0;
    discard.addEventListener('click', async () => {
      if (!armed) {
        discard.textContent = 'Press again to delete it';
        armed = window.setTimeout(() => {
          armed = 0;
          discard.textContent = 'Discard';
        }, 4000);
        return;
      }
      clearTimeout(armed);
      if (await ask('recording.wrapup', { id: catalogue.id, discard: true })) {
        wrapping = null;
        idle();
      }
    });
    const row = el('div', 'record-row');
    row.append(save, discard);
    body.replaceChildren(
      el('p', 'record-hint', `“${catalogue.name}” stopped after ${clock(catalogue.length)}. Add your notes, then save it.`),
      field('Notes', notes),
      field('Tags', tags),
      ...(rows.length ? [el('h3', '', 'Chapters'), chapters] : []),
      row,
    );
  };

  /** A recording the app closed on before its wrap-up: offer to keep it (#522). */
  const offerUnfinished = async () => {
    const answer = await connection.request<{ recordings: Catalogue[] }>('recording.list').catch(() => null);
    const left = answer?.recordings.find((r) => !r.wrapped && r.id !== store.state.session.recording?.id);
    if (!left || wrapping || store.state.session.recording) return;
    const keep = button(`Finish “${left.name}”`);
    keep.addEventListener('click', () => wrapUp(left));
    const note = el('p', 'record-hint', left.finished ? 'A recording is waiting for its notes.' : 'A recording was cut short when MR Studio closed.');
    body.append(note, keep);
  };

  const show = () => {
    const recording = store.state.session.recording;
    if (recording) running(recording);
    else if (!wrapping) {
      clearInterval(timer);
      idle();
    }
  };
  let shown = JSON.stringify(store.state.session.recording ?? null);
  store.onParticipants(() => {
    const now = JSON.stringify(store.state.session.recording ?? null);
    if (now !== shown) {
      shown = now;
      show();
    }
  });
  show();
  return panel;
}

/** The controller's red dot and time while a recording runs (#522). Nothing on the table or phones. */
export function recordingDot(store: Store): HTMLElement {
  const dot = el('div', 'recording-dot');
  dot.setAttribute('role', 'status');
  const time = el('span', 'recording-time');
  dot.append(el('span', 'record-dot'), el('span', 'recording-label', t('Recording')), time);
  let timer = 0;
  const show = () => {
    const recording = store.state.session.recording;
    dot.hidden = !recording;
    clearInterval(timer);
    if (!recording) return;
    const tick = () => (time.textContent = clock(Date.now() - recording.started));
    tick();
    timer = window.setInterval(tick, 1000);
  };
  show();
  store.onParticipants(show);
  return dot;
}
