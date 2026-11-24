// What the Masterplan's table and its controller hero share: the params, finding the drawing,
// and turning it into pictures (the base, each phase, the colour version).
import { phaseNumber, phaseTitle } from '@mrstudio/sdk';
import type { SiteInfo } from '@mrstudio/sdk';

export interface Params {
  dataset: string;
  reveal: boolean;
  look: 'line' | 'colour';
  opening: 'none' | 'fade' | 'trace';
  opening_s: number;
  colour: string;
  colour_after_s: number;
  colour_s: number;
  start: 'all' | 'base';
  grow: 'middle' | 'phase';
  earlier: number;
  later: number;
  finale: boolean;
  hover: boolean;
  corners: string;
  motion: 'roles' | 'none';
  role_s: number;
  opacity: number;
}

export /** The drawing's dataset: the one named, or the table's first SVG. */
function datasetOf(site: SiteInfo, named: string): string | null {
  if (named) return named;
  return Object.entries(site.data ?? {}).find(([, path]) => String(path).toLowerCase().endsWith('.svg'))?.[0] ?? null;
}

export /** One part of the drawing as an image of `width` by `height` pixels: the phase `keep`, or with `keep` null what lies outside every phase. */
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

export /** Loads a picture (PNG, JPEG, WebP or SVG) of a dataset, or null. */
async function loadImage(url: string | null): Promise<HTMLImageElement | null> {
  if (!url) return null;
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
    return image;
  } catch {
    console.warn(`[plan] '${url}' could not be shown`);
    return null;
  }
}

/** A phase group's own <title>, which drawings exported from Illustrator or Boxy carry. */
function titleOf(group: Element): string | null {
  for (const child of group.children) if (child.localName.toLowerCase() === 'title') return child.textContent?.trim() || null;
  return null;
}

/**
 * The drawing's phases in the order Next reveals them, with their names. Phases named with
 * numbers ("01_PROJECT BOUNDARY", "02 Living campus") go in that order (#300); others in the
 * drawing's own order.
 */
export function orderedPhases(svg: Document): { group: Element; name: string }[] {
  const groups = [...svg.querySelectorAll('[data-mrs-phase]')].map((group, k) => {
    const raw = titleOf(group) ?? group.getAttribute('data-mrs-name') ?? `Part ${k + 1}`;
    return { group, name: phaseTitle(raw), number: phaseNumber(raw) ?? phaseNumber(group.getAttribute('data-mrs-name')), k };
  });
  if (groups.length > 1 && groups.every((g) => g.number !== null)) groups.sort((a, b) => a.number! - b.number! || a.k - b.k);
  return groups.map(({ group, name }) => ({ group, name }));
}
