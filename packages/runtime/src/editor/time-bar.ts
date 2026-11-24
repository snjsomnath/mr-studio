/**
 * The time bar (#61): a thin timeline under the canvas for a layer that runs on time, such as
 * Sunlight, Cool paths and Mobility. Scrubbing it, or playing it, changes what the preview shows
 * now (`layer.set`), never the layer's saved starting value; "Use as the start" saves the moment
 * shown (`scene.set`). Leaving the layer puts the preview back.
 *
 * A layer names its time controls with `clock` in layer.json: `hour` (a time of day in hours),
 * `date` (the day), `progress` (a share of a run, 0 to 100) and `play` (the layer's own play switch,
 * which the bar pauses while it scrubs).
 */
import { sunPosition } from '@mrstudio/sdk';
import type { Connection, Control, LayerManifest, LayerState, SiteInfo } from '@mrstudio/sdk';

import { clock, el } from '../controls.ts';
import { icon } from './icons.ts';

type Range = Extract<Control, { type: 'range' }>;

interface Channels {
  /** The control the bar moves: a time of day, or a share of a run. */
  time: Range;
  kind: 'hour' | 'progress';
  date?: Control;
  play?: Control;
}

/** The time controls a layer names, or null when it does not run on time. */
export function clockOf(manifest: LayerManifest): Channels | null {
  const controls = manifest.controls ?? [];
  const find = (kind: string) => controls.find((c) => c.clock === kind);
  const hour = find('hour');
  const progress = find('progress');
  const time = (hour ?? progress) as Range | undefined;
  if (!time || time.type !== 'range') return null;
  return { time, kind: hour ? 'hour' : 'progress', date: find('date'), play: find('play') };
}

/** Speeds of play: hours of the day (or per cent of a run) per second. */
const SPEEDS = [
  { label: '1×', hour: 0.5, progress: 2 },
  { label: '4×', hour: 2, progress: 8 },
  { label: '16×', hour: 8, progress: 32 },
];

/** Minutes the time zone is ahead of UTC at a moment. */
function zoneOffset(zone: string | null, utcMs: number): number {
  if (!zone) return -new Date(utcMs).getTimezoneOffset();
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-GB', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        .formatToParts(utcMs)
        .map((p) => [p.type, p.value]),
    );
    const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    return Math.round((local - utcMs) / 60000);
  } catch {
    return 0;
  }
}

export interface TimeBarHost {
  site: () => SiteInfo;
  connection: Connection;
  /** Saves values as the layer's start, as the inspector does. */
  save: (layer: string, params: Record<string, unknown>) => Promise<unknown>;
}

export class TimeBar {
  readonly element = el('div', 'ed-time');
  private layer: string | null = null;
  private channels: Channels | null = null;
  /** The saved values when the layer was opened, which the preview goes back to. */
  private start: Record<string, unknown> = {};
  /** What the bar itself last showed, to tell its own echoes from a change made elsewhere. */
  private mine: Record<string, unknown> = {};
  private value = 0;
  private playing = false;
  private speed = 0;
  private timer = 0;
  private last = 0;
  private readonly host: TimeBarHost;
  private readonly playButton = el('button', 'ed-time-play');
  private readonly speedButton = el('button', 'ed-time-speed');
  private readonly track = el('div', 'ed-time-track');
  private readonly shade = el('canvas', 'ed-time-shade');
  private readonly head = el('div', 'ed-time-head');
  private readonly readout = el('strong', 'ed-time-value');
  private readonly day = el('span', 'ed-time-day');
  private readonly note = el('span', 'ed-time-note');
  private readonly use = el('button', 'ed-button ed-time-use');
  private readonly back = el('button', 'ed-button ed-time-back');

  constructor(host: TimeBarHost) {
    this.host = host;
    this.element.hidden = true;
    this.element.setAttribute('role', 'group');
    this.element.ariaLabel = 'Time preview';
    this.playButton.type = this.speedButton.type = this.use.type = this.back.type = 'button';
    this.playButton.addEventListener('click', () => this.setPlaying(!this.playing));
    this.speedButton.title = 'How fast play runs';
    this.speedButton.addEventListener('click', () => {
      this.speed = (this.speed + 1) % SPEEDS.length;
      this.drawSpeed();
    });
    this.track.tabIndex = 0;
    this.track.setAttribute('role', 'slider');
    this.track.append(this.shade, this.head);
    this.use.append(icon('check', 14), el('span', undefined, 'Use as start'));
    this.use.title = 'Save this moment as where the layer starts when it opens';
    this.use.addEventListener('click', () => void this.keep());
    this.back.append(icon('reset', 14));
    this.back.ariaLabel = 'Back to the start';
    this.back.title = 'Show the moment the layer starts at again';
    this.back.addEventListener('click', () => this.restore());
    const times = el('div', 'ed-time-main');
    const ticks = el('div', 'ed-time-ticks');
    times.append(this.track, ticks);
    this.element.append(this.playButton, this.speedButton, this.day, times, this.readout, this.note, this.back, this.use);
    this.drawSpeed();
    this.scrubbing();
    new ResizeObserver(() => this.drawShade()).observe(this.track);
    // Leaving the page puts the preview back too, so the table never keeps a moment nobody chose.
    window.addEventListener('pagehide', () => this.close());
  }

  /** Follows the layer open in the editor; null, or a layer without time, hides the bar and puts the preview back. */
  open(id: string | null, manifest: LayerManifest | undefined, state: LayerState | undefined): void {
    if (id === this.layer) return;
    this.close();
    const channels = manifest ? clockOf(manifest) : null;
    if (!id || !state || !channels) return;
    this.layer = id;
    this.channels = channels;
    this.start = this.pick(state.params);
    this.mine = { ...this.start };
    this.value = Number(state.params[channels.time.id] ?? channels.time.default);
    this.element.hidden = false;
    this.element.dataset.kind = channels.kind;
    this.track.ariaLabel = channels.kind === 'hour' ? 'Time of day' : channels.time.label;
    const ticks = this.element.querySelector('.ed-time-ticks')!;
    const marks = channels.kind === 'hour' ? ['00', '06', '12', '18', '24'] : ['0 %', '25 %', '50 %', '75 %', '100 %'];
    ticks.replaceChildren(...marks.map((m) => el('span', undefined, m)));
    this.draw();
    this.drawShade();
  }

  /** The layer changed: a value set elsewhere (the inspector, the controller) becomes the start. */
  sync(id: string, state: LayerState): void {
    if (id !== this.layer || !this.channels) return;
    const now = this.pick(state.params);
    for (const [key, value] of Object.entries(now)) {
      if (JSON.stringify(value) === JSON.stringify(this.mine[key])) continue;
      // Not the bar's own echo: someone set it.
      this.start[key] = value;
      this.mine[key] = value;
      if (key === this.channels.time.id && !this.playing) this.value = Number(value);
      if (key === this.channels.date?.id) this.drawShade();
    }
    this.draw();
  }

  /** Puts the preview back as the layer starts, and hides the bar. */
  close(): void {
    this.setPlaying(false);
    if (this.layer && this.changed()) this.send(this.start);
    this.layer = null;
    this.channels = null;
    this.element.hidden = true;
  }

  private pick(params: Record<string, unknown>): Record<string, unknown> {
    const c = this.channels;
    if (!c) return {};
    const out: Record<string, unknown> = { [c.time.id]: params[c.time.id] ?? c.time.default };
    if (c.date) out[c.date.id] = params[c.date.id] ?? ('default' in c.date ? c.date.default : undefined);
    if (c.play) out[c.play.id] = params[c.play.id] ?? ('default' in c.play ? c.play.default : undefined);
    return out;
  }

  private changed(): boolean {
    const c = this.channels;
    return Boolean(c && Math.abs(this.value - Number(this.start[c.time.id])) > 1e-6);
  }

  /** Live only: what the table shows now, not what it starts with. */
  private send(params: Record<string, unknown>): void {
    if (!this.layer) return;
    Object.assign(this.mine, params);
    void this.host.connection.request('layer.set', { layer: this.layer, params }).catch(() => {});
  }

  private show(value: number): void {
    const c = this.channels;
    if (!c) return;
    const span = c.time.max - c.time.min;
    let next = value;
    // A day wraps round; a run stops at its end.
    if (c.kind === 'hour') next = c.time.min + ((((next - c.time.min) % span) + span) % span);
    else next = Math.min(c.time.max, Math.max(c.time.min, next));
    const step = c.time.step ?? 0;
    if (step) next = c.time.min + Math.round((next - c.time.min) / step) * step;
    this.value = Number(next.toFixed(4));
    const params: Record<string, unknown> = { [c.time.id]: this.value };
    // The layer's own animation would fight the bar: it rests while the bar is in charge.
    if (c.play && this.mine[c.play.id] === true) params[c.play.id] = false;
    this.send(params);
    this.draw();
  }

  private async keep(): Promise<void> {
    const c = this.channels;
    if (!this.layer || !c) return;
    this.setPlaying(false);
    const params = { [c.time.id]: this.value };
    await this.host.save(this.layer, params);
    Object.assign(this.start, params);
    this.draw();
  }

  private restore(): void {
    this.setPlaying(false);
    const c = this.channels;
    if (!c) return;
    this.value = Number(this.start[c.time.id]);
    this.send(this.start);
    this.draw();
  }

  private setPlaying(on: boolean): void {
    this.playing = on && this.channels !== null;
    window.clearInterval(this.timer);
    if (this.playing) {
      this.last = performance.now();
      // A few steps a second: each one asks the engine for a new moment.
      this.timer = window.setInterval(() => {
        const now = performance.now();
        const c = this.channels;
        if (!c) return this.setPlaying(false);
        const rate = SPEEDS[this.speed]![c.kind];
        const next = this.value + (rate * (now - this.last)) / 1000;
        this.last = now;
        if (c.kind === 'progress' && next >= c.time.max) {
          this.show(c.time.max);
          this.setPlaying(false);
          return;
        }
        this.show(next);
      }, 125);
    }
    this.draw();
  }

  private drawSpeed(): void {
    this.speedButton.textContent = SPEEDS[this.speed]!.label;
  }

  private draw(): void {
    const c = this.channels;
    if (!c) return;
    this.playButton.replaceChildren(icon(this.playing ? 'pause' : 'play', 14));
    this.playButton.title = this.playing ? 'Pause' : 'Play through the day in the preview';
    this.playButton.ariaLabel = this.playButton.title;
    const share = (this.value - c.time.min) / (c.time.max - c.time.min);
    this.head.style.left = `${share * 100}%`;
    this.track.setAttribute('aria-valuemin', String(c.time.min));
    this.track.setAttribute('aria-valuemax', String(c.time.max));
    this.track.setAttribute('aria-valuenow', String(this.value));
    const text = c.kind === 'hour' ? clock(this.value) : `${Math.round(this.value)} %`;
    this.track.setAttribute('aria-valuetext', text);
    this.readout.textContent = text;
    const date = c.date ? this.start[c.date.id] : undefined;
    this.day.textContent = typeof date === 'string' ? new Date(`${date}T12:00:00Z`).toLocaleDateString([], { day: 'numeric', month: 'short' }) : '';
    this.day.hidden = !this.day.textContent;
    const moved = this.changed();
    const startText = c.kind === 'hour' ? clock(Number(this.start[c.time.id])) : `${Math.round(Number(this.start[c.time.id]))} %`;
    this.note.textContent = moved ? `Preview · starts ${startText}` : 'Start';
    this.note.title = moved ? `Only the preview shows this moment. The layer still starts at ${startText} until you use this as the start.` : 'The moment the layer starts at when it opens';
    this.note.classList.toggle('is-moved', moved);
    this.use.disabled = !moved;
    this.back.disabled = !moved;
  }

  /** Night, twilight and day along the track, from the sun at the table on the day shown. */
  private drawShade(): void {
    const c = this.channels;
    const width = this.track.clientWidth;
    if (!c || width === 0) return;
    const ratio = window.devicePixelRatio || 1;
    this.shade.width = Math.round(width * ratio);
    this.shade.height = 1;
    const g = this.shade.getContext('2d')!;
    if (c.kind !== 'hour') {
      g.fillStyle = '#dfe3ea';
      g.fillRect(0, 0, this.shade.width, 1);
      return;
    }
    const site = this.host.site();
    const date = c.date && typeof this.start[c.date.id] === 'string' ? (this.start[c.date.id] as string) : new Date().toISOString().slice(0, 10);
    const [y, m, d] = date.split('-').map(Number) as [number, number, number];
    const midnight = Date.UTC(y, m - 1, d);
    const offset = zoneOffset(site.timezone, midnight + 12 * 3600_000);
    for (let x = 0; x < this.shade.width; x++) {
      const hour = c.time.min + ((c.time.max - c.time.min) * x) / this.shade.width;
      const utc = midnight + (hour * 60 - offset) * 60_000;
      const degrees = sunPosition(utc, site.origin.lat, site.origin.lon).altitude;
      // Night is dark blue, twilight purple, the day pale amber, brightest at noon.
      g.fillStyle = degrees < -6 ? '#2b3550' : degrees < 0 ? '#6d6a9a' : `hsl(40 ${70 + Math.min(20, degrees / 3)}% ${82 - Math.min(10, degrees / 6)}%)`;
      g.fillRect(x, 0, 1, 1);
    }
  }

  /** Dragging on the track, clicking it, and the arrow keys move the preview. */
  private scrubbing(): void {
    const at = (event: PointerEvent): number => {
      const c = this.channels!;
      const box = this.track.getBoundingClientRect();
      const share = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
      return c.time.min + share * (c.time.max - c.time.min);
    };
    this.track.addEventListener('pointerdown', (event) => {
      if (!this.channels) return;
      this.setPlaying(false);
      this.track.setPointerCapture(event.pointerId);
      this.show(at(event));
    });
    this.track.addEventListener('pointermove', (event) => {
      if (this.channels && this.track.hasPointerCapture(event.pointerId)) this.show(at(event));
    });
    this.track.addEventListener('keydown', (event) => {
      const c = this.channels;
      if (!c) return;
      const step = c.kind === 'hour' ? (event.shiftKey ? 1 : 0.25) : event.shiftKey ? 10 : 1;
      if (event.key === 'ArrowRight' || event.key === 'ArrowUp') this.show(this.value + step);
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') this.show(this.value - step);
      else if (event.key === 'Home') this.show(c.time.min);
      else if (event.key === 'End') this.show(c.kind === 'hour' ? c.time.max - (c.time.step ?? 0.25) : c.time.max);
      else if (event.key === ' ') this.setPlaying(!this.playing);
      else return;
      event.preventDefault();
      event.stopPropagation();
    });
  }
}
