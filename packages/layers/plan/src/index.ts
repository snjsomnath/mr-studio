// Masterplan (#193): a plan drawing over the table, its groups revealed one phase at a time.
// The host has already read the SVG and made it safe (crates/mrs-site/src/plan.rs): phase groups
// carry `data-mrs-phase`, `data-mrs-name` and the drawing stretches over the table. Each phase is
// rasterised on its own, as an image, so nothing in the drawing ever runs on the table.
import { defineLayer, siteDataUrl } from '@mrstudio/sdk';
import type { LayerManifest, SiteInfo } from '@mrstudio/sdk';

import manifest from '../layer.json';

interface Params {
  dataset: string;
  reveal: boolean;
  opacity: number;
}

interface Phase {
  name: string;
  colour: string;
  image: HTMLImageElement;
  /** 0 hidden to 1 shown, moving towards `target`. */
  shown: number;
  target: number;
  /** Where a reveal started, so it grows from the faint plan to the full phase. */
  from: number;
}

/** Seconds a phase takes to come in, and to go. */
const IN_S = 1.6;
const OUT_S = 0.5;
/** Seconds the newest phase glows after it lands. */
const GLOW_S = 1.4;
/** Phases still to come show this faintly, so the whole plan can be read ahead. */
const GHOST = 0.12;

const ease = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

/** The drawing's dataset: the one named, or the table's first SVG. */
function datasetOf(site: SiteInfo, named: string): string | null {
  if (named) return named;
  return Object.entries(site.data ?? {}).find(([, path]) => String(path).toLowerCase().endsWith('.svg'))?.[0] ?? null;
}

/** One part of the drawing as an image of `width` by `height` pixels: the phase `keep`, or with `keep` null what lies outside every phase. */
async function picture(svg: Document, keep: string | null, width: number, height: number): Promise<HTMLImageElement> {
  const copy = svg.documentElement.cloneNode(true) as SVGSVGElement;
  for (const group of copy.querySelectorAll('[data-mrs-phase]')) if (group.getAttribute('data-mrs-phase') !== keep) group.remove();
  if (keep !== null) {
    // Only the phase: shapes outside every phase belong to the base picture.
    const phase = copy.querySelector(`[data-mrs-phase="${keep}"]`);
    const keepPath = new Set<Element>();
    for (let n: Element | null = phase; n && n !== copy; n = n.parentElement) keepPath.add(n);
    const prune = (parent: Element) => {
      for (const child of [...parent.children]) {
        const tag = child.localName.toLowerCase();
        if (['defs', 'style', 'clippath', 'mask', 'symbol', 'lineargradient', 'radialgradient', 'pattern', 'filter', 'marker'].includes(tag)) continue;
        if (child === phase) continue;
        if (keepPath.has(child)) prune(child);
        else child.remove();
      }
    };
    prune(copy);
  }
  copy.setAttribute('width', String(width));
  copy.setAttribute('height', String(height));
  const blob = new Blob([new XMLSerializer().serializeToString(copy)], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
  } finally {
    URL.revokeObjectURL(url);
  }
  return image;
}

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

export default defineLayer<Params>({
  manifest: manifest as LayerManifest,

  async table(ctx) {
    const drawing = ctx.map.addDrawing('plan', { opacity: ctx.params.opacity, resolution: 2560 });
    let base: HTMLImageElement | null = null;
    let phases: Phase[] = [];
    let glow = 0;
    let newest = -1;
    let dirty = true;
    let loading = 0;

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
      const width = Math.round(drawing.width * drawing.scale);
      const height = Math.round(drawing.height * drawing.scale);
      const groups = svg ? [...svg.querySelectorAll('[data-mrs-phase]')] : [];
      const [nextBase, ...images] = svg ? await Promise.all([picture(svg, null, width, height), ...groups.map((g) => picture(svg!, g.getAttribute('data-mrs-phase'), width, height))]) : [null];
      if (mine !== loading) return;
      base = nextBase ?? null;
      phases = groups.map((group, k) => ({ name: group.getAttribute('data-mrs-name') ?? `Part ${k + 1}`, colour: colourOf(group), image: images[k]!, shown: 0, target: 0, from: 0 }));
      describe();
      aim(false);
    }

    /** Steps and legend: Next walks the phases; the legend lists them and follows the reveal. */
    function describe() {
      const names = phases.map((p) => p.name);
      ctx.steps.define(ctx.params.reveal ? names.length : 0, names);
      ctx.legend.set(phases.map((p) => ({ label: p.name, color: p.colour, shape: 'fill' })));
      ctx.publish({ note: phases.length ? '' : ctx.say('Add a plan drawing (SVG) to the table') });
    }

    /**
     * Which phases show now. The overview shows the whole plan; from the first step on, the
     * phases revealed so far show in full and those to come faintly. `land` plays the newest one in.
     */
    function aim(land: boolean) {
      const revealed = ctx.params.reveal ? ctx.steps.revealed : 0;
      phases.forEach((p, k) => (p.target = revealed <= 0 || k < revealed ? 1 : GHOST));
      // Turning the layer on, or turning the reveal off, shows what is there at once.
      if (!land) for (const p of phases) p.shown = p.target;
      if (land && revealed > 0 && revealed <= phases.length) {
        newest = revealed - 1;
        const p = phases[newest]!;
        // Out of the overview, the first phase is played in again from faint.
        if (p.shown >= 1) p.shown = GHOST;
        p.from = p.shown;
        glow = GLOW_S + IN_S;
      }
      dirty = true;
    }

    ctx.onFrame((dt) => {
      for (const p of phases) {
        if (p.shown === p.target) continue;
        p.shown = p.target > p.shown ? Math.min(p.target, p.shown + dt / IN_S) : Math.max(p.target, p.shown - dt / OUT_S);
        dirty = true;
      }
      if (glow > 0) {
        glow = Math.max(0, glow - dt);
        dirty = true;
      }
      if (!dirty) return;
      dirty = false;
      const g = drawing.ctx;
      const { width: w, height: h } = drawing;
      drawing.clear();
      if (base) g.drawImage(base, 0, 0, w, h);
      const reach = Math.hypot(w, h) / 2;
      phases.forEach((p, k) => {
        if (p.shown <= 0) return;
        const rising = p.target === 1 && p.shown < 1;
        const progress = rising ? (p.shown - p.from) / Math.max(1e-6, 1 - p.from) : 1;
        g.save();
        if (rising) {
          // Coming in: the faint phase, and the full one inside a circle growing from the middle of the table.
          g.globalAlpha = p.from;
          g.drawImage(p.image, 0, 0, w, h);
          g.beginPath();
          g.arc(w / 2, h / 2, ease(progress) * reach, 0, Math.PI * 2);
          g.clip();
          g.globalAlpha = 1;
        } else {
          g.globalAlpha = p.shown;
        }
        g.drawImage(p.image, 0, 0, w, h);
        g.restore();
        if (rising) {
          const r = ease(progress) * reach;
          g.save();
          g.strokeStyle = 'rgb(255 255 255 / 0.55)';
          g.lineWidth = 6 / drawing.scale;
          g.shadowColor = '#fff';
          g.shadowBlur = 24;
          g.beginPath();
          g.arc(w / 2, h / 2, r, 0, Math.PI * 2);
          g.stroke();
          g.restore();
        }
        // The newest phase glows once it has landed: drawn again, lightened, fading out.
        if (k === newest && glow > 0 && glow < GLOW_S && p.target === 1) {
          g.save();
          g.globalCompositeOperation = 'lighter';
          g.globalAlpha = 0.45 * Math.sin((glow / GLOW_S) * Math.PI);
          g.drawImage(p.image, 0, 0, w, h);
          g.restore();
        }
      });
      drawing.commit();
    });

    await load();

    return {
      update(changed) {
        if (changed.includes('opacity')) drawing.setOpacity(ctx.params.opacity);
        if (changed.includes('dataset')) void load();
        else if (changed.includes('reveal')) {
          describe();
          aim(false);
        }
      },
      step() {
        aim(true);
      },
    };
  },
});
