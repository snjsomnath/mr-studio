// Sunlight's hero on the controller (#137): the sky as a timeline. The arc is the sun's real
// path over the chosen day at the site, the sun sits on it at the chosen time, and the
// scrubber under it uses the same time scale, so the sun is always straight above the thumb.
// Dragging anywhere on the hero sets the time; ▶ animates the day.
import { formatHour } from '@mrstudio/sdk';
import type { PanelContext, PanelHandlers } from '@mrstudio/sdk';

import { sunAt, sunDay } from './look.ts';
import type { SunDay } from './look.ts';

type Params = { mode: string; date: string; hour: number; play: boolean };

const SVG = 'http://www.w3.org/2000/svg';
/** Height of the scrubber band, in rem, so it grows with the controller (#77). */
const BAND_REM = 6.5;
/** The arc's top is this many degrees of sun height. */
const MAX_ALT = 65;
const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

const STYLE = `
.sun-hero { position: relative; height: clamp(16rem, 40vh, 30rem); border-radius: 1.125rem; overflow: hidden; touch-action: none; user-select: none; cursor: ew-resize;
  box-shadow: 0 1.25rem 3.75rem rgb(0 0 0 / 0.35), inset 0 0 0 1px rgb(255 255 255 / 0.06); color: #fff; }
.sun-hero [hidden] { display: none !important; }
.sun-hero svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.sun-hero .glass { background: rgb(255 255 255 / 0.14); backdrop-filter: blur(0.875rem); -webkit-backdrop-filter: blur(0.875rem); box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.22); }
.sun-hero-clock { position: absolute; left: 2.75rem; top: 2.25rem; padding: 1.125rem 1.625rem 1rem; border-radius: 1rem; pointer-events: none; }
.sun-hero-clock b { display: block; font-size: 4.75rem; font-weight: 600; line-height: 1; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }
.sun-hero-clock span { display: block; margin-top: 0.5rem; font-size: 1.125rem; opacity: 0.88; }
.sun-hero-facts { position: absolute; right: 2.75rem; top: 2.75rem; display: flex; gap: 0.75rem; pointer-events: none; }
.sun-hero-fact { padding: 0.625rem 1rem; border-radius: 0.75rem; text-align: right; }
.sun-hero-fact small { display: block; font-size: 0.75rem; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.78; }
.sun-hero-fact b { font-size: 1.5rem; font-weight: 600; font-variant-numeric: tabular-nums; }
.sun-hero-band { position: absolute; left: 0; right: 0; bottom: 0; height: ${BAND_REM}rem; background: linear-gradient(rgb(10 13 20 / 0.55), rgb(10 13 20 / 0.85));
  backdrop-filter: blur(0.625rem); -webkit-backdrop-filter: blur(0.625rem); border-top: 1px solid rgb(255 255 255 / 0.08); }
.sun-hero-play { position: absolute; left: 2.25rem; bottom: 1.25rem; width: 4rem; height: 4rem; border: 0; border-radius: 50%; display: grid; place-items: center; cursor: pointer;
  background: linear-gradient(#ffd97a, #ffc23d); color: #1c1505; box-shadow: 0 0.375rem 1.125rem rgb(255 194 61 / 0.35); }
.sun-hero-play svg { position: static; width: 1.625rem; height: 1.625rem; }
.sun-hero-play:focus-visible { outline: 3px solid #fff; outline-offset: 3px; }
`;

function node<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>, parent: Element): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  parent.append(el);
  return el;
}

/** The sky's colours for a sun height: night, golden hour or day. */
function skyStops(altitude: number): [string, string, string, string, string] {
  if (altitude < -6) return ['#05070f', '#0b1330', '#16224a', '#22305a', '#2b3866'];
  if (altitude < 0) return ['#151a3d', '#2c2f6b', '#6b4e86', '#d6866a', '#f2a46b'];
  if (altitude < 10) return ['#2a4f9e', '#5b7fc6', '#a9b6d8', '#f6c693', '#f7a96a'];
  return ['#1f5fc7', '#4f8fe0', '#9cc3ef', '#f4dcb8', '#f7c89a'];
}

export function sunlightHero(ctx: PanelContext<Params>, el: HTMLElement): PanelHandlers {
  el.innerHTML = `<style>${STYLE}</style>`;
  const root = document.createElement('div');
  root.className = 'sun-hero';
  root.setAttribute('role', 'slider');
  root.setAttribute('aria-label', ctx.say('Time of day'));
  root.tabIndex = 0;
  el.append(root);
  const svg = node('svg', {}, root);
  const clock = document.createElement('div');
  clock.className = 'sun-hero-clock glass';
  clock.innerHTML = '<b></b><span></span>';
  const facts = document.createElement('div');
  facts.className = 'sun-hero-facts';
  facts.innerHTML = '<div class="sun-hero-fact glass"><small></small><b></b></div><div class="sun-hero-fact glass"><small></small><b></b></div>';
  const [heightName, fromName] = [...facts.querySelectorAll('small')];
  heightName!.textContent = ctx.say('Sun height');
  fromName!.textContent = ctx.say('From the');
  const band = document.createElement('div');
  band.className = 'sun-hero-band';
  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'sun-hero-play';
  root.append(clock, facts, band, play);
  const scrub = node('svg', {}, band);

  let day: SunDay | null = null;
  let dayDate = '';
  /** The hour under the finger while dragging, so the sun follows at once. */
  let dragged: number | null = null;

  const size = () => ({ w: root.clientWidth, h: root.clientHeight, rem: parseFloat(getComputedStyle(document.documentElement).fontSize) || 16 });
  const scale = () => {
    const { w, rem } = size();
    const x0 = 8.5 * rem;
    const x1 = w - 3.5 * rem;
    return { x0, x1, x: (hour: number) => x0 + (hour / 24) * (x1 - x0), hour: (px: number) => Math.min(24, Math.max(0, ((px - x0) / (x1 - x0)) * 24)) };
  };

  function draw() {
    const { w, h, rem } = size();
    if (w === 0 || h === 0) return;
    if (dayDate !== ctx.params.date || !day) {
      dayDate = ctx.params.date;
      day = sunDay(ctx.site, ctx.params.date);
    }
    const instant = ctx.params.mode === 'instant';
    const hour = dragged ?? ctx.params.hour;
    const now = sunAt(ctx.site, ctx.params.date, hour);
    const { x } = scale();
    const bandH = BAND_REM * rem;
    const horizon = h - bandH - 3.75 * rem;
    const top = 8.5 * rem;
    const y = (alt: number) => horizon - (alt / MAX_ALT) * (horizon - top);
    const sx = x(now.hour);
    const sy = y(now.altitude);
    const stops = skyStops(instant ? now.altitude : day.peak.altitude);
    const lit = day.samples.filter((s) => s.altitude > 0);
    const line = (samples: { hour: number; altitude: number }[]) => samples.map((s, i) => `${i ? 'L' : 'M'}${x(s.hour).toFixed(1)} ${y(s.altitude).toFixed(1)}`).join('');
    const before = lit.filter((s) => s.hour <= now.hour);
    const up = instant && now.altitude > 0;
    // A sunrise or sunset label gives way to the sun when the sun sits on it.
    const clear = (hour: number) => !instant || Math.abs(x(hour) - sx) > 5 * rem || sy < horizon - 3.5 * rem;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.innerHTML = `
      <defs>
        <linearGradient id="sun-hero-air" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="${stops[0]}"/><stop offset=".45" stop-color="${stops[1]}"/><stop offset=".72" stop-color="${stops[2]}"/>
          <stop offset=".86" stop-color="${stops[3]}"/><stop offset="1" stop-color="${stops[4]}"/>
        </linearGradient>
        <radialGradient id="sun-hero-glow" cx="${sx}" cy="${sy}" r="${Math.max(w, h) * 0.3}" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#fff6d8" stop-opacity="${up ? 0.85 : 0}"/><stop offset=".12" stop-color="#ffe9a8" stop-opacity="${up ? 0.45 : 0}"/>
          <stop offset=".4" stop-color="#fff" stop-opacity="${up ? 0.12 : 0}"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
        </radialGradient>
        <radialGradient id="sun-hero-disc"><stop offset="0" stop-color="#fff"/><stop offset=".55" stop-color="#fff4c7"/><stop offset="1" stop-color="#ffd86b"/></radialGradient>
        <linearGradient id="sun-hero-ground" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#2a3550" stop-opacity="0"/><stop offset=".2" stop-color="#1c2538" stop-opacity=".6"/><stop offset="1" stop-color="#0f1522" stop-opacity=".95"/>
        </linearGradient>
        <filter id="sun-hero-soft"><feGaussianBlur stdDeviation="${0.4 * rem}"/></filter>
        <clipPath id="sun-hero-above"><rect x="0" y="0" width="${w}" height="${horizon}"/></clipPath>
      </defs>
      <rect width="${w}" height="${h}" fill="url(#sun-hero-air)"/>
      <rect width="${w}" height="${h}" fill="url(#sun-hero-glow)"/>
      <g opacity="${now.altitude > 0 || !instant ? 0.5 : 0.12}" filter="url(#sun-hero-soft)">
        <ellipse cx="${w * 0.21}" cy="${horizon * 0.62}" rx="${w * 0.1}" ry="${1.6 * rem}" fill="#fff"/><ellipse cx="${w * 0.27}" cy="${horizon * 0.59}" rx="${w * 0.07}" ry="${1.4 * rem}" fill="#fff"/>
        <ellipse cx="${w * 0.78}" cy="${horizon * 0.8}" rx="${w * 0.12}" ry="${1.4 * rem}" fill="#fff"/><ellipse cx="${w * 0.84}" cy="${horizon * 0.77}" rx="${w * 0.06}" ry="${1.1 * rem}" fill="#fff"/>
      </g>
      <rect x="0" y="${horizon}" width="${w}" height="${h - horizon}" fill="url(#sun-hero-ground)"/>
      <line x1="0" x2="${w}" y1="${horizon}" y2="${horizon}" stroke="rgb(255 255 255 / .35)"/>
      <path d="${line(day.samples)}" fill="none" stroke="rgb(255 255 255 / .22)" stroke-width="2" stroke-dasharray="2 8" stroke-linecap="round"/>
      <g clip-path="url(#sun-hero-above)">
        <path d="${line(lit)}" fill="none" stroke="rgb(255 255 255 / .7)" stroke-width="2.5" stroke-dasharray="1 9" stroke-linecap="round"/>
        ${instant && before.length > 1 ? `<path d="${line(before)}" fill="none" stroke="rgb(255 255 255 / .92)" stroke-width="3" stroke-linecap="round"/>` : ''}
      </g>
      ${day.sunrise !== null && clear(day.sunrise) ? `<text x="${x(day.sunrise)}" y="${horizon + 1.6 * rem}" fill="#fff" opacity=".9" font-size="${0.95 * rem}" text-anchor="middle">${ctx.say('Sunrise {time}', { time: formatHour(day.sunrise) })}</text>` : ''}
      ${day.sunset !== null && clear(day.sunset) ? `<text x="${x(day.sunset)}" y="${horizon + 1.6 * rem}" fill="#fff" opacity=".9" font-size="${0.95 * rem}" text-anchor="middle">${ctx.say('Sunset {time}', { time: formatHour(day.sunset) })}</text>` : ''}
      ${
        instant
          ? `<line x1="${sx}" x2="${sx}" y1="${sy + 2.1 * rem}" y2="${h - bandH}" stroke="rgb(255 255 255 / .35)" stroke-width="1.5" stroke-dasharray="3 5"/>
             <circle cx="${sx}" cy="${sy}" r="${3.75 * rem}" fill="#fff3c4" opacity="${up ? 0.22 : 0.08}"/>
             <circle cx="${sx}" cy="${sy}" r="${2.5 * rem}" fill="#fff3c4" opacity="${up ? 0.35 : 0.12}"/>
             <circle cx="${sx}" cy="${sy}" r="${1.6 * rem}" fill="url(#sun-hero-disc)" opacity="${up ? 1 : 0.45}"/>`
          : ''
      }`;

    // The scrubber, on the same time scale as the sky.
    const track = 2.5 * rem;
    const rise = day.sunrise ?? (day.peak.altitude > 0 ? 0 : null);
    const set = day.sunset ?? (day.peak.altitude > 0 ? 24 : null);
    scrub.setAttribute('viewBox', `0 0 ${w} ${bandH}`);
    scrub.innerHTML = `
      <defs><linearGradient id="sun-hero-lit" x1="0" y1="0" x2="${w}" y2="0" gradientUnits="userSpaceOnUse">
        <stop offset="${rise === null ? 0 : (x(rise) / w).toFixed(3)}" stop-color="#ffb35c"/><stop offset="${(x(day.peak.hour) / w).toFixed(3)}" stop-color="#ffe08a"/>
        <stop offset="${set === null ? 1 : (x(set) / w).toFixed(3)}" stop-color="#ff9e57"/></linearGradient></defs>
      <rect x="${x(0)}" y="${track - 0.25 * rem}" width="${x(24) - x(0)}" height="${0.5 * rem}" rx="${0.25 * rem}" fill="rgb(255 255 255 / .14)"/>
      ${rise !== null && set !== null ? `<rect x="${x(rise)}" y="${track - 0.25 * rem}" width="${x(set) - x(rise)}" height="${0.5 * rem}" rx="${0.25 * rem}" fill="url(#sun-hero-lit)"/>` : ''}
      ${[0, 3, 6, 9, 12, 15, 18, 21, 24].map((t) => `<text x="${x(t)}" y="${track + 2.1 * rem}" fill="rgb(255 255 255 / .6)" font-size="${0.95 * rem}" text-anchor="middle">${String(t).padStart(2, '0')}</text>`).join('')}
      ${instant ? `<circle cx="${sx}" cy="${track}" r="${1.05 * rem}" fill="#fff" stroke="rgb(255 200 87 / .55)" stroke-width="${0.5 * rem}"/>` : ''}`;

    const [time, when] = clock.children as unknown as [HTMLElement, HTMLElement];
    const date = new Date(`${ctx.params.date}T12:00:00Z`).toLocaleDateString(ctx.language === 'sv' ? 'sv-SE' : 'en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });
    const daylight = rise !== null && set !== null ? set - rise : 0;
    time.textContent = instant ? formatHour(hour) : `${daylight.toFixed(1)} h`;
    when.textContent = instant ? date : ctx.say('of daylight on {date}', { date });
    const [height, from] = [...facts.querySelectorAll('b')] as [HTMLElement, HTMLElement];
    facts.hidden = !instant;
    height.textContent = now.altitude > 0 ? `${Math.round(now.altitude)}°` : ctx.say('Below');
    from.textContent = ctx.say(COMPASS[Math.round((((now.azimuth % 360) + 360) % 360) / 45) % 8]!);
    play.hidden = !instant;
    play.setAttribute('aria-label', ctx.params.play ? ctx.say('Pause the day') : ctx.say('Animate the day'));
    play.innerHTML = ctx.params.play
      ? '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="currentColor" style="margin-left:0.2rem"><path d="M7 5l12 7-12 7z"/></svg>';
    root.setAttribute('aria-valuemin', '0');
    root.setAttribute('aria-valuemax', '24');
    root.setAttribute('aria-valuenow', String(hour));
    root.setAttribute('aria-valuetext', formatHour(hour));
    root.style.cursor = instant ? 'ew-resize' : 'default';
  }

  // Drag anywhere on the sky or the band to set the time, to the nearest five minutes.
  const toHour = (event: PointerEvent) => Math.round(scale().hour(event.clientX - root.getBoundingClientRect().left) * 12) / 12;
  root.addEventListener('pointerdown', (event) => {
    if (ctx.params.mode !== 'instant' || (event.target as Element).closest('.sun-hero-play')) return;
    root.setPointerCapture(event.pointerId);
    dragged = toHour(event);
    ctx.setParams({ hour: dragged, play: false });
    draw();
  });
  root.addEventListener('pointermove', (event) => {
    if (dragged === null) return;
    dragged = toHour(event);
    ctx.setParams({ hour: dragged });
    draw();
  });
  const release = () => {
    dragged = null;
  };
  root.addEventListener('pointerup', release);
  root.addEventListener('pointercancel', release);
  root.addEventListener('keydown', (event) => {
    const step = { ArrowLeft: -0.25, ArrowRight: 0.25, PageDown: -1, PageUp: 1 }[event.key];
    if (step === undefined || ctx.params.mode !== 'instant') return;
    event.preventDefault();
    ctx.setParams({ hour: Math.min(24, Math.max(0, ctx.params.hour + step)) });
  });
  play.addEventListener('click', () => ctx.setParams({ play: !ctx.params.play }));

  const resize = new ResizeObserver(() => draw());
  resize.observe(root);
  ctx.onCleanup(() => resize.disconnect());
  draw();
  return { update: draw };
}
