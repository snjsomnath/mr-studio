import {
  Soundscape,
  compassBearing,
  crownRadius,
  defineLayer,
  follow,
  hasSiteData,
  hearsSound,
  isovist,
  outsideBuildings,
  readSiteData,
  tableFrame,
  viewMoved,
  viewScene,
} from '@mrstudio/sdk';
import type { CanvasOverlay, Isovist, LayerManifest, PointerSample, ToolInput, ViewBuilding, ViewTree, XY } from '@mrstudio/sdk';

import manifest from '../layer.json';
import { isovistHero } from './hero.ts';
import { isovistPanel } from './panel.ts';
import { greenWord, partColour, streetViewMetadataUrl, throughSource, viewParts } from './view.ts';

export interface Params {
  fov: string;
  sound: boolean;
  radius: number;
  trees: boolean;
  follow: boolean;
  streetview: boolean;
  source: string;
  volume: number;
  nature: string;
  city: string;
}

type LonLat = [number, number];

/** The look of the demo (animations/isovist.js), in its own pixel sizes at the Chalmers table's scale. */
const LOOK = {
  fill: 'rgba(255, 255, 0, 0.35)',
  band: 'rgba(255, 213, 0, 0.1)',
  edge: '#ff0099',
  viewer: '#ff0000',
  trail: '#ff6b6b',
  treeFill: 'rgba(45, 90, 39, 0.7)',
  treeEdge: 'rgba(27, 61, 27, 0.9)',
  camera: '#00ff88',
};
/** The demo's pixels were drawn at about 1.5 pixels per metre. */
const DEMO_PX_PER_M = 1.5;
/** A press this many metres from the viewer picks it up instead of placing it anew. */
const GRAB_M = 14;
/** Picks are sent on at most this often while the pointer moves. */
const SEND_MS = 60;
/** After this long without local input, this view takes the viewer from the host again. */
const LOCAL_HOLD_MS = 800;
/** Street View metadata is asked again after the viewer moves this far (the demo's 5 m). */
const METADATA_M = 5;
const CAMERA_HISTORY = 10;
const TRAIL_STEP_M = 2;
const TRAIL_POINTS = 160;
/** A move longer than this is a new place, not a step of the walk. */
const TRAIL_JUMP_M = 25;
const DIRECTION_M = 30;
/** The edge breathes as in the demo: width 12 ± 4 px and blur 10 ± 4 px, very slowly. */
const PULSE_SPEED = 0.1;
/** Redraws per second: the edge moves slowly, so the table need not draw every frame. */
const DRAW_FPS = 30;

/** Lantmäteriet's building type, or another dataset's, for the view's breakdown. */
function buildingType(properties: Record<string, unknown>): string {
  const value = properties.objekttyp ?? properties.type ?? properties.building ?? properties.category;
  return typeof value === 'string' && value.trim() ? value.trim() : 'Unknown';
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
    const toTable = (lonLat: readonly number[]) => frame.toTable([lonLat[0]!, lonLat[1]!]) as XY;
    const canvas: CanvasOverlay = ctx.map.addCanvas('isovist');

    // ---- The scene the eye is stopped by: footprints and tree crowns, in table metres ----
    const buildings: ViewBuilding[] = [];
    const outlines: LonLat[][][] = [];
    for (const feature of features(await readSiteData(ctx.site, 'buildings'))) {
      const g = feature?.geometry;
      const polygons = g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [];
      for (const rings of polygons) {
        if (!rings?.[0] || rings[0].length < 3) continue;
        outlines.push(rings);
        buildings.push({ rings: rings.map((ring: number[][]) => ring.map(toTable)), type: buildingType(feature.properties ?? {}) });
      }
    }
    const trees: ViewTree[] = [];
    const crowns: { lonLat: LonLat; r: number }[] = [];
    if (hasSiteData(ctx.site, 'trees')) {
      for (const feature of features(await readSiteData(ctx.site, 'trees'))) {
        const c = feature?.geometry?.type === 'Point' ? feature.geometry.coordinates : null;
        if (!c) continue;
        const r = crownRadius(feature.properties ?? {});
        const [x, y] = toTable(c);
        trees.push({ x, y, r });
        crowns.push({ lonLat: [c[0], c[1]], r });
      }
    }
    const scene = viewScene(buildings, trees);

    // ---- The viewer: where they stand and where they look ----
    let viewer: XY = outsideBuildings(scene, [frame.width / 2, frame.height / 2]);
    let look: XY = [viewer[0], viewer[1] - 50];
    let heading = -Math.PI / 2;
    let view: Isovist | null = null;
    let dirty = true;
    let lastLocal = -Infinity;
    let drag: string | null = null;
    /** The mouse is over the table: the viewer looks at it and walks after it. */
    let cursorHere = false;
    const trail: XY[] = [];

    const options = () => ({ radius_m: ctx.params.radius, fov_deg: Number(ctx.params.fov) || 120, heading, trees: ctx.params.trees });

    function recompute(): void {
      const dx = look[0] - viewer[0];
      const dy = look[1] - viewer[1];
      if (Math.hypot(dx, dy) > 0.5) heading = Math.atan2(dy, dx);
      view = isovist(scene, viewer, options());
      const last = trail.at(-1);
      if (!last || Math.hypot(viewer[0] - last[0], viewer[1] - last[1]) >= TRAIL_STEP_M) {
        trail.push([viewer[0], viewer[1]]);
        if (trail.length > TRAIL_POINTS) trail.shift();
      }
      publishView();
      dirty = false;
    }

    // ---- Sending picks through the host, so the projector and the editor agree ----
    let lastSent = -Infinity;
    let trailing: ReturnType<typeof setTimeout> | undefined;
    let unsent: { stand?: LonLat; look?: LonLat } = {};
    const round = (lonLat: LonLat) => lonLat.map((v) => Math.round(v * 1e7) / 1e7) as LonLat;
    function flush(): void {
      clearTimeout(trailing);
      trailing = undefined;
      lastSent = performance.now();
      for (const tool of ['stand', 'look'] as const) {
        const lonLat = unsent[tool];
        if (lonLat) ctx.sendTool(tool, { type: 'Point', coordinates: round(lonLat) }).catch((error) => console.warn('[isovist] pick not sent', error));
      }
      unsent = {};
    }
    function send(tool: 'stand' | 'look', point: XY): void {
      unsent[tool] = frame.toLonLat(point);
      const wait = lastSent + SEND_MS - performance.now();
      if (wait <= 0) flush();
      else trailing ??= setTimeout(flush, wait);
    }
    ctx.onCleanup(() => clearTimeout(trailing));

    function stand(point: XY, local: boolean): void {
      const next = outsideBuildings(scene, point, ctx.params.radius);
      // A new place, not a step: the walk starts again there.
      if (Math.hypot(next[0] - viewer[0], next[1] - viewer[1]) > TRAIL_JUMP_M) trail.length = 0;
      viewer = next;
      dirty = true;
      if (local) send('stand', viewer);
    }

    ctx.pointer.on((sample: PointerSample) => {
      lastLocal = performance.now();
      const point: XY = [sample.point[0], sample.point[1]];
      if (sample.source === 'mouse') cursorHere = sample.phase !== 'leave';
      if (drag === sample.id) {
        if (sample.phase === 'move' && sample.pressed) {
          // A finger dragging the viewer walks it, looking the way it goes.
          if (sample.source !== 'mouse') {
            const d = Math.hypot(point[0] - viewer[0], point[1] - viewer[1]);
            if (d > 0.5) {
              look = [point[0] + ((point[0] - viewer[0]) / d) * 50, point[1] + ((point[1] - viewer[1]) / d) * 50];
              send('look', look);
            }
          }
          stand(point, true);
          return;
        }
        if (sample.phase === 'up' || sample.phase === 'leave' || !sample.pressed) {
          drag = null;
          flush();
        }
        return;
      }
      if (sample.phase === 'down') {
        drag = sample.id;
        if (Math.hypot(point[0] - viewer[0], point[1] - viewer[1]) > GRAB_M) stand(point, true);
        return;
      }
      if (sample.source === 'mouse' && sample.phase === 'move') {
        look = point;
        dirty = true;
        send('look', look);
      }
    });

    // ---- What the controller and the TV show ----
    let published: { point: XY; bearing: number } | null = null;
    function publishView(): void {
      if (!view) return;
      const s = view.stats;
      const bearing = compassBearing(heading, ctx.site.extent.rotation_deg);
      const values: Record<string, unknown> = {
        gvf: Math.round(s.gvf * 1000) / 1000,
        gvfPercent: Math.round(s.gvf * 100),
        gvfWord: greenWord(s.gvf),
        parts: viewParts(s.open, s.trees, s.byType, s.rays),
        seenBuildings: s.seenBuildings,
        seenTrees: s.seenTrees,
        fov: Number(ctx.params.fov) || 120,
      };
      // The place and heading go on only after 3 m or 15° (the demo's throttle), so Street View is not asked at every step.
      if (viewMoved(published, viewer, bearing)) {
        published = { point: viewer, bearing };
        values.viewer = round(frame.toLonLat(viewer));
        values.bearing = Math.round(bearing);
      }
      ctx.publish(values);
    }

    ctx.legend.set([
      { id: 'seen', label: 'Seen from here', color: '#ffe600', shape: 'fill' },
      { id: 'edge', label: 'Edge of sight', color: LOOK.edge, shape: 'line' },
      { id: 'trees', label: 'Trees in view', color: partColour('Trees'), shape: 'fill' },
      { id: 'camera', label: 'Street View camera', color: LOOK.camera, shape: 'point' },
    ]);

    // ---- Street View's real camera positions, a fading green trail (the demo's `isovist-streetview-camera`) ----
    let camera: LonLat | null = null;
    const cameras: LonLat[] = [];
    let asked: XY | null = null;
    let asking = false;
    /** The source that refused (no key, no connection), so it is not asked again until it changes. */
    let refusedBy: string | null = null;
    async function askCamera(): Promise<void> {
      const source = ctx.params.source || 'streetview';
      if (!ctx.params.streetview || asking || refusedBy === source) return;
      if (asked && Math.hypot(viewer[0] - asked[0], viewer[1] - asked[1]) < METADATA_M) return;
      asking = true;
      asked = viewer;
      try {
        const response = await fetch(throughSource(source, streetViewMetadataUrl(frame.toLonLat(viewer))));
        if (!response.ok) {
          refusedBy = source;
          ctx.publish({ streetview: response.status === 424 ? 'needs-key' : response.status === 404 ? 'no-source' : 'refused' });
          return;
        }
        const body = await response.json();
        ctx.publish({ streetview: body.status === 'OK' ? 'ok' : 'no-coverage' });
        if (body.status !== 'OK' || !body.location) return;
        const next: LonLat = [body.location.lng, body.location.lat];
        const [ax, ay] = camera ? toTable(camera) : [0, 0];
        const [bx, by] = toTable(next);
        if (camera && Math.hypot(ax - bx, ay - by) > 2) {
          cameras.unshift(camera);
          cameras.length = Math.min(cameras.length, CAMERA_HISTORY);
        }
        camera = next;
        ctx.publish({ camera: round(next) });
      } catch {
        refusedBy = source;
      } finally {
        asking = false;
      }
    }

    // ---- Drawing ----
    const P = (point: XY) => canvas.project(frame.toLonLat(point));
    function draw(time: number): void {
      const g = canvas.context;
      canvas.clear();
      if (!view) return;
      const s = Math.min(3, Math.max(0.6, canvas.pixelsPerMetre / DEMO_PX_PER_M));
      g.lineCap = 'round';
      g.lineJoin = 'round';

      // Buildings and trees in view, in their colours.
      for (const i of view.seenBuildings) {
        g.beginPath();
        for (const ring of outlines[i]!) {
          ring.forEach((c, k) => {
            const [x, y] = canvas.project(c);
            if (k === 0) g.moveTo(x, y);
            else g.lineTo(x, y);
          });
          g.closePath();
        }
        const colour = partColour(buildings[i]!.type);
        g.globalAlpha = 0.6;
        g.fillStyle = colour;
        g.fill('evenodd');
        g.globalAlpha = 1;
        g.lineWidth = Math.max(1, 1.5 * s);
        g.strokeStyle = colour;
        g.stroke();
      }
      for (const i of view.seenTrees) {
        const tree = crowns[i]!;
        const [x, y] = canvas.project(tree.lonLat);
        g.beginPath();
        g.arc(x, y, Math.max(1.5, tree.r * canvas.pixelsPerMetre), 0, Math.PI * 2);
        g.fillStyle = LOOK.treeFill;
        g.fill();
        g.lineWidth = Math.max(1, 1.5 * s);
        g.strokeStyle = LOOK.treeEdge;
        g.stroke();
      }

      // The view: a yellow fill with three stacked bands that fade with distance.
      const outline = new Path2D();
      view.polygon.forEach((point, k) => {
        const [x, y] = P(point);
        if (k === 0) outline.moveTo(x, y);
        else outline.lineTo(x, y);
      });
      outline.closePath();
      g.fillStyle = LOOK.fill;
      g.fill(outline);
      const [vx, vy] = P(viewer);
      g.save();
      g.clip(outline);
      g.fillStyle = LOOK.band;
      for (let b = 1; b <= 3; b++) {
        g.beginPath();
        g.arc(vx, vy, ((ctx.params.radius * b) / 3) * canvas.pixelsPerMetre, 0, Math.PI * 2);
        g.fill();
      }
      g.restore();

      // The edge of sight: a glowing pink dashed line that breathes.
      const sine = Math.sin(time * PULSE_SPEED);
      const width = (12 + sine * 4) * s * 0.6;
      g.save();
      g.setLineDash([width * 2, width * 2]);
      g.lineWidth = width;
      g.strokeStyle = LOOK.edge;
      g.globalAlpha = 0.95 + sine * 0.05;
      g.shadowColor = LOOK.edge;
      g.shadowBlur = (10 + sine * 4) * s;
      g.stroke(outline);
      g.restore();

      // Where the viewer has walked.
      if (trail.length > 1) {
        g.beginPath();
        trail.forEach((point, k) => {
          const [x, y] = P(point);
          if (k === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        });
        g.globalAlpha = 0.4;
        g.strokeStyle = LOOK.trail;
        g.lineWidth = 2 * s;
        g.stroke();
        g.globalAlpha = 0.3;
        g.fillStyle = LOOK.trail;
        for (const point of trail) {
          const [x, y] = P(point);
          g.beginPath();
          g.arc(x, y, 2 * s, 0, Math.PI * 2);
          g.fill();
        }
        g.globalAlpha = 1;
      }

      // Street View's cameras: fading history, then the current one with a glow.
      cameras.forEach((c, k) => {
        const [x, y] = canvas.project(c);
        const alpha = 1 - (k + 1) / (CAMERA_HISTORY + 1);
        g.globalAlpha = alpha;
        g.beginPath();
        g.arc(x, y, 7 * s * 0.7, 0, Math.PI * 2);
        g.fillStyle = LOOK.camera;
        g.fill();
        g.lineWidth = 2 * s * 0.7;
        g.strokeStyle = '#ffffff';
        g.stroke();
      });
      g.globalAlpha = 1;
      if (camera) {
        const [x, y] = canvas.project(camera);
        const glow = g.createRadialGradient(x, y, 0, x, y, 18 * s * 0.7);
        glow.addColorStop(0, 'rgba(0, 255, 136, 0.45)');
        glow.addColorStop(1, 'rgba(0, 255, 136, 0)');
        g.fillStyle = glow;
        g.beginPath();
        g.arc(x, y, 18 * s * 0.7, 0, Math.PI * 2);
        g.fill();
        g.beginPath();
        g.arc(x, y, 10 * s * 0.7, 0, Math.PI * 2);
        g.fillStyle = LOOK.camera;
        g.fill();
        g.lineWidth = 3 * s * 0.7;
        g.strokeStyle = '#ffffff';
        g.stroke();
      }

      // The viewer: a red dot with a line the way they look.
      const [lx, ly] = P([viewer[0] + Math.cos(heading) * DIRECTION_M, viewer[1] + Math.sin(heading) * DIRECTION_M]);
      g.beginPath();
      g.moveTo(vx, vy);
      g.lineTo(lx, ly);
      g.strokeStyle = LOOK.viewer;
      g.lineWidth = 3 * s;
      g.stroke();
      g.beginPath();
      g.arc(vx, vy, Math.max(4, 5 * s), 0, Math.PI * 2);
      g.fillStyle = LOOK.viewer;
      g.fill();
      g.lineWidth = Math.max(1, 1.5 * s);
      g.strokeStyle = '#ffffff';
      g.stroke();
    }

    // ---- Soundscape: city and nature beds mixed by the green view ----
    const soundscape = new Soundscape({ audible: hearsSound() });
    ctx.onCleanup(() => soundscape.stop());
    const bed = (file: string) => ({ file: file.trim() ? (file.includes('/') ? file.trim() : `data/sounds/${file.trim()}`) : null });
    let mixSent = '';

    let time = 0;
    let since = Infinity;
    ctx.onFrame((dt) => {
      time += dt;
      since += dt;
      if (ctx.params.follow && cursorHere && !drag) {
        const next = follow(viewer, look, dt);
        if (next[0] !== viewer[0] || next[1] !== viewer[1]) stand(next, true);
      }
      if (dirty) recompute();
      void askCamera();
      soundscape.audible = hearsSound();
      soundscape.update(ctx.params.sound && view ? view.stats.gvf : null, { nature: bed(ctx.params.nature), city: bed(ctx.params.city) }, ctx.params.volume, dt);
      const v = soundscape.volumes;
      const mix = ctx.params.sound ? `${v.nature.toFixed(2)},${v.city.toFixed(2)}` : 'off';
      if (mix !== mixSent) {
        mixSent = mix;
        ctx.publish({ mix: ctx.params.sound ? { nature: Number(v.nature.toFixed(2)), city: Number(v.city.toFixed(2)) } : null });
      }
      if (since >= 1 / DRAW_FPS || canvas.revision !== drawnRevision) {
        since = 0;
        drawnRevision = canvas.revision;
        draw(time);
      }
    });
    let drawnRevision = -1;

    return {
      update(changed) {
        if (changed.some((k) => ['fov', 'radius', 'trees'].includes(k))) dirty = true;
        if (changed.includes('source') || changed.includes('streetview')) {
          refusedBy = null;
          asked = null;
        }
      },
      tool(input: ToolInput) {
        const geometry = input.geometry as { type?: string; coordinates?: number[] } | null;
        if (geometry?.type !== 'Point' || !Array.isArray(geometry.coordinates)) return;
        // This view is being worked with a pointer: its own picks are newer than the host's echo of them.
        if (performance.now() - lastLocal < LOCAL_HOLD_MS) return;
        const point = toTable(geometry.coordinates);
        if (input.tool === 'stand') stand(point, false);
        else if (input.tool === 'look') {
          look = point;
          dirty = true;
        }
      },
    };
  },

  // The controller's hero: Street View from where the viewer stands, looking their way (#82).
  hero: (ctx, el) => isovistHero(ctx as never, el),

  panel: (ctx, el) => isovistPanel(ctx as never, el),
});
