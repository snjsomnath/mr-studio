import { defineLayer, formatHour, zonedTimeToUtc } from '@mrstudio/sdk';
import type { FieldStream, LayerManifest, TableContext } from '@mrstudio/sdk';

import manifest from '../layer.json';
import { skyColormap, sunAt, sunDay, sunHoursColormap } from './look.ts';
import { SunPath } from './sun-path.ts';

interface Params {
  mode: 'instant' | 'day';
  date: string;
  hour: number;
  play: boolean;
  trees: boolean;
  path: boolean;
  opacity: number;
}

/** Hours of the day that pass per second while animating. */
const PLAY_HOURS_PER_SECOND = 1;
/** The step of the `hour` control. Animation advances in whole steps. */
const HOUR_STEP = 0.05;

/** Kernel params for the layer's params. The site's time zone turns wall-clock time into UTC. */
function kernelParams(ctx: TableContext<Params>) {
  const { mode, date, hour, trees } = ctx.params;
  return { mode, time: zonedTimeToUtc(date, mode === 'day' ? 12 : hour, ctx.site.timezone), trees };
}

/** Shadow edges are blurred by this many cells, a soft penumbra. */
const SOFTEN_CELLS = 1.6;
/** Seconds a new result takes to ease in, so stepped times read as continuous motion. */
const GLIDE_SECONDS = 0.14;

export default defineLayer<Params>({
  manifest: manifest as LayerManifest,

  async table(ctx) {
    const sunNow = () => sunAt(ctx.site, ctx.params.date, ctx.params.hour);
    const overlay = ctx.map.addField('sunlight', {
      colormap: skyColormap(sunNow().altitude),
      opacity: ctx.params.opacity,
      soften: SOFTEN_CELLS,
      glide: GLIDE_SECONDS,
    });
    const path = new SunPath(ctx.map.addElement(), ctx.site.extent.rotation_deg);
    let stream: FieldStream | null = null;
    let generation = 0;
    ctx.onCleanup(() => {
      generation++;
      stream?.close();
    });

    // The light's colour and the sun on its path follow the clock at once; the shadows follow from the engine.
    function dress() {
      const day = ctx.params.mode === 'day';
      const sun = sunNow();
      overlay.setStyle({ colormap: day ? sunHoursColormap : skyColormap(sun.altitude), soften: day ? 1 : SOFTEN_CELLS });
      path.setVisible(ctx.params.path);
      path.setSun(day ? { ...sun, altitude: -90 } : sun);
      // The TV's colour key shows the ramp the table is using right now.
      ctx.publish({ ramp: day ? sunHoursColormap : skyColormap(sun.altitude), rampLow: day ? '0 h' : 'Shade' });
    }

    // The timeline on the TV shades the hours between sunrise and sunset.
    function publishDay() {
      const day = sunDay(ctx.site, ctx.params.date);
      path.setDay(day);
      ctx.publish({ sunrise: day.sunrise ?? 0, sunset: day.sunset ?? 0 });
    }

    // One job per mode: a shadow mask for an instant, or sun hours for the day.
    async function open() {
      const mine = ++generation;
      stream?.close();
      stream = null;
      const field = ctx.params.mode === 'day' ? 'sun_hours' : 'shadow';
      // The panel shows progress from the first moment, not the previous job's.
      ctx.publish({ progress: 0 });
      const opened = await ctx.engine.open('sunlight', kernelParams(ctx), [field]);
      if (mine !== generation) {
        // The mode changed again, or the layer was turned off, while this was opening.
        opened.close();
        return;
      }
      stream = opened;
      dress();
      opened.on(field, (frame) => overlay.set(frame));
      opened.onStatus((status) => {
        // The TV panels in layer.json show these. Text is worded here so the panels stay plain data.
        const altitude = Math.round(status.info.sun.altitude_deg * 10) / 10;
        const azimuth = Math.round(status.info.sun.azimuth_deg);
        const daylightHours = Math.round(status.info.daylight_hours * 10) / 10;
        const percent = Math.round(status.progress * 100);
        const day = ctx.params.mode === 'day';
        ctx.publish({
          altitude,
          azimuth,
          daylightHours,
          progress: Math.round(status.progress * 100) / 100,
          sun: altitude > 0 ? `sun ${altitude}° up, bearing ${azimuth}°` : 'sun below the horizon',
          dayStatus: !day ? '' : percent < 100 ? `adding up the day, ${percent}%` : 'whole day added up',
          rampHigh: day ? `${daylightHours} h` : 'Sun',
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
      ctx.setParams({ hour: Math.round(((ctx.params.hour + steps * HOUR_STEP) % 24) / HOUR_STEP) * HOUR_STEP });
    });

    publishDay();
    await open();

    return {
      update(changed) {
        if (changed.includes('opacity')) overlay.setStyle({ opacity: ctx.params.opacity });
        if (changed.includes('date')) publishDay();
        if (changed.includes('mode')) void open();
        else {
          dress();
          if (changed.some((key) => key === 'date' || key === 'hour' || key === 'trees')) stream?.set(kernelParams(ctx));
        }
      },
    };
  },

  // The one custom panel: the day as a curve, the sun's height against the clock, with the sun on it.
  // The clock, the daylight figure, the timeline and the colour key are plain panels in layer.json.
  panel(ctx, el) {
    const W = 320;
    const H = 100;
    const HORIZON = 76;
    const x = (hour: number) => (hour / 24) * W;
    const y = (altitude: number) => HORIZON - (Math.max(-10, altitude) / 90) * 62;
    // Colours are the dashboard's tokens, so a site's theme restyles the curve too. Labels are 12 units of a
    // 320-wide drawing in a panel about 2.1 times that, which keeps them at the dashboard's smallest text size.
    el.innerHTML = `
      <style>
        .sunlight-day { display: block; width: 100%; height: 100%; overflow: visible; color: var(--mrs-text); }
        .sunlight-day text { font-size: 12px; fill: var(--mrs-muted); font-variant-numeric: tabular-nums; }
      </style>
      <svg class="sunlight-day" viewBox="0 0 ${W} ${H}" role="img" aria-label="The sun's height over the day">
        <defs>
          <linearGradient id="sunlight-sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="var(--mrs-accent)" stop-opacity="0.45"/><stop offset="1" stop-color="var(--mrs-accent)" stop-opacity="0.03"/>
          </linearGradient>
          <clipPath id="sunlight-above"><rect x="0" y="0" width="${W}" height="${HORIZON}"/></clipPath>
        </defs>
        <path class="sunlight-fill" fill="url(#sunlight-sky)" clip-path="url(#sunlight-above)"/>
        <path class="sunlight-curve" fill="none" stroke="var(--mrs-accent)" stroke-width="1.5" stroke-linejoin="round"/>
        <line x1="0" x2="${W}" y1="${HORIZON}" y2="${HORIZON}" stroke="var(--mrs-line)"/>
        <text class="sunlight-rise" y="${HORIZON + 16}" text-anchor="middle"></text>
        <text class="sunlight-set" y="${HORIZON + 16}" text-anchor="middle"></text>
        <text class="sunlight-peak" text-anchor="middle"></text>
        <g class="sunlight-marker"><line y1="0" y2="${HORIZON}" stroke="var(--mrs-muted)" stroke-dasharray="2 3"/><circle class="sunlight-glow" r="9" fill="var(--mrs-accent)" fill-opacity="0.3"/><circle class="sunlight-core" r="3.5" fill="var(--mrs-accent)"/></g>
      </svg>`;
    const find = <T extends Element>(selector: string) => el.querySelector<T>(selector)!;
    let drawnDate = '';

    function drawDay() {
      const day = sunDay(ctx.site, ctx.params.date);
      const line = day.samples.map((s, i) => `${i === 0 ? 'M' : 'L'}${x(s.hour).toFixed(1)} ${y(s.altitude).toFixed(1)}`).join('');
      find('.sunlight-curve').setAttribute('d', line);
      find('.sunlight-fill').setAttribute('d', `${line}L${W} ${H}L0 ${H}Z`);
      const label = (selector: string, hour: number | null) => {
        const text = find(selector);
        text.textContent = hour === null ? '' : formatHour(hour);
        if (hour !== null) text.setAttribute('x', Math.min(W - 18, Math.max(18, x(hour))).toFixed(1));
      };
      label('.sunlight-rise', day.sunrise);
      label('.sunlight-set', day.sunset);
      const peak = find('.sunlight-peak');
      peak.textContent = day.peak.altitude > 0 ? `${Math.round(day.peak.altitude)}°` : '';
      peak.setAttribute('x', x(day.peak.hour).toFixed(1));
      peak.setAttribute('y', (y(day.peak.altitude) - 5).toFixed(1));
    }

    function update() {
      if (drawnDate !== ctx.params.date) {
        drawnDate = ctx.params.date;
        drawDay();
      }
      // The marker follows the control at once.
      const now = sunAt(ctx.site, ctx.params.date, ctx.params.hour);
      const marker = find<SVGGElement>('.sunlight-marker');
      marker.style.display = ctx.params.mode === 'day' ? 'none' : '';
      marker.querySelector('line')!.setAttribute('transform', `translate(${x(now.hour).toFixed(1)} 0)`);
      for (const dot of marker.querySelectorAll('circle')) {
        dot.setAttribute('cx', x(now.hour).toFixed(1));
        dot.setAttribute('cy', y(now.altitude).toFixed(1));
        dot.setAttribute('opacity', now.altitude > 0 ? '1' : '0.35');
      }
    }
    update();
    return { update };
  },
});
