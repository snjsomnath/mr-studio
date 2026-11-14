import { colormaps, defineLayer, zonedTimeToUtc } from '@mrstudio/sdk';
import type { FieldStream, LayerManifest, TableContext } from '@mrstudio/sdk';

import manifest from '../layer.json';

interface Params {
  mode: 'instant' | 'day';
  date: string;
  hour: number;
  play: boolean;
  trees: boolean;
  opacity: number;
}

/** Hours of the day that pass per second while animating. */
const PLAY_HOURS_PER_SECOND = 1.5;
/** The step of the `hour` control. Animation advances in whole steps. */
const HOUR_STEP = 0.25;

/** Kernel params for the layer's params. The site's time zone turns wall-clock time into UTC. */
function kernelParams(ctx: TableContext<Params>) {
  const { mode, date, hour, trees } = ctx.params;
  return { mode, time: zonedTimeToUtc(date, mode === 'day' ? 12 : hour, ctx.site.timezone), trees };
}

export default defineLayer<Params>({
  manifest: manifest as LayerManifest,

  async table(ctx) {
    const overlay = ctx.map.addField('sunlight', { colormap: colormaps.daylight, opacity: ctx.params.opacity });
    let stream: FieldStream | null = null;
    let generation = 0;
    ctx.onCleanup(() => {
      generation++;
      stream?.close();
    });

    // One job per mode: a shadow mask for an instant, or sun hours for the day.
    async function open() {
      const mine = ++generation;
      stream?.close();
      stream = null;
      const day = ctx.params.mode === 'day';
      const field = day ? 'sun_hours' : 'shadow';
      const opened = await ctx.engine.open('sunlight', kernelParams(ctx), [field]);
      if (mine !== generation) {
        // The mode changed again, or the layer was turned off, while this was opening.
        opened.close();
        return;
      }
      stream = opened;
      overlay.setStyle({ colormap: day ? colormaps.sun : colormaps.daylight });
      opened.on(field, (frame) => overlay.set(frame));
      opened.onStatus((status) => {
        // The TV panels in layer.json show these. Text is made here so the panels stay plain data.
        const altitude = Math.round(status.info.sun.altitude_deg * 10) / 10;
        const azimuth = Math.round(status.info.sun.azimuth_deg);
        const daylightHours = Math.round(status.info.daylight_hours * 10) / 10;
        const percent = Math.round(status.progress * 100);
        ctx.publish({
          altitude,
          azimuth,
          daylightHours,
          sun: altitude > 0 ? `sun ${altitude}° up, bearing ${azimuth}°` : 'sun below the horizon',
          dayStatus: !day ? '' : percent < 100 ? `adding up the day, ${percent}%` : 'whole day added up',
          dayMax: `${daylightHours} h`,
        });
      });
    }

    let carried = 0;
    ctx.onFrame((dt) => {
      if (!ctx.params.play || ctx.params.mode !== 'instant') return;
      carried += dt * PLAY_HOURS_PER_SECOND;
      const steps = Math.floor(carried / HOUR_STEP);
      if (steps === 0) return;
      carried -= steps * HOUR_STEP;
      ctx.setParams({ hour: (ctx.params.hour + steps * HOUR_STEP) % 24 });
    });

    await open();

    return {
      update(changed) {
        if (changed.includes('opacity')) overlay.setStyle({ opacity: ctx.params.opacity });
        if (changed.includes('mode')) void open();
        else if (changed.some((key) => key === 'date' || key === 'hour' || key === 'trees')) stream?.set(kernelParams(ctx));
      },
    };
  },
});
