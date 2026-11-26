// Isovist's hero on the controller (#82, #190): Street View from where the viewer stands on
// the table, looking the way they look, with how green that view is over it and what the
// view is made of along the foot. The picture comes through the host, which signs it with the
// Google key kept in Sources, so the key never reaches a page. Without a key the hero still
// shows the view's make-up, over a drawing of the sight cone.
import type { PanelContext, PanelHandlers } from '@mrstudio/sdk';

import type { Params } from './index.ts';
import type { ViewPart } from './view.ts';
import { mixWord, streetViewImageUrl, throughSource } from './view.ts';

type Shared = {
  viewer?: [number, number];
  bearing?: number;
  gvfPercent?: number;
  gvfWord?: string;
  parts?: ViewPart[];
  seenBuildings?: number;
  seenTrees?: number;
  mix?: { nature: number; city: number } | null;
  streetview?: 'ok' | 'no-coverage' | 'needs-key' | 'no-source' | 'refused';
};

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
export const compassWord = (bearing: number) => COMPASS[Math.round((((bearing % 360) + 360) % 360) / 45) % 8]!;

const STYLE = `
.iso-hero { position: relative; height: calc(clamp(16rem, 44vh, 32rem) * var(--mrs-hero-scale, 1)); border-radius: 1.125rem; overflow: hidden; color: #fff; user-select: none;
  background: radial-gradient(120% 100% at 50% 100%, #2a2f45 0%, #151827 55%, #0b0d17 100%);
  box-shadow: 0 1.25rem 3.75rem rgb(0 0 0 / 0.35), inset 0 0 0 1px rgb(255 255 255 / 0.06); }
.iso-hero img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity 0.6s ease; }
.iso-hero img.shown { opacity: 1; }
.iso-hero > svg { position: absolute; left: 0; right: 0; top: 0; bottom: 5.5rem; width: 100%; height: calc(100% - 5.5rem); transition: opacity 0.6s ease; }
.iso-hero .glass { background: rgb(10 12 20 / 0.45); backdrop-filter: blur(0.875rem); -webkit-backdrop-filter: blur(0.875rem); box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.18); }
.iso-hero-readout { position: absolute; left: 2.25rem; top: 2rem; padding: 1rem 1.5rem 0.9rem; border-radius: 1rem; }
.iso-hero-readout b { display: block; font-size: 4.25rem; font-weight: 600; line-height: 1; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }
.iso-hero-readout b small { font-size: 1.6rem; font-weight: 500; letter-spacing: 0; margin-left: 0.3rem; opacity: 0.85; }
.iso-hero-readout span { display: block; margin-top: 0.45rem; font-size: 1.1rem; opacity: 0.9; }
.iso-hero-facts { position: absolute; right: 2.25rem; top: 2rem; display: flex; flex-direction: column; gap: 0.6rem; align-items: flex-end; }
.iso-hero-fact { padding: 0.6rem 1rem; border-radius: 0.8rem; text-align: right; }
.iso-hero-fact small { display: block; font-size: 0.85rem; opacity: 0.8; }
.iso-hero-fact b { font-size: 1.25rem; font-weight: 600; }
.iso-hero-note { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -30%); max-width: 70%; text-align: center; font-size: 1.05rem; line-height: 1.4; padding: 0.8rem 1.2rem; border-radius: 0.8rem; }
.iso-hero-note[hidden] { display: none; }
.iso-hero-band { position: absolute; left: 0; right: 0; bottom: 0; padding: 1rem 2.25rem 1.1rem; background: linear-gradient(rgb(6 8 16 / 0.35), rgb(6 8 16 / 0.85)); backdrop-filter: blur(0.625rem); -webkit-backdrop-filter: blur(0.625rem); border-top: 1px solid rgb(255 255 255 / 0.08); }
.iso-hero-bar { display: flex; height: 0.9rem; border-radius: 0.45rem; overflow: hidden; background: rgb(255 255 255 / 0.1); }
.iso-hero-bar i { display: block; height: 100%; transition: flex-grow 0.4s ease; }
.iso-hero-keys { display: flex; flex-wrap: wrap; gap: 0.35rem 1.2rem; margin-top: 0.6rem; font-size: 0.95rem; }
.iso-hero-keys span { display: inline-flex; align-items: center; gap: 0.4rem; white-space: nowrap; opacity: 0.92; font-variant-numeric: tabular-nums; }
.iso-hero-keys span::before { content: ''; width: 0.75rem; height: 0.75rem; border-radius: 0.2rem; background: var(--c); }
`;

/** Where Street View stands, in words for the note over the drawing. */
function note(state: Shared['streetview'], enabled: boolean, source: string, say: PanelContext['say']): string | null {
  if (!enabled) return null;
  switch (state) {
    case 'needs-key':
      return say('Add a Google Street View key in Sources to see the street from here.');
    case 'no-source':
      return say('There is no Street View source called "{source}". Add Google Street View in Sources.', { source });
    case 'refused':
      return say('Google did not give a picture. Check the Street View key in Sources.');
    case 'no-coverage':
      return say('Street View has no picture near here.');
    default:
      return null;
  }
}

export function isovistHero(ctx: PanelContext<Params>, el: HTMLElement): PanelHandlers {
  el.innerHTML = `<style>${STYLE}</style>`;
  const root = document.createElement('div');
  root.className = 'iso-hero';
  // Two pictures, so a new view fades in over the last one.
  const pictures = [document.createElement('img'), document.createElement('img')];
  for (const img of pictures) img.alt = '';
  const art = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  art.setAttribute('viewBox', '0 0 800 260');
  art.setAttribute('preserveAspectRatio', 'xMidYMax meet');
  art.innerHTML = `
    <defs><radialGradient id="iso-cone" cx="400" cy="250" r="250" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ffff00" stop-opacity=".55"/><stop offset=".6" stop-color="#ffd500" stop-opacity=".22"/><stop offset="1" stop-color="#ffd500" stop-opacity="0"/></radialGradient></defs>
    <path d="M400 246 L250 18 Q400 -10 550 18 Z" fill="url(#iso-cone)"/>
    <path d="M400 246 L250 18 Q400 -10 550 18 Z" fill="none" stroke="#ff0099" stroke-width="3" stroke-dasharray="6 6" opacity=".8"/>
    <circle cx="400" cy="246" r="6" fill="#ff0000" stroke="#fff" stroke-width="1.5"/>`;
  const readout = document.createElement('div');
  readout.className = 'iso-hero-readout glass';
  readout.innerHTML = '<b></b><span></span>';
  const facts = document.createElement('div');
  facts.className = 'iso-hero-facts';
  const message = document.createElement('div');
  message.className = 'iso-hero-note glass';
  const band = document.createElement('div');
  band.className = 'iso-hero-band';
  const bar = document.createElement('div');
  bar.className = 'iso-hero-bar';
  const keys = document.createElement('div');
  keys.className = 'iso-hero-keys';
  band.append(bar, keys);
  root.append(art, ...pictures, readout, facts, message, band);
  el.append(root);

  let front = 0;
  let wanted = '';
  let shownUrl = '';
  let objectUrl: string | null = null;
  let failed: Shared['streetview'] | null = null;
  ctx.onCleanup(() => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  });

  /** Fetches the picture through the host (so a refusal has a reason) and fades it in. */
  async function show(url: string): Promise<void> {
    wanted = url;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        if (wanted === url) {
          failed = response.status === 424 ? 'needs-key' : response.status === 404 ? (response.headers.get('content-type')?.includes('json') ? 'no-source' : 'no-coverage') : 'refused';
          for (const img of pictures) img.classList.remove('shown');
          art.style.opacity = '1';
          update();
        }
        return;
      }
      const blob = await response.blob();
      if (wanted !== url) return;
      failed = null;
      const next = pictures[1 - front]!;
      const old = objectUrl;
      objectUrl = URL.createObjectURL(blob);
      next.src = objectUrl;
      await next.decode().catch(() => {});
      if (wanted !== url) return;
      next.classList.add('shown');
      pictures[front]!.classList.remove('shown');
      front = 1 - front;
      shownUrl = url;
      art.style.opacity = '0';
      if (old) setTimeout(() => URL.revokeObjectURL(old), 800);
      update();
    } catch {
      // The host is away; keep what is shown.
    }
  }

  function update(): void {
    const s = ctx.shared as Shared;
    const gvf = s.gvfPercent;
    const [big, line] = readout.children as unknown as [HTMLElement, HTMLElement];
    big.textContent = gvf === undefined ? '–' : String(gvf);
    const unit = document.createElement('small');
    unit.textContent = ctx.say('% green');
    big.append(unit);
    line.textContent =
      s.bearing === undefined
        ? ctx.say('Click the table to stand somewhere')
        : ctx.say('{word} green view, looking {direction}', { word: ctx.say(s.gvfWord ?? ''), direction: ctx.say(compassWord(s.bearing)) });

    const list: [string, string][] = [];
    if (s.seenBuildings !== undefined) list.push([ctx.say('In view'), ctx.say('{buildings} buildings, {trees} trees', { buildings: s.seenBuildings, trees: s.seenTrees ?? 0 })]);
    if (ctx.params.sound) list.push([ctx.say('Sounds like'), ctx.say(mixWord(s.mix))]);
    facts.replaceChildren(
      ...list.map(([label, value]) => {
        const card = document.createElement('div');
        card.className = 'iso-hero-fact glass';
        card.innerHTML = '<small></small><b></b>';
        card.children[0]!.textContent = label;
        card.children[1]!.textContent = value;
        return card;
      }),
    );

    const parts = s.parts ?? [];
    bar.replaceChildren(
      ...parts.map((p) => {
        const i = document.createElement('i');
        i.style.background = p.colour;
        i.style.flexGrow = String(Math.max(0, p.share));
        return i;
      }),
    );
    keys.replaceChildren(
      ...parts
        .filter((p) => p.share > 0.005)
        .map((p) => {
          const k = document.createElement('span');
          k.style.setProperty('--c', p.colour);
          k.textContent = `${ctx.say(p.label)} ${Math.round(p.share * 100)}%`;
          return k;
        }),
    );

    const source = ctx.params.source || 'streetview';
    const text = note(failed ?? s.streetview, ctx.params.streetview, source, ctx.say);
    message.textContent = text ?? '';
    message.hidden = text === null || shownUrl !== '' && !failed;

    if (ctx.params.streetview && s.viewer && s.bearing !== undefined && failed !== 'needs-key' && failed !== 'no-source') {
      const url = throughSource(source, streetViewImageUrl(s.viewer, s.bearing));
      if (url !== wanted) void show(url);
    }
    if (!ctx.params.streetview) {
      for (const img of pictures) img.classList.remove('shown');
      art.style.opacity = '1';
      shownUrl = '';
      wanted = '';
    }
  }

  update();
  return {
    update() {
      // A new key or source: try again.
      if (failed && (ctx.shared as Shared).streetview === 'ok') failed = null;
      update();
    },
  };
}
