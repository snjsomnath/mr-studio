import { SPRITE_FLOATS, drainSteps, inSlices, readSiteGeometry, defineLayer, seededRandom, tableSpace } from '@mrstudio/sdk';
import type { LayerManifest } from '@mrstudio/sdk';

import manifest from '../layer.json';

interface Params {
  lit: number;
  color: string;
  pace: number;
  opacity: number;
}

interface Light {
  /** The window: a short dash along a facade, from (x0, y0) to (x1, y1) in table metres. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Which building it is on, for the building's own tint and its brief blackouts. */
  building: number;
  /** Lit when `lit` is above this, so raising the control lights more windows rather than different ones. */
  threshold: number;
  /** Current and target brightness, 0..1. */
  level: number;
  target: number;
  /** Seconds until this window next changes its mind. */
  wait: number;
}

interface Building {
  rings: [number, number][][];
  /** About one building in five is lit white; the rest are warm. */
  white: boolean;
  /** How bright its windows are, so the city is not one even glow. */
  brightness: number;
  /** Seconds left in a blackout, when the whole building goes dark for a moment. */
  dark: number;
  /** Its outline, made once (#483). */
  outline: Path2D | null;
}

/** Window and glow brightness is drawn in this many steps, so each frame is a few strokes, not one per window (#483). */
const LEVELS = 16;
/** Buildings looked at before setup lets the page breathe, on a site with tens of thousands. */
const SETUP_PAUSE = 2000;
/** Buildings whose glow is laid down in one frame. */
const GLOW_CHUNK = 4000;
const breathe = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Windows along the facades, as in the interactive map: lit dashes on the footprint outline, seen from above. */
const WINDOW_M = 3;
const GAP_M = 4.5;
/** The most windows worth drawing; a very built-up site spaces them further apart. */
const MAX_LIGHTS = 20_000;
const FRAME_S = 1 / 15;
/** The facade line, and the soft glow under it, in metres. */
const LINE_M = 1.4;
const GLOW_M = 5;
const WHITE = '#ffffff';
/** Pixels per metre of the window dash picture, and the clear margin around it. */
const DASH_PX = 16;
const DASH_PAD_M = 0.25;

/** A lit window seen from above: a short round-ended dash, in the control's colour and in white. */
function dashes(color: string): HTMLCanvasElement[] {
  return [color, WHITE].map((paint) => {
    const image = document.createElement('canvas');
    image.width = Math.ceil((WINDOW_M + LINE_M + DASH_PAD_M * 2) * DASH_PX);
    image.height = Math.ceil((LINE_M + DASH_PAD_M * 2) * DASH_PX);
    const g = image.getContext('2d')!;
    g.setTransform(DASH_PX, 0, 0, DASH_PX, image.width / 2, image.height / 2);
    g.strokeStyle = paint;
    g.lineWidth = LINE_M;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(-WINDOW_M / 2, 0);
    g.lineTo(WINDOW_M / 2, 0);
    g.stroke();
    return image;
  });
}

export default defineLayer<Params>({
  manifest: manifest as LayerManifest,

  async table(ctx) {
    // The soft glow under the facades changes only with the controls, so it is a picture of its own,
    // drawn once, and only the windows are drawn again (#596).
    const glowCanvas = ctx.map.addDrawing('glow', { opacity: ctx.params.opacity });
    // The windows are a dash picture the graphics card stamps for every lit window (#609).
    const windows = ctx.map.addSprites('windows', dashes(ctx.params.color), { opacity: ctx.params.opacity, blend: 'add' });
    const space = tableSpace(ctx.site);
    const random = seededRandom(23);
    const footprints = (await readSiteGeometry(ctx.site, 'buildings'))?.polygons ?? [];

    const buildings: Building[] = [];
    let seen = 0;
    for (const { geometry: rings } of footprints) {
      if (++seen % SETUP_PAUSE === 0) await breathe();
      const outer = rings[0] ?? [];
      const xs = outer.map((p) => p[0]);
      const ys = outer.map((p) => p[1]);
      if (Math.max(...xs) < 0 || Math.max(...ys) < 0 || Math.min(...xs) > space.width || Math.min(...ys) > space.height) continue;
      const index = buildings.length;
      buildings.push({ rings, white: (index * 7) % 5 === 0, brightness: 0.55 + (((index * 7) % 13) / 13) * 0.45, dark: 0, outline: null });
    }

    // Windows walk each facade, courtyards included, from a random start so rows do not line up.
    const lights: Light[] = [];
    for (let scale = 1; ; scale *= 1.4) {
      lights.length = 0;
      const step = (WINDOW_M + GAP_M) * scale;
      for (let b = 0; b < buildings.length; b++) {
        if (b > 0 && b % SETUP_PAUSE === 0) await breathe();
        const building = buildings[b]!;
        for (const ring of building.rings) {
          let carry = random() * step;
          for (let i = 0; i + 1 < ring.length; i++) {
            const [ax, ay] = ring[i]!;
            const [bx, by] = ring[i + 1]!;
            const length = Math.hypot(bx - ax, by - ay);
            if (length === 0) continue;
            const [ux, uy] = [(bx - ax) / length, (by - ay) / length];
            for (let d = carry; d + WINDOW_M <= length; d += step) {
              lights.push({ x0: ax + ux * d, y0: ay + uy * d, x1: ax + ux * (d + WINDOW_M), y1: ay + uy * (d + WINDOW_M), building: b, threshold: random(), level: 0, target: 0, wait: random() * 4 });
            }
            // The next edge carries on the rhythm where this one left it.
            carry = Math.max(0, carry + Math.ceil(Math.max(0, length - carry) / step) * step - length);
          }
        }
      }
      if (lights.length <= MAX_LIGHTS) break;
    }

    let since = Infinity;
    ctx.onFrame((dt) => {
      since += dt;
      if (since < FRAME_S) return;
      const step = Math.min(since, 0.25);
      since = 0;
      const { lit, pace } = ctx.params;
      // Now and then a whole building goes dark for a moment, as in the interactive map.
      for (const building of buildings) {
        if (building.dark > 0) building.dark -= step * pace;
        else if (random() < 0.004 * pace) building.dark = 0.3 + random() * 1.4;
      }
      // The windows come on and go off.
      for (const light of lights) {
        light.wait -= step * pace;
        if (light.wait <= 0) {
          // Most windows follow the control; a few are switched the other way for a while, which is the twinkle.
          const on = light.threshold < lit;
          light.target = random() < 0.12 ? (on ? 0.15 : lit > 0 ? 0.7 : 0) : on ? 0.55 + random() * 0.45 : 0;
          light.wait = 2 + random() * 14;
        }
        light.level += (light.target - light.level) * Math.min(1, step * 2.5);
      }
      showGlow();
      placeWindows();
    });

    let buffer = new Float32Array(0);
    /** Hands every lit window to the graphics card: a dash along its facade, as bright as it is lit. */
    function placeWindows() {
      if (buffer.length < lights.length * SPRITE_FLOATS) buffer = new Float32Array(lights.length * SPRITE_FLOATS);
      let n = 0;
      for (const light of lights) {
        const building = buildings[light.building]!;
        if (light.level < 0.02 || building.dark > 0) continue;
        const o = n++ * SPRITE_FLOATS;
        buffer[o] = (light.x0 + light.x1) / 2;
        buffer[o + 1] = (light.y0 + light.y1) / 2;
        buffer[o + 2] = WINDOW_M + LINE_M + DASH_PAD_M * 2;
        buffer[o + 3] = LINE_M + DASH_PAD_M * 2;
        buffer[o + 4] = Math.atan2(light.y1 - light.y0, light.x1 - light.x0);
        buffer[o + 5] = building.white ? 1 : 0;
        buffer[o + 6] = Math.min(1, light.level * building.brightness);
      }
      windows.set(buffer, n);
    }

    const outline = (building: Building): Path2D => {
      if (building.outline) return building.outline;
      const path = new Path2D();
      for (const ring of building.rings) {
        ring.forEach(([x, y], i) => (i === 0 ? path.moveTo(x, y) : path.lineTo(x, y)));
        path.closePath();
      }
      return (building.outline = path);
    };
    /** One path per colour and brightness step: index `white * LEVELS + level`. */
    const buckets = () => Array.from({ length: LEVELS * 2 }, () => null as Path2D | null);
    const level = (alpha: number) => Math.min(LEVELS - 1, Math.round(alpha * (LEVELS - 1)));
    const stroke = (g: CanvasRenderingContext2D, paths: (Path2D | null)[], alpha: (step: number) => number) => {
      paths.forEach((path, i) => {
        if (!path) return;
        g.strokeStyle = i >= LEVELS ? WHITE : ctx.params.color;
        g.globalAlpha = alpha(i % LEVELS);
        g.stroke(path);
      });
    };

    /** Every lit building's soft outline glow, for a level and colour: the same picture every frame, so it is drawn once (#483). */
    function* glowSteps(g: CanvasRenderingContext2D, skipDark: boolean): Generator<void, void> {
      // In chunks, so a city's glow is laid down over a few frames rather than in one long pause.
      for (let from = 0; from < buildings.length; from += GLOW_CHUNK) {
        const glows = buckets();
        for (const building of buildings.slice(from, from + GLOW_CHUNK)) {
          if (skipDark && building.dark > 0) continue;
          const i = (building.white ? LEVELS : 0) + level(building.brightness);
          (glows[i] ??= new Path2D()).addPath(outline(building));
        }
        g.lineWidth = GLOW_M;
        stroke(g, glows, (step) => 0.12 * (step / (LEVELS - 1)) * Math.min(1, ctx.params.lit * 2));
        yield;
      }
    }
    let glowKey = '';
    let stopGlow = () => {};
    ctx.onCleanup(() => stopGlow());
    /** Draws the glow again when the controls that shape it change: a chunk a frame, shown when done. */
    function showGlow() {
      const key = `${ctx.params.lit}|${ctx.params.color}`;
      if (key === glowKey) return;
      glowKey = key;
      stopGlow();
      const g = glowCanvas.ctx;
      glowCanvas.clear();
      if (ctx.params.lit <= 0) {
        glowCanvas.commit();
        return;
      }
      g.save();
      g.globalCompositeOperation = 'lighter';
      g.lineCap = 'round';
      g.lineJoin = 'round';
      stopGlow = inSlices(
        glowSteps(g, false),
        () => {
          g.restore();
          glowCanvas.commit();
        },
        0,
      );
    }

    /**
     * Draws the lit facades as they are now into `g`, in table metres, for a magnifier's sharp picture
     * (#413); the table itself has the glow's picture and the window sprites. Windows of the same
     * colour and brightness go in one stroke (#483).
     */
    function paint(g: CanvasRenderingContext2D) {
      const { lit } = ctx.params;
      g.save();
      g.globalCompositeOperation = 'lighter';
      g.lineCap = 'round';
      g.lineJoin = 'round';
      // A soft glow along every lit building's outline, so the facades read as lit from within.
      if (lit > 0) drainSteps(glowSteps(g, true));
      // The windows themselves: dashes along the facade that come on and go off.
      const windows = buckets();
      for (const light of lights) {
        const building = buildings[light.building]!;
        if (light.level < 0.02 || building.dark > 0) continue;
        const path = (windows[(building.white ? LEVELS : 0) + level(light.level * building.brightness)] ??= new Path2D());
        path.moveTo(light.x0, light.y0);
        path.lineTo(light.x1, light.y1);
      }
      g.lineWidth = LINE_M;
      stroke(g, windows, (step) => step / (LEVELS - 1));
      g.restore();
    }
    ctx.map.addDetail((g) => {
      g.globalAlpha = ctx.params.opacity;
      paint(g);
    });

    return {
      update(changed) {
        if (changed.includes('opacity')) {
          windows.setOpacity(ctx.params.opacity);
          glowCanvas.setOpacity(ctx.params.opacity);
        }
        if (changed.includes('color')) windows.setImages(dashes(ctx.params.color));
        // Respond to the slider now rather than as each window's timer runs out.
        if (changed.includes('lit')) for (const light of lights) light.wait = Math.min(light.wait, random() * 1.5);
      },
    };
  },
});
