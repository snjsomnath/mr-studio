import { cssGradient, defineLayer, formatHour, zonedTimeToUtc } from '@mrstudio/sdk';
import type { FieldStream, LayerManifest, TableContext } from '@mrstudio/sdk';

import manifest from '../layer.json';
import { TREE_SHADE_CSS, skyColormap, sunAt, sunDay, sunHoursColormap, treeHoursColormap, treeShadeColormap } from './look.ts';
import { SunPath } from './sun-path.ts';

interface Params {
  mode: 'instant' | 'day';
  date: string;
  hour: number;
  play: boolean;
  trees: boolean;
  treeColor: boolean;
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
    // Tree shade is drawn over the light in its own colour.
    const treeOverlay = ctx.map.addField('tree-shade', { colormap: treeShadeColormap, opacity: 0, soften: SOFTEN_CELLS, glide: GLIDE_SECONDS });
    const treeOpacity = () => (ctx.params.trees && ctx.params.treeColor ? ctx.params.opacity : 0);
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
      treeOverlay.setStyle({ colormap: day ? treeHoursColormap : treeShadeColormap, soften: day ? 1 : SOFTEN_CELLS, opacity: treeOpacity() });
      path.setVisible(ctx.params.path);
      path.setSun(day ? { ...sun, altitude: -90 } : sun);
    }

    // One job per mode: a shadow mask for an instant, or sun hours for the day.
    async function open() {
      const mine = ++generation;
      stream?.close();
      stream = null;
      const [field, treeField] = ctx.params.mode === 'day' ? ['sun_hours', 'tree_shade_hours'] : ['shadow', 'tree_shade'];
      // The panel shows progress from the first moment, not the previous job's.
      ctx.publish({ progress: 0 });
      const opened = await ctx.engine.open('sunlight', kernelParams(ctx), [field, treeField]);
      if (mine !== generation) {
        // The mode changed again, or the layer was turned off, while this was opening.
        opened.close();
        return;
      }
      stream = opened;
      dress();
      opened.on(field, (frame) => overlay.set(frame));
      opened.on(treeField, (frame) => treeOverlay.set(frame));
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
      ctx.setParams({ hour: Math.round(((ctx.params.hour + steps * HOUR_STEP) % 24) / HOUR_STEP) * HOUR_STEP });
    });

    path.setDay(sunDay(ctx.site, ctx.params.date));
    await open();

    return {
      update(changed) {
        if (changed.includes('opacity')) overlay.setStyle({ opacity: ctx.params.opacity });
        if (changed.includes('date')) path.setDay(sunDay(ctx.site, ctx.params.date));
        if (changed.includes('mode')) void open();
        else {
          dress();
          if (changed.some((key) => key === 'date' || key === 'hour' || key === 'trees')) stream?.set(kernelParams(ctx));
        }
      },
    };
  },

  panel(ctx, el) {
    // The day as a curve: the sun's height against the clock, with the sun on it.
    const W = 320;
    const H = 104;
    const HORIZON = 78;
    const x = (hour: number) => (hour / 24) * W;
    const y = (altitude: number) => HORIZON - (Math.max(-10, altitude) / 90) * 84;
    el.innerHTML = `
      <style>
        .sunlight-panel { display: grid; gap: 10px; }
        .sunlight-readout { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; font-variant-numeric: tabular-nums; }
        .sunlight-clock { font-size: 2rem; font-weight: 600; letter-spacing: -0.01em; }
        .sunlight-sun { opacity: 0.7; text-align: right; }
        .sunlight-day { display: block; width: 100%; height: auto; overflow: visible; }
        .sunlight-day text { font-size: 9px; fill: currentColor; opacity: 0.6; font-variant-numeric: tabular-nums; }
        .sunlight-ramp { height: 10px; border-radius: 5px; box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.08); }
        .sunlight-key { display: flex; align-items: center; gap: 8px; font-size: 0.8rem; opacity: 0.8; margin-top: 8px; }
        .sunlight-key i { width: 22px; height: 10px; border-radius: 5px; background: ${TREE_SHADE_CSS}; }
        .sunlight-ticks { display: flex; justify-content: space-between; font-size: 0.8rem; opacity: 0.7; margin-top: 4px; font-variant-numeric: tabular-nums; }
      </style>
      <div class="sunlight-panel">
        <div class="sunlight-readout"><span class="sunlight-clock"></span><span class="sunlight-sun"></span></div>
        <svg class="sunlight-day" viewBox="0 0 ${W} ${H}" role="img" aria-label="The sun's height over the day">
          <defs>
            <linearGradient id="sunlight-sky" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="#ffd27a" stop-opacity="0.55"/><stop offset="1" stop-color="#ff8a3c" stop-opacity="0.04"/>
            </linearGradient>
            <radialGradient id="sunlight-dot"><stop offset="0" stop-color="#fff7d6"/><stop offset="0.3" stop-color="#ffd27a" stop-opacity="0.6"/><stop offset="1" stop-color="#ff9a3c" stop-opacity="0"/></radialGradient>
            <clipPath id="sunlight-above"><rect x="0" y="0" width="${W}" height="${HORIZON}"/></clipPath>
          </defs>
          <path class="sunlight-fill" fill="url(#sunlight-sky)" clip-path="url(#sunlight-above)"/>
          <path class="sunlight-curve" fill="none" stroke="#ffd27a" stroke-width="1.5" stroke-linejoin="round"/>
          <line x1="0" x2="${W}" y1="${HORIZON}" y2="${HORIZON}" stroke="currentColor" stroke-opacity="0.25"/>
          <text class="sunlight-rise" y="${HORIZON + 14}" text-anchor="middle"></text>
          <text class="sunlight-set" y="${HORIZON + 14}" text-anchor="middle"></text>
          <text class="sunlight-peak" text-anchor="middle"></text>
          <g class="sunlight-marker"><line y1="0" y2="${HORIZON}" stroke="#fff7d6" stroke-opacity="0.25" stroke-dasharray="2 3"/><circle class="sunlight-glow" r="12" fill="url(#sunlight-dot)"/><circle class="sunlight-core" r="3" fill="#fffbe8"/></g>
        </svg>
        <div><div class="sunlight-ramp"></div><div class="sunlight-ticks"><span></span><span></span><span></span></div><div class="sunlight-key"><i></i><span></span></div></div>
      </div>`;
    const find = <T extends Element>(selector: string) => el.querySelector<T>(selector)!;
    const clock = find<HTMLElement>('.sunlight-clock');
    const sun = find<HTMLElement>('.sunlight-sun');
    const ramp = find<HTMLElement>('.sunlight-ramp');
    const [low, middle, high] = el.querySelectorAll<HTMLElement>('.sunlight-ticks span');
    let drawnDate = '';

    function drawDay() {
      const day = sunDay(ctx.site, ctx.params.date);
      const line = day.samples.map((s, i) => `${i === 0 ? 'M' : 'L'}${x(s.hour).toFixed(1)} ${y(s.altitude).toFixed(1)}`).join('');
      find('.sunlight-curve').setAttribute('d', line);
      find('.sunlight-fill').setAttribute('d', `${line}L${W} ${H}L0 ${H}Z`);
      const label = (selector: string, hour: number | null) => {
        const text = find(selector);
        text.textContent = hour === null ? '' : formatHour(hour);
        if (hour !== null) text.setAttribute('x', x(hour).toFixed(1));
      };
      label('.sunlight-rise', day.sunrise);
      label('.sunlight-set', day.sunset);
      const peak = find('.sunlight-peak');
      peak.textContent = day.peak.altitude > 0 ? `${Math.round(day.peak.altitude)}°` : '';
      peak.setAttribute('x', x(day.peak.hour).toFixed(1));
      peak.setAttribute('y', (y(day.peak.altitude) - 7).toFixed(1));
    }

    function update() {
      const day = ctx.params.mode === 'day';
      const { altitude, azimuth, daylightHours, progress } = ctx.shared;
      if (drawnDate !== ctx.params.date) {
        drawnDate = ctx.params.date;
        drawDay();
      }
      // The marker follows the control at once; the readout reports what the engine computed.
      const now = sunAt(ctx.site, ctx.params.date, ctx.params.hour);
      const marker = find<SVGGElement>('.sunlight-marker');
      marker.style.display = day ? 'none' : '';
      marker.querySelector('line')!.setAttribute('transform', `translate(${x(now.hour).toFixed(1)} 0)`);
      for (const dot of marker.querySelectorAll('circle')) {
        dot.setAttribute('cx', x(now.hour).toFixed(1));
        dot.setAttribute('cy', y(now.altitude).toFixed(1));
        dot.setAttribute('opacity', now.altitude > 0 ? '1' : '0.35');
      }
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
      const key = find<HTMLElement>('.sunlight-key');
      key.style.display = ctx.params.trees && ctx.params.treeColor ? '' : 'none';
      key.querySelector('span')!.textContent = day ? 'sun lost to trees' : 'shade from trees';
      low!.textContent = day ? '0 h' : 'shade';
      middle!.textContent = day && daylightHours ? `${Math.round(daylightHours / 2)} h` : '';
      high!.textContent = day ? `${daylightHours ?? ''} h` : 'sun';
      ramp.style.background = cssGradient(day ? sunHoursColormap : skyColormap(now.altitude));
    }
    update();
    return { update };
  },
});
