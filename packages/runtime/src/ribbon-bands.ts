// Where the table's ribbons go (#78): pure geometry, so it is tested without a browser.
// Rules in docs/contracts/present.md, Ribbon.

import type { SiteInfo } from '@mrstudio/sdk';

export type Side = 'top' | 'bottom' | 'left' | 'right';
export const SIDES: Side[] = ['bottom', 'top', 'left', 'right'];
type Setting = 'off' | 'auto' | { cm: number };

/** A side is used only with at least this much free, in cm. */
export const MIN_CM = 4;
/** The band an `auto` side takes when there is room for it, as in the Chalmers demo. */
export const AUTO_CM = 9;
/** Kept clear between the model's edge and the ribbon, in cm. */
export const GAP_CM = 0.5;

/** One ribbon on the surface: its side, its size and where it sits, in CSS pixels. */
export interface Band {
  side: Side;
  cm: number;
  rect: { left: number; top: number; width: number; height: number };
  /** Degrees the content turns so it reads from its own edge. */
  turn: number;
  front: boolean;
}

const TURN: Record<Side, number> = { bottom: 0, top: 180, left: 90, right: -90 };
const OPPOSITE: Record<Side, Side> = { bottom: 'top', top: 'bottom', left: 'right', right: 'left' };

/** What each side is set to. Without `table.ribbons`, the front edge is on auto and the rest are off. */
export function ribbonSettings(table: NonNullable<SiteInfo['table']>): Record<Side, Setting> {
  const front = table.front ?? 'bottom';
  const set = table.ribbons;
  return Object.fromEntries(SIDES.map((side) => [side, set ? (set[side] ?? 'off') : side === front ? 'auto' : 'off'])) as Record<Side, Setting>;
}

/** The sides in the order `auto` prefers them: the front, the two beside it, the far side last. */
export function sidesByPreference(front: Side = 'bottom'): Side[] {
  const beside = SIDES.filter((side) => side !== front && side !== OPPOSITE[front]);
  return [front, ...beside, OPPOSITE[front]];
}

/**
 * Pixels per cm on the table: the model's projected edges over its size in cm. With a
 * projector at an angle the near edge is longer than the far one, so the edges are averaged.
 */
export function pixelsPerCm(footprint: [number, number][], table: { width_cm: number; height_cm: number }): number {
  const length = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const [tl, tr, br, bl] = footprint as [[number, number], [number, number], [number, number], [number, number]];
  const across = (length(tl, tr) + length(bl, br)) / 2 / table.width_cm;
  const down = (length(tl, bl) + length(tr, br)) / 2 / table.height_cm;
  return (across + down) / 2;
}

/**
 * The ribbons that fit. `free` is the space on each side of the model in cm, or omitted to
 * work it out from the footprint and the surface size (`preview` says there is always room,
 * as in the editor, which shows what the table would get).
 */
export function ribbonBands(input: {
  footprint: [number, number][];
  surface: { width: number; height: number };
  table: NonNullable<SiteInfo['table']>;
  preview?: boolean;
}): Band[] {
  const { footprint, surface, table } = input;
  const px = pixelsPerCm(footprint, table);
  if (!Number.isFinite(px) || px <= 0) return [];
  const xs = footprint.map((p) => p[0]);
  const ys = footprint.map((p) => p[1]);
  const box = { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
  const freePx: Record<Side, number> = {
    top: box.top,
    bottom: surface.height - box.bottom,
    left: box.left,
    right: surface.width - box.right,
  };
  const settings = ribbonSettings(table);
  const front = table.front ?? 'bottom';
  const bands: Band[] = [];
  for (const side of sidesByPreference(front)) {
    const setting = settings[side];
    if (setting === 'off') continue;
    const wanted = setting === 'auto' ? AUTO_CM : setting.cm;
    const room = input.preview ? wanted : Math.max(0, freePx[side] / px - GAP_CM);
    // Auto needs the minimum; a set size is drawn when it, or the minimum, fits.
    if (room < Math.min(wanted, MIN_CM)) continue;
    const cm = Math.min(wanted, room);
    const thick = cm * px;
    const gap = GAP_CM * px;
    const rect =
      side === 'bottom' ? { left: box.left, top: box.bottom + gap, width: box.right - box.left, height: thick }
      : side === 'top' ? { left: box.left, top: box.top - gap - thick, width: box.right - box.left, height: thick }
      : side === 'left' ? { left: box.left - gap - thick, top: box.top, width: thick, height: box.bottom - box.top }
      : { left: box.right + gap, top: box.top, width: thick, height: box.bottom - box.top };
    bands.push({ side, cm, rect, turn: TURN[side], front: side === front });
  }
  return bands;
}

/** How much room the editor's preview keeps around the model per side, as a fraction of the model's width. */
export function previewReserve(table: NonNullable<SiteInfo['table']>): Record<Side, number> {
  const settings = ribbonSettings(table);
  return Object.fromEntries(
    SIDES.map((side) => {
      const setting = settings[side];
      const cm = setting === 'off' ? 0 : (setting === 'auto' ? AUTO_CM : setting.cm) + GAP_CM;
      return [side, cm / table.width_cm];
    }),
  ) as Record<Side, number>;
}
