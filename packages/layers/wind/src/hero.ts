// Wind's hero on the controller (#76): a compass dial and a speed band over moving air.
// The dial is turned as the table is, so "up" on the dial is "up" on the table. Its knob sits
// on the side the wind comes from, and the streaks behind it blow the way the wind does, faster
// when it is stronger. Dragging around the dial sets the direction; dragging along the band
// at the foot sets the speed.
import type { PanelContext, PanelHandlers } from '@mrstudio/sdk';

type Params = { speed: number; direction: number };

const SVG = 'http://www.w3.org/2000/svg';
const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
/** The speed band's range, as the layer's control has it. */
const MIN = 1;
const MAX = 20;
/** Height of the speed band, in rem, so it grows with the controller (#77). */
const BAND_REM = 6.5;
const STREAKS = 110;

/** What a sailor would call the wind (Beaufort), so a number reads as a feeling. */
export function windName(speed: number): string {
  const names: [number, string][] = [
    [0.5, 'Calm'],
    [1.6, 'Light air'],
    [3.4, 'Light breeze'],
    [5.5, 'Gentle breeze'],
    [8, 'Moderate breeze'],
    [10.8, 'Fresh breeze'],
    [13.9, 'Strong breeze'],
    [17.2, 'Near gale'],
    [20.8, 'Gale'],
  ];
  return names.find(([limit]) => speed < limit)?.[1] ?? 'Strong gale';
}

const STYLE = `
.wind-hero { position: relative; height: calc(clamp(16rem, 40vh, 30rem) * var(--mrs-hero-scale, 1)); border-radius: 1.125rem; overflow: hidden; touch-action: none; user-select: none; color: #fff;
  background: radial-gradient(120% 90% at 50% 40%, #1d3b66 0%, #12284a 45%, #0a1630 100%);
  box-shadow: 0 1.25rem 3.75rem rgb(0 0 0 / 0.35), inset 0 0 0 1px rgb(255 255 255 / 0.06); }
.wind-hero canvas, .wind-hero > svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.wind-hero .glass { background: rgb(255 255 255 / 0.12); backdrop-filter: blur(0.875rem); -webkit-backdrop-filter: blur(0.875rem); box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.2); }
.wind-hero-readout { position: absolute; left: 2.75rem; top: 2.25rem; padding: 1.125rem 1.625rem 1rem; border-radius: 1rem; pointer-events: none; }
.wind-hero-readout b { display: block; font-size: 4.75rem; font-weight: 600; line-height: 1; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }
.wind-hero-readout b small { font-size: 1.75rem; font-weight: 500; letter-spacing: 0; margin-left: 0.375rem; opacity: 0.85; }
.wind-hero-readout span { display: block; margin-top: 0.5rem; font-size: 1.125rem; opacity: 0.88; }
.wind-hero-dial { cursor: grab; outline: none; }
.wind-hero-dial:focus-visible .wind-hero-ring { stroke: #fff; }
.wind-hero-band { position: absolute; left: 0; right: 0; bottom: 0; height: ${BAND_REM}rem; cursor: ew-resize; outline: none;
  background: linear-gradient(rgb(6 12 26 / 0.45), rgb(6 12 26 / 0.8)); backdrop-filter: blur(0.625rem); -webkit-backdrop-filter: blur(0.625rem); border-top: 1px solid rgb(255 255 255 / 0.08); }
.wind-hero-band:focus-visible { box-shadow: inset 0 0 0 3px rgb(255 255 255 / 0.6); }
.wind-hero-band svg { width: 100%; height: 100%; display: block; }
`;

export function windHero(ctx: PanelContext<Params>, el: HTMLElement): PanelHandlers {
  el.innerHTML = `<style>${STYLE}</style>`;
  const root = document.createElement('div');
  root.className = 'wind-hero';
  el.append(root);
  const canvas = document.createElement('canvas');
  const art = document.createElementNS(SVG, 'svg');
  const readout = document.createElement('div');
  readout.className = 'wind-hero-readout glass';
  readout.innerHTML = '<b></b><span></span>';
  const band = document.createElement('div');
  band.className = 'wind-hero-band';
  band.setAttribute('role', 'slider');
  band.setAttribute('aria-label', ctx.say('Speed of the wind'));
  band.setAttribute('aria-valuemin', String(MIN));
  band.setAttribute('aria-valuemax', String(MAX));
  band.tabIndex = 0;
  const scale = document.createElementNS(SVG, 'svg');
  band.append(scale);
  root.append(canvas, art, readout, band);

  /** What the finger holds while dragging, so the dial and the air follow at once. */
  let held: Partial<Params> = {};
  /** What the keys last set, until the layer's params catch up, so quick presses add up. */
  let keyed: Partial<Params> = {};
  const now = (): Params => {
    if (keyed.speed === ctx.params.speed) delete keyed.speed;
    if (keyed.direction === ctx.params.direction) delete keyed.direction;
    return { speed: held.speed ?? keyed.speed ?? ctx.params.speed, direction: held.direction ?? keyed.direction ?? ctx.params.direction };
  };
  const rotation = () => ctx.site.extent.rotation_deg ?? 0;
  const rem = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const size = () => ({ w: root.clientWidth, h: root.clientHeight, rem: rem() });
  const geometry = () => {
    const { w, h, rem: r } = size();
    const bandH = BAND_REM * r;
    // Room for the compass letters outside the ring and the knob on it.
    const radius = Math.max(4 * r, Math.min((h - bandH) / 2 - 3.25 * r, w * 0.2));
    return { w, h, r, bandH, cx: w / 2, cy: (h - bandH) / 2, radius, x0: 3.5 * r, x1: w - 3.5 * r };
  };
  /** A point at `angle` degrees clockwise from the dial's up, `distance` from its centre. */
  const at = (angle: number, distance: number, g = geometry()) => {
    const a = (angle * Math.PI) / 180;
    return { x: g.cx + distance * Math.sin(a), y: g.cy - distance * Math.cos(a) };
  };

  function draw() {
    const g = geometry();
    if (g.w === 0 || g.h === 0) return;
    const { speed, direction } = now();
    const from = direction - rotation();
    const knob = at(from, g.radius, g);
    const tip = at(from + 180, g.radius * 0.62, g);
    const tail = at(from, g.radius * 0.62, g);
    const ticks = Array.from({ length: 72 }, (_, i) => {
      const angle = i * 5 - rotation();
      const long = i % 9 === 0;
      const a = at(angle, g.radius - (long ? 1.1 : 0.55) * g.r, g);
      const b = at(angle, g.radius - 0.15 * g.r, g);
      return `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="rgb(255 255 255 / ${long ? 0.7 : 0.28})" stroke-width="${long ? 2 : 1.25}"/>`;
    }).join('');
    const letters = (['N', 'E', 'S', 'W'] as const)
      .map((letter, i) => {
        const p = at(i * 90 - rotation(), g.radius + 2.3 * g.r, g);
        return `<text x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" dy="0.35em" text-anchor="middle" font-size="${1.05 * g.r}" font-weight="${letter === 'N' ? 700 : 500}" fill="rgb(255 255 255 / ${letter === 'N' ? 0.95 : 0.7})">${letter}</text>`;
      })
      .join('');
    // The dial is drawn anew each time: one that had the focus keeps it.
    const focused = document.activeElement instanceof SVGElement && document.activeElement.classList.contains('wind-hero-dial');
    art.setAttribute('viewBox', `0 0 ${g.w} ${g.h}`);
    art.innerHTML = `
      <defs>
        <radialGradient id="wind-hero-face"><stop offset="0" stop-color="#fff" stop-opacity=".1"/><stop offset="1" stop-color="#fff" stop-opacity=".02"/></radialGradient>
        <linearGradient id="wind-hero-arrow" x1="${tail.x}" y1="${tail.y}" x2="${tip.x}" y2="${tip.y}" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#9fd8ff" stop-opacity=".15"/><stop offset="1" stop-color="#e6f6ff"/>
        </linearGradient>
      </defs>
      <g class="wind-hero-dial" role="slider" aria-label="Direction the wind comes from" tabindex="0"
         aria-valuemin="0" aria-valuemax="355" aria-valuenow="${direction}" aria-valuetext="from the ${COMPASS[Math.round(direction / 45) % 8]}">
        <circle cx="${g.cx}" cy="${g.cy}" r="${g.radius + 2.6 * g.r}" fill="transparent"/>
        <circle cx="${g.cx}" cy="${g.cy}" r="${g.radius}" fill="url(#wind-hero-face)"/>
        <circle class="wind-hero-ring" cx="${g.cx}" cy="${g.cy}" r="${g.radius}" fill="none" stroke="rgb(255 255 255 / .35)" stroke-width="1.5"/>
        ${ticks}${letters}
        <line x1="${tail.x}" y1="${tail.y}" x2="${tip.x}" y2="${tip.y}" stroke="url(#wind-hero-arrow)" stroke-width="${0.55 * g.r}" stroke-linecap="round"/>
        <path d="M0 0 L${-1.1 * g.r} ${1.6 * g.r} L${1.1 * g.r} ${1.6 * g.r} Z" fill="#e6f6ff" transform="translate(${tip.x} ${tip.y}) rotate(${from + 180})"/>
        <circle cx="${knob.x}" cy="${knob.y}" r="${1.15 * g.r}" fill="#fff" stroke="rgb(120 200 255 / .6)" stroke-width="${0.5 * g.r}"/>
      </g>`;
    if (focused) art.querySelector<SVGGElement>('.wind-hero-dial')?.focus();

    // The speed band, on a line from MIN to MAX.
    const x = (v: number) => g.x0 + ((v - MIN) / (MAX - MIN)) * (g.x1 - g.x0);
    const track = 2.5 * g.r;
    scale.setAttribute('viewBox', `0 0 ${g.w} ${g.bandH}`);
    scale.innerHTML = `
      <defs><linearGradient id="wind-hero-fill" x1="${x(MIN)}" x2="${x(MAX)}" y1="0" y2="0" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#7cc7ff"/><stop offset=".55" stop-color="#b98cff"/><stop offset="1" stop-color="#ff7aa8"/></linearGradient></defs>
      <rect x="${x(MIN)}" y="${track - 0.25 * g.r}" width="${x(MAX) - x(MIN)}" height="${0.5 * g.r}" rx="${0.25 * g.r}" fill="rgb(255 255 255 / .14)"/>
      <rect x="${x(MIN)}" y="${track - 0.25 * g.r}" width="${x(speed) - x(MIN)}" height="${0.5 * g.r}" rx="${0.25 * g.r}" fill="url(#wind-hero-fill)"/>
      ${[1, 5, 10, 15, 20].map((v) => `<text x="${x(v)}" y="${track + 2.1 * g.r}" fill="rgb(255 255 255 / .6)" font-size="${0.95 * g.r}" text-anchor="middle">${v}${v === MAX ? ' m/s' : ''}</text>`).join('')}
      <circle cx="${x(speed)}" cy="${track}" r="${1.05 * g.r}" fill="#fff" stroke="rgb(185 140 255 / .55)" stroke-width="${0.5 * g.r}"/>`;
    band.setAttribute('aria-valuenow', String(speed));
    band.setAttribute('aria-valuetext', `${speed} metres a second`);

    const [value, words] = readout.children as unknown as [HTMLElement, HTMLElement];
    value.innerHTML = `${speed}<small>m/s</small>`;
    words.textContent = ctx.say('{name}, from the {direction}', { name: ctx.say(windName(speed)), direction: ctx.say(COMPASS[Math.round(direction / 45) % 8]!) });
  }

  // ---- The air: streaks that blow the way the wind does ----
  const streaks = Array.from({ length: STREAKS }, () => ({ x: Math.random(), y: Math.random(), life: Math.random(), depth: 0.4 + Math.random() * 0.6 }));
  let frame = 0;
  let last = performance.now();
  const tick = (time: number) => {
    frame = requestAnimationFrame(tick);
    const dt = Math.min(0.05, (time - last) / 1000);
    last = time;
    const { w, h } = size();
    if (w === 0 || h === 0) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) {
      canvas.width = Math.round(w * ratio);
      canvas.height = Math.round(h * ratio);
    }
    const c = canvas.getContext('2d');
    if (!c) return;
    c.setTransform(ratio, 0, 0, ratio, 0, 0);
    c.clearRect(0, 0, w, h);
    const { speed, direction } = now();
    const blow = ((direction + 180 - rotation()) * Math.PI) / 180;
    const [dx, dy] = [Math.sin(blow), -Math.cos(blow)];
    const pace = 0.04 + speed * 0.018;
    const length = (1.5 + speed * 0.9) * (rem() / 16) * 4;
    c.lineCap = 'round';
    for (const s of streaks) {
      s.x += (dx * pace * s.depth * dt * h) / w;
      s.y += dy * pace * s.depth * dt;
      s.life -= dt * 0.35;
      if (s.life <= 0 || s.x < -0.1 || s.x > 1.1 || s.y < -0.1 || s.y > 1.1) {
        Object.assign(s, { x: Math.random(), y: Math.random(), life: 1 });
      }
      const fade = Math.sin(Math.PI * Math.min(1, Math.max(0, s.life)));
      const [px, py] = [s.x * w, s.y * h];
      const gradient = c.createLinearGradient(px - dx * length * s.depth, py - dy * length * s.depth, px, py);
      gradient.addColorStop(0, 'rgba(190, 228, 255, 0)');
      gradient.addColorStop(1, `rgba(220, 240, 255, ${(0.55 * fade * s.depth).toFixed(3)})`);
      c.strokeStyle = gradient;
      c.lineWidth = 1 + s.depth * 1.5;
      c.beginPath();
      c.moveTo(px - dx * length * s.depth, py - dy * length * s.depth);
      c.lineTo(px, py);
      c.stroke();
    }
  };
  frame = requestAnimationFrame(tick);

  // ---- Direct handling ----
  const dialAngle = (event: PointerEvent) => {
    const box = root.getBoundingClientRect();
    const g = geometry();
    const [px, py] = [event.clientX - box.left - g.cx, event.clientY - box.top - g.cy];
    const angle = (Math.atan2(px, -py) * 180) / Math.PI + rotation();
    return (((Math.round(angle / 5) * 5) % 360) + 360) % 360;
  };
  const bandSpeed = (event: PointerEvent) => {
    const g = geometry();
    const v = MIN + ((event.clientX - root.getBoundingClientRect().left - g.x0) / (g.x1 - g.x0)) * (MAX - MIN);
    return Math.min(MAX, Math.max(MIN, Math.round(v * 2) / 2));
  };
  let dragging: 'dial' | 'band' | null = null;
  const apply = (event: PointerEvent) => {
    if (dragging === 'band') held = { speed: bandSpeed(event) };
    else if (dragging === 'dial') held = { direction: dialAngle(event) };
    ctx.setParams(held);
    draw();
  };
  root.addEventListener('pointerdown', (event) => {
    const target = event.target as Element;
    dragging = target.closest('.wind-hero-band') ? 'band' : target.closest('.wind-hero-dial') ? 'dial' : null;
    if (!dragging) return;
    // A drag takes over from keys pressed before it: their value must not come back once it ends.
    keyed = {};
    root.setPointerCapture(event.pointerId);
    apply(event);
  });
  root.addEventListener('pointermove', (event) => dragging && apply(event));
  const release = () => {
    // What the hand left is shown until the host confirms it, as for keys: an older value coming
    // back in between must not turn the dial back (#560).
    keyed = { ...keyed, ...held };
    dragging = null;
    held = {};
  };
  root.addEventListener('pointerup', release);
  root.addEventListener('pointercancel', release);
  // Keys: on the dial, ← → turn it 5° and Page Up/Down 45°; on the band they change the speed.
  root.addEventListener('keydown', (event) => {
    const onBand = (event.target as Element).closest('.wind-hero-band');
    const onDial = (event.target as Element).closest('.wind-hero-dial');
    if (!onBand && !onDial) return;
    const small = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[event.key];
    const large = { PageDown: -1, PageUp: 1 }[event.key];
    if (small === undefined && large === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    const { speed, direction } = now();
    if (onBand) keyed.speed = Math.min(MAX, Math.max(MIN, speed + (small ?? 0) * 0.5 + (large ?? 0) * 5));
    else keyed.direction = (((direction + (small ?? 0) * 5 + (large ?? 0) * 45) % 360) + 360) % 360;
    ctx.setParams({ ...keyed });
    draw();
  });

  const resize = new ResizeObserver(() => draw());
  resize.observe(root);
  ctx.onCleanup(() => {
    resize.disconnect();
    cancelAnimationFrame(frame);
  });
  draw();
  return { update: draw };
}
