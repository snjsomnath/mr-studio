// Draws the "New table" illustration on the Home page: a table seen from above at an angle, with a
// small city projected on its top, a lit route and a soft glow. Writes apps/studio/ui/art/new-table.svg.
//   node scripts/new-table-art.mjs
// The drawing is generated rather than hand-made so it stays easy to change: edit the numbers below.
import { mkdirSync, writeFileSync } from 'node:fs';

const W = 10; // table length (x), in drawing units
const D = 6.25; // table depth (y), 16 : 10
const RIM = 0.32; // frame around the projected area
const THICK = 0.34; // frame thickness
const LEG = 2.1; // leg length below the frame
const S = 24; // pixels per unit

// Axonometric axes, flatter than isometric so the long table fits a wide card.
const AX = [0.9, 0.38];
const AY = [-0.7, 0.44];
const OX = 4.9 * S; // where the table's far-left corner (0, 0) lands
const OY = 1.9 * S;
const P = (x, y, z = 0) => [OX + (x * AX[0] + y * AY[0]) * S, OY + (x * AX[1] + y * AY[1] - z) * S];
const seen = [];
const pts = (list) => list.map(([x, y, z]) => { const q = P(x, y, z); seen.push(q); return q; }).map((q) => q.map((n) => n.toFixed(1)).join(',')).join(' ');
const poly = (list, attrs) => `<polygon points="${pts(list)}" ${attrs}/>`;

// A small deterministic random, so the city is the same every time.
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

// River across the near-left corner, as a band between two lines x + k·y = c.
const inRiver = (x, y) => {
  const v = x - 0.95 * y;
  return v > -4.1 && v < -2.9;
};
const riverEdge = (c) => {
  // Where x - 0.95 y = c meets the projected area.
  const a = [RIM, RIM, D - RIM, W - RIM];
  const hits = [];
  for (const y of [a[0], a[2]]) {
    const x = c + 0.95 * y;
    if (x >= a[1] && x <= a[3]) hits.push([x, y]);
  }
  for (const x of [a[1], a[3]]) {
    const y = (x - c) / 0.95;
    if (y > a[0] && y < a[2]) hits.push([x, y]);
  }
  return hits.sort((p, q) => p[1] - q[1]);
};

// Buildings: a street grid of blocks, each block holding a few boxes.
const buildings = [];
const cols = [0.55, 2.1, 3.65, 5.2, 6.75, 8.3];
const rows = [0.55, 2.05, 3.55, 5.05];
for (const bx of cols) {
  for (const by of rows) {
    const bw = Math.min(1.25, W - RIM - 0.2 - bx);
    const bd = Math.min(1.2, D - RIM - 0.2 - by);
    if (bw < 0.4 || bd < 0.4) continue;
    const kind = rand();
    if (kind < 0.12) continue; // a square
    const parts = kind > 0.6
      ? [[bx + 0.08, by + 0.08, bw * 0.42, bd - 0.16], [bx + bw * 0.6, by + 0.08, bw * 0.34, bd * 0.42]]
      : kind > 0.3
        ? [[bx + 0.1, by + 0.1, bw - 0.2, bd * 0.38], [bx + 0.1, by + bd * 0.6, bw * 0.5, bd * 0.32]]
        : [[bx + 0.12, by + 0.12, bw - 0.24, bd - 0.24]];
    for (const [x, y, w, d] of parts) {
      if ([[x, y], [x + w, y], [x, y + d], [x + w, y + d]].some(([px, py]) => inRiver(px, py))) continue;
      const tall = 0.14 + rand() ** 3 * 0.7;
      buildings.push({ x, y, w, d, h: tall, lit: rand() > 0.9 });
    }
  }
}
// Park: one block left open and green.
const park = { x: 6.75, y: 3.55, w: 1.25, d: 1.2 };
const isPark = (b) => b.x >= park.x - 0.01 && b.x < park.x + park.w && b.y >= park.y - 0.01 && b.y < park.y + park.d;
const city = buildings.filter((b) => !isPark(b)).sort((a, b) => a.x + a.y - (b.x + b.y));

const box = ({ x, y, w, d, h, lit }) => {
  const top = lit ? 'url(#lit)' : '#e9edf7';
  const left = lit ? '#d99a3c' : '#b4bdd2';
  const right = lit ? '#b97f2a' : '#8f9ab3';
  return [
    poly([[x, y + d, 0], [x + w, y + d, 0], [x + w, y + d, h], [x, y + d, h]], `fill="${left}"`),
    poly([[x + w, y, 0], [x + w, y + d, 0], [x + w, y + d, h], [x + w, y, h]], `fill="${right}"`),
    poly([[x, y, h], [x + w, y, h], [x + w, y + d, h], [x, y + d, h]], `fill="${top}"`),
  ].join('');
};

// The lit route runs along the streets.
const route = [[RIM + 0.05, 1.83], [3.43, 1.83], [3.43, 3.33], [6.53, 3.33], [6.53, 4.83], [W - RIM - 0.05, 4.83]];
const routePath = 'M' + route.map(([x, y]) => P(x, y, 0.01).map((n) => n.toFixed(1)).join(' ')).join('L');

const inner = [[RIM, RIM, 0], [W - RIM, RIM, 0], [W - RIM, D - RIM, 0], [RIM, D - RIM, 0]];
const outerTop = [[0, 0, 0], [W, 0, 0], [W, D, 0], [0, D, 0]];
const leg = (x, y) => {
  const t = 0.22;
  return [
    poly([[x, y + t, -THICK], [x + t, y + t, -THICK], [x + t, y + t, -THICK - LEG], [x, y + t, -THICK - LEG]], 'fill="#3a4357"'),
    poly([[x + t, y, -THICK], [x + t, y + t, -THICK], [x + t, y + t, -THICK - LEG], [x + t, y, -THICK - LEG]], 'fill="#252c3b"'),
  ].join('');
};
const [r1, r2] = [riverEdge(-4.1), riverEdge(-2.9)];
const river = r1.length === 2 && r2.length === 2 ? [...r1, ...r2.reverse()] : [];
const [cx, cy] = P(W / 2, D / 2, -THICK - LEG);

const body = `<ellipse cx="${cx.toFixed(1)}" cy="${(cy - 6).toFixed(1)}" rx="${(W * 0.62 * S).toFixed(1)}" ry="${(D * 0.42 * S).toFixed(1)}" fill="url(#floor)"/>
${leg(0.25, D - 0.47)}${leg(W - 0.47, D - 0.47)}${leg(W - 0.47, 0.25)}
${poly(outerTop.map(([x, y]) => [x, y, 0]), 'class="glow" fill="#4f74ff" opacity=".35" filter="url(#blur)"')}
${poly([[0, D, 0], [W, D, 0], [W, D, -THICK], [0, D, -THICK]], 'fill="#3b4560"')}
${poly([[W, 0, 0], [W, D, 0], [W, D, -THICK], [W, 0, -THICK]], 'fill="#283049"')}
${poly(outerTop, 'fill="#4a5572"')}
${poly(inner, 'fill="url(#ground)"')}
${river.length ? poly(river.map(([x, y]) => [x, y, 0]), 'fill="url(#water)"') : ''}
${poly([[park.x, park.y, 0], [park.x + park.w, park.y, 0], [park.x + park.w, park.y + park.d, 0], [park.x, park.y + park.d, 0]], 'fill="#2f6b4f"')}
<path d="${routePath}" fill="none" stroke="#6f8cff" stroke-width="7" stroke-linejoin="round" opacity=".9" filter="url(#soft)"/>
<path d="${routePath}" fill="none" stroke="#b9c8ff" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>
<path class="route" d="${routePath}" fill="none" stroke="#ffffff" stroke-width="2.4" stroke-linecap="round"/>
${city.map(box).join('\n')}
`;
// Fit the picture: everything drawn, the glow and the floor shadow, plus a margin.
const xs = seen.map((q) => q[0]);
const ys = seen.map((q) => q[1]);
const M = 16;
const [x0, y0] = [Math.floor(Math.min(...xs) - M), Math.floor(Math.min(...ys) - M)];
const [w0, h0] = [Math.ceil(Math.max(...xs) + M) - x0, Math.ceil(Math.max(...ys) + M) - y0];
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0} ${y0} ${w0} ${h0}" width="${w0}" height="${h0}">
<!-- Generated by scripts/new-table-art.mjs. Edit that script, not this file. -->
<style>
.route{stroke-dasharray:6 8;animation:flow 1.6s linear infinite}
.glow{animation:breathe 4s ease-in-out infinite}
@keyframes flow{to{stroke-dashoffset:-14}}
@keyframes breathe{50%{opacity:.55}}
@media (prefers-reduced-motion:reduce){.route,.glow{animation:none}}
</style>
<defs>
<radialGradient id="floor"><stop offset="0" stop-color="#1c2a55" stop-opacity=".28"/><stop offset="1" stop-color="#1c2a55" stop-opacity="0"/></radialGradient>
<linearGradient id="ground" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#16203a"/><stop offset="1" stop-color="#0c1222"/></linearGradient>
<linearGradient id="lit" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffd27a"/><stop offset="1" stop-color="#f3ad3d"/></linearGradient>
<linearGradient id="water" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#2148a8"/><stop offset="1" stop-color="#1a3577"/></linearGradient>
<filter id="blur" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="9"/></filter>
<filter id="soft" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="3"/></filter>
</defs>
${body}</svg>
`;

mkdirSync(new URL('../apps/studio/ui/art/', import.meta.url), { recursive: true });
writeFileSync(new URL('../apps/studio/ui/art/new-table.svg', import.meta.url), svg);
console.log(`new-table.svg: ${city.length} buildings, ${svg.length} bytes`);
