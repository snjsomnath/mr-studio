// Three seasons side by side (#256, from #81). The engine adds up the hours of direct sun on the
// equinox, midsummer and midwinter of the chosen year at once. The table has one model, so it
// shows one season at a time, all on one scale of hours, and moves through them; the controller's
// hero lays the three side by side as small maps on that same scale.
import { lut, zonedTimeToUtc } from '@mrstudio/sdk';
import type { Colormap, FieldFrame, FieldOverlay, FieldStream, PanelContext, PanelHandlers, TableContext } from '@mrstudio/sdk';

import { sunDay, sunHoursColormap, windowParams } from './look.ts';
import type { SunDay } from './look.ts';

export const SEASONS = [
  { key: 'mar', monthDay: '03-20', name: 'Equinox' },
  { key: 'jun', monthDay: '06-21', name: 'Midsummer' },
  { key: 'dec', monthDay: '12-21', name: 'Midwinter' },
] as const;

/** One season as the hero draws it, published as `shared.seasons`. */
export interface SeasonCard {
  name: string;
  date: string;
  /** Hours of daylight, and of direct sun on average over the table. */
  daylight: number;
  mean: number;
  /** Share (0..1) of the table with at least the threshold's hours, when one is set. */
  pass: number | null;
  progress: number;
  /** A small map of sun hours on the common scale: `w` by `h` bytes, 255 the scale's top, as base64. */
  thumb: string;
  w: number;
  h: number;
}

type Params = { mode: string; date: string; trees: boolean; threshold: number; season: string; opacity: number; window: string };

/** Seconds each season stays on the table while they take turns. */
export const CYCLE_S = 7;
/** The fade from one season to the next eases in with this time constant, in seconds: about a second in all. */
const CROSSFADE_S = 0.35;
/** The small maps' width in cells. */
const THUMB_W = 120;

/** The date of a season in the year of `date`. */
export const seasonDate = (date: string, k: number) => `${date.slice(0, 4)}-${SEASONS[k]!.monthDay}`;

/** A frame's values in hours, whether quantised or not. */
export function hoursOf(frame: Pick<FieldFrame, 'data' | 'min' | 'max'>): Float32Array {
  if (frame.data instanceof Float32Array) return frame.data;
  const out = new Float32Array(frame.data.length);
  const span = frame.max - frame.min;
  for (let i = 0; i < out.length; i++) out[i] = frame.min + (frame.data[i]! / 255) * span;
  return out;
}

/** Hours quantised over 0..`top`, so every season is drawn on the same scale. */
export function onScale(hours: Float32Array, top: number): Uint8Array {
  const out = new Uint8Array(hours.length);
  const k = top > 0 ? 255 / top : 0;
  for (let i = 0; i < hours.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(hours[i]! * k)));
  return out;
}

/** The average hours, and the share of cells at or above `threshold` (null without one). */
export function summary(hours: Float32Array, threshold: number): { mean: number; pass: number | null } {
  let sum = 0;
  let pass = 0;
  for (const h of hours) {
    sum += h;
    if (h >= threshold - 1e-3) pass++;
  }
  const n = Math.max(1, hours.length);
  return { mean: sum / n, pass: threshold > 0 ? pass / n : null };
}

/** A small copy of a quantised grid, `w` cells wide, by nearest cells. */
export function shrink(values: Uint8Array, width: number, height: number, w = THUMB_W): { data: Uint8Array; w: number; h: number } {
  const outW = Math.min(width, w);
  const outH = Math.max(1, Math.round((height * outW) / width));
  const data = new Uint8Array(outW * outH);
  for (let y = 0; y < outH; y++) {
    const sy = Math.min(height - 1, Math.floor(((y + 0.5) * height) / outH));
    for (let x = 0; x < outW; x++) data[y * outW + x] = values[sy * width + Math.min(width - 1, Math.floor(((x + 0.5) * width) / outW))]!;
  }
  return { data, w: outW, h: outH };
}

const base64 = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** Which season the table shows: the one pinned, or the one whose turn it is. */
export function seasonShown(season: string, seconds: number): number {
  const pinned = SEASONS.findIndex((s) => s.key === season);
  return pinned >= 0 ? pinned : Math.floor(seconds / CYCLE_S) % SEASONS.length;
}

/**
 * Runs the three seasons on the table. `colormap(top)` is the ramp for a scale ending at `top`
 * hours; `showDay` puts a season's day on the sun path.
 */
export function seasonsOnTable(
  ctx: TableContext<Params>,
  overlay: FieldOverlay,
  colormap: (top: number) => Colormap,
  showDay: (day: SunDay) => void,
) {
  const results: ({ frame: FieldFrame; hours: Float32Array; daylight: number; progress: number } | null)[] = SEASONS.map(() => null);
  const streams: FieldStream[] = [];
  let generation = 0;
  let clock = 0;
  let shown = -1;
  let drawnRevision = '';

  const top = () => Math.max(1, ...results.map((r) => r?.daylight ?? 0));

  function publish() {
    const t = top();
    const cards: SeasonCard[] = SEASONS.map((season, k) => {
      const r = results[k];
      const date = seasonDate(ctx.params.date, k);
      if (!r) return { name: season.name, date, daylight: 0, mean: 0, pass: null, progress: 0, thumb: '', w: 0, h: 0 };
      const small = shrink(onScale(r.hours, t), r.frame.width, r.frame.height);
      const { mean, pass } = summary(r.hours, ctx.params.threshold);
      return { name: season.name, date, daylight: round(r.daylight), mean: round(mean), pass: pass === null ? null : round(pass), progress: round(r.progress), thumb: base64(small.data), w: small.w, h: small.h };
    });
    ctx.publish({ seasons: cards, seasonTop: round(t), ramp: colormap(t), rampLow: '0 h', rampHigh: `${round(t)} h` });
  }

  /** Puts the shown season on the table, on the common scale. */
  function draw(force = false) {
    const k = seasonShown(ctx.params.season, clock);
    const r = results[k];
    const key = `${k}|${r?.frame.revision ?? -1}|${top()}`;
    if (!force && key === drawnRevision) return;
    drawnRevision = key;
    if (k !== shown) {
      shown = k;
      showDay(sunDay(ctx.site, seasonDate(ctx.params.date, k)));
      ctx.publish({ seasonShown: k });
    }
    overlay.setStyle({ colormap: colormap(top()), glide: CROSSFADE_S });
    if (r) overlay.set({ ...r.frame, min: 0, max: top(), data: onScale(r.hours, top()) });
  }

  async function open() {
    const mine = ++generation;
    close(false);
    results.fill(null);
    drawnRevision = '';
    const opened = await Promise.all(
      SEASONS.map((_, k) =>
        ctx.engine.open(
          'sunlight',
          {
            mode: 'day',
            time: zonedTimeToUtc(seasonDate(ctx.params.date, k), 12, ctx.site.timezone),
            trees: ctx.params.trees,
            ...windowParams(ctx.site, seasonDate(ctx.params.date, k), ctx.params.window),
          },
          ['sun_hours'],
        ),
      ),
    );
    if (mine !== generation) {
      for (const s of opened) s.close();
      return;
    }
    streams.push(...opened);
    opened.forEach((stream, k) => {
      let daylight = 0;
      let progress = 0;
      stream.onStatus((status) => {
        daylight = status.info.daylight_hours ?? daylight;
        progress = status.progress;
        const r = results[k];
        if (r) {
          r.daylight = daylight;
          r.progress = progress;
        }
      });
      stream.on('sun_hours', (frame) => {
        results[k] = { frame, hours: hoursOf(frame), daylight, progress };
        draw();
        publishSoon();
      });
    });
    publish();
    draw(true);
  }

  // Cards are published at most a few times a second while the sums come in.
  let pending: ReturnType<typeof setTimeout> | undefined;
  function publishSoon() {
    pending ??= setTimeout(() => {
      pending = undefined;
      publish();
    }, 300);
  }

  function close(all = true) {
    if (all) generation++;
    for (const s of streams.splice(0)) s.close();
    clearTimeout(pending);
    pending = undefined;
    shown = -1;
  }

  return {
    open,
    close,
    /** Moves the turn on; called every frame while seasons show. */
    tick(dt: number) {
      clock += dt;
      draw();
    },
    update(changed: string[]) {
      if (changed.some((key) => key === 'date' || key === 'trees' || key === 'window')) void open();
      else {
        if (changed.includes('season')) clock = 0;
        if (changed.includes('threshold')) publish();
        draw(true);
      }
    },
  };
}

const round = (v: number) => Math.round(v * 100) / 100;

// ---- The controller's hero: the seasons side by side ------------------------------------

const STYLE = `
.sun-seasons { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1.25rem; padding: 1.5rem; border-radius: 1.125rem; color: #fff;
  background: radial-gradient(120% 120% at 50% 0%, #1d2a4d 0%, #111830 60%, #0a0f1f 100%); box-shadow: 0 1.25rem 3.75rem rgb(0 0 0 / 0.35), inset 0 0 0 1px rgb(255 255 255 / 0.06); }
.sun-seasons[hidden] { display: none; }
.sun-season { position: relative; display: flex; flex-direction: column; gap: 0.75rem; padding: 1rem; border: 0; border-radius: 1rem; color: inherit; font: inherit; text-align: left; cursor: pointer;
  background: rgb(255 255 255 / 0.06); box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.1); transition: background 0.3s, box-shadow 0.3s, transform 0.3s; }
.sun-season.is-shown { background: rgb(255 255 255 / 0.13); box-shadow: inset 0 0 0 2px #ffd45e, 0 0.75rem 2rem rgb(255 196 80 / 0.18); transform: translateY(-0.25rem); }
.sun-season canvas { width: 100%; border-radius: 0.6rem; background: #0a0e2c; image-rendering: auto; }
.sun-season-head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; }
.sun-season-head b { font-size: 1.5rem; font-weight: 600; }
.sun-season-head span { font-size: 0.95rem; opacity: 0.78; }
.sun-season-facts { display: flex; gap: 1.25rem; }
.sun-season-facts div small { display: block; font-size: 0.72rem; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.75; }
.sun-season-facts div b { font-size: 1.6rem; font-weight: 600; font-variant-numeric: tabular-nums; }
.sun-season-facts div b small { display: inline; font-size: 0.95rem; letter-spacing: 0; text-transform: none; margin-left: 0.15rem; }
.sun-season-bar { position: absolute; left: 1rem; right: 1rem; bottom: 0.4rem; height: 0.2rem; border-radius: 0.1rem; background: rgb(255 255 255 / 0.12); overflow: hidden; }
.sun-season-bar i { display: block; height: 100%; background: #ffd45e; }
.sun-season-pinned { position: absolute; top: 4.4rem; left: 1.6rem; padding: 0.2rem 0.55rem; border-radius: 0.5rem; font-size: 0.75rem; background: #ffd45e; color: #1c1505; font-weight: 600; }
`;

export function seasonsHero(ctx: PanelContext<Params>, el: HTMLElement): PanelHandlers {
  const style = document.createElement('style');
  style.textContent = STYLE;
  const root = document.createElement('div');
  root.className = 'sun-seasons';
  el.append(style, root);
  const cards = SEASONS.map((season) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'sun-season';
    card.innerHTML = `<div class="sun-season-head"><b></b><span></span></div><canvas></canvas>
      <div class="sun-season-facts"><div><small></small><b></b></div><div><small></small><b></b></div><div data-pass><small></small><b></b></div></div>
      <div class="sun-season-bar"><i></i></div><span class="sun-season-pinned" hidden></span>`;
    // A tap pins the season on the table; a tap on the pinned one lets them take turns again.
    card.addEventListener('click', () => ctx.setParams({ season: ctx.params.season === season.key ? 'cycle' : season.key }));
    root.append(card);
    return card;
  });
  let drawn = '';

  function update() {
    root.hidden = ctx.params.mode !== 'seasons';
    if (root.hidden) return;
    const list = (ctx.shared.seasons ?? []) as SeasonCard[];
    const shownIndex = Number(ctx.shared.seasonShown ?? -1);
    const ramp = lut((ctx.shared.ramp as Colormap | undefined) ?? sunHoursColormap);
    const locale = ctx.language === 'sv' ? 'sv-SE' : 'en-GB';
    cards.forEach((card, k) => {
      const season = SEASONS[k]!;
      const info = list[k];
      card.classList.toggle('is-shown', k === shownIndex);
      card.setAttribute('aria-pressed', String(ctx.params.season === season.key));
      const [name, date] = card.querySelectorAll<HTMLElement>('.sun-season-head > *');
      name!.textContent = ctx.say(season.name);
      date!.textContent = new Date(`${seasonDate(ctx.params.date, k)}T12:00:00Z`).toLocaleDateString(locale, { day: 'numeric', month: 'long', timeZone: 'UTC' });
      const facts = card.querySelectorAll<HTMLElement>('.sun-season-facts > div');
      const fact = (n: number, label: string, value: string, unit: string) => {
        facts[n]!.querySelector('small')!.textContent = label;
        facts[n]!.querySelector('b')!.innerHTML = `${value}<small>${unit}</small>`;
      };
      fact(0, ctx.say('Daylight'), info?.progress ? info.daylight.toFixed(1) : '–', 'h');
      fact(1, ctx.say('Sun, on average'), info?.progress ? info.mean.toFixed(1) : '–', 'h');
      const pass = info?.pass ?? null;
      facts[2]!.hidden = pass === null;
      if (pass !== null) fact(2, ctx.say('At least {hours} h', { hours: ctx.params.threshold }), String(Math.round(pass * 100)), '%');
      card.querySelector<HTMLElement>('.sun-season-bar')!.hidden = (info?.progress ?? 0) >= 1;
      card.querySelector<HTMLElement>('.sun-season-bar i')!.style.width = `${Math.round((info?.progress ?? 0) * 100)}%`;
      const pinned = card.querySelector<HTMLElement>('.sun-season-pinned')!;
      pinned.hidden = ctx.params.season !== season.key;
      pinned.textContent = ctx.say('On the table');
      // The small map, redrawn only when it changed.
      const canvas = card.querySelector('canvas')!;
      const key = `${info?.thumb.length ?? 0}|${info?.thumb.slice(0, 64) ?? ''}|${info?.thumb.slice(-64) ?? ''}|${JSON.stringify(ctx.shared.ramp ?? null).length}`;
      if (!info?.thumb || (canvas.dataset.key === key && drawn)) return;
      canvas.dataset.key = key;
      canvas.width = info.w;
      canvas.height = info.h;
      const bytes = Uint8Array.from(atob(info.thumb), (c) => c.charCodeAt(0));
      const image = canvas.getContext('2d')!.createImageData(info.w, info.h);
      for (let i = 0; i < bytes.length; i++) {
        const v = bytes[i]! * 4;
        image.data[i * 4] = ramp[v]!;
        image.data[i * 4 + 1] = ramp[v + 1]!;
        image.data[i * 4 + 2] = ramp[v + 2]!;
        image.data[i * 4 + 3] = 255;
      }
      canvas.getContext('2d')!.putImageData(image, 0, 0);
    });
    drawn = 'yes';
  }
  update();
  return { update };
}
