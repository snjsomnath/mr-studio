// How much sun does this spot get? (#252) A tap on the table, a click in the editor's map or a
// phone's point picks a spot; the engine marches the sun's rays from that one cell every five
// minutes across the day, and the controller's hero shows the spot's day as a strip of sun and
// shade. The table only marks the spot: a ring that glows while the spot is in the sun.
import { zonedTimeToUtc } from '@mrstudio/sdk';
import type { CanvasOverlay, PointerSample, TableContext, ToolInput } from '@mrstudio/sdk';

/** What the engine's sunlight probe returns (crates/mrs-engine/src/kernels/sunlight). */
interface Probe {
  day_start: number;
  step_minutes: number;
  light: number[];
  tree: number[];
  altitude: number[];
  sun_hours: number;
  tree_hours: number;
  daylight_hours: number;
  first_sun: number | null;
  last_sun: number | null;
  roof: boolean;
}

/** What the hero draws, published as `shared.spot`. Hours are the site's wall clock. */
export interface SpotDay {
  /** The site's hour of the first sample's middle, and hours between samples. */
  start: number;
  step: number;
  /** Per sample: 1 lit, 0 dark; between for light through a tree. */
  light: number[];
  /** Per sample: the share trees took. */
  tree: number[];
  /** Per sample: whether the sun is up. */
  up: boolean[];
  sunHours: number;
  treeHours: number;
  daylightHours: number;
  firstSun: number | null;
  lastSun: number | null;
  roof: boolean;
}

type Params = { mode: string; date: string; hour: number; trees: boolean };

/** Ring radius on the table, in metres, so the mark keeps its size on any table. */
const RING_M = 12;
const MIN_RING_PX = 14;

const round = (value: number) => Math.round(value * 100) / 100;

export function spotOnTable(ctx: TableContext<Params>) {
  const canvas: CanvasOverlay = ctx.map.addCanvas('sunlight-spot');
  let at: [number, number] | null = null;
  let day: SpotDay | null = null;
  let asked = 0;
  let drawn = '';

  /** The site's wall-clock hour of a Unix time on the chosen date. */
  const hourOf = (unix: number) => (unix * 1000 - Date.parse(zonedTimeToUtc(ctx.params.date, 0, ctx.site.timezone))) / 3_600_000;

  async function probe() {
    const mine = ++asked;
    if (!at) {
      day = null;
      ctx.publish({ spot: null });
      return;
    }
    try {
      const time = zonedTimeToUtc(ctx.params.date, 12, ctx.site.timezone);
      const answer = await ctx.engine.probe<Probe>('sunlight', { time, trees: ctx.params.trees }, at);
      if (mine !== asked) return;
      const step = answer.step_minutes / 60;
      day = {
        start: hourOf(answer.day_start) + step / 2,
        step,
        light: answer.light.map(round),
        tree: answer.tree.map(round),
        up: answer.altitude.map((a) => a > 0.5),
        sunHours: round(answer.sun_hours),
        treeHours: round(answer.tree_hours),
        daylightHours: round(answer.daylight_hours),
        firstSun: answer.first_sun === null ? null : round(hourOf(answer.first_sun)),
        lastSun: answer.last_sun === null ? null : round(hourOf(answer.last_sun)),
        roof: answer.roof,
      };
      ctx.publish({ spot: day });
    } catch (error) {
      if (mine !== asked) return;
      console.warn('[sunlight] the spot was not probed', error);
      at = null;
      day = null;
      ctx.publish({ spot: null });
    }
  }

  /** The light at the spot at the controller's time, or at the day's best in day mode. */
  function lightNow(): number {
    if (!day) return 0;
    if (ctx.params.mode === 'day') return day.sunHours > 0 ? 1 : 0;
    const k = Math.round((ctx.params.hour - day.start) / day.step);
    return day.light[Math.min(day.light.length - 1, Math.max(0, k))] ?? 0;
  }

  let pulse = 0;
  function draw(dt: number) {
    pulse = (pulse + dt / 2.4) % 1;
    const key = at ? `${canvas.revision}|${at.join()}|${lightNow()}|${Math.round(pulse * 40)}` : '';
    if (key === drawn) return;
    drawn = key;
    canvas.clear();
    if (!at) return;
    const g = canvas.context;
    const [x, y] = canvas.project(at);
    const r = Math.max(MIN_RING_PX, RING_M * canvas.pixelsPerMetre);
    const lit = lightNow();
    // A dark halo keeps the ring readable on lit ground; the ring itself is warm in the sun, cool in shade.
    g.lineWidth = r * 0.5;
    g.strokeStyle = 'rgb(8 12 24 / 0.45)';
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.stroke();
    g.lineWidth = r * 0.24;
    g.strokeStyle = lit >= 0.5 ? '#ffd45e' : lit > 0 ? '#9fdc8a' : '#8fb4ff';
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.stroke();
    // A ripple that moves out from the spot, so it is found at a glance.
    g.globalAlpha = (1 - pulse) * 0.7;
    g.lineWidth = r * 0.12;
    g.beginPath();
    g.arc(x, y, r * (1 + pulse * 1.6), 0, Math.PI * 2);
    g.stroke();
    g.globalAlpha = 1;
    g.fillStyle = '#fff';
    g.beginPath();
    g.arc(x, y, Math.max(2, r * 0.18), 0, Math.PI * 2);
    g.fill();
  }
  ctx.onFrame(draw);

  // A click or tap on the table picks the spot, through the host so every view of the table agrees.
  ctx.pointer.on((sample: PointerSample) => {
    if (sample.phase !== 'down' || sample.source === 'phone') return;
    const coordinates = sample.lonLat.map((v) => Math.round(v * 1e7) / 1e7) as [number, number];
    ctx.sendTool('spot', { type: 'Point', coordinates }).catch((error) => console.warn('[sunlight] the spot was not sent', error));
  });

  ctx.publish({ spot: null });

  return {
    /** The spot, if one is picked. */
    at: () => at,
    tool(input: ToolInput) {
      const geometry = input.geometry as { type?: string; coordinates?: number[] };
      if (input.tool !== 'spot' || geometry.type !== 'Point' || !geometry.coordinates) return;
      at = [geometry.coordinates[0]!, geometry.coordinates[1]!];
      void probe();
    },
    clear() {
      at = null;
      void probe();
    },
    /** The day or the trees changed: the spot's day is asked again. */
    update(changed: string[]) {
      if (at && changed.some((key) => key === 'date' || key === 'trees')) void probe();
    },
  };
}
