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
  drawRolePiece,
  drawTrace,
  elementName,
  growRadius,
  invert,
  multiply,
  openingAt,
  parseCorners,
  turnCorners,
  placement,
  hasRoles,
  roleFrame,
  roleMoves,
  roleOfName,
  rolePieces,
  siteDataUrl,
  stagedWeight,
  tableFrame,
  traceDrawing,
} from '@mrstudio/sdk';
import type { Affine, HoverRegion, LayerManifest, PanelContext, RolePiece, TraceBatch } from '@mrstudio/sdk';

import manifest from '../layer.json';
import { datasetOf, loadImage, orderedPhases, picture } from './drawing.ts';
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
  /** Its parts with their roles when the drawing names them (#300), drawn moving instead of the picture. */
  pieces: RolePiece[] | null;
  /** Seconds its parts have been coming to life. */
  motion: number;
}

/** Seconds a phase takes to come in, and to go. */
const IN_S = 1.6;
const OUT_S = 0.5;
/** Seconds the newest phase glows after it lands. */
const GLOW_S = 1.4;
/** How strongly every phase shows in the finale, before one is pointed at. */
const FINALE = 0.8;
/** The finale's marks (#416): seconds between one phase's mark and the next landing, how long one takes to land, and a pulse's period. */
const MARK_STAGGER_S = 0.18;
const MARK_IN_S = 0.9;
const MARK_PULSE_S = 2.6;
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
    /** How far the opening has drawn the lines, 0 to 1, as last painted. */
    let drawnNow = 0;
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
      // Corners are of the drawing as shown; a drawing shown turned is placed by its own corners (#301).
      const corners = parseCorners(ctx.params.corners);
      const shown: [number, number][] = corners ? corners.map((c) => frame.toTable(c)) : [[0, 0], [drawing.width, 0], [0, drawing.height]];
      const turn = Number(ctx.params.turn) / 90 || 0;
      const nextPlace = placement(drawing, corners || turn ? turnCorners(shown, turn) : null);
      const across = Math.hypot(nextPlace[0], nextPlace[1]);
      const down = Math.hypot(nextPlace[2], nextPlace[3]);
      const budget = Math.sqrt((drawing.width * drawing.scale * drawing.height * drawing.scale) / Math.max(1e-6, across * down * drawing.scale * drawing.scale));
      const width = Math.max(1, Math.round(Math.min(4096, across * drawing.scale * Math.min(1, budget))));
      const height = Math.max(1, Math.round(Math.min(4096, down * drawing.scale * Math.min(1, budget))));
      const groups = svg ? orderedPhases(svg) : [];
      const [nextBase, ...images] = svg ? await Promise.all([picture(svg, null, width, height), ...groups.map(({ group }) => picture(svg!, group.getAttribute('data-mrs-phase'), width, height))]) : [null];
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
      // Parts named by what they are (a boundary, routes, points) move by role (#300).
      let pieces: (RolePiece[] | null)[] = groups.map(() => null);
      if (svg && ctx.params.motion !== 'none' && hasRoles(svg.documentElement)) {
        const box = (svg.documentElement.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
        const [vx, vy, vw, vh] = box.length === 4 && box.every(Number.isFinite) ? box : [0, 0, width, height];
        const toTable = multiply(nextPlace, [1 / (vw || 1), 0, 0, 1 / (vh || 1), -(vx ?? 0) / (vw || 1), -(vy ?? 0) / (vh || 1)]);
        pieces = groups.map(({ group }) => rolePieces(group, toTable, roleOfName(elementName(group)) ?? 'shape'));
      }
      if (mine !== loading) return;
      place = nextPlace;
      diagonal = Math.hypot(across, down);
      base = nextBase ?? null;
      colourImage = nextColour;
      trace = nextTrace;
      const aspect = across / Math.max(1e-6, down);
      phases = groups.map(({ group, name }, k) => {
        const { box, mask } = measure(images[k]!, aspect);
        const bounds = box ? boundsOf(box) : null;
        const middle: [number, number] = bounds ? [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2] : [drawing.width / 2, drawing.height / 2];
        return { name, colour: colourOf(group), image: images[k]!, shown: 0, target: 0, from: 0, bounds, middle, mask, pieces: pieces[k] ?? null, motion: 0 };
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
      phases.forEach((p, k) => {
        const target = stagedWeight(k, revealed, phases.length, weights);
        // A phase that comes on (or back from hidden) comes to life again.
        if (target > 0 && p.target <= 0 && p.shown <= 0.01) p.motion = 0;
        p.target = target;
      });
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
        p.motion = 0;
        glow = GLOW_S + IN_S;
      }
      dirty = true;
    }

    /** Seconds since the finale began, while it shows; null otherwise. */
    let finaleClock: number | null = null;
    const inFinale = () => ctx.params.finale && ctx.params.reveal && phases.length > 0 && ctx.steps.revealed > phases.length;

    ctx.onFrame((dt) => {
      clock += dt;
      if (inFinale() && ctx.params.marks) {
        finaleClock = (finaleClock ?? 0) + dt;
        dirty = true;
      } else if (finaleClock !== null) {
        finaleClock = null;
        dirty = true;
      }
      for (const p of phases) {
        if (p.shown === p.target) continue;
        p.shown = p.target > p.shown ? Math.min(p.target, p.shown + dt / IN_S) : Math.max(p.target, p.shown - dt / OUT_S);
        dirty = true;
      }
      if (glow > 0) {
        glow = Math.max(0, glow - dt);
        dirty = true;
      }
      // Parts moving by role keep the drawing alive while their phase shows.
      const living = ctx.params.opening === 'none' || clock >= ctx.params.opening_s;
      for (const p of phases) {
        if (!p.pieces || p.shown <= 0) continue;
        if (living) p.motion += dt;
        if (p.motion < ctx.params.role_s || p.pieces.some((piece) => roleMoves(piece.role))) dirty = true;
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
      drawnNow = drawn;
      // The controller's picture turns with the table: in lines until the turn is half way.
      const turned = colour >= 0.5 && drawn >= 1;
      if (turned !== publishedTurn) {
        publishedTurn = turned;
        ctx.publish({ turned });
      }
      if (!dirty) return;
      dirty = false;
      drawing.clear();
      paint(drawing.ctx, drawing.scale, false);
      drawing.commit();
    });

    /**
     * Paints the drawing as it is now into `g`, in table metres; `scale` is pixels per metre.
     * The table's drawing, and a magnifier's sharp picture (`sharp`, #351), are both painted here.
     */
    function paint(g: CanvasRenderingContext2D, scale: number, sharp: boolean): void {
      const { width: w, height: h } = drawing;
      const colour = lookNow;
      const drawn = drawnNow;
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
        drawTrace(g, trace, drawn, { dash: diagonal * 0.11, minWidth: 0.8 / scale });
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
      if (p.pieces) {
        // Moving by role: its parts come to life over role_s, then keep their steady motion.
        const progress = Math.min(1, p.motion / Math.max(0.1, ctx.params.role_s));
        const weight = Math.min(1, (p.target >= 1 ? Math.max(p.shown, progress > 0 ? 1 : 0) : p.shown) + (1 - p.shown) * lit) * fadeIn;
        const style = { weight, glowPx: drawing.width * scale * 0.01, minWidth: 0.8 / scale, dash: [diagonal * 0.011, diagonal * 0.008] as [number, number] };
        for (const piece of p.pieces) drawRolePiece(g, piece, roleFrame(piece.role, progress, clock, piece.index, piece.count), style);
      } else {
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
          g.lineWidth = 6 / scale;
          g.shadowColor = '#fff';
          g.shadowBlur = 24;
          g.beginPath();
          g.arc(from[0], from[1], r, 0, Math.PI * 2);
          g.stroke();
          g.restore();
        }
      }
      // The newest phase glows once it has landed, and a phase pointed at glows while it is held.
      const landed = !p.pieces && k === newest && glow > 0 && glow < GLOW_S && p.target === 1 ? 0.45 * Math.sin((glow / GLOW_S) * Math.PI) : 0;
      const shine = Math.max(landed, 0.3 * lit);
      if (shine > 0) {
        g.save();
        g.globalCompositeOperation = 'lighter';
        g.globalAlpha = shine;
        placed(() => g.drawImage(p.image, 0, 0, 1, 1));
        g.restore();
      }
    });
    if (finaleClock !== null) drawMarks(g, scale, finaleClock);
    }

    /**
     * The finale's marks (#416): every phase's middle gets a dot and a ring in its colour,
     * landing one after another, then a ring pulsing outward now and then, like the old
     * artwork's "all locations" overlay. Sized from the drawing so any plan gets them.
     */
    function drawMarks(g: CanvasRenderingContext2D, scale: number, t: number): void {
      const size = Math.max(diagonal * 0.012, 6 / scale);
      phases.forEach((p, k) => {
        if (!p.bounds) return;
        const local = t - k * MARK_STAGGER_S;
        if (local <= 0) return;
        const land = ease(local / MARK_IN_S);
        const [x, y] = p.middle;
        g.save();
        g.fillStyle = p.colour;
        g.strokeStyle = p.colour;
        g.shadowColor = p.colour;
        g.shadowBlur = 18;
        // A dot and a steady ring, overshooting a little as they land.
        const r = size * (land < 1 ? 1 + 0.35 * Math.sin(land * Math.PI) : 1);
        g.globalAlpha = land;
        g.beginPath();
        g.arc(x, y, r * 0.42, 0, Math.PI * 2);
        g.fill();
        g.lineWidth = Math.max(size * 0.16, 1.5 / scale);
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.stroke();
        // A ring that spreads and fades, each phase out of step with the next.
        if (land >= 1) {
          const phase = ((local - MARK_IN_S) / MARK_PULSE_S + k * 0.37) % 1;
          g.globalAlpha = 0.7 * (1 - phase) * (1 - phase);
          g.lineWidth = Math.max(size * 0.1, 1 / scale);
          g.beginPath();
          g.arc(x, y, size * (1 + 2.6 * ease(phase)), 0, Math.PI * 2);
          g.stroke();
        }
        g.restore();
      });
    }

    ctx.map.addDetail((g, scale) => paint(g, scale, true));

    await load();

    return {
      update(changed) {
        if (changed.includes('opacity')) drawing.setOpacity(ctx.params.opacity);
        if (['dataset', 'colour', 'corners', 'turn', 'opening'].some((key) => changed.includes(key))) void load();
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
