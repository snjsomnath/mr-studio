// Masterplan (#193): a plan drawing over the table, its groups revealed one phase at a time.
// Drawing reveal (#286) adds the Lindholmen artwork's opening: the lines trace in, the drawing
// turns to a colour version, phases grow from their own middle with the earlier ones dimmed,
// pointing at a phase lights it (#289), and the drawing can be placed by its corners on the map.
// The host has already read the SVG and made it safe (crates/mrs-site/src/plan.rs): phase groups
// carry `data-mrs-phase`, `data-mrs-name` and the drawing stretches over the table. Each phase is
// rasterised on its own, as an image, so nothing in the drawing ever runs on the table.
import {
  HoverRegions,
  apply,
  defineLayer,
  drawTrace,
  growRadius,
  invert,
  multiply,
  openingAt,
  parseCorners,
  placement,
  siteDataUrl,
  stagedWeight,
  tableFrame,
  traceDrawing,
} from '@mrstudio/sdk';
import type { Affine, HoverRegion, LayerManifest, PanelContext, TraceBatch } from '@mrstudio/sdk';

import manifest from '../layer.json';
import { datasetOf, loadImage, picture } from './drawing.ts';
import type { Params } from './drawing.ts';
import { planHero } from './hero.ts';

interface Phase {
  name: string;
  colour: string;
  image: HTMLImageElement;
  /** 0 hidden to 1 shown, moving towards `target`. */
  shown: number;
  target: number;
  /** Where a reveal started, so it grows from the faint plan to the full phase. */
  from: number;
  /** Where its paint is, in table metres (x0, y0, x1, y1), and its middle; null when it paints nothing. */
  bounds: [number, number, number, number] | null;
  middle: [number, number];
  /** Its paint at a low resolution, for pointing at it. */
  mask: ImageData | null;
}

/** Seconds a phase takes to come in, and to go. */
const IN_S = 1.6;
const OUT_S = 0.5;
/** Seconds the newest phase glows after it lands. */
const GLOW_S = 1.4;
/** How strongly every phase shows in the finale, before one is pointed at. */
const FINALE = 0.8;
/** Width of the low-resolution copy of each phase used for pointing at it. */
const MASK_W = 256;
/** Seconds a look change (lines, colour) takes from the controller. */
const LOOK_S = 0.65;

const ease = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

/** A phase's colour for the legend: its own, else the first it draws with. */
function colourOf(group: Element): string {
  const own = group.getAttribute('data-mrs-colour');
  if (own) return own;
  for (const el of [group, ...group.querySelectorAll('*')]) {
    for (const key of ['fill', 'stroke']) {
      const value = (el.getAttribute(key) ?? (el.getAttribute('style') ?? '').match(new RegExp(`(?:^|;)\\s*${key}\\s*:\\s*([^;]+)`))?.[1] ?? '').trim();
      if (value && !/^(none|transparent|currentcolor|inherit|url\()/i.test(value)) return value;
    }
  }
  return '#9aa4b2';
}

/** Where a phase paints, from a low-resolution copy: its bounds in the drawing's unit square, and the copy. */
function measure(image: HTMLImageElement, aspect: number): { box: [number, number, number, number] | null; mask: ImageData | null } {
  const w = MASK_W;
  const h = Math.max(1, Math.round(MASK_W / Math.max(0.05, aspect)));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  if (!g) return { box: null, mask: null };
  g.drawImage(image, 0, 0, w, h);
  let mask: ImageData;
  try {
    mask = g.getImageData(0, 0, w, h);
  } catch {
    return { box: null, mask: null };
  }
  let [x0, y0, x1, y1] = [w, h, -1, -1];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if ((mask.data[(y * w + x) * 4 + 3] ?? 0) > 16) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return { box: x1 < 0 ? null : [x0 / w, y0 / h, (x1 + 1) / w, (y1 + 1) / h], mask };
}

export default defineLayer<Params>({
  manifest: manifest as LayerManifest,

  async table(ctx) {
    const drawing = ctx.map.addDrawing('plan', { opacity: ctx.params.opacity, resolution: 2560 });
    const frame = tableFrame(ctx.site);
    let base: HTMLImageElement | null = null;
    let colourImage: HTMLImageElement | null = null;
    let trace: TraceBatch[] = [];
    let phases: Phase[] = [];
    let glow = 0;
    let newest = -1;
    let dirty = true;
    let loading = 0;
    /** The drawing's unit square to table metres. */
    let place: Affine = placement(drawing);
    /** Seconds since the drawing was loaded: the opening and the turn to colour run on it. */
    let clock = 0;
    /** The look's own cross-fade after a change from the controller: from, to, and how far. */
    let lookFade: { from: number; to: number; t: number } | null = null;
    let lookNow = 0;
    let publishedTurn: boolean | null = null;
    let diagonal = Math.hypot(drawing.width, drawing.height);

    const hover = new HoverRegions<number>({
      regions: () => (hoverable() ? regions : []),
      settle_s: 0.2,
      onEnter: (region) => {
        ctx.legend.highlight(phases[region.data!]?.name ?? null);
        ctx.publish({ pointing: phases[region.data!]?.name ?? '' });
      },
      onLeave: () => {
        const held = hover.active()[0];
        ctx.legend.highlight(held ? (phases[held.data!]?.name ?? null) : null);
        ctx.publish({ pointing: held ? (phases[held.data!]?.name ?? '') : '' });
      },
    });
    let regions: HoverRegion<number>[] = [];
    ctx.pointer.on((sample) => hover.handle(sample));

    /** Pointing lights a phase when the whole plan is on show: the overview or the finale. */
    function hoverable(): boolean {
      if (!ctx.params.hover) return false;
      const revealed = ctx.params.reveal ? ctx.steps.revealed : 0;
      return (revealed === 0 && ctx.params.start === 'all') || revealed > phases.length;
    }

    async function load() {
      const mine = ++loading;
      const name = datasetOf(ctx.site, ctx.params.dataset);
      const url = name ? siteDataUrl(ctx.site, name) : null;
      let svg: Document | null = null;
      if (url) {
        try {
          const response = await fetch(url);
          if (response.ok) svg = new DOMParser().parseFromString(await response.text(), 'image/svg+xml');
          else console.warn(`[plan] '${name}' could not be loaded: HTTP ${response.status}`);
        } catch (error) {
          console.warn(`[plan] '${name}' could not be loaded`, error);
        }
      }
      if (svg?.querySelector('parsererror') || svg?.documentElement.localName !== 'svg') svg = null;
      // Placed by its corners, or stretched over the table; pictured at the drawing's own pixel density.
      const corners = parseCorners(ctx.params.corners);
      const nextPlace = placement(drawing, corners ? (corners.map((c) => frame.toTable(c)) as [[number, number], [number, number], [number, number]]) : null);
      const across = Math.hypot(nextPlace[0], nextPlace[1]);
      const down = Math.hypot(nextPlace[2], nextPlace[3]);
      const budget = Math.sqrt((drawing.width * drawing.scale * drawing.height * drawing.scale) / Math.max(1e-6, across * down * drawing.scale * drawing.scale));
      const width = Math.max(1, Math.round(Math.min(4096, across * drawing.scale * Math.min(1, budget))));
      const height = Math.max(1, Math.round(Math.min(4096, down * drawing.scale * Math.min(1, budget))));
      const groups = svg ? [...svg.querySelectorAll('[data-mrs-phase]')] : [];
      const [nextBase, ...images] = svg ? await Promise.all([picture(svg, null, width, height), ...groups.map((g) => picture(svg!, g.getAttribute('data-mrs-phase'), width, height))]) : [null];
      const nextColour = await loadImage(ctx.params.colour ? siteDataUrl(ctx.site, ctx.params.colour) : null);
      // The lines to trace are those outside every phase, as the base picture has them.
      let nextTrace: TraceBatch[] = [];
      if (svg && ctx.params.opening === 'trace') {
        const copy = svg.documentElement.cloneNode(true) as SVGSVGElement;
        for (const group of copy.querySelectorAll('[data-mrs-phase]')) group.remove();
        const box = (copy.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
        const [vw, vh] = box.length === 4 && box.every(Number.isFinite) ? [box[2]!, box[3]!] : [width, height];
        nextTrace = traceDrawing(copy, multiply(nextPlace, [1 / (vw || 1), 0, 0, 1 / (vh || 1), 0, 0]));
      }
      if (mine !== loading) return;
      place = nextPlace;
      diagonal = Math.hypot(across, down);
      base = nextBase ?? null;
      colourImage = nextColour;
      trace = nextTrace;
      const aspect = across / Math.max(1e-6, down);
      phases = groups.map((group, k) => {
        const { box, mask } = measure(images[k]!, aspect);
        const bounds = box ? boundsOf(box) : null;
        const middle: [number, number] = bounds ? [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2] : [drawing.width / 2, drawing.height / 2];
        return { name: group.getAttribute('data-mrs-name') ?? `Part ${k + 1}`, colour: colourOf(group), image: images[k]!, shown: 0, target: 0, from: 0, bounds, middle, mask };
      });
      const back = invert(place);
      regions = phases.flatMap((p, k) =>
        p.mask
          ? [{
              id: `phase-${k}`,
              data: k,
              contains: (point: [number, number]) => {
                const [u, v] = apply(back, point);
                const px = Math.floor(u * p.mask!.width);
                const py = Math.floor(v * p.mask!.height);
                if (px < 0 || py < 0 || px >= p.mask!.width || py >= p.mask!.height) return false;
                return (p.mask!.data[(py * p.mask!.width + px) * 4 + 3] ?? 0) > 24;
              },
            }]
          : [],
      );
      clock = 0;
      lookFade = null;
      describe();
      aim(false);
    }

    /** A box in the drawing's unit square as the bounds it covers in table metres. */
    function boundsOf([u0, v0, u1, v1]: [number, number, number, number]): [number, number, number, number] {
      const points = [apply(place, [u0, v0]), apply(place, [u1, v0]), apply(place, [u0, v1]), apply(place, [u1, v1])];
      const xs = points.map((p) => p[0]);
      const ys = points.map((p) => p[1]);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    }

    /** Steps and legend: Next walks the phases (and the finale); the legend lists them and follows the reveal. */
    function describe() {
      const names = phases.map((p) => p.name);
      const finale = ctx.params.finale && names.length > 0;
      ctx.steps.define(ctx.params.reveal ? names.length + (finale ? 1 : 0) : 0, finale ? [...names, ctx.say('All together')] : names);
      ctx.legend.set(phases.map((p) => ({ label: p.name, color: p.colour, shape: 'fill' })));
      ctx.publish({ note: phases.length ? '' : ctx.say('Add a plan drawing (SVG) to the table'), pointing: '' });
    }

    /**
     * Which phases show now. The overview shows the whole plan (or only what is outside the
     * phases); from the first step on, the newest phase in full, those before it as `earlier`
     * says and those to come as `later` says. `land` plays the newest one in.
     */
    function aim(land: boolean) {
      const revealed = ctx.params.reveal ? ctx.steps.revealed : 0;
      const weights = { overview: ctx.params.start === 'base' ? 'none' : 'all', earlier: ctx.params.earlier, later: ctx.params.later, finale: ctx.params.finale ? FINALE : null } as const;
      phases.forEach((p, k) => (p.target = stagedWeight(k, revealed, phases.length, weights)));
      // The controller's picture of the drawing follows the table.
      ctx.publish({ shown: phases.map((p) => Math.round(p.target * 100) / 100) });
      // Turning the layer on, or turning the reveal off, shows what is there at once.
      if (!land) for (const p of phases) p.shown = p.target;
      if (land && revealed > 0 && revealed <= phases.length) {
        newest = revealed - 1;
        const p = phases[newest]!;
        // Out of the overview, the phase is played in again from faint.
        if (p.shown >= 1) p.shown = Math.min(ctx.params.later, 0.5);
        p.from = p.shown;
        glow = GLOW_S + IN_S;
      }
      dirty = true;
    }

    ctx.onFrame((dt) => {
      clock += dt;
      for (const p of phases) {
        if (p.shown === p.target) continue;
        p.shown = p.target > p.shown ? Math.min(p.target, p.shown + dt / IN_S) : Math.max(p.target, p.shown - dt / OUT_S);
        dirty = true;
      }
      if (glow > 0) {
        glow = Math.max(0, glow - dt);
        dirty = true;
      }
      hover.tick(dt, performance.now() / 1000);
      if (hover.moving) dirty = true;

      // The opening and the turn to colour, unless the controller changed the look since.
      const timing = {
        in_s: ctx.params.opening === 'none' ? 0 : ctx.params.opening_s,
        colour_after_s: colourImage && ctx.params.look === 'colour' ? ctx.params.colour_after_s : null,
        colour_s: ctx.params.colour_s,
      };
      const opening = openingAt(clock, timing);
      let colour = opening.colour;
      if (lookFade) {
        lookFade.t = Math.min(1, lookFade.t + dt / LOOK_S);
        const e = lookFade.t * lookFade.t * (3 - 2 * lookFade.t);
        colour = lookFade.from + (lookFade.to - lookFade.from) * e;
      }
      if (!colourImage) colour = 0;
      const drawn = opening.drawn;
      const opened = drawn >= 1 && (lookFade ? lookFade.t >= 1 : timing.colour_after_s === null || clock >= timing.in_s + timing.colour_after_s + timing.colour_s);
      if (!opened || colour !== lookNow) dirty = true;
      lookNow = colour;
      // The controller's picture turns with the table: in lines until the turn is half way.
      const turned = colour >= 0.5 && drawn >= 1;
      if (turned !== publishedTurn) {
        publishedTurn = turned;
        ctx.publish({ turned });
      }
      if (!dirty) return;
      dirty = false;
      const g = drawing.ctx;
      const { width: w, height: h } = drawing;
      drawing.clear();
      // The drawing as it is placed: its unit square drawn through the placement.
      const placed = (draw: () => void) => {
        g.save();
        g.transform(...place);
        draw();
        g.restore();
      };
      // What lies outside every phase: traced in, faded in, or there; then turned to colour.
      if (base && colour < 1) {
        if (ctx.params.opening === 'trace' && drawn < 1) {
          placed(() => {
            g.globalAlpha = drawn * 0.22;
            g.drawImage(base!, 0, 0, 1, 1);
          });
          drawTrace(g, trace, drawn, { dash: diagonal * 0.11, minWidth: 0.8 / drawing.scale });
        } else {
          placed(() => {
            g.globalAlpha = (ctx.params.opening === 'fade' ? drawn : 1) * (1 - colour);
            g.drawImage(base!, 0, 0, 1, 1);
          });
        }
      }
      if (colourImage && colour > 0) {
        placed(() => {
          g.globalAlpha = colour;
          g.drawImage(colourImage!, 0, 0, 1, 1);
        });
      }
      const reach = Math.hypot(w, h) / 2;
      const fadeIn = ctx.params.opening === 'none' ? 1 : drawn;
      phases.forEach((p, k) => {
        if (p.shown <= 0) return;
        const rising = p.target === 1 && p.shown < 1 && k === newest;
        const progress = rising ? (p.shown - p.from) / Math.max(1e-6, 1 - p.from) : 1;
        const from: [number, number] = ctx.params.grow === 'phase' ? p.middle : [w / 2, h / 2];
        const radius = ctx.params.grow === 'phase' && p.bounds ? growRadius(from, p.bounds) : reach;
        const lit = hover.level(`phase-${k}`);
        g.save();
        if (rising) {
          // Coming in: the faint phase, and the full one inside a circle growing from its start.
          placed(() => {
            g.globalAlpha = p.from * fadeIn;
            g.drawImage(p.image, 0, 0, 1, 1);
          });
          g.beginPath();
          g.arc(from[0], from[1], ease(progress) * radius, 0, Math.PI * 2);
          g.clip();
          g.globalAlpha = fadeIn;
        } else {
          g.globalAlpha = Math.min(1, (p.shown + (1 - p.shown) * lit) * fadeIn);
        }
        placed(() => g.drawImage(p.image, 0, 0, 1, 1));
        g.restore();
        if (rising) {
          const r = ease(progress) * radius;
          g.save();
          g.strokeStyle = 'rgb(255 255 255 / 0.55)';
          g.lineWidth = 6 / drawing.scale;
          g.shadowColor = '#fff';
          g.shadowBlur = 24;
          g.beginPath();
          g.arc(from[0], from[1], r, 0, Math.PI * 2);
          g.stroke();
          g.restore();
        }
        // The newest phase glows once it has landed, and a phase pointed at glows while it is held.
        const landed = k === newest && glow > 0 && glow < GLOW_S && p.target === 1 ? 0.45 * Math.sin((glow / GLOW_S) * Math.PI) : 0;
        const shine = Math.max(landed, 0.3 * lit);
        if (shine > 0) {
          g.save();
          g.globalCompositeOperation = 'lighter';
          g.globalAlpha = shine;
          placed(() => g.drawImage(p.image, 0, 0, 1, 1));
          g.restore();
        }
      });
      drawing.commit();
    });

    await load();

    return {
      update(changed) {
        if (changed.includes('opacity')) drawing.setOpacity(ctx.params.opacity);
        if (['dataset', 'colour', 'corners', 'opening'].some((key) => changed.includes(key))) void load();
        else if (['reveal', 'finale', 'start', 'earlier', 'later'].some((key) => changed.includes(key))) {
          describe();
          aim(false);
        }
        if (changed.includes('look')) lookFade = { from: lookNow, to: ctx.params.look === 'colour' ? 1 : 0, t: 0 };
        dirty = true;
      },
      step() {
        aim(true);
      },
    };
  },

  hero(ctx: PanelContext<Params>, el: HTMLElement) {
    return planHero(ctx, el);
  },
});
