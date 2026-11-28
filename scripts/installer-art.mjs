// Draws the pictures for the installers (#695) in the editor's light identity:
//   - Windows setup (NSIS): the Welcome and Finish side pictures, the header picture, and the
//     slideshow that plays while the files copy (an RLE AVI for the Windows animation control,
//     at 100 %, 150 % and 200 % screen scaling).
//   - Mac: the background of the .dmg window (app icon on the left, Applications on the right).
// Writes apps/studio/src-tauri/installer/. Needs Playwright's Chromium and ffmpeg (with msrle).
//   node scripts/installer-art.mjs            all of it
//   node scripts/installer-art.mjs --preview  also keeps the PNGs in target/installer-art
// The slides use real table screenshots from docs/screenshots: change SLIDES to change the show.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'apps/studio/src-tauri/installer');
const SHOTS = join(ROOT, 'docs/screenshots');
const preview = process.argv.includes('--preview');
const work = preview ? join(ROOT, 'target/installer-art') : mkdtempSync(join(tmpdir(), 'mrs-installer-art-'));
mkdirSync(work, { recursive: true });
mkdirSync(OUT, { recursive: true });

// The editor's tokens (apps/studio/ui/home.css).
const T = {
  bg: '#f6f7f9', panel: '#ffffff', line: '#dfe3ea', text: '#1c2230', muted: '#667085',
  accent: '#3557d4', soft: '#eef2ff', amber: '#f3ad3d', canvas: '#0b0f1a',
  dialog: '#f0f0f0', // the colour of a Windows setup page around the slideshow
};

// One slide per thing the table does: a real table screenshot, cropped, and two lines.
const SLIDES = [
  { img: '302-sun-playing.png', pos: '55% 40%', zoom: 1.25, title: 'Sun and shadow', text: 'Play any day of the year across your model, hour by hour.' },
  { img: '159-wind-after-ribbons.jpg', pos: '50% 50%', zoom: 1.4, title: 'Wind through the streets', text: 'Ribbons and particles show where it is calm and where it gusts.' },
  { img: '196-coolpaths-pet-table.jpg', pos: '62% 70%', zoom: 1.6, title: 'Cool paths', text: 'The shortest walk next to the one that stays in the shade.' },
  { img: '202-after.png', pos: '45% 40%', zoom: 1.3, title: 'Trams and buses', text: 'Live departures moving across the city on the table.' },
  { img: '189-stormwater-table.jpg', pos: '40% 45%', zoom: 1.5, title: 'Where the rain goes', text: 'Cloudbursts run down the streets and pool in real time.' },
  { img: '163-cultural-gravity.png', pos: '12% 30%', zoom: 1.0, crop: [0.01, 0.07, 0.3, 0.42], title: 'Places that pull people in', text: 'Animated places, routes and gravity, built without code.' },
];

const FONT = `font-family: 'Segoe UI Variable', 'Segoe UI', Inter, system-ui, sans-serif;`;
const MARK = (size, radius) => `<span class="mark" style="width:${size}px;height:${size}px;border-radius:${radius}px"><svg viewBox="0 0 24 24"><path d="M12 3 3 7.5l9 4.5 9-4.5L12 3Z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/></svg></span>`;
const BASE_CSS = `
  * { box-sizing: border-box; margin: 0; }
  html, body { ${FONT} color: ${T.text}; -webkit-font-smoothing: antialiased; }
  .mark { display: inline-grid; place-items: center; background: ${T.accent}; color: #fff; flex: none; }
  .mark svg { width: 62%; height: 62%; fill: none; stroke: currentColor; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }
`;
const file = (p) => pathToFileURL(p).href;
const tableArt = file(join(ROOT, 'apps/studio/ui/art/new-table.svg'));

function shotImg(s) {
  // A table screenshot as a background, cropped to `crop` (fractions) and zoomed.
  const url = file(join(SHOTS, s.img));
  if (s.crop) {
    const [x, y, cw, ch] = s.crop;
    return `background-image:url('${url}');background-size:${100 / cw}% ${100 / ch}%;background-position:${(x / (1 - cw)) * 100 || 0}% ${(y / (1 - ch)) * 100 || 0}%;`;
  }
  return `background-image:url('${url}');background-size:${s.zoom * 100}% auto;background-position:${s.pos};`;
}

// --- Windows: the slideshow on the progress page -------------------------------------------------
// Base size in CSS pixels (100 % scaling). The page's details list is about 450 x 160 there.
const SW = 440, SH = 150;
function slideHtml(i, reveal = null) {
  // reveal = { next, x }: the next picture wipes in from the left behind a lit line, like the
  // table's reveal line, and the words change once the line is past the middle.
  const s = SLIDES[i];
  const n = reveal ? SLIDES[reveal.next] : null;
  const x = reveal ? reveal.x : 0;
  const swap = reveal ? Math.min(1, Math.max(0, (x - 45) / 35)) : 0; // words: old out, new in
  const on = reveal && swap > 0.5 ? reveal.next : i;
  const dots = SLIDES.map((_, j) => `<i class="${j === on ? 'on' : ''}"></i>`).join('');
  const words = (t, o) => `<div class="text" style="opacity:${o}"><b>${t.title}</b><p>${t.text}</p></div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
    body { width: ${SW}px; height: ${SH}px; background: ${T.dialog}; overflow: hidden; }
    .card { position: absolute; inset: 0; display: grid; grid-template-columns: 236px 1fr; gap: 14px; padding: 7px 14px 7px 7px; background: ${T.panel}; border: 1px solid ${T.line}; border-radius: 6px; }
    .pic { position: relative; border-radius: 4px; overflow: hidden; background: ${T.canvas}; }
    .pic div { position: absolute; inset: 0; background-repeat: no-repeat; }
    .pic .wipe { clip-path: inset(0 calc(100% - ${x}%) 0 0); }
    .beam { position: absolute; top: 0; bottom: 0; width: 2px; left: calc(${x}% - 1px); background: ${T.amber}; box-shadow: 0 0 10px 3px rgba(243,173,61,.6); }
    .words { position: relative; min-width: 0; }
    .text { position: absolute; left: 0; right: 0; top: 14px; }
    .text b { font-size: 15px; font-weight: 600; letter-spacing: -0.005em; }
    .text p { margin-top: 5px; font-size: 12px; line-height: 1.4; color: ${T.muted}; }
    .dots { position: absolute; left: 0; bottom: 8px; display: flex; gap: 5px; }
    .dots i { width: 6px; height: 6px; border-radius: 3px; background: ${T.line}; }
    .dots i.on { width: 16px; background: ${T.accent}; }
  </style></head><body><div class="card">
    <div class="pic"><div style="${shotImg(s)}"></div>${n ? `<div class="wipe" style="${shotImg(n)}"></div><span class="beam"></span>` : ''}</div>
    <div class="words">${words(s, 1 - swap)}${n ? words(n, swap) : ''}<div class="dots">${dots}</div></div>
  </div></body></html>`;
}

// --- Windows: side pictures (Welcome, Finish) and the header --------------------------------------
// NSIS shows them at 164 x 314 and 150 x 57 at 100 % scaling, stretched with the screen's scaling;
// drawn at 2x so they stay sharp on a 150-200 % laptop.
function sideHtml(kind) {
  const finish = kind === 'finish';
  const art = finish
    ? `<div class="lit" style="${shotImg({ img: '302-sun-playing.png', pos: '55% 40%', zoom: 2.2 })}"><span class="ok"><svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></span></div>`
    : `<img class="table" src="${tableArt}">`;
  const words = finish
    ? `<b>Ready for the table</b><span>Open MR Studio, make a table, press Present.</span>`
    : `<b>Your place, on a table</b><span>Table, controller and phones, from one app.</span>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
    body { width: 164px; height: 314px; overflow: hidden; position: relative;
      background: radial-gradient(130% 70% at 50% 46%, #ffffff 0%, ${T.soft} 62%, #dfe6fb 100%); }
    .brand { position: absolute; left: 14px; top: 16px; display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; }
    .grid { position: absolute; inset: 0; background-image: linear-gradient(${T.accent}10 1px, transparent 1px), linear-gradient(90deg, ${T.accent}10 1px, transparent 1px); background-size: 14px 14px; mask-image: radial-gradient(90% 55% at 50% 50%, #000 30%, transparent 75%); }
    .table { position: absolute; left: -26px; top: 84px; width: 216px; filter: drop-shadow(0 10px 14px rgba(28,42,85,.18)); }
    .lit { position: absolute; left: 14px; right: 14px; top: 78px; height: 132px; border-radius: 8px; background-color: ${T.canvas}; background-repeat: no-repeat; box-shadow: 0 10px 22px rgba(28,42,85,.22), 0 0 0 1px rgba(28,42,85,.1); }
    .ok { position: absolute; right: -8px; top: -8px; width: 26px; height: 26px; border-radius: 13px; background: ${T.accent}; display: grid; place-items: center; box-shadow: 0 2px 6px rgba(53,87,212,.4), 0 0 0 2px #fff; }
    .ok svg { width: 15px; height: 15px; fill: none; stroke: #fff; stroke-width: 2.6; stroke-linecap: round; stroke-linejoin: round; }
    .words { position: absolute; left: 14px; right: 12px; bottom: 26px; display: grid; gap: 4px; }
    .words b { font-size: 13px; font-weight: 600; }
    .words span { font-size: 11px; line-height: 1.35; color: ${T.muted}; }
  </style></head><body><div class="grid"></div>
    <div class="brand">${MARK(22, 6)}MR Studio</div>${art}<div class="words">${words}</div>
  </body></html>`;
}

function headerHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
    body { width: 150px; height: 57px; overflow: hidden; background: #fff; position: relative; }
    img { position: absolute; right: 4px; top: 2px; height: 53px; }
  </style></head><body><img src="${tableArt}"></body></html>`;
}

// --- Mac: the .dmg window ------------------------------------------------------------------------
// 660 x 400 points; tauri.conf.json puts the app icon's centre at (180, 186) and Applications at (480, 186).
function dmgHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
    body { width: 660px; height: 400px; overflow: hidden; position: relative;
      background: radial-gradient(90% 80% at 50% 48%, #ffffff 0%, ${T.bg} 55%, ${T.soft} 100%); }
    .grid { position: absolute; inset: 0; background-image: linear-gradient(${T.accent}0d 1px, transparent 1px), linear-gradient(90deg, ${T.accent}0d 1px, transparent 1px); background-size: 20px 20px; mask-image: radial-gradient(70% 60% at 50% 48%, #000 25%, transparent 80%); }
    .brand { position: absolute; left: 24px; top: 22px; display: flex; align-items: center; gap: 10px; font-size: 15px; font-weight: 600; }
    .brand small { display: block; font-size: 12px; font-weight: 400; color: ${T.muted}; }
    .slot { position: absolute; top: 104px; width: 150px; height: 172px; border-radius: 24px; background: rgba(255,255,255,.75); box-shadow: 0 0 0 1px ${T.line}, 0 6px 18px rgba(28,42,85,.08); }
    .arrow { position: absolute; left: 266px; top: 168px; width: 128px; height: 36px; }
    .arrow path { fill: none; stroke: ${T.accent}; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }
    .arrow .dash { stroke-dasharray: 2 9; opacity: .55; }
    .hint { position: absolute; left: 0; right: 0; bottom: 34px; text-align: center; font-size: 13px; color: ${T.muted}; }
    .hint b { color: ${T.text}; font-weight: 600; }
  </style></head><body><div class="grid"></div>
    <div class="brand">${MARK(30, 8)}<div>MR Studio<small>A real place on a table</small></div></div>
    <div class="slot" style="left:105px"></div><div class="slot" style="left:405px"></div>
    <svg class="arrow" viewBox="0 0 128 36"><path class="dash" d="M6 18h86"/><path d="M84 18h34M106 7l12 11-12 11"/></svg>
    <div class="hint">Drag <b>MR Studio</b> onto <b>Applications</b> to install it.</div>
  </body></html>`;
}

// --- Rendering -----------------------------------------------------------------------------------
const browser = await chromium.launch();
async function render(html, w, h, scale, out) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: scale });
  const htmlPath = join(work, `page-${Math.random().toString(36).slice(2)}.html`);
  writeFileSync(htmlPath, html);
  await page.goto(file(htmlPath));
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: out });
  await page.close();
  rmSync(htmlPath);
}
const ff = (...args) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
const toBmp = (png, bmp) => ff('-i', png, '-pix_fmt', 'bgr24', bmp);

// Side pictures and header, 2x.
for (const kind of ['sidebar', 'finish']) {
  const png = join(work, `${kind}.png`);
  await render(sideHtml(kind), 164, 314, 2, png);
  toBmp(png, join(OUT, `${kind}.bmp`));
}
await render(headerHtml(), 150, 57, 2, join(work, 'header.png'));
toBmp(join(work, 'header.png'), join(OUT, 'header.bmp'));

// The DMG background (1x: Finder shows the picture at its pixel size).
await render(dmgHtml(), 660, 400, 1, join(OUT, 'dmg-background.png'));

// The slideshow: each slide holds HOLD frames, then the next wipes in over WIPE frames. 10 fps.
const FPS = 10, HOLD = 32, WIPE = 9;
for (const [pct, scale] of [[100, 1], [150, 1.5], [200, 2]]) {
  const dir = join(work, `slides-${pct}`);
  mkdirSync(dir, { recursive: true });
  const list = [];
  for (let i = 0; i < SLIDES.length; i++) {
    const still = join(dir, `s${i}.png`);
    await render(slideHtml(i), SW, SH, scale, still);
    for (let k = 0; k < HOLD; k++) list.push(still);
    const next = (i + 1) % SLIDES.length;
    for (let k = 1; k <= WIPE; k++) {
      const t = k / (WIPE + 1);
      const x = (1 - (1 - t) * (1 - t)) * 100; // ease out
      const f = join(dir, `s${i}-w${k}.png`);
      await render(slideHtml(i, { next, x }), SW, SH, scale, f);
      list.push(f);
    }
  }
  const concat = join(dir, 'frames.txt');
  writeFileSync(concat, list.map((f) => `file '${f}'\nduration ${1 / FPS}`).join('\n') + `\nfile '${list.at(-1)}'\n`);
  // One palette for the whole show (the animation control takes 8-bit RLE), no dithering so the
  // runs stay long and the file small.
  const palette = join(dir, 'palette.png');
  ff('-f', 'concat', '-safe', '0', '-i', concat, '-vf', 'palettegen=max_colors=256:stats_mode=full', palette);
  ff('-f', 'concat', '-safe', '0', '-i', concat, '-i', palette, '-lavfi', `fps=${FPS},paletteuse=dither=none`,
    '-c:v', 'msrle', '-g', String(HOLD + WIPE), join(OUT, `slides-${pct}.avi`));
}
await browser.close();
if (!preview) rmSync(work, { recursive: true, force: true });
console.log(`Wrote ${OUT}`);
