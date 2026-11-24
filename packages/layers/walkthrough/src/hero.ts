// Video walk's hero on the controller (#194): the video, large, with play and pause and a
// scrubber along its foot. The hero is the clock: what it does is written into the layer's
// state params, and the table's walker follows them.
import { siteDataUrl } from '@mrstudio/sdk';
import type { PanelContext, PanelHandlers } from '@mrstudio/sdk';

import type { Params } from './index.ts';
import { clock, videoDataset, videoTime } from './path.ts';

/** The video is moved to the clock when it is this many seconds off. */
const DRIFT_S = 0.3;

const STYLE = `
.walk-hero { position: relative; height: clamp(16rem, 44vh, 32rem); aspect-ratio: 16 / 9; max-width: 100%; margin: 0 auto; border-radius: 1.125rem; overflow: hidden; color: #fff; user-select: none;
  background: #0b0d17; box-shadow: 0 1.25rem 3.75rem rgb(0 0 0 / 0.35), inset 0 0 0 1px rgb(255 255 255 / 0.06); }
.walk-hero [hidden] { display: none !important; }
.walk-hero video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; background: #0b0d17; }
.walk-hero-note { position: absolute; left: 50%; top: 45%; transform: translate(-50%, -50%); max-width: 70%; text-align: center; font-size: 1.1rem; line-height: 1.4;
  padding: 0.9rem 1.3rem; border-radius: 0.8rem; background: rgb(255 255 255 / 0.08); box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.16); }
.walk-hero-band { position: absolute; left: 0; right: 0; bottom: 0; display: flex; align-items: center; gap: 1.25rem; padding: 1.5rem 2rem 1.25rem;
  background: linear-gradient(rgb(6 8 16 / 0), rgb(6 8 16 / 0.78)); }
.walk-hero-play { flex: none; width: 3.75rem; height: 3.75rem; border: 0; border-radius: 50%; display: grid; place-items: center; color: #fff; cursor: pointer;
  background: rgb(255 255 255 / 0.16); backdrop-filter: blur(0.875rem); -webkit-backdrop-filter: blur(0.875rem); box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.3); }
.walk-hero-play svg { width: 1.6rem; height: 1.6rem; }
.walk-hero-bar { position: relative; flex: 1; height: 2.75rem; cursor: pointer; touch-action: none; }
.walk-hero-bar::before { content: ''; position: absolute; left: 0; right: 0; top: 50%; height: 0.4rem; margin-top: -0.2rem; border-radius: 0.2rem; background: rgb(255 255 255 / 0.25); }
.walk-hero-bar i { position: absolute; left: 0; top: 50%; height: 0.4rem; margin-top: -0.2rem; border-radius: 0.2rem; background: #7fe7ff; box-shadow: 0 0 0.75rem #38d6ff; }
.walk-hero-bar b { position: absolute; top: 50%; width: 1.25rem; height: 1.25rem; margin: -0.625rem 0 0 -0.625rem; border-radius: 50%; background: #fff; box-shadow: 0 0 0.75rem #38d6ff; }
.walk-hero-time { flex: none; font-size: 1.1rem; font-variant-numeric: tabular-nums; opacity: 0.92; min-width: 6.5rem; text-align: right; }
`;

const PLAY = '<svg viewBox="0 0 24 24" fill="currentColor" style="margin-left:0.2rem"><path d="M7 5l12 7-12 7z"/></svg>';
const PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>';

export function walkHero(ctx: PanelContext<Params>, el: HTMLElement): PanelHandlers {
  el.innerHTML = `<style>${STYLE}</style>`;
  const root = document.createElement('div');
  root.className = 'walk-hero';
  root.innerHTML = `
    <video playsinline muted preload="auto"></video>
    <div class="walk-hero-note" hidden></div>
    <div class="walk-hero-band">
      <button class="walk-hero-play" type="button"></button>
      <div class="walk-hero-bar" role="slider" tabindex="0"><i></i><b></b></div>
      <div class="walk-hero-time"></div>
    </div>`;
  el.append(root);
  const video = root.querySelector('video')!;
  const note = root.querySelector<HTMLElement>('.walk-hero-note')!;
  const play = root.querySelector<HTMLButtonElement>('.walk-hero-play')!;
  const bar = root.querySelector<HTMLElement>('.walk-hero-bar')!;
  const fill = bar.querySelector('i')!;
  const knob = bar.querySelector('b')!;
  const time = root.querySelector<HTMLElement>('.walk-hero-time')!;

  let src = '';
  let dragged: number | null = null;
  const length = () => (Number.isFinite(video.duration) && video.duration > 0 ? video.duration : Number(ctx.shared.length) || 0);
  const clockNow = () => videoTime(ctx.params, Date.now(), length(), ctx.params.loop);

  /** The video follows the shared clock: playing or paused, and where. */
  function sync() {
    const name = videoDataset(ctx.site, ctx.params.video);
    // A dataset by name, or a video kept under data/media by its path (#306).
    const url = name ? (siteDataUrl(ctx.site, name) ?? (name.includes('/') ? `/site/${name}` : '')) : '';
    if (url !== src) {
      src = url;
      if (url) video.src = url;
      else video.removeAttribute('src');
    }
    const missing = !url ? ctx.say('Add a video to the table') : ctx.shared.note ? String(ctx.shared.note) : '';
    note.hidden = !missing;
    note.textContent = missing;
    video.loop = ctx.params.loop;
    const t = dragged ?? clockNow();
    if (video.readyState >= 1 && Math.abs(video.currentTime - t) > DRIFT_S) video.currentTime = t;
    if (ctx.params.playing && dragged === null) {
      if (video.paused) video.play().catch(() => {});
    } else if (!video.paused) video.pause();
    draw();
  }

  function draw() {
    const total = length();
    const t = dragged ?? (video.readyState >= 1 ? video.currentTime : clockNow());
    const share = total > 0 ? Math.min(1, t / total) : 0;
    fill.style.width = `${share * 100}%`;
    knob.style.left = `${share * 100}%`;
    time.textContent = `${clock(t)} / ${clock(total)}`;
    play.innerHTML = ctx.params.playing ? PAUSE : PLAY;
    play.setAttribute('aria-label', ctx.params.playing ? ctx.say('Pause the walk') : ctx.say('Play the walk'));
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', String(Math.round(total)));
    bar.setAttribute('aria-valuenow', String(Math.round(t)));
    bar.setAttribute('aria-valuetext', clock(t));
  }

  const round = (t: number) => Math.round(t * 100) / 100;
  play.addEventListener('click', () => {
    const at = round(video.readyState >= 1 ? video.currentTime : clockNow());
    // Played to the end without looping: Play starts again from the start.
    const from = !ctx.params.playing && length() > 0 && at >= length() - 0.05 ? 0 : at;
    ctx.setParams(ctx.params.playing ? { playing: false, at } : { playing: true, at: from, since: Date.now() });
  });
  video.addEventListener('ended', () => {
    if (!ctx.params.loop && ctx.params.playing) ctx.setParams({ playing: false, at: round(length()) });
  });
  video.addEventListener('loadedmetadata', sync);
  video.addEventListener('timeupdate', draw);

  // Drag along the bar to move through the video; the table's walker moves with it.
  const toTime = (event: PointerEvent) => {
    const box = bar.getBoundingClientRect();
    return round(Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)) * length());
  };
  let sent = 0;
  const send = (at: number, force = false) => {
    if (!force && performance.now() - sent < 80) return;
    sent = performance.now();
    ctx.setParams({ at, since: Date.now() });
  };
  bar.addEventListener('pointerdown', (event) => {
    if (!length()) return;
    bar.setPointerCapture(event.pointerId);
    dragged = toTime(event);
    video.currentTime = dragged;
    send(dragged, true);
    draw();
  });
  bar.addEventListener('pointermove', (event) => {
    if (dragged === null) return;
    dragged = toTime(event);
    video.currentTime = dragged;
    send(dragged);
    draw();
  });
  const release = () => {
    if (dragged === null) return;
    send(dragged, true);
    dragged = null;
  };
  bar.addEventListener('pointerup', release);
  bar.addEventListener('pointercancel', release);
  bar.addEventListener('keydown', (event) => {
    const step = { ArrowLeft: -5, ArrowRight: 5, PageDown: -30, PageUp: 30 }[event.key];
    if (step === undefined || !length()) return;
    event.preventDefault();
    send(round(Math.min(length(), Math.max(0, clockNow() + step))), true);
  });

  ctx.onCleanup(() => {
    video.pause();
    video.removeAttribute('src');
    video.load();
  });
  sync();
  return { update: sync };
}
