// Field walk's hero on the controller (#445): the spot on show, large. A photo fills the frame
// over a soft blur of itself; a sound is a big play button over its waveform. The walker's animal,
// name, time and note sit at the foot. Previous and Next on the sides, and a strip of every spot
// underneath, walker by walker, to pick one. A tap on a dot on the table picks it too.
import type { PanelContext, PanelHandlers } from '@mrstudio/sdk';

import type { Params } from './index.ts';
import { FEELINGS, clockTime, fetchWalk, kindsOf, legend, mediaUrl, ordered, spotColour, step, tracks } from './spots.ts';
import type { Arriving, Spot, Track } from './spots.ts';

const STYLE = `
.fw { display: grid; gap: 0.9rem; color: #fff; user-select: none; }
.fw [hidden] { display: none !important; }
.fw-frame { position: relative; height: calc(clamp(16rem, 46vh, 34rem) * var(--mrs-hero-scale, 1)); border-radius: 1.125rem; overflow: hidden; background: #0b0d17;
  box-shadow: 0 1.25rem 3.75rem rgb(0 0 0 / 0.35), inset 0 0 0 1px rgb(255 255 255 / 0.06); }
/* The colour key takes a row: the picture gives it up, so the tools stay in the hero's box. */
.fw:has(.fw-key:not([hidden])) .fw-frame { height: calc(clamp(13rem, 35vh, 28rem) * var(--mrs-hero-scale, 1)); }
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
.fw-words > span { display: block; font-size: 1.05rem; opacity: 0.88; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fw-count { margin-left: auto; font-size: 1rem; opacity: 0.8; font-variant-numeric: tabular-nums; }
.fw-nav { position: absolute; top: 50%; width: 3.5rem; height: 3.5rem; margin-top: -1.75rem; border-radius: 50%; color: #fff; cursor: pointer; font-size: 1.6rem; line-height: 1; }
.fw-prev { left: 1.25rem; } .fw-next { right: 1.25rem; }
.fw-empty { position: absolute; inset: 0; }
.fw-empty span { font-size: 1.1rem; max-width: 34rem; line-height: 1.4; }
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
/* The buttons are the controller's shared .mrs-button (#708): Remove and Clear in danger red, Clear set apart. */
.fw-tools .fw-clear { margin-left: 0.75rem; }
.fw-tools .fw-said { margin-right: auto; align-self: center; font-size: 0.95rem; opacity: 0.85; }
.fw-mark { position: absolute; inset: 0; display: grid; place-content: center; justify-items: center; gap: 0.75rem; text-align: center; }
.fw-mark i { font-style: normal; font-size: calc(6rem * var(--mrs-hero-scale, 1)); line-height: 1; filter: drop-shadow(0 0.5rem 1.5rem rgb(0 0 0 / 0.4)); }
.fw-mark b { font-size: 1.8rem; font-weight: 600; }
.fw-tag { display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.15rem 0.6rem; margin-right: 0.5rem; border-radius: 999px; font-size: 1rem; font-weight: 600; color: #0b0d17; background: var(--c); }
.fw-key { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; font-size: 1.05rem; }
.fw-key span { display: inline-flex; align-items: center; gap: 0.45rem; }
.fw-key i { width: 0.95rem; height: 0.95rem; border-radius: 50%; background: var(--c); box-shadow: 0 0 0.6rem var(--c); }
.fw-key em { font-style: normal; opacity: 0.7; font-variant-numeric: tabular-nums; }
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
      <div class="fw-mark" hidden><i></i><b></b></div>
      <div class="fw-empty mrs-empty" hidden><b></b><span></span></div>
      <button class="fw-nav fw-prev mrs-glass" type="button">‹</button>
      <button class="fw-nav fw-next mrs-glass" type="button">›</button>
      <div class="fw-foot"><div class="fw-who"></div><div class="fw-words"><b></b><span></span></div><div class="fw-count"></div></div>
    </div>
    <div class="fw-key" hidden></div>
    <div class="fw-strip" role="listbox"></div>
    <div class="fw-tools"><span class="fw-said"></span><button type="button" class="fw-remove mrs-button is-danger"></button><button type="button" class="fw-save mrs-button"></button><button type="button" class="fw-clear mrs-button is-danger"></button></div>`;
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
  const save = $<HTMLButtonElement>('.fw-save');
  const said = $<HTMLElement>('.fw-said');
  const mark = $<HTMLElement>('.fw-mark');
  const key = $<HTMLElement>('.fw-key');
  const clear = $<HTMLButtonElement>('.fw-clear');
  $<HTMLElement>('.fw-empty b').textContent = ctx.say('No spots yet');
  $<HTMLElement>('.fw-empty span').textContent = ctx.say('Visitors mark spots on their phones: Field walk, at the top of the phone page. Each spot shows here as it arrives.');
  prev.setAttribute('aria-label', ctx.say('Previous spot'));
  next.setAttribute('aria-label', ctx.say('Next spot'));
  remove.textContent = ctx.say('Remove this spot');
  clear.textContent = ctx.say('Clear the walk');
  save.textContent = ctx.say('Save the walk as data');

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
  const walkerColour = (spot: Spot) => walks.find((t) => t.walker.id === spot.walker.id)?.colour ?? '#7fe7ff';
  const colourOf = (spot: Spot) => spotColour(spot, ctx.params.colour ?? 'walker', walkerColour(spot), kindsOf(ctx.params.kinds));

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
  // The walk as an ordinary dataset of the table (#628): kinds and feelings with each spot.
  // Saving re-reads the table's data, which reloads this screen: the saved revision is kept in the
  // layer's settings, so the hero still says so afterwards, until the walk changes.
  save.onclick = async () => {
    save.disabled = true;
    said.textContent = ctx.say('Saving…');
    ctx.setParams({ saved: ctx.params.revision });
    try {
      await ctx.action('save');
      said.textContent = ctx.say('Saved as the fieldwalk data: {n} spots.', { n: spots.length });
    } catch (error) {
      ctx.setParams({ saved: 0 });
      said.textContent = (error as Error).message;
    } finally {
      save.disabled = false;
    }
  };
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
        thumb.style.setProperty('--c', colourOf(spot));
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
          icon.textContent = spot.kind === 'sound' ? '♪' : spot.feeling ? FEELINGS[spot.feeling - 1]! : '●';
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
    if (!save.disabled) said.textContent = ctx.params.saved > 0 && ctx.params.saved === ctx.params.revision && spots.length > 0 ? ctx.say('Saved as the fieldwalk data: {n} spots.', { n: spots.length }) : '';
    const spot = current();
    const list = ordered(spots);
    empty.hidden = spots.length > 0 || arriving.length > 0;
    remove.hidden = !spot;
    clear.hidden = save.hidden = spots.length === 0;
    const items = legend(spots, ctx.params.colour ?? 'walker', kindsOf(ctx.params.kinds));
    key.hidden = items.length === 0 || spots.length === 0;
    key.replaceChildren(
      ...items.map((item) => {
        const entry = document.createElement('span');
        entry.style.setProperty('--c', item.colour);
        entry.append(document.createElement('i'), item.label, Object.assign(document.createElement('em'), { textContent: String(item.count) }));
        return entry;
      }),
    );
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
    line.replaceChildren();
    if (spot.label) {
      const tag = document.createElement('span');
      tag.className = 'fw-tag';
      tag.style.setProperty('--c', spotColour(spot, 'kind', '', kindsOf(ctx.params.kinds)));
      tag.textContent = spot.label;
      line.append(tag);
    }
    line.append([spot.feeling ? FEELINGS[spot.feeling - 1] : '', clockTime(spot.at, ctx.language), spot.note ?? ''].filter(Boolean).join(' · '));
    count.textContent = `${list.findIndex((s) => s.id === spot.id) + 1} / ${list.length}`;
    if (showing === spot.id) return;
    showing = spot.id;
    const url = mediaUrl(spot);
    mark.hidden = spot.kind !== 'mark';
    if (spot.kind === 'mark') {
      // Nothing was taken: what it is and how it feels, large.
      audio.pause();
      photo.hidden = sound.hidden = true;
      blur.style.backgroundImage = `radial-gradient(circle at 50% 45%, ${colour}, #0b0d17 72%)`;
      $<HTMLElement>('.fw-mark i').textContent = spot.feeling ? FEELINGS[spot.feeling - 1]! : '📍';
      $<HTMLElement>('.fw-mark b').textContent = spot.label ?? '';
    } else if (spot.kind === 'photo') {
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
      } else {
        // The colouring or the kinds may have changed: the strip's colours with them.
        buildStrip();
        render();
      }
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
