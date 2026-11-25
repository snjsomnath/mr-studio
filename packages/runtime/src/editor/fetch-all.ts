import type { SiteInfo } from '@mrstudio/sdk';

import { el } from '../controls.ts';
import { icon } from './icons.ts';
import { TARGETS } from './importer.ts';
import type { ImportReport } from './importer.ts';

/**
 * "Fetch everything from open data" (#310), at the top of the wizard's "Your place": every
 * dataset open sources can give a table, in one go. OpenStreetMap is asked once for all of its
 * datasets (`POST /api/data/osm`), the ground comes from free elevation, and each is then
 * brought in one after another, with the editor reloading once at the end. One list shows how
 * each is doing, and a dataset that failed can be tried again on its own.
 */

/** What the card needs from the window around it. */
export interface FetchAllHost {
  site(): SiteInfo;
  /** Holds back the reload that `site.changed` causes, until released, so that all the imports land as one. */
  hold(on: boolean): void;
}

type Status = 'idle' | 'waiting' | 'fetching' | 'importing' | 'done' | 'empty' | 'failed';

interface Row {
  target: string;
  dataset: string;
  name: string;
  icon: string;
  from: 'osm' | 'elevation';
  picked: boolean;
  status: Status;
  words?: string;
}

/** Where the outcome waits for the editor to come back after its reload. */
const KEPT = 'mrs-fetch-all';

export class FetchAll {
  readonly element = el('section', 'fa');
  private rows: Row[];
  private busy = false;
  private since = 0;
  private open = false;
  private readonly host: FetchAllHost;

  constructor(host: FetchAllHost) {
    this.host = host;
    const data = host.site().data ?? {};
    // Everything open sources can give, in the order of the rows below. What the table has already starts unticked.
    this.rows = TARGETS.filter((t) => t.osm || t.elevation).map((t) => ({
      target: t.target,
      dataset: t.dataset,
      name: t.name,
      icon: t.icon,
      from: t.osm ? 'osm' : 'elevation',
      picked: !(t.dataset in data),
      status: 'idle',
    }));
    // The outcome of a fetch from before the reload it caused.
    try {
      const kept = sessionStorage.getItem(KEPT);
      sessionStorage.removeItem(KEPT);
      const outcome = kept ? (JSON.parse(kept) as Pick<Row, 'dataset' | 'status' | 'words'>[]) : [];
      for (const row of this.rows) {
        const was = outcome.find((o) => o.dataset === row.dataset);
        if (was) Object.assign(row, { status: was.status, words: was.words, picked: was.status === 'failed' });
      }
      this.open = outcome.length > 0;
    } catch {
      // No session storage: the list starts afresh.
    }
    this.render();
  }

  render(): void {
    const head = el('div', 'fa-head');
    const badge = el('span', 'wz-badge');
    badge.append(icon('sparkle', 20));
    const words = el('div');
    words.append(
      el('strong', undefined, 'Fetch everything from open data'),
      el('p', undefined, 'Buildings, streets, walking paths and trees from OpenStreetMap, and the ground from free elevation, in one go. Needs the internet.'),
    );
    head.append(badge, words);
    const nodes: HTMLElement[] = [head];
    if (!this.open && !this.busy) {
      const choose = el('button', 'ed-button', 'Choose what to fetch');
      choose.type = 'button';
      choose.addEventListener('click', () => {
        this.open = true;
        this.render();
      });
      words.append(choose);
      this.element.replaceChildren(...nodes);
      return;
    }

    const list = el('ul', 'fa-list');
    list.setAttribute('aria-live', 'polite');
    const data = this.host.site().data ?? {};
    for (const row of this.rows) {
      const item = el('li', `fa-row is-${row.status}`);
      item.dataset.dataset = row.dataset;
      const tick = el('input');
      Object.assign(tick, { type: 'checkbox', checked: row.picked, disabled: this.busy, ariaLabel: `Fetch ${row.name.toLowerCase()}` });
      tick.addEventListener('change', () => {
        row.picked = tick.checked;
        this.render();
      });
      const label = el('label', 'fa-name');
      const name = el('span');
      name.append(el('strong', undefined, row.name), el('small', 'fa-from', row.from === 'osm' ? 'OpenStreetMap' : 'Free elevation'));
      label.append(tick, icon(row.icon, 16), name);
      item.append(label, this.statusOf(row, row.dataset in data));
      list.append(item);
    }
    nodes.push(list);

    const actions = el('div', 'wz-report-actions');
    const picked = this.rows.filter((r) => r.picked);
    const go = el('button', 'ed-button is-primary', picked.length === this.rows.length ? 'Fetch all' : `Fetch ${picked.length} of ${this.rows.length}`);
    go.type = 'button';
    go.disabled = this.busy || picked.length === 0;
    go.addEventListener('click', () => void this.run(picked));
    actions.append(go);
    if (this.busy) actions.append(this.clock());
    else {
      const close = el('button', 'ed-button', 'Close');
      close.type = 'button';
      close.addEventListener('click', () => {
        this.open = false;
        for (const row of this.rows) if (row.status !== 'idle') row.status = 'idle';
        this.render();
      });
      actions.append(close);
    }
    nodes.push(actions);
    if (this.rows.some((r) => r.from === 'osm' && r.status === 'done')) {
      nodes.push(el('p', 'im-credit', '© OpenStreetMap contributors. The credit is kept with the data and shown with the table.'));
    }
    this.element.replaceChildren(...nodes);
  }

  /** The words and colour of one row's state, with Try again when it failed. */
  private statusOf(row: Row, has: boolean): HTMLElement {
    const box = el('span', 'fa-status');
    const say = (text: string) => box.append(el('span', undefined, text));
    switch (row.status) {
      case 'idle':
        say(has ? 'On the table. Tick to replace it' : row.picked ? 'Ready' : 'Left out');
        break;
      case 'waiting':
        say('Waiting');
        break;
      case 'fetching':
      case 'importing': {
        const spinner = el('span', 'im-spinner');
        spinner.setAttribute('aria-hidden', 'true');
        box.append(spinner);
        say(row.status === 'importing' ? 'Bringing it in' : row.from === 'osm' ? 'Asking OpenStreetMap' : 'Downloading');
        break;
      }
      case 'done': {
        const done = el('span', undefined, row.words ?? 'On the table');
        done.prepend(icon('check', 12), ' ');
        box.append(done);
        break;
      }
      case 'empty':
        say(row.words ?? 'Nothing mapped here. Bring in a file below.');
        break;
      case 'failed': {
        say(row.words ?? 'It did not work.');
        const again = el('button', 'ed-button', 'Try again');
        again.type = 'button';
        again.disabled = this.busy;
        again.addEventListener('click', () => void this.run([row]));
        box.append(again);
        break;
      }
    }
    return box;
  }

  /** How long the fetch has taken, said kindly when OpenStreetMap is slow. */
  private clock(): HTMLElement {
    const line = el('span', 'fa-clock');
    line.setAttribute('role', 'status');
    // Which server and part the host is asking now (#424), e.g. "Asking overpass-api.de, part 2 of 4".
    let asking = '';
    const say = () => {
      const seconds = Math.floor((Date.now() - this.since) / 1000);
      const osm = this.rows.some((r) => r.status === 'fetching' && r.from === 'osm');
      if (osm) {
        void fetch('/api/data/osm/status')
          .then((r) => (r.ok ? r.json() : null))
          .then((s: { words?: string } | null) => (asking = s?.words ?? ''))
          .catch(() => undefined);
      }
      const slow = osm && seconds >= 15 ? 'OpenStreetMap is busy, so this can take a minute. It tries the next server if one does not answer. ' : '';
      line.textContent = osm && asking ? `${slow}${asking}… ${seconds} s` : slow ? `${slow}${seconds} s` : seconds >= 2 ? `${seconds} s` : '';
    };
    say();
    const timer = setInterval(() => (line.isConnected && this.busy ? say() : clearInterval(timer)), 1000);
    return line;
  }

  /** Fetches and brings in `rows`: OpenStreetMap's in one request, the ground beside it, then each import in turn. */
  private async run(rows: Row[]): Promise<void> {
    if (this.busy || rows.length === 0) return;
    this.busy = true;
    this.open = true;
    this.since = Date.now();
    for (const row of this.rows) if (!rows.includes(row) && row.status !== 'done' && row.status !== 'failed' && row.status !== 'empty') row.status = 'idle';
    for (const row of rows) Object.assign(row, { status: 'waiting', words: undefined });
    this.host.hold(true);
    let changed = false;
    try {
      const osm = rows.filter((r) => r.from === 'osm');
      const ground = rows.filter((r) => r.from === 'elevation');
      for (const row of [...osm, ...ground]) row.status = 'fetching';
      this.render();
      // The ground comes from another service: it downloads while OpenStreetMap is asked.
      const grounds = Promise.all(ground.map(async (row) => (changed = (await this.bringIn(row, 'elevation')) || changed)));
      if (osm.length) {
        const fetched = await this.askOsm(osm);
        for (const row of osm) {
          const answer = fetched.get(row.dataset);
          if (!answer) Object.assign(row, { status: 'failed', words: 'OpenStreetMap did not answer. Check the internet connection and try again in a minute.' });
          else if (!answer.ok) Object.assign(row, { status: answer.code === 'osm.empty' ? 'empty' : 'failed', words: answer.words });
        }
        this.render();
        // Each in turn: the host brings one file in at a time, and each import uses what was just fetched.
        for (const row of osm) if (row.status === 'fetching') changed = (await this.bringIn(row, 'osm')) || changed;
      }
      await grounds;
    } finally {
      this.busy = false;
      try {
        sessionStorage.setItem(KEPT, JSON.stringify(this.rows.filter((r) => r.status !== 'idle').map(({ dataset, status, words }) => ({ dataset, status, words }))));
        if (!changed) sessionStorage.removeItem(KEPT);
      } catch {
        // As above: the list is lost with the reload, and the rows below still show what is on the table.
      }
      this.render();
      // One reload for everything that came in.
      this.host.hold(false);
    }
  }

  /** One request to OpenStreetMap for every row: each dataset's count, or why it has none. */
  private async askOsm(rows: Row[]): Promise<Map<string, { ok: boolean; code?: string; words?: string }>> {
    const found = new Map<string, { ok: boolean; code?: string; words?: string }>();
    try {
      const response = await fetch(`/api/data/osm?${new URLSearchParams({ targets: rows.map((r) => r.target).join(',') })}`, { method: 'POST', body: '' });
      if (!response.ok) {
        const words = ((await response.json().catch(() => null))?.error as string | undefined) ?? `The table refused the fetch (${response.status}).`;
        for (const row of rows) found.set(row.dataset, { ok: false, words });
        return found;
      }
      const answer = (await response.json()) as { datasets: { dataset: string; ok: boolean; count?: number; report?: ImportReport }[] };
      for (const d of answer.datasets) {
        const issue = d.report?.issues.find((i) => i.severity === 'blocker');
        found.set(d.dataset, { ok: d.ok, code: issue?.code, words: issue?.message });
      }
    } catch (error) {
      for (const row of rows) found.set(row.dataset, { ok: false, words: `OpenStreetMap could not be asked: ${(error as Error).message}` });
    }
    return found;
  }

  /** Brings one dataset in from its open source. True when the table changed. */
  private async bringIn(row: Row, source: 'osm' | 'elevation'): Promise<boolean> {
    row.status = source === 'osm' ? 'importing' : 'fetching';
    this.render();
    try {
      const response = await fetch(`/api/data/import?${new URLSearchParams({ target: row.target, source })}`, { method: 'POST', body: '' });
      if (response.status === 200 || response.status === 422) {
        const report = (await response.json()) as ImportReport;
        const blocker = report.issues.find((i) => i.severity === 'blocker');
        if (response.status === 200) Object.assign(row, { status: 'done', words: report.summary });
        else Object.assign(row, { status: blocker?.code?.endsWith('.empty') ? 'empty' : 'failed', words: blocker?.message ?? report.summary });
      } else Object.assign(row, { status: 'failed', words: (await response.text()) || `The table refused it (${response.status}).` });
    } catch (error) {
      Object.assign(row, { status: 'failed', words: `It could not be fetched: ${(error as Error).message}` });
    }
    this.render();
    return (row.status as Status) === 'done';
  }
}
