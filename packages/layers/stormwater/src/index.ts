import { colormaps, defineLayer } from '@mrstudio/sdk';
import type { FieldFrame, FlowOverlay, LayerManifest, TableContext } from '@mrstudio/sdk';

import manifest from '../layer.json';

// Stormwater (#189): the `stormwater` kernel floods the site live, as a storm
// running `pace` times faster than real time. The table shows the water two ways,
// both 2D and top down: glowing drops riding the running water (the shared flow
// overlay's `droplets`, after the Chalmers demo's glow sprites) and the pools
// that gather, coloured by depth.

interface Params {
  rain: number;
  show: 'both' | 'flow' | 'pools';
  pace: number;
  infiltration: number;
  roofs: boolean;
  trees: boolean;
  detail: string;
  drops: number;
  opacity: number;
}

/** Frames a second from the engine; the drops animate on the table in between. */
const FIELD_HZ = 10;
/** Velocity at the top of the drops' colour ramp, m/s. */
const FAST = 1.2;
/** Water slower than this draws no drops, m/s: it is pooling, and the pools show it. */
const STILL = 0.03;

function kernelParams(ctx: TableContext<Params>, storm?: number) {
  const { rain, infiltration, pace, roofs, trees, detail } = ctx.params;
  const params: Record<string, unknown> = { rain_mm_h: rain, infiltration_mm_h: infiltration, speed: pace, roofs, trees, resolution: Number(detail) };
  if (storm !== undefined) params.storm = storm;
  return params;
}

/** How a status reads on the controller. */
function describe(info: Record<string, number>, rain: number, settled: boolean, ctx: Pick<TableContext, 'say' | 'language'>): Record<string, unknown> {
  const flooded = Math.round(info.flooded_m2 ?? 0);
  const say = ctx.say;
  const number = (value: number) => value.toLocaleString(ctx.language === 'sv' ? 'sv-SE' : 'en-GB');
  return {
    minutes: Math.floor(info.minutes ?? 0),
    status: settled ? (rain > 0 ? say('Steady: as much runs off as falls') : say('Drained')) : rain > 0 ? say('Raining {rain} mm/h', { rain }) : say('Draining'),
    rainMm: Math.round((info.rain_mm ?? 0) * 10) / 10,
    rainCaption: say('{volume} m³ on the site', { volume: number(Math.round(info.rain_m3 ?? 0)) }),
    waterM3: Math.round(info.water_m3 ?? 0),
    waterCaption: flooded > 0 ? say('{area} m² deeper than 10 cm', { area: number(flooded) }) : say('Deepest {depth} cm', { depth: Math.round((info.deepest_m ?? 0) * 100) }),
    deepest: Math.round((info.deepest_m ?? 0) * 100) / 100,
    realtime: Math.round(info.realtime ?? 0),
  };
}

export default defineLayer<Params>({
  manifest: manifest as LayerManifest,

  async table(ctx) {
    const longer = Math.max(ctx.site.extent.width_m, ctx.site.extent.height_m);
    // The drops move at the storm's own pace: real metres per second, times the storm speed, over the table.
    const flowStyle = () => ({
      mode: 'droplets' as const,
      colormap: colormaps.runoff,
      max: FAST,
      count: ctx.params.drops,
      rate: Math.min(0.2, Math.max(0.01, ctx.params.pace / longer)),
      opacity: ctx.params.opacity,
      still: STILL,
    });
    const poolOpacity = () => (ctx.params.show === 'flow' ? 0 : ctx.params.opacity);
    const pools = ctx.map.addField('pools', { colormap: colormaps.water, opacity: poolOpacity(), glide: 0.3 });
    let flow: FlowOverlay | null = null;
    let u: FieldFrame | null = null;
    let v: FieldFrame | null = null;
    const restyle = () => {
      pools.setStyle({ opacity: poolOpacity() });
      if (ctx.params.show === 'pools') {
        flow?.remove();
        flow = null;
      } else if (flow) {
        flow.setStyle(flowStyle());
      } else {
        flow = ctx.map.addFlow('runoff', flowStyle());
        if (u && v) flow.set(u, v);
      }
    };
    restyle();
    ctx.publish({ ramp: colormaps.water, ...describe({}, ctx.params.rain, false, ctx) });

    const stream = await ctx.engine.open('stormwater', kernelParams(ctx), ['depth', 'u', 'v'], { maxHz: FIELD_HZ });
    stream.on('depth', (frame) => pools.set(frame));
    stream.on('u', (frame) => (u = frame));
    stream.on('v', (frame) => {
      v = frame;
      // The components travel as two frames; draw once both belong to the same result.
      if (u && u.revision === frame.revision) flow?.set(u, frame);
    });
    stream.onStatus((status) => ctx.publish(describe(status.info, ctx.params.rain, status.state === 'done', ctx)));

    return {
      update(changed) {
        if (changed.some((key) => key === 'show' || key === 'opacity' || key === 'drops' || key === 'pace')) restyle();
        if (changed.some((key) => key === 'rain' || key === 'pace' || key === 'infiltration' || key === 'roofs' || key === 'trees' || key === 'detail')) {
          stream.set(kernelParams(ctx));
        }
      },
      action(id) {
        // A new storm number dries the site and starts the rain again.
        if (id === 'again') stream.set(kernelParams(ctx, Date.now()));
      },
    };
  },
});
