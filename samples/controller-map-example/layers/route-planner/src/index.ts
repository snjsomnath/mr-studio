// Route planner: a site layer with its own map app on the controller (#283).
//
// The controller's centre is the layer's `stage` (layer.json `stage: "custom"`): a map of the site
// from `controllerMap`. Two taps there make a route, along the streets or straight, and go to the
// table as a tool input (`ctx.sendTool`), so every view of the table draws the same route. A button
// on the stage presses the named action `travel` (`ctx.action`), and the table sends a light along
// the route. The table draws; the controller is for choosing.
import { StreetGraph, along, controllerMap, defineLayer, streetLines, tableSpace, track, withAlpha } from '@mrstudio/sdk';
import type { LayerManifest, Position, ToolGeometry, XY } from '@mrstudio/sdk';

import manifest from '../layer.json';

interface Params {
  streets: boolean;
}

/** The route as the table published it, for the controller's map. */
interface Shared {
  route?: Position[];
  metres?: number;
  straight?: boolean;
  travelling?: boolean;
}

const ROUTE = '#5ce1e6';
const LIGHT = '#fff6c2';

/** WGS84 from table metres. */
function lonLatOf(site: { corners: [number, number][] }, width: number, height: number, [x, y]: XY): Position {
  const [tl, tr, , bl] = site.corners as [Position, Position, Position, Position];
  const u = x / width;
  const v = y / height;
  return [tl[0] + u * (tr[0] - tl[0]) + v * (bl[0] - tl[0]), tl[1] + u * (tr[1] - tl[1]) + v * (bl[1] - tl[1])];
}

export default defineLayer<Params>({
  manifest: manifest as LayerManifest,

  // ---- Controller: the layer's own map app ---------------------------------------------
  stage(ctx, el) {
    const space = tableSpace(ctx.site);
    let graph: StreetGraph | null = null;
    void streetLines(ctx.site).then((lines) => (graph = new StreetGraph(lines, { shortestPieceM: 0 })));

    const mapBox = document.createElement('div');
    Object.assign(mapBox.style, { position: 'absolute', inset: '0' });
    const bar = document.createElement('div');
    Object.assign(bar.style, {
      position: 'absolute',
      left: '1rem',
      right: '1rem',
      bottom: '1rem',
      display: 'flex',
      gap: '1rem',
      alignItems: 'center',
      justifyContent: 'space-between',
      pointerEvents: 'none',
    });
    const words = document.createElement('div');
    Object.assign(words.style, { fontSize: '1.25rem', padding: '0.5rem 0.875rem', borderRadius: '0.75rem', background: 'var(--panel, rgba(0,0,0,0.6))' });
    const travel = document.createElement('button');
    travel.type = 'button';
    travel.textContent = ctx.say('Send a traveller');
    Object.assign(travel.style, {
      pointerEvents: 'auto',
      minHeight: '3.5rem',
      padding: '0 1.5rem',
      border: '0',
      borderRadius: '999px',
      background: 'var(--accent, #ffb84d)',
      color: 'var(--accent-ink, #111)',
      font: 'inherit',
      fontSize: '1.25rem',
      fontWeight: '650',
      cursor: 'pointer',
    });
    travel.addEventListener('click', () => void ctx.action('travel'));
    bar.append(words, travel);
    el.append(mapBox, bar);

    const map = controllerMap(mapBox, ctx, {
      data: [
        { name: 'roads', stroke: 'rgba(160, 170, 190, 0.55)', width: 2 },
        { name: 'buildings', fill: 'rgba(160, 170, 190, 0.22)' },
      ],
      mode: 'line',
      points: 2,
      onDraw(line) {
        const [a, b] = (line as Extract<ToolGeometry, { type: 'LineString' }>).coordinates as [Position, Position];
        let path: Position[] = [a, b];
        if (ctx.params.streets && graph) {
          const way = graph.route(space.toTable(...a), space.toTable(...b));
          if (!way) {
            words.textContent = ctx.say('No street joins these two points');
            return;
          }
          path = [a, ...way.map((xy) => lonLatOf(ctx.site, space.width, space.height, xy)), b];
        }
        void ctx.sendTool('route', { type: 'LineString', coordinates: path });
      },
      // The route the table shows, so the controller and the table agree.
      draw(g, m) {
        const shared = ctx.shared as Shared;
        if (!shared.route?.length) return;
        g.lineWidth = 6;
        g.lineCap = g.lineJoin = 'round';
        g.strokeStyle = withAlpha(ROUTE, 0.9);
        g.beginPath();
        shared.route.forEach((p, i) => (i ? g.lineTo(...m.project(p)) : g.moveTo(...m.project(p))));
        g.stroke();
        for (const end of [shared.route[0]!, shared.route.at(-1)!]) {
          g.fillStyle = ROUTE;
          g.beginPath();
          g.arc(...m.project(end), 8, 0, Math.PI * 2);
          g.fill();
        }
      },
    });

    const update = () => {
      const shared = ctx.shared as Shared;
      travel.disabled = !shared.route?.length;
      travel.style.opacity = travel.disabled ? '0.4' : '1';
      if (map.drawing.length === 1) words.textContent = ctx.say('Tap an end');
      else if (shared.metres) {
        const metres = Math.round(shared.metres);
        words.textContent = shared.straight ? ctx.say('{metres} m as the crow flies', { metres }) : ctx.say('{metres} m along the streets', { metres });
      } else words.textContent = ctx.say('Tap a start, then an end');
      map.redraw();
    };
    mapBox.addEventListener('pointerup', () => setTimeout(update));
    update();
    return { update };
  },

  // ---- Table: the route drawn in, and a traveller on request --------------------------
  table(ctx) {
    const canvas = ctx.map.addCanvas('route-planner');
    let route: Position[] = [];
    let drawn = 0;
    let path: ReturnType<typeof track> | null = null;
    let traveller = -1;
    const space = tableSpace(ctx.site);

    ctx.onFrame((dt) => {
      canvas.clear();
      if (route.length < 2 || !path) return;
      const g = canvas.context;
      const m = canvas.pixelsPerMetre;
      drawn = Math.min(1, drawn + dt / 1.2);
      // The route draws itself in, from the start.
      const shown = path.length * (1 - (1 - drawn) ** 3);
      const xy = route.map((p) => canvas.project(p));
      g.lineCap = g.lineJoin = 'round';
      // A soft glow under a bright core, about 8 m and 3 m wide on the table, never thinner than a few pixels.
      for (const [width, alpha] of [
        [8, 0.22],
        [3, 0.95],
      ] as const) {
        g.lineWidth = Math.max(width * 1.5, width * m);
        g.strokeStyle = withAlpha(ROUTE, alpha);
        g.setLineDash([shown * (xy.length > 1 ? pixelLength(xy) / path.length : 1), 1e6]);
        g.beginPath();
        xy.forEach((p, i) => (i ? g.lineTo(...p) : g.moveTo(...p)));
        g.stroke();
      }
      g.setLineDash([]);
      // A traveller: a bright light with a tail, about 60 m a second.
      if (traveller >= 0) {
        traveller += dt * 60;
        g.shadowColor = LIGHT;
        g.shadowBlur = 14;
        for (let k = 0; k < 12; k++) {
          const s = traveller - k * 4;
          if (s < 0 || s > path.length) continue;
          const at = along(path, s);
          const [x, y] = canvas.project(lonLatOf(ctx.site, space.width, space.height, [at.x, at.y]));
          g.fillStyle = withAlpha(LIGHT, 1 - k / 12);
          g.beginPath();
          g.arc(x, y, Math.max(9 - k * 0.6, (6 - k * 0.4) * m), 0, Math.PI * 2);
          g.fill();
        }
        g.shadowBlur = 0;
        if (traveller - 48 > path.length) {
          traveller = -1;
          ctx.cue({ type: 'Point', coordinates: route.at(-1)! }, { colour: LIGHT });
          ctx.publish({ travelling: false });
        }
      }
    });

    const show = (coordinates: Position[]) => {
      route = coordinates;
      const metres = route.map((p) => space.toTable(...p));
      path = track(metres);
      drawn = 0;
      traveller = -1;
      const straight = route.length === 2;
      ctx.publish({ route, metres: path.length, straight, travelling: false });
    };

    return {
      tool(input) {
        if (input.tool === 'route' && input.geometry.type === 'LineString') show(input.geometry.coordinates);
      },
      action(id) {
        if (id !== 'travel' || !path) return;
        traveller = 0;
        ctx.publish({ travelling: true });
      },
    };
  },
});

/** The length of a polyline in pixels. */
function pixelLength(points: [number, number][]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
  return total;
}
