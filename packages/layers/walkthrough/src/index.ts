// Video walk (#194): a video someone filmed while walking plays on the controller, and on the
// table the walker moves along the path they took, in step with the picture: a faint line of
// the whole walk, a bright trail of what is behind them, and what they could see from there.
// The controller's hero owns playing, pausing and scrubbing; it writes the play state into
// params that are never shown (tier "state"), so every view of the table follows the same clock.
import { crownRadius, defineLayer, hasSiteData, isovist, readSiteData, siteDataUrl, tableFrame, viewScene } from '@mrstudio/sdk';
import type { CanvasOverlay, Isovist, LayerManifest, ViewBuilding, ViewTree } from '@mrstudio/sdk';

import manifest from '../layer.json';
import { walkHero } from './hero.ts';
import { headingAt, makeWalk, pathDataset, videoDataset, videoTime, walkAt, walkOf } from './path.ts';
import type { Walk, XY } from './path.ts';

export interface Params {
  view: boolean;
  loop: boolean;
  video: string;
  path: string;
  opacity: number;
  playing: boolean;
  at: number;
  since: number;
}

/** The look on the table. */
const LOOK = {
  route: 'rgb(255 255 255 / 0.35)',
  trail: '#7fe7ff',
  walker: '#ffffff',
  glow: '#38d6ff',
  view: 'rgb(127 231 255 / 0.22)',
  viewEdge: 'rgb(127 231 255 / 0.75)',
};
/** What the walker sees: a person's field of view, as far as a street reaches. */
const FOV_DEG = 90;
const SIGHT_M = 120;
/** Sizes in metres, kept at least so many pixels so they read on a small table. */
const WALKER_M = 3.2;
const MIN_WALKER_PX = 11;

/** The video's length, from its own header, read by the browser. */
function videoLength(url: string): Promise<number> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    const done = (value: number) => {
      video.removeAttribute('src');
      video.load();
      resolve(value);
    };
    video.addEventListener('loadedmetadata', () => done(Number.isFinite(video.duration) ? video.duration : 0), { once: true });
    video.addEventListener('error', () => done(0), { once: true });
    video.src = url;
  });
}

function features(geojson: any): any[] {
  if (!geojson) return [];
  if (geojson.type === 'FeatureCollection') return geojson.features ?? [];
  return geojson.type === 'Feature' ? [geojson] : [];
}

export default defineLayer<Params>({
  manifest: manifest as LayerManifest,

  async table(ctx) {
    const frame = tableFrame(ctx.site);
    const canvas: CanvasOverlay = ctx.map.addCanvas('walkthrough');
    canvas.setOpacity(ctx.params.opacity);
    const toLonLat = (p: XY) => frame.toLonLat(p) as [number, number];

    // ---- The clock: the play state from the controller, timed by this view's own clock ----
    // The controller writes when it pressed play with its clock; another computer's clock may be a
    // little off, so a change is timed from when it arrived here. Only a view that opens while the
    // video plays has to trust the controller's clock.
    let receivedAt = Math.min(Date.now(), ctx.params.since || Date.now());
    const now = () => videoTime({ playing: ctx.params.playing, at: ctx.params.at, since: receivedAt }, Date.now(), duration, ctx.params.loop);

    // ---- The walk and the video's length ----
    let duration = 0;
    let walk: Walk | null = null;
    let drawn = '';
    let pulse = 0;
    let loading = 0;
    async function load() {
      const mine = ++loading;
      const videoName = videoDataset(ctx.site, ctx.params.video);
      const videoUrl = videoName ? siteDataUrl(ctx.site, videoName) : null;
      const pathName = pathDataset(ctx.site, ctx.params.path);
      const [length, geojson] = await Promise.all([videoUrl ? videoLength(videoUrl) : 0, pathName ? readSiteData(ctx.site, pathName) : null]);
      if (mine !== loading) return;
      duration = length;
      const found = walkOf(geojson);
      walk = found.lonLat.length > 1 ? makeWalk(found.lonLat.map((c) => frame.toTable(c) as XY), found.times, duration) : null;
      if (walk?.timed && !duration) duration = walk.times.at(-1) ?? 0;
      const missing = !videoUrl ? 'Add a video to the table' : !walk ? 'Add the path the video was filmed along (GeoJSON)' : '';
      ctx.publish({ note: missing ? ctx.say(missing) : '', length: duration, walked: walk ? Math.round(walk.along.at(-1)!) : 0 });
      drawn = '';
    }

    // ---- What the walker sees: footprints and tree crowns, in table metres ----
    const buildings: ViewBuilding[] = [];
    for (const feature of features(hasSiteData(ctx.site, 'buildings') ? await readSiteData(ctx.site, 'buildings') : null)) {
      const g = feature?.geometry;
      const polygons = g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [];
      for (const rings of polygons) {
        if (rings?.[0]?.length >= 3) buildings.push({ rings: rings.map((ring: number[][]) => ring.map((c) => frame.toTable([c[0]!, c[1]!]) as XY)), type: 'building' });
      }
    }
    const trees: ViewTree[] = [];
    for (const feature of features(hasSiteData(ctx.site, 'trees') ? await readSiteData(ctx.site, 'trees') : null)) {
      const c = feature?.geometry?.type === 'Point' ? feature.geometry.coordinates : null;
      if (!c) continue;
      const [x, y] = frame.toTable([c[0], c[1]]);
      trees.push({ x, y, r: crownRadius(feature.properties ?? {}) });
    }
    const scene = buildings.length || trees.length ? viewScene(buildings, trees) : null;
    let sight: { at: XY; heading: number; view: Isovist } | null = null;
    let heading = -Math.PI / 2;

    await load();

    // ---- Drawing, at most when something moved ----
    ctx.onFrame((dt) => {
      pulse = (pulse + dt / 2) % 1;
      if (!walk) {
        if (drawn !== 'none') canvas.clear();
        drawn = 'none';
        return;
      }
      const t = now();
      const here = walkAt(walk, t);
      heading = headingAt(walk, t) ?? heading;
      const key = `${canvas.revision}|${here.at[0].toFixed(2)},${here.at[1].toFixed(2)}|${heading.toFixed(2)}|${ctx.params.view}|${Math.round(pulse * 30)}`;
      if (key === drawn) return;
      drawn = key;

      const g = canvas.context;
      const px = canvas.pixelsPerMetre;
      const project = (p: XY) => canvas.project(toLonLat(p));
      canvas.clear();
      g.lineCap = 'round';
      g.lineJoin = 'round';

      // What the walker sees, under the lines.
      if (ctx.params.view && scene) {
        if (!sight || Math.hypot(sight.at[0] - here.at[0], sight.at[1] - here.at[1]) > 0.4 || Math.abs(sight.heading - heading) > 0.03) {
          sight = { at: here.at, heading, view: isovist(scene, here.at, { radius_m: SIGHT_M, fov_deg: FOV_DEG, heading, trees: true }) };
        }
        const poly = sight.view.polygon.map(project);
        if (poly.length > 2) {
          const [cx, cy] = project(here.at);
          const fill = g.createRadialGradient(cx, cy, 0, cx, cy, SIGHT_M * px);
          fill.addColorStop(0, 'rgb(127 231 255 / 0.55)');
          fill.addColorStop(1, 'rgb(127 231 255 / 0.1)');
          g.fillStyle = fill;
          g.beginPath();
          poly.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y)));
          g.closePath();
          g.fill();
          g.strokeStyle = LOOK.viewEdge;
          g.lineWidth = 1.5;
          g.stroke();
        }
      }

      // The whole walk, faint and dashed, so where they will go reads ahead.
      const points = walk.points.map(project);
      g.setLineDash([Math.max(3, 2 * px), Math.max(4, 3 * px)]);
      g.strokeStyle = LOOK.route;
      g.lineWidth = Math.max(2, 0.9 * px);
      g.beginPath();
      points.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.stroke();
      g.setLineDash([]);

      // The trail behind them, bright and glowing.
      const behind: [number, number][] = [];
      for (let k = 0; k < walk.points.length && walk.along[k]! <= here.along; k++) behind.push(points[k]!);
      behind.push(project(here.at));
      g.save();
      g.shadowColor = LOOK.glow;
      g.shadowBlur = 14;
      g.strokeStyle = LOOK.trail;
      g.lineWidth = Math.max(4, 1.6 * px);
      g.beginPath();
      behind.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.stroke();
      g.restore();

      // The walker: a glowing dot with a ripple, and a short pointer the way they face.
      const [x, y] = project(here.at);
      const r = Math.max(MIN_WALKER_PX, WALKER_M * px);
      g.save();
      g.globalAlpha = (1 - pulse) * 0.8;
      g.strokeStyle = LOOK.glow;
      g.lineWidth = r * 0.3;
      g.beginPath();
      g.arc(x, y, r * (1 + pulse * 2.2), 0, Math.PI * 2);
      g.stroke();
      g.restore();
      // The map may be turned: the heading is drawn through the projection, not from table angles.
      const [hx, hy] = project([here.at[0] + Math.cos(heading) * 10, here.at[1] + Math.sin(heading) * 10]);
      const a = Math.atan2(hy - y, hx - x);
      g.save();
      g.shadowColor = LOOK.glow;
      g.shadowBlur = 18;
      g.fillStyle = LOOK.walker;
      g.beginPath();
      g.moveTo(x + Math.cos(a) * r * 2.1, y + Math.sin(a) * r * 2.1);
      g.lineTo(x + Math.cos(a + 2.4) * r, y + Math.sin(a + 2.4) * r);
      g.lineTo(x + Math.cos(a - 2.4) * r, y + Math.sin(a - 2.4) * r);
      g.closePath();
      g.fill();
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
      g.restore();
      g.fillStyle = LOOK.glow;
      g.beginPath();
      g.arc(x, y, r * 0.45, 0, Math.PI * 2);
      g.fill();
    });

    return {
      update(changed) {
        if (changed.some((key) => key === 'playing' || key === 'at' || key === 'since')) receivedAt = Date.now();
        if (changed.includes('opacity')) canvas.setOpacity(ctx.params.opacity);
        if (changed.some((key) => key === 'video' || key === 'path')) void load();
        drawn = '';
      },
    };
  },

  // The controller's hero: the video itself, with play, pause and a scrubber.
  hero: (ctx, el) => walkHero(ctx, el),
});
