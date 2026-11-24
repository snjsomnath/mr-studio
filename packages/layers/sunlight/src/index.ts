import { defineLayer, formatHour, zonedTimeToUtc } from '@mrstudio/sdk';
import type { Colormap, FieldFrame, FieldStream, LayerManifest, LightHandle, SunLight, TableContext } from '@mrstudio/sdk';

import manifest from '../layer.json';
import { skyColormap, skyLight, sunAt, sunDay, sunHoursColormap, thresholdColormap, treeHoursColormap, treeShadeColormap } from './look.ts';
import { sunlightHero } from './hero.ts';
import { SunPath } from './sun-path.ts';
import { hasShade, isFlat } from './flat.ts';
import { spotOnTable } from './spot.ts';
import { SEASONS, seasonsHero, seasonsOnTable } from './seasons.ts';
import { trailsOnTable } from './trails.ts';
import { playPace, sharpSoften } from './pace.ts';

interface Params {
  mode: 'instant' | 'day' | 'seasons';
  date: string;
  hour: number;
  play: boolean;
  trees: boolean;
  treeColor: boolean;
  threshold: number;
  path: boolean;
  relight: boolean;
  opacity: number;
  season: string;
  trails: boolean;
}

/** Hours of the day that pass per second while animating, with the sun well up or well down. */
const PLAY_HOURS_PER_SECOND = 1;
/** The step of the `hour` control: the time the host is told is rounded to it. */
const HOUR_STEP = 0.05;
/**
 * While playing, the table runs its own clock and moves the sun and its shadows every frame (#302). The host, and
 * through it the controller and the TV, hears the time this often. Each time it hears costs a round trip and the
 * engine's tree shade, so the table must never wait for it to move.
 */
const PLAY_SYNC_SECONDS = 0.1;
/** While playing, new shadow masks come every frame or two, so each eases in this fast and the shadows keep up with the sun. */
const PLAY_GLIDE_SECONDS = 0.06;

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

export default defineLayer<Params>({
  manifest: manifest as LayerManifest,

  async table(ctx) {
    // The table's own clock while the day plays, ahead of the host's `hour`; null when it follows the host.
    let clock: number | null = null;
    // The hours this table sent while playing, so their echoes from the host are told apart from someone scrubbing.
    const sent: number[] = [];
    let sinceSync = 0;
    const hourNow = () => clock ?? ctx.params.hour;
    const playing = () => ctx.params.play && ctx.params.mode === 'instant';
    const sunNow = () => sunAt(ctx.site, ctx.params.date, hourNow());
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
    // After sunset the mask is shade everywhere: that is night falling, not a table without shade, so the light
    // field stays and its colours fade into the night instead of the map popping back (#302).
    const dark = () => flat && sunNow().altitude > 0 && !(ctx.params.trees && treesShade);
    const show = (frame: FieldFrame) => {
      overlay.set(frame);
      const was = dark();
      flat = sunNow().altitude > 0 ? isFlat(frame) : true;
      if (dark() !== was) dress();
    };
    let maskRequest = 0;
    // One mask is drawn at a time; a sun that moved meanwhile is drawn as soon as it is back, for the newest time.
    let masking = false;
    let maskAgain = false;
    // While playing, the next mask waits as long as the last one took, so a slow graphics card spends at most
    // about half its time on shadows and the frame rate holds; a fast one still gets a new mask every frame or two.
    let maskFreeAt = 0;
    const sharpWanted = () => ctx.params.mode === 'instant' && !ctx.params.relight;
    async function reshadow() {
      if (!sharpWanted() || sharp === false) return;
      if (masking) {
        maskAgain = true;
        return;
      }
      masking = true;
      maskAgain = false;
      const mine = ++maskRequest;
      let frame: FieldFrame | null;
      const started = performance.now();
      try {
        frame = await ctx.model.sunShadowMask(sunNow(), () => void reshadow());
      } finally {
        masking = false;
        const now = performance.now();
        maskFreeAt = now + (now - started);
      }
      if (mine === maskRequest && sharpWanted()) {
        const first = sharp === undefined;
        sharp = frame !== null;
        if (frame) show(frame);
        // The first answer changes how the field and tree shade are styled.
        if (first) dress();
      }
      if (maskAgain && !playing()) void reshadow();
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
      if (percent < 100) return ctx.say('adding up the day, {percent}%', { percent });
      return ctx.params.threshold > 0 ? ctx.say('under {hours} h of sun is flagged', { hours: ctx.params.threshold }) : ctx.say('whole day added up');
    };
    ctx.onCleanup(() => {
      generation++;
      stream?.close();
    });

    // The light's colour and the sun on its path follow the clock at once; the shadows follow from the engine.
    function dress() {
      const day = ctx.params.mode === 'day';
      const sun = sunNow();
      if (ctx.params.mode === 'seasons') {
        // The seasons draw their own field on a common scale (seasons.ts); only the look is set here.
        relight();
        overlay.setStyle({ soften: 1, opacity: ctx.params.opacity });
        treeOverlay.setStyle({ opacity: 0 });
        path.setVisible(ctx.params.path);
        path.setSun({ ...sun, altitude: -90 });
        ctx.publish({ dayStatus: '', treeLow: '', treeHigh: '' });
        return;
      }
      relight();
      // While playing, each frame asks for the shadows itself (animate).
      if (!playing()) void reshadow();
      overlay.setStyle({
        colormap: day ? hoursColormap(ctx.params.threshold, daylightHours) : skyColormap(sun.altitude),
        soften: day ? 1 : SOFTEN_CELLS,
        // With nothing to cast shade the whole table would be lit in one colour; stay dark instead (#55).
        opacity: relit() || dark() ? 0 : ctx.params.opacity,
        // A shadow-map mask has fine pixels; soften by a few of them, like a real penumbra.
        ...(sharp && sharpWanted() ? { soften: sharpSoften(sun.altitude) } : {}),
        glide: playing() ? PLAY_GLIDE_SECONDS : GLIDE_SECONDS,
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

    // Each frame of a play: the sun on its path, the light's colour and the shadows follow the table's clock.
    // The rest of dress() (the TV's key, tree shade) follows the host's time, a few times a second.
    function animate() {
      const sun = sunNow();
      relight();
      if (performance.now() >= maskFreeAt) void reshadow();
      if (!relit()) overlay.setStyle({ colormap: skyColormap(sun.altitude), ...(sharp ? { soften: sharpSoften(sun.altitude) } : {}) });
      if (ctx.params.trees && !ctx.params.treeColor && sharp) treeOverlay.setStyle({ colormap: treeColormap() });
      path.setSun(sun);
    }

    // The timeline on the TV shades the hours between sunrise and sunset.
    function publishDay() {
      if (ctx.params.mode === 'seasons') return;
      const day = sunDay(ctx.site, ctx.params.date);
      path.setDay(day);
      ctx.publish({ sunrise: day.sunrise ?? 0, sunset: day.sunset ?? 0 });
    }

    let seasonSteps = false;
    // One job per mode: a shadow mask for an instant, or sun hours for the day.
    async function open() {
      const mine = ++generation;
      stream?.close();
      stream = null;
      // Seasons run three day sums of their own; Next steps through them.
      if (ctx.params.mode === 'seasons') {
        seasonSteps = true;
        ctx.steps.define(SEASONS.length, SEASONS.map((s) => ctx.say(s.name)));
        dress();
        await seasons.open();
        return;
      }
      if (seasonSteps) {
        seasons.close();
        ctx.steps.define(0);
        publishDay();
      }
      seasonSteps = false;
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

    const seasons = seasonsOnTable(ctx, overlay, (top) => hoursColormap(ctx.params.threshold, top), (day) => path.setDay(day));
    ctx.onCleanup(() => seasons.close());

    /** Tells the host the table's time, rounded to the control's step, and remembers it to know its echo. */
    function sync(hour: number) {
      const rounded = Math.round((hour % 24) / HOUR_STEP) * HOUR_STEP;
      sent.push(rounded);
      if (sent.length > 32) sent.shift();
      ctx.setParams({ hour: rounded });
    }
    const wasSent = (hour: number) => sent.some((h) => Math.abs(h - hour) < 1e-6);

    ctx.onFrame((dt) => {
      if (ctx.params.mode === 'seasons') seasons.tick(dt);
      if (!playing()) return;
      // The clock moves by the frame's own time, so the sun moves the same distance on screen for the same time.
      clock = (hourNow() + dt * PLAY_HOURS_PER_SECOND * playPace(sunNow().altitude)) % 24;
      sinceSync += dt;
      if (sinceSync >= PLAY_SYNC_SECONDS) {
        sinceSync = 0;
        sync(clock);
      }
      animate();
    });

    const spot = spotOnTable(ctx);
    const trails = trailsOnTable(ctx, spot.at);

    publishDay();
    await open();

    return {
      tool: (input) => spot.tool(input),
      // Next and Previous pin a season; the overview lets them take turns.
      step(revealed) {
        if (ctx.params.mode !== 'seasons') return;
        const season = revealed > 0 ? SEASONS[revealed - 1]!.key : 'cycle';
        if (season !== ctx.params.season) ctx.setParams({ season });
      },
      action(id) {
        if (id === 'clearSpot') spot.clear();
      },
      update(changed) {
        if (clock !== null) {
          if (changed.includes('hour') && !wasSent(ctx.params.hour)) {
            // Someone moved the time while it played, or after: the table follows them.
            clock = null;
          } else if (!playing()) {
            // Stopped: the host is told where the table's clock got to, and the table holds there until it hears back.
            if (Math.abs(ctx.params.hour - Math.round(clock / HOUR_STEP) * HOUR_STEP) < 1e-6) clock = null;
            else if (changed.includes('play') || changed.includes('mode')) sync(clock);
          }
          if (clock === null) sent.length = 0;
        }
        spot.update(changed);
        trails.update(changed);
        if (changed.includes('date')) publishDay();
        if (changed.includes('mode')) void open();
        else if (ctx.params.mode === 'seasons') {
          dress();
          seasons.update(changed);
        } else {
          dress();
          if (changed.some((key) => key === 'date' || key === 'hour' || key === 'trees')) stream?.set(kernelParams(ctx));
        }
      },
    };
  },

  // The controller's hero: the sky as a timeline, with the time scrubber (#137).
  // The daylight figure, the tree shade and the colour key are plain panels in layer.json.
  // In Seasons, the three seasons side by side take its place (#256).
  hero: (ctx, el) => {
    const sky = sunlightHero(ctx as never, el);
    const seasons = seasonsHero(ctx as never, el);
    return {
      update() {
        sky.update?.();
        seasons.update?.();
      },
    };
  },
});
