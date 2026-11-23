// A timeline hero for the controller (docs/contracts/present.md, Stage): a layer that plays
// over time gets one large, direct way in. A sky-like backdrop, a big readout, a few facts,
// and a band at the foot with ▶ and a scrubber. A drag anywhere on the hero, or the keys,
// moves the time. Sunlight's sky is the first of these; Cool paths and Mobility use this one.

export interface HeroFact {
  label: string;
  value: string;
}

export interface TimelineHeroSpec {
  /** What the band sets, for screen readers: "Time of day". */
  label: string;
  min: number;
  max: number;
  /** Values snap to this. */
  step: number;
  /** The value now, and how to set it. Setting it stops a playing timeline. */
  value(): number;
  set(value: number): void;
  /** Where the band is labelled, and how. */
  ticks: number[];
  tick(value: number): string;
  /** How a value is read aloud and shown while dragging. */
  format(value: number): string;
  /** ▶ and ⏸, when the timeline plays by itself. */
  playing?(): boolean;
  play?(playing: boolean): void;
  /** The big readout: a value, an optional unit beside it and a line under it. */
  readout(value: number): { value: string; unit?: string; line?: string };
  /** Up to three small facts at the top right. */
  facts?(value: number): HeroFact[];
  /** The backdrop, top to bottom, for a value: three CSS colours. Default: the night sky. */
  sky?(value: number): [string, string, string];
  /** A stretch of the band to light up, such as the hours of daylight. */
  lit?(): { from: number; to: number; colors: [string, string] } | null;
}

const STYLE = `
.mrs-hero { position: relative; height: clamp(16rem, 40vh, 30rem); border-radius: 1.125rem; overflow: hidden; touch-action: none; user-select: none; cursor: ew-resize; outline: none;
  box-shadow: 0 1.25rem 3.75rem rgb(0 0 0 / 0.35), inset 0 0 0 1px rgb(255 255 255 / 0.06); color: #fff; transition: background 0.6s ease; }
.mrs-hero:focus-visible { box-shadow: inset 0 0 0 3px rgb(255 255 255 / 0.6); }
.mrs-hero [hidden] { display: none !important; }
.mrs-hero .glass { background: rgb(255 255 255 / 0.14); backdrop-filter: blur(0.875rem); -webkit-backdrop-filter: blur(0.875rem); box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.22); }
.mrs-hero-readout { position: absolute; left: 2.75rem; top: 2.25rem; padding: 1.125rem 1.625rem 1rem; border-radius: 1rem; pointer-events: none; }
.mrs-hero-readout b { display: block; font-size: 4.75rem; font-weight: 600; line-height: 1; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }
.mrs-hero-readout b small { font-size: 1.75rem; font-weight: 500; letter-spacing: 0; margin-left: 0.375rem; opacity: 0.85; }
.mrs-hero-readout span { display: block; margin-top: 0.5rem; font-size: 1.125rem; opacity: 0.88; }
.mrs-hero-facts { position: absolute; right: 2.75rem; top: 2.75rem; display: flex; gap: 0.75rem; pointer-events: none; }
.mrs-hero-fact { padding: 0.625rem 1rem; border-radius: 0.75rem; text-align: right; }
.mrs-hero-fact small { display: block; font-size: 0.75rem; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.78; }
.mrs-hero-fact b { font-size: 1.5rem; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
.mrs-hero-band { position: absolute; left: 0; right: 0; bottom: 0; height: 6.5rem; background: linear-gradient(rgb(10 13 20 / 0.5), rgb(10 13 20 / 0.82));
  backdrop-filter: blur(0.625rem); -webkit-backdrop-filter: blur(0.625rem); border-top: 1px solid rgb(255 255 255 / 0.08); }
.mrs-hero-band svg { width: 100%; height: 100%; display: block; }
.mrs-hero-play { position: absolute; left: 2.25rem; bottom: 1.25rem; width: 4rem; height: 4rem; border: 0; border-radius: 50%; display: grid; place-items: center; cursor: pointer;
  background: linear-gradient(#ffd97a, #ffc23d); color: #1c1505; box-shadow: 0 0.375rem 1.125rem rgb(255 194 61 / 0.35); }
.mrs-hero-play svg { width: 1.625rem; height: 1.625rem; }
.mrs-hero-play:focus-visible { outline: 3px solid #fff; outline-offset: 3px; }
`;

const SVG = 'http://www.w3.org/2000/svg';
const NIGHT: [string, string, string] = ['#0b1330', '#16224a', '#2b3866'];
const PLAY = '<svg viewBox="0 0 24 24" fill="currentColor" style="margin-left:0.2rem"><path d="M7 5l12 7-12 7z"/></svg>';
const PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>';

/**
 * Draws a timeline hero into `el`. Call `update()` when the value or anything the readout
 * shows changes; `onCleanup` gets what to release when the layer closes.
 */
export function timelineHero(el: HTMLElement, spec: TimelineHeroSpec, onCleanup: (cleanup: () => void) => void): { update(): void } {
  el.innerHTML = `<style>${STYLE}</style>`;
  const root = document.createElement('div');
  root.className = 'mrs-hero';
  root.setAttribute('role', 'slider');
  root.setAttribute('aria-label', spec.label);
  root.setAttribute('aria-valuemin', String(spec.min));
  root.setAttribute('aria-valuemax', String(spec.max));
  root.tabIndex = 0;
  const readout = document.createElement('div');
  readout.className = 'mrs-hero-readout glass';
  readout.innerHTML = '<b></b><span></span>';
  const facts = document.createElement('div');
  facts.className = 'mrs-hero-facts';
  const band = document.createElement('div');
  band.className = 'mrs-hero-band';
  const scale = document.createElementNS(SVG, 'svg');
  band.append(scale);
  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'mrs-hero-play';
  play.hidden = !spec.play;
  root.append(readout, facts, band, play);
  el.append(root);

  /** The value under the finger while dragging, so the hero follows at once. */
  let held: number | null = null;
  /** The value the keys last set, until the layer's params catch up, so quick presses add up. */
  let keyed: number | null = null;
  const rem = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const span = () => {
    const r = rem();
    const x0 = (spec.play ? 8.5 : 3.5) * r;
    const x1 = root.clientWidth - 3.5 * r;
    return { r, x0, x1, x: (v: number) => x0 + ((v - spec.min) / (spec.max - spec.min)) * (x1 - x0) };
  };
  const snap = (v: number) => Math.min(spec.max, Math.max(spec.min, Math.round(v / spec.step) * spec.step));

  let playing: boolean | undefined;
  function update() {
    const w = root.clientWidth;
    if (w === 0) return;
    if (keyed !== null && Math.abs(spec.value() - keyed) < spec.step / 2) keyed = null;
    const value = held ?? keyed ?? spec.value();
    const { r, x } = span();
    const [top, middle, bottom] = spec.sky?.(value) ?? NIGHT;
    root.style.background = `linear-gradient(${top}, ${middle} 60%, ${bottom})`;
    const shown = spec.readout(value);
    const [big, line] = readout.children as unknown as [HTMLElement, HTMLElement];
    big.textContent = shown.value;
    if (shown.unit) {
      const unit = document.createElement('small');
      unit.textContent = shown.unit;
      big.append(unit);
    }
    line.textContent = shown.line ?? '';
    line.hidden = !shown.line;
    const list = spec.facts?.(value) ?? [];
    facts.replaceChildren(
      ...list.slice(0, 3).map((fact) => {
        const card = document.createElement('div');
        card.className = 'mrs-hero-fact glass';
        const label = document.createElement('small');
        label.textContent = fact.label;
        const text = document.createElement('b');
        text.textContent = fact.value;
        card.append(label, text);
        return card;
      }),
    );
    // The band: a track, the lit stretch, the ticks and the thumb.
    const h = band.clientHeight || 6.5 * r;
    const track = 2.5 * r;
    const lit = spec.lit?.() ?? null;
    scale.setAttribute('viewBox', `0 0 ${w} ${h}`);
    scale.innerHTML = `
      ${lit ? `<defs><linearGradient id="mrs-hero-lit" x1="${x(lit.from)}" x2="${x(lit.to)}" y1="0" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${lit.colors[0]}"/><stop offset="1" stop-color="${lit.colors[1]}"/></linearGradient></defs>` : ''}
      <rect x="${x(spec.min)}" y="${track - 0.25 * r}" width="${x(spec.max) - x(spec.min)}" height="${0.5 * r}" rx="${0.25 * r}" fill="rgb(255 255 255 / .14)"/>
      ${lit ? `<rect x="${x(lit.from)}" y="${track - 0.25 * r}" width="${Math.max(0, x(lit.to) - x(lit.from))}" height="${0.5 * r}" rx="${0.25 * r}" fill="url(#mrs-hero-lit)"/>` : ''}
      ${spec.ticks.map((t) => `<text x="${x(t)}" y="${track + 2.1 * r}" fill="rgb(255 255 255 / .6)" font-size="${0.95 * r}" text-anchor="middle">${spec.tick(t)}</text>`).join('')}
      <circle cx="${x(value)}" cy="${track}" r="${1.05 * r}" fill="#fff" stroke="rgb(255 200 87 / .55)" stroke-width="${0.5 * r}"/>`;
    root.setAttribute('aria-valuenow', String(value));
    root.setAttribute('aria-valuetext', spec.format(value));
    const now = spec.playing?.() ?? false;
    if (spec.play && now !== playing) {
      playing = now;
      play.innerHTML = now ? PAUSE : PLAY;
      play.setAttribute('aria-label', now ? 'Pause' : 'Play');
      play.setAttribute('aria-pressed', String(now));
    }
  }

  const at = (event: PointerEvent) => {
    const { x0, x1 } = span();
    return snap(spec.min + ((event.clientX - root.getBoundingClientRect().left - x0) / (x1 - x0)) * (spec.max - spec.min));
  };
  root.addEventListener('pointerdown', (event) => {
    if ((event.target as Element).closest('.mrs-hero-play')) return;
    root.setPointerCapture(event.pointerId);
    held = at(event);
    spec.set(held);
    update();
  });
  root.addEventListener('pointermove', (event) => {
    if (held === null) return;
    held = at(event);
    spec.set(held);
    update();
  });
  const release = () => {
    held = null;
  };
  root.addEventListener('pointerup', release);
  root.addEventListener('pointercancel', release);
  root.addEventListener('keydown', (event) => {
    const range = spec.max - spec.min;
    const move = { ArrowLeft: -spec.step, ArrowRight: spec.step, PageDown: -range / 8, PageUp: range / 8, Home: -range, End: range }[event.key];
    if (move === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    keyed = snap((keyed ?? spec.value()) + move);
    spec.set(keyed);
    update();
  });
  play.addEventListener('click', () => spec.play?.(!(spec.playing?.() ?? false)));

  const resize = new ResizeObserver(() => update());
  resize.observe(root);
  onCleanup(() => resize.disconnect());
  update();
  return { update };
}
