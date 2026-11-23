// The automatic layout. Panels are placed on the grid first-fit, in priority
// order. When a page is full, by cells or by budget, the rest go to another
// page. A panel is never resized or squeezed to make room.
//
// A short canvas (the controller with a layer's hero open) has fewer rows than
// the full grid, never shorter ones: a panel taller than the rows there are is
// left out, the lowest priority first in line for the next page.

import type { PanelSize } from '@mrstudio/sdk';

import { GRID, SCREEN, SIZES } from './rules.ts';

export interface PackItem<T> {
  item: T;
  size: PanelSize;
  reads: number;
  priority?: number;
  /** A fixed place, from a site page. */
  at?: { col: number; row: number };
  /** The page a fixed panel belongs to. */
  page?: number;
}

export interface Placement<T> {
  item: T;
  /** 1-based, as CSS grid lines. */
  col: number;
  row: number;
  cols: number;
  rows: number;
  reads: number;
}

export interface Page<T> {
  panels: Placement<T>[];
  reads: number;
}

/** Sizes that span the screen sit at the bottom, like the timeline they usually are. */
const DOCKED: PanelSize[] = ['band', 'strip'];

class Cells {
  readonly rows: number;
  private taken: Uint8Array;

  constructor(rows: number) {
    this.rows = rows;
    this.taken = new Uint8Array(GRID.columns * rows);
  }

  fits(col: number, row: number, cols: number, rows: number): boolean {
    if (col < 1 || row < 1 || col + cols - 1 > GRID.columns || row + rows - 1 > this.rows) return false;
    for (let r = row; r < row + rows; r++) for (let c = col; c < col + cols; c++) if (this.taken[(r - 1) * GRID.columns + c - 1]) return false;
    return true;
  }

  take(col: number, row: number, cols: number, rows: number): void {
    for (let r = row; r < row + rows; r++) for (let c = col; c < col + cols; c++) this.taken[(r - 1) * GRID.columns + c - 1] = 1;
  }

  /** The first free place for a panel: reading order, or from the bottom for docked sizes. */
  find(cols: number, rows: number, fromBottom: boolean): { col: number; row: number } | null {
    const last = this.rows - rows + 1;
    for (let i = 0; i < last; i++) {
      const row = fromBottom ? last - i : i + 1;
      for (let col = 1; col <= GRID.columns - cols + 1; col++) if (this.fits(col, row, cols, rows)) return { col, row };
    }
    return null;
  }
}

/**
 * Lays panels out on as many pages as the rules require. `rows` is how many grid rows
 * the canvas has room for (1 to 6); fixed panels from a site's pages always get all six.
 */
export function pack<T>(items: PackItem<T>[], rows: number = GRID.rows): Page<T>[] {
  const gridRows = items.some((entry) => entry.at) ? GRID.rows : Math.max(1, Math.min(GRID.rows, Math.floor(rows)));
  const pages: (Page<T> & { cells: Cells })[] = [];
  const page = (index: number) => {
    while (pages.length <= index) pages.push({ panels: [], reads: 0, cells: new Cells(gridRows) });
    return pages[index]!;
  };
  const put = (target: Page<T> & { cells: Cells }, entry: PackItem<T>, col: number, row: number) => {
    const { cols, rows } = SIZES[entry.size];
    target.cells.take(col, row, cols, rows);
    target.panels.push({ item: entry.item, col, row, cols, rows, reads: entry.reads });
    target.reads += entry.reads;
  };

  // Fixed panels first: a site's pages are taken as written (validatePage has checked them).
  for (const entry of items) {
    if (!entry.at) continue;
    const target = page(entry.page ?? 0);
    const { cols, rows } = SIZES[entry.size];
    if (target.cells.fits(entry.at.col, entry.at.row, cols, rows)) put(target, entry, entry.at.col, entry.at.row);
  }

  const free = items
    .map((entry, order) => ({ entry, order }))
    .filter(({ entry }) => !entry.at)
    .sort((a, b) => (b.entry.priority ?? 0) - (a.entry.priority ?? 0) || a.order - b.order);
  for (const { entry } of free) {
    const { cols, rows } = SIZES[entry.size];
    // A panel that no page could hold (taller than the canvas, or over the screen's budget alone) is left out.
    if (rows > gridRows || entry.reads > SCREEN.reads) continue;
    for (let index = 0; ; index++) {
      const target = page(index);
      if (target.panels.length >= SCREEN.panels || target.reads + entry.reads > SCREEN.reads) continue;
      const place = target.cells.find(cols, rows, DOCKED.includes(entry.size));
      if (!place) continue;
      put(target, entry, place.col, place.row);
      break;
    }
  }
  return pages.filter((p) => p.panels.length > 0).map(({ panels, reads }) => ({ panels, reads }));
}
