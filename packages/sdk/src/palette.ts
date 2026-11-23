// The table's palette (#93, docs/visualisation.md §6). Layers and custom layers refer to
// named slots (`@accent`, `@warm`, `@cat3`) and named ramps instead of raw colours, so a
// table with several layers reads as one piece and changing the palette recolours them all.
// The sets are tuned for a dark, projected table: every slot is light enough to project
// (C1, C2), warm means sun and heat, cool means shade and night, green is vegetation, red
// is a warning and white is kept for focus (C3, C4).

import type { Rgba } from './blocks/scale.ts';
import { colour } from './blocks/scale.ts';

/** The slots every set fills. */
export const PALETTE_SLOTS = ['accent', 'focus', 'warm', 'cool', 'green', 'warning', 'neutral', 'cat1', 'cat2', 'cat3', 'cat4', 'cat5', 'cat6', 'cat7', 'cat8'] as const;
export type PaletteSlot = (typeof PALETTE_SLOTS)[number];

/** What each slot is for, in the editor's words. */
export const SLOT_ROLES: Record<PaletteSlot, string> = {
  accent: 'Accent: the table’s own colour',
  focus: 'Focus: the thing being discussed',
  warm: 'Warm: sun, heat, energy',
  cool: 'Cool: shade, cold, night',
  green: 'Green: trees and parks',
  warning: 'Warning: a failed threshold',
  neutral: 'Neutral: context',
  cat1: 'Category 1',
  cat2: 'Category 2',
  cat3: 'Category 3',
  cat4: 'Category 4',
  cat5: 'Category 5',
  cat6: 'Category 6',
  cat7: 'Category 7',
  cat8: 'Category 8',
};

/** A ramp is a list of colours from low to high, spread evenly. */
export type Ramp = readonly string[];

export interface PaletteSet {
  id: string;
  name: string;
  description: string;
  slots: Record<PaletteSlot, string>;
  /** Sequential ramps rise in lightness (C2); `diverging` has a lit middle (C6). */
  ramps: Record<string, Ramp>;
}

const RAMPS = {
  sun: ['#2a1458', '#7a2a7a', '#c8466a', '#f0803c', '#fcc860', '#fff6c8'],
  ice: ['#141e50', '#1f4f9a', '#2f86c8', '#5cc0e0', '#a8e6f0', '#eefcff'],
  glow: ['#1d1a4a', '#3b3f9e', '#2f8fb0', '#3cc79a', '#b8e86a', '#fbffc8'],
  diverging: ['#3b6fe0', '#7fb2f0', '#e8e4dc', '#f6a85c', '#e2463c'],
} satisfies Record<string, Ramp>;

/** The built-in sets. `night` is the default. */
export const PALETTE_SETS: readonly PaletteSet[] = [
  {
    id: 'night',
    name: 'Night',
    description: 'Bright, clear colours on a dark table. The default.',
    slots: {
      accent: '#4fd1c5', focus: '#f8fafc', warm: '#fbbf24', cool: '#60a5fa', green: '#2dcd8c', warning: '#e2364c', neutral: '#94a3b8',
      cat1: '#4fd1c5', cat2: '#fbbf24', cat3: '#f472b6', cat4: '#60a5fa', cat5: '#a3e635', cat6: '#c084fc', cat7: '#fb923c', cat8: '#e2e8f0',
    },
    ramps: RAMPS,
  },
  {
    id: 'ember',
    name: 'Ember',
    description: 'Warm and soft, for energy, heat and evening stories.',
    slots: {
      accent: '#ff8a4c', focus: '#fff7ed', warm: '#ffb347', cool: '#7c9cf5', green: '#5fd39a', warning: '#ff4d5e', neutral: '#b6a89c',
      cat1: '#ff8a4c', cat2: '#ffd166', cat3: '#ef6f9c', cat4: '#7c9cf5', cat5: '#9ee37d', cat6: '#c99cff', cat7: '#ff6b6b', cat8: '#f1e3d3',
    },
    ramps: RAMPS,
  },
  {
    id: 'harbour',
    name: 'Harbour',
    description: 'Cool blues and greens, for water, air and mobility.',
    slots: {
      accent: '#38bdf8', focus: '#f0f9ff', warm: '#fcd34d', cool: '#818cf8', green: '#34d399', warning: '#f43f5e', neutral: '#94a3b8',
      cat1: '#38bdf8', cat2: '#34d399', cat3: '#fcd34d', cat4: '#a78bfa', cat5: '#f472b6', cat6: '#2dd4bf', cat7: '#fb923c', cat8: '#e2e8f0',
    },
    ramps: RAMPS,
  },
];

/** The palette as site.json has it: a set and the slots this table changes. */
export interface SitePalette {
  set?: string;
  slots?: Record<string, string>;
}

export interface ResolvedPalette {
  set: PaletteSet;
  slots: Record<PaletteSlot, string>;
  ramps: Record<string, Ramp>;
}

/** The site's palette with its overrides applied over its set (or `night`). */
export function resolvePalette(palette?: SitePalette | null): ResolvedPalette {
  const set = PALETTE_SETS.find((s) => s.id === palette?.set) ?? PALETTE_SETS[0]!;
  const slots = { ...set.slots };
  for (const [slot, value] of Object.entries(palette?.slots ?? {})) {
    if ((PALETTE_SLOTS as readonly string[]).includes(slot) && /^#[0-9a-f]{6}$/i.test(value)) slots[slot as PaletteSlot] = value;
  }
  return { set, slots, ramps: set.ramps };
}

let lastKey: string | null = null;
let lastPalette: ResolvedPalette | null = null;

/**
 * The palette a core layer draws with, from its site (`ctx.site`, which follows the table's
 * palette as it changes). Cheap to call every frame: it resolves again only when the palette
 * changed. Compare `.set` or the result itself to notice a change and redraw.
 */
export function tablePalette(site: { palette?: SitePalette | null }): ResolvedPalette {
  const key = JSON.stringify(site.palette ?? null);
  if (key !== lastKey || !lastPalette) {
    lastKey = key;
    lastPalette = resolvePalette(site.palette);
  }
  return lastPalette;
}

/** The categorical slots, in order. */
export function categorySlots(palette: ResolvedPalette): string[] {
  return [1, 2, 3, 4, 5, 6, 7, 8].map((n) => palette.slots[`cat${n}` as PaletteSlot]);
}

/** A colour as written in a recipe: `@slot` from the palette, or `#rrggbb`. Unknown slots fall back to neutral. */
export function paletteColour(value: string | undefined, palette: ResolvedPalette, fallback: PaletteSlot = 'neutral'): Rgba {
  if (!value) return colour(palette.slots[fallback]);
  if (value.startsWith('@')) return colour(palette.slots[value.slice(1) as PaletteSlot] ?? palette.slots[fallback]);
  try {
    return colour(value);
  } catch {
    return colour(palette.slots[fallback]);
  }
}

/** The hex of a recipe colour, for swatches and legends. */
export function paletteHex(value: string | undefined, palette: ResolvedPalette): string {
  const [r, g, b] = paletteColour(value, palette);
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
}

/** A colour along a ramp, `t` from 0 to 1. */
export function rampColour(ramp: Ramp, t: number): Rgba {
  const stops = ramp.map((c) => colour(c));
  if (stops.length === 0) return [255, 255, 255, 1];
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  if (stops.length === 1) return stops[0]!;
  const a = stops[i]!;
  const b = stops[i + 1]!;
  const f = x - i;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
}

/** CIE lightness, 0 (black) to 100 (white). */
export function lightness(hex: string): number {
  const [r, g, b] = colour(hex).slice(0, 3).map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y;
}

/**
 * Whether a colour shows on the projected table. A projector cannot draw darker than the
 * room makes the model, so a dark colour shows as almost nothing (§1, C1). Returns a
 * warning for the picker, or null.
 */
export function projectionWarning(hex: string): string | null {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return null;
  const l = lightness(hex);
  if (l < 30) return 'Too dark to see on the projected table: a projector cannot draw darker than the model.';
  if (l < 45) return 'Dim on the projected table. Fine for quiet context, not for what matters.';
  return null;
}
