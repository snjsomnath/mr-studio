// Field walk's hero on the controller (#445): the spot on show, large. A photo fills the frame
// over a soft blur of itself; a sound is a big play button over its waveform. The walker's animal,
// name, time and note sit at the foot. Previous and Next on the sides, and a strip of every spot
// underneath, walker by walker, to pick one. A tap on a dot on the table picks it too.
import type { PanelContext, PanelHandlers } from '@mrstudio/sdk';

import type { Params } from './index.ts';
import { clockTime, fetchWalk, mediaUrl, ordered, step, tracks } from './spots.ts';
import type { Arriving, Spot, Track } from './spots.ts';

const STYLE = `
.fw { display: grid; gap: 0.9rem; color: #fff; user-select: none; }
.fw [hidden] { display: none !important; }
.fw-frame { position: relative; height: clamp(16rem, 46vh, 34rem); border-radius: 1.125rem; overflow: hidden; background: #0b0d17;
  box-shadow: 0 1.25rem 3.75rem rgb(0 0 0 / 0.35), inset 0 0 0 1px rgb(255 255 255 / 0.06); }
/* Kept open alongside another layer (an X-ray over the walk): the spots stay on the table and the
   controller keeps one line for the walk; its viewer comes back when the other layer closes. */
.layer-open:not(.is-alongside) ~ .is-alongside .fw { display: none; }
.is-alongside .fw { flex: 1 1 100%; }
.fw-blur { position: absolute; inset: -2rem; background-size: cover; background-position: center; filter: blur(2rem) brightness(0.55); }
.fw-photo { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
.fw-sound { position: absolute; inset: 0; display: grid; place-items: center; }
.fw-wave { position: absolute; left: 6%; right: 6%; top: 22%; height: 46%; width: 88%; }
.fw-play { position: relative; width: 6.5rem; height: 6.5rem; border: 0; border-radius: 50%; display: grid; place-items: center; color: #fff; cursor: pointer;
  background: rgb(255 255 255 / 0.16); backdrop-filter: blur(0.875rem); -webkit-backdrop-filter: blur(0.875rem); box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.35), 0 0 3rem var(--c, #7fe7ff); }
.fw-play svg { width: 2.6rem; height: 2.6rem; }
.fw-foot { position: absolute; left: 0; right: 0; bottom: 0; display: flex; align-items: center; gap: 1rem; padding: 2.5rem 1.75rem 1.25rem;
  background: linear-gradient(rgb(6 8 16 / 0), rgb(6 8 16 / 0.8)); }
.fw-who { flex: none; width: 3.25rem; height: 3.25rem; border-radius: 50%; display: grid; place-items: center; font-size: 1.7rem; box-shadow: 0 0 0 3px rgb(255 255 255 / 0.85); }
.fw-words { min-width: 0; }
.fw-words b { display: block; font-size: 1.35rem; font-weight: 600; }
.fw-words span { display: block; font-size: 1.05rem; opacity: 0.88; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fw-count { margin-left: auto; font-size: 1rem; opacity: 0.8; font-variant-numeric: tabular-nums; }
.fw-nav { position: absolute; top: 50%; width: 3.5rem; height: 3.5rem; margin-top: -1.75rem; border: 0; border-radius: 50%; color: #fff; cursor: pointer; font-size: 1.6rem; line-height: 1;
  background: rgb(255 255 255 / 0.14); backdrop-filter: blur(0.875rem); -webkit-backdrop-filter: blur(0.875rem); box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.25); }
.fw-prev { left: 1.25rem; } .fw-next { right: 1.25rem; }
.fw-empty { position: absolute; inset: 0; display: grid; place-content: center; gap: 0.6rem; text-align: center; padding: 2rem; }
.fw-empty b { font-size: 1.6rem; font-weight: 600; }
.fw-empty span { font-size: 1.1rem; opacity: 0.8; max-width: 34rem; line-height: 1.4; }
.fw-strip { display: flex; gap: 0.5rem; overflow-x: auto; padding: 0.25rem 0.1rem 0.5rem; scrollbar-width: thin; }
.fw-strip-walker { flex: none; align-self: center; width: 2.25rem; height: 2.25rem; border-radius: 50%; display: grid; place-items: center; font-size: 1.15rem; margin-left: 0.35rem; }
.fw-thumb { flex: none; position: relative; width: 5.25rem; height: 3.75rem; border: 0; padding: 0; border-radius: 0.6rem; overflow: hidden; cursor: pointer; background: #1a1d2b;
  box-shadow: inset 0 0 0 2px var(--c); opacity: 0.8; }
.fw-thumb[aria-current="true"] { opacity: 1; box-shadow: inset 0 0 0 3px #fff, 0 0 0 2px var(--c); }
.fw-arriving { cursor: default; opacity: 0.6; background: transparent; box-shadow: none; outline: 2px dashed var(--c); outline-offset: -2px; animation: fw-pulse 1.4s ease-in-out infinite; }
@keyframes fw-pulse { 50% { opacity: 0.25; } }
.fw-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.fw-thumb i { position: absolute; inset: 0; display: grid; place-items: center; font-style: normal; font-size: 1.4rem; color: var(--c); }
.fw-tools { display: flex; gap: 0.6rem; justify-content: flex-end; }
.fw-tools button { border: 0; border-radius: 0.6rem; padding: 0.5rem 0.9rem; font: inherit; font-size: 0.95rem; cursor: pointer; color: inherit; background: rgb(127 127 127 / 0.16); }
.fw-tools button[data-armed="true"] { background: #c92a2a; color: #fff; }
`;

const PLAY = '<svg viewBox="0 0 24 24" fill="currentColor" style="margin-left:0.25rem"><path d="M7 5l12 7-12 7z"/></svg>';
const PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>';

export function fieldHero(ctx: PanelContext<Params>, el: HTMLElement): PanelHandlers {
  el.innerHTML = `<style>${STYLE}</style>`;
  const root = document.createElement('div');
  root.className = 'fw';
  root.innerHTML = `
    <div class="fw-frame">
      <div class="fw-blur"></div>
      <img class="fw-photo" alt="" hidden>
      <div class="fw-sound" hidden><canvas class="fw-wave"></canvas><button class="fw-play" type="button"></button></div>
      <div class="fw-empty" hidden><b></b><span></span></div>
      <button class="fw-nav fw-prev" type="button">‹</button>
      <button class="fw-nav fw-next" type="button">›</button>
      <div class="fw-foot"><div class="fw-who"></div><div class="fw-words"><b></b><span></span></div><div class="fw-count"></div></div>
    </div>
    <div class="fw-strip" role="listbox"></div>
    <div class="fw-tools"><button type="button" class="fw-remove"></button><button type="button" class="fw-clear"></button></div>`;
  el.append(root);
  const $ = <T extends Element>(s: string) => root.querySelector<T>(s)!;
  const blur = $<HTMLElement>('.fw-blur');
  const photo = $<HTMLImageElement>('.fw-photo');
  const sound = $<HTMLElement>('.fw-sound');
  const wave = $<HTMLCanvasElement>('.fw-wave');
  const play = $<HTMLButtonElement>('.fw-play');
  const empty = $<HTMLElement>('.fw-empty');
  const prev = $<HTMLButtonElement>('.fw-prev');
  const next = $<HTMLButtonElement>('.fw-next');
  const foot = $<HTMLElement>('.fw-foot');
  const who = $<HTMLElement>('.fw-who');
  const name = $<HTMLElement>('.fw-words b');
  const line = $<HTMLElement>('.fw-words span');
  const count = $<HTMLElement>('.fw-count');
  const strip = $<HTMLElement>('.fw-strip');
  const remove = $<HTMLButtonElement>('.fw-remove');
  const clear = $<HTMLButtonElement>('.fw-clear');
  $<HTMLElement>('.fw-empty b').textContent = ctx.say('No spots yet');
  $<HTMLElement>('.fw-empty span').textContent = ctx.say('Visitors mark spots on their phones: Field walk, at the top of the phone page. Each spot shows here as it arrives.');
  prev.setAttribute('aria-label', ctx.say('Previous spot'));
  next.setAttribute('aria-label', ctx.say('Next spot'));
  remove.textContent = ctx.say('Remove this spot');
  clear.textContent = ctx.say('Clear the walk');

  const audio = new Audio();
  audio.preload = 'auto';
  let spots: Spot[] = [];
  let walks: Track[] = [];
  let arriving: Arriving[] = [];
  let revision = -1;
  let showing = '';
  let peaks: number[] = [];
  let loading = 0;

  const show = (id: string) => ctx.setParams({ shown: id });
  const current = (): Spot | null => spots.find((s) => s.id === ctx.params.shown) ?? null;
  const colourOf = (spot: Spot) => walks.find((t) => t.walker.id === spot.walker.id)?.colour ?? '#7fe7ff';

  prev.onclick = () => {
    const s = step(spots, ctx.params.shown, -1);
    if (s) show(s.id);
  };
  next.onclick = () => {
    const s = step(spots, ctx.params.shown, 1);
    if (s) show(s.id);
  };
  play.onclick = () => {
    if (audio.paused) void audio.play().catch(() => {});
    else audio.pause();
  };
  audio.onplay = audio.onpause = audio.onended = () => (play.innerHTML = audio.paused ? PLAY : PAUSE);
  remove.onclick = () => void ctx.action('remove').catch(() => {});
  // Clearing deletes everyone's photos and sounds: the button asks once more.
  let armed: number | undefined;
  clear.onclick = () => {
    if (clear.dataset.armed === 'true') {
      window.clearTimeout(armed);
      clear.dataset.armed = 'false';
      clear.textContent = ctx.say('Clear the walk');
      void ctx.action('clear').catch(() => {});
      return;
    }
    clear.dataset.armed = 'true';
    clear.textContent = ctx.say('Press again to delete {n} spots', {
      n: spots.length,
    });
    armed = window.setTimeout(() => {
      clear.dataset.armed = 'false';
      clear.textContent = ctx.say('Clear the walk');
    }, 4000);
  };

  async function load() {
    const mine = ++loading;
    const walk = await fetchWalk();
    if (mine !== loading) return;
    spots = walk.spots;
    walks = tracks(spots);
    arriving = walk.pending;
    buildStrip();
    render();
  }

  function buildStrip() {
    strip.replaceChildren();
    // Walkers whose first spot is still on its way get their place in the strip too.
    const groups = [...walks];
    for (const a of arriving) {
      if (!groups.some((t) => t.walker.id === a.walker.id))
        groups.push({
          walker: a.walker,
          colour: a.walker.colour ?? '#7fe7ff',
          spots: [],
        });
    }
    for (const track of groups) {
      const badge = document.createElement('span');
      badge.className = 'fw-strip-walker';
      badge.style.background = track.colour;
      badge.textContent = track.walker.avatar ?? '';
      badge.title = track.walker.name ?? '';
      strip.append(badge);
      for (const spot of track.spots) {
        const thumb = document.createElement('button');
        thumb.type = 'button';
        thumb.className = 'fw-thumb';
        thumb.dataset.id = spot.id;
        thumb.style.setProperty('--c', track.colour);
        thumb.setAttribute('role', 'option');
        thumb.setAttribute('aria-label', `${track.walker.name ?? ''} ${clockTime(spot.at, ctx.language)}`);
        if (spot.kind === 'photo') {
          const img = document.createElement('img');
          img.loading = 'lazy';
          img.alt = '';
          img.src = mediaUrl(spot);
          thumb.append(img);
        } else {
          const icon = document.createElement('i');
          icon.textContent = '♪';
          thumb.append(icon);
        }
        thumb.onclick = () => show(spot.id);
        strip.append(thumb);
      }
      // Still being sent from the phone: a dashed tile in the walker's colour.
      for (const a of arriving.filter((x) => x.walker.id === track.walker.id)) {
        const tile = document.createElement('div');
        tile.className = 'fw-thumb fw-arriving';
        tile.style.setProperty('--c', track.colour);
        tile.title = ctx.say('Arriving from the phone');
        const icon = document.createElement('i');
        icon.textContent = a.kind === 'sound' ? '♪' : '⤓';
        tile.append(icon);
        strip.append(tile);
      }
    }
  }

  function render() {
    const spot = current();
    const list = ordered(spots);
    empty.hidden = spots.length > 0 || arriving.length > 0;
    remove.hidden = !spot;
    clear.hidden = spots.length === 0;
    prev.hidden = next.hidden = spots.length < 2;
    foot.hidden = !spot;
    for (const thumb of strip.querySelectorAll<HTMLElement>('.fw-thumb')) {
      const on = thumb.dataset.id === spot?.id;
      thumb.setAttribute('aria-current', String(on));
      if (on && showing !== spot?.id)
        thumb.scrollIntoView({
          block: 'nearest',
          inline: 'center',
          behavior: 'smooth',
        });
    }
    if (!spot) {
      photo.hidden = sound.hidden = true;
      blur.style.backgroundImage = '';
      if (showing) audio.pause();
      showing = '';
      // Nothing picked yet: the first spot is on show.
      if (list.length > 0 && ctx.params.shown === '') show(list[0]!.id);
      return;
    }
    const colour = colourOf(spot);
    who.style.background = colour;
    who.textContent = spot.walker.avatar ?? '';
    name.textContent = spot.walker.name ?? ctx.say('A walker');
    line.textContent = [clockTime(spot.at, ctx.language), spot.note ?? ''].filter(Boolean).join(' · ');
    count.textContent = `${list.findIndex((s) => s.id === spot.id) + 1} / ${list.length}`;
    if (showing === spot.id) return;
    showing = spot.id;
    const url = mediaUrl(spot);
    if (spot.kind === 'photo') {
      audio.pause();
      sound.hidden = true;
      photo.hidden = false;
      photo.src = url;
      blur.style.backgroundImage = `url("${url}")`;
    } else {
      photo.hidden = true;
      sound.hidden = false;
      blur.style.backgroundImage = `radial-gradient(circle at 50% 50%, ${colour}, #0b0d17 70%)`;
      play.style.setProperty('--c', colour);
      audio.src = url;
      peaks = [];
      void waveform(url).then((p) => {
        if (showing === spot.id) peaks = p;
      });
      // A sound picked on the controller or the table plays at once.
      void audio.play().catch(() => (play.innerHTML = PLAY));
      play.innerHTML = PAUSE;
    }
  }

  // The waveform, with what has played lit.
  let raf = 0;
  const drawWave = () => {
    raf = requestAnimationFrame(drawWave);
    if (sound.hidden) return;
    const scale = devicePixelRatio || 1;
    const w = Math.round(wave.clientWidth * scale);
    const h = Math.round(wave.clientHeight * scale);
    if (wave.width !== w || wave.height !== h) Object.assign(wave, { width: w, height: h });
    const g = wave.getContext('2d')!;
    g.clearRect(0, 0, w, h);
    const bars = 72;
    const gap = w / bars;
    const played = audio.duration > 0 ? audio.currentTime / audio.duration : 0;
    for (let i = 0; i < bars; i++) {
      const p = peaks.length ? peaks[Math.floor((i / bars) * peaks.length)]! : 0.08 + 0.06 * Math.sin(i * 0.7 + performance.now() / 400);
      const bh = Math.max(2 * scale, p * h);
      g.fillStyle = i / bars < played ? '#ffffff' : 'rgb(255 255 255 / 0.35)';
      g.fillRect(i * gap + gap * 0.2, (h - bh) / 2, gap * 0.6, bh);
    }
  };
  drawWave();

  ctx.onCleanup(() => {
    cancelAnimationFrame(raf);
    audio.pause();
    audio.removeAttribute('src');
  });

  void load();
  return {
    update() {
      if (ctx.params.revision !== revision) {
        revision = ctx.params.revision;
        void load();
      } else render();
    },
  };
}

/** Loudness peaks of a sound, 0..1, for its waveform. Empty if the browser cannot read it. */
async function waveform(url: string): Promise<number[]> {
  try {
    const bytes = await (await fetch(url)).arrayBuffer();
    const context = new OfflineAudioContext(1, 1, 44100);
    const buffer = await context.decodeAudioData(bytes);
    const data = buffer.getChannelData(0);
    const n = 200;
    const size = Math.max(1, Math.floor(data.length / n));
    const peaks: number[] = [];
    for (let i = 0; i < n; i++) {
      let max = 0;
      for (let j = i * size; j < Math.min(data.length, (i + 1) * size); j++) max = Math.max(max, Math.abs(data[j]!));
      peaks.push(max);
    }
    const top = Math.max(...peaks, 1e-6);
    return peaks.map((p) => p / top);
  } catch {
    return [];
  }
}
