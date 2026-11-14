import { colormaps, cssGradient, defineLayer, formatHour, zonedTimeToUtc } from '@mrstudio/sdk';
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
        ctx.publish({
          altitude: Math.round(status.info.sun.altitude_deg * 10) / 10,
          azimuth: Math.round(status.info.sun.azimuth_deg * 10) / 10,
          daylightHours: Math.round(status.info.daylight_hours * 100) / 100,
          progress: Math.round(status.progress * 100) / 100,
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

  panel(ctx, el) {
    el.innerHTML = `
      <style>
        .sunlight-panel { display: grid; gap: 12px; }
        .sunlight-readout { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; font-variant-numeric: tabular-nums; }
        .sunlight-clock { font-size: 2rem; font-weight: 600; }
        .sunlight-sun { opacity: 0.7; text-align: right; }
        .sunlight-ramp { height: 10px; border-radius: 5px; }
        .sunlight-ticks { display: flex; justify-content: space-between; font-size: 0.8rem; opacity: 0.7; margin-top: 4px; }
      </style>
      <div class="sunlight-panel">
        <div class="sunlight-readout"><span class="sunlight-clock"></span><span class="sunlight-sun"></span></div>
        <div><div class="sunlight-ramp"></div><div class="sunlight-ticks"><span></span><span></span></div></div>
      </div>`;
    const clock = el.querySelector<HTMLElement>('.sunlight-clock')!;
    const sun = el.querySelector<HTMLElement>('.sunlight-sun')!;
    const ramp = el.querySelector<HTMLElement>('.sunlight-ramp')!;
    const [low, high] = el.querySelectorAll<HTMLElement>('.sunlight-ticks span');

    function update() {
      const day = ctx.params.mode === 'day';
      const { altitude, azimuth, daylightHours, progress } = ctx.shared;
      clock.textContent = day
        ? new Date(`${ctx.params.date}T12:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'long', timeZone: 'UTC' })
        : formatHour(ctx.params.hour);
      if (day) {
        sun.textContent = progress === undefined || progress >= 1 ? `${daylightHours ?? 0} h of daylight` : `computing ${Math.round(progress * 100)}%`;
      } else if (altitude === undefined) {
        sun.textContent = '';
      } else {
        sun.textContent = altitude > 0 ? `sun ${altitude}° up, bearing ${azimuth}°` : 'sun below the horizon';
      }
      low!.textContent = day ? '0 h' : 'shade';
      high!.textContent = day ? `${daylightHours ?? ''} h` : 'sun';
      ramp.style.background = cssGradient(day ? colormaps.sun : colormaps.daylight);
    }
    update();
    return { update };
  },
});
