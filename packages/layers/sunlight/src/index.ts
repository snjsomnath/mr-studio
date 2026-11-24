import { defineLayer, formatHour, zonedTimeToUtc } from '@mrstudio/sdk';
import type { Colormap, FieldFrame, FieldStream, LayerManifest, LightHandle, SunLight, TableContext } from '@mrstudio/sdk';

import manifest from '../layer.json';
import { skyColormap, skyLight, sunAt, sunDay, sunHoursColormap, thresholdColormap, treeHoursColormap, treeShadeColormap } from './look.ts';
import { sunlightHero } from './hero.ts';
import { SunPath } from './sun-path.ts';
import { hasShade, isFlat } from './flat.ts';

interface Params {
  mode: 'instant' | 'day';
  date: string;
  hour: number;
  play: boolean;
  trees: boolean;
  treeColor: boolean;
  threshold: number;
  path: boolean;
  relight: boolean;
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

/** The sun hours ramp, with areas under the layer's threshold flagged when one is set. */
function hoursColormap(threshold: number, daylightHours: number | undefined) {
  return threshold > 0 && daylightHours ? thresholdColormap(threshold / daylightHours) : sunHoursColormap;
}

/** Shadow edges are blurred by this many cells, a soft penumbra. */
const SOFTEN_CELLS = 1.6;
/** Seconds a new result takes to ease in, so stepped times read as continuous motion. */
const GLIDE_SECONDS = 0.14;
/** Softening of the shadow-map mask, in its pixels of about 0.3 m. */
const SHARP_SOFTEN = 1.2;

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
    // Tree shade is drawn over the light in its own colour, on the twin's ground and roofs.
    const treeOverlay = ctx.model.addField('tree-shade', { colormap: treeShadeColormap, opacity: 0, soften: SOFTEN_CELLS, glide: GLIDE_SECONDS });
    // Buildings and the ground cast sharp shadows from a GPU shadow map of their real outlines (#133), drawn in this
    // layer's own field so the table's layer order holds. The engine's shadow field, drawn from its cells, is the
    // fallback when there is no twin, and still gives trees their soft shade.
    let sharp: boolean | undefined;
    // Whether the light field is one colour everywhere, and whether trees shade anything (#55).
    let flat = false;
    let treesShade = false;
    const dark = () => flat && !(ctx.params.trees && treesShade);
    const show = (frame: FieldFrame) => {
      overlay.set(frame);
      const was = dark();
      flat = isFlat(frame);
      if (dark() !== was) dress();
    };
    let maskRequest = 0;
    const sharpWanted = () => ctx.params.mode === 'instant' && !ctx.params.relight;
    async function reshadow() {
      if (!sharpWanted() || sharp === false) return;
      const mine = ++maskRequest;
      const frame = await ctx.model.sunShadowMask(sunNow(), () => void reshadow());
      if (mine !== maskRequest || !sharpWanted()) return;
      const first = sharp === undefined;
      sharp = frame !== null;
      if (frame) show(frame);
      // The first answer changes how the field and tree shade are styled.
      if (first) dress();
    }
    // Without their own colour, trees shade in the same colour as buildings.
    const treeColormap = (): Colormap => {
      if (ctx.params.treeColor || !sharp) return treeShadeColormap;
      const [shade] = skyColormap(sunNow().altitude).stops;
      return { stops: [[0, shade![1], shade![2], shade![3], 0], [1, shade![1], shade![2], shade![3], shade![4]]] };
    };
    const treeOpacity = () => (ctx.params.trees && (ctx.params.treeColor || (sharp && sharpWanted())) ? ctx.params.opacity : 0);
    const path = new SunPath(ctx.map.addElement(), ctx.site.extent.rotation_deg);
    let stream: FieldStream | null = null;
    let generation = 0;
    let daylightHours: number | undefined;

    // Relighting: instead of colouring a shadow mask, a sun and a sky light the twin itself,
    // so walls catch the light and shadows fall on every surface. Tree shade stays a field.
    let sunLight: LightHandle<SunLight> | null = null;
    const relit = () => ctx.params.relight && ctx.params.mode === 'instant';
    function relight() {
      if (!relit()) {
        sunLight?.remove();
        sunLight = null;
        return;
      }
      const sun = sunNow();
      const look = skyLight(sun.altitude);
      const light = { azimuth: sun.azimuth, altitude: sun.altitude, color: look.sun, intensity: look.intensity * ctx.params.opacity, sky: { color: look.sky } };
      if (sunLight) sunLight.set(light);
      else sunLight = ctx.model.addLight({ type: 'sun', ...light });
    }
    let percent = 0;
    // The line under the daylight figure on the TV: progress, then what the map is flagging.
    const dayStatus = () => {
      if (ctx.params.mode !== 'day') return '';
      if (percent < 100) return `adding up the day, ${percent}%`;
      return ctx.params.threshold > 0 ? `under ${ctx.params.threshold} h of sun is flagged` : 'whole day added up';
    };
    ctx.onCleanup(() => {
      generation++;
      stream?.close();
    });

    // The light's colour and the sun on its path follow the clock at once; the shadows follow from the engine.
    function dress() {
      const day = ctx.params.mode === 'day';
      const sun = sunNow();
      relight();
      void reshadow();
      overlay.setStyle({
        colormap: day ? hoursColormap(ctx.params.threshold, daylightHours) : skyColormap(sun.altitude),
        soften: day ? 1 : SOFTEN_CELLS,
        // With nothing to cast shade the whole table would be lit in one colour; stay dark instead (#55).
        opacity: relit() || dark() ? 0 : ctx.params.opacity,
        // A shadow-map mask has fine pixels; soften by a few of them, like a real penumbra.
        ...(sharp && sharpWanted() ? { soften: SHARP_SOFTEN } : {}),
      });
      treeOverlay.setStyle({ colormap: day ? treeHoursColormap : treeColormap(), soften: day ? 1 : SOFTEN_CELLS, opacity: treeOpacity() });
      path.setVisible(ctx.params.path);
      path.setSun(day ? { ...sun, altitude: -90 } : sun);
      // The TV's colour key shows the ramp the table is using right now.
      ctx.publish({
        ramp: day ? hoursColormap(ctx.params.threshold, daylightHours) : skyColormap(sun.altitude),
        dayStatus: dayStatus(),
        rampLow: day ? '0 h' : 'Shade',
        treeRamp: day ? treeHoursColormap : treeShadeColormap,
        treeLow: day ? 'No sun lost' : 'No shade',
        treeHigh: day ? 'Most lost' : 'Full shade',
      });
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
      const [field, treeField] = ctx.params.mode === 'day' ? ['sun_hours', 'tree_shade_hours'] : ['shadow', 'tree_shade'];
      // The panel shows progress from the first moment, not the previous job's.
      percent = 0;
      ctx.publish({ progress: 0 });
      const asked = kernelParams(ctx);
      const opened = await ctx.engine.open('sunlight', asked, [field, treeField]);
      if (mine !== generation) {
        // The mode changed again, or the layer was turned off, while this was opening.
        opened.close();
        return;
      }
      stream = opened;
      // The time or day may have changed while the job was opening, which can take seconds while the
      // engine is still busy with a stopped day's sums (#121). Those changes had no stream to go to.
      const now = kernelParams(ctx);
      if (JSON.stringify(now) !== JSON.stringify(asked)) opened.set(now);
      dress();
      // With a shadow map, the engine's cells only fill in until the first mask is ready.
      opened.on(field, (frame) => {
        if (!(sharp && sharpWanted())) show(frame);
      });
      opened.on(treeField, (frame) => {
        treeOverlay.set(frame);
        const was = dark();
        treesShade = hasShade(frame);
        if (dark() !== was) dress();
      });
      opened.onStatus((status) => {
        if (daylightHours !== status.info.daylight_hours) {
          daylightHours = status.info.daylight_hours;
          dress();
        }
        // The TV panels in layer.json show these. Text is worded here so the panels stay plain data.
        const altitude = Math.round(status.info.sun.altitude_deg * 10) / 10;
        const azimuth = Math.round(status.info.sun.azimuth_deg);
        const hours = Math.round(status.info.daylight_hours * 10) / 10;
        percent = Math.round(status.progress * 100);
        const day = ctx.params.mode === 'day';
        ctx.publish({
          altitude,
          azimuth,
          daylightHours: hours,
          progress: Math.round(status.progress * 100) / 100,
          sun: altitude > 0 ? `sun ${altitude}° up, bearing ${azimuth}°` : 'sun below the horizon',
          dayStatus: dayStatus(),
          rampHigh: day ? `${hours} h` : 'Sun',
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
        if (changed.includes('date')) publishDay();
        if (changed.includes('mode')) void open();
        else {
          dress();
          if (changed.some((key) => key === 'date' || key === 'hour' || key === 'trees')) stream?.set(kernelParams(ctx));
        }
      },
    };
  },

  // The controller's hero: the sky as a timeline, with the time scrubber (#137).
  // The daylight figure, the tree shade and the colour key are plain panels in layer.json.
  hero: (ctx, el) => sunlightHero(ctx as never, el),
});
