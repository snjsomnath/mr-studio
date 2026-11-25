/**
 * The controller's hand-made pages (#155), as data: where a panel fits on the 12 by 6 grid, what
 * a page spends of the screen's budget, and a new panel that starts from its widget's example.
 * The page editor (pages-editor.ts) draws these; nothing here touches the page, so the tests read it.
 *
 * Nothing is dragged (docs/editor-ui.md, rule 7): a panel goes in the first free place, is moved
 * a cell at a time with buttons or the arrow keys, or is put where an empty cell is clicked.
 */
import { GRID, panelReads, SCREEN, SIZES, TEXT } from '@mrstudio/dashboard';
import type { WidgetDefinition, WidgetRegistry } from '@mrstudio/dashboard';
import type { PanelSize, PanelSpec } from '@mrstudio/sdk';

export interface Page {
  id: string;
  title?: string;
  panels: PanelSpec[];
}

export interface Cell {
  col: number;
  row: number;
}

/** True when a panel of `size` at `at` stays on the grid and covers no other panel (but `except`). */
export function fits(panels: readonly PanelSpec[], size: PanelSize, at: Cell, except?: string): boolean {
  const s = SIZES[size];
  if (!s || at.col < 1 || at.row < 1 || at.col + s.cols - 1 > GRID.columns || at.row + s.rows - 1 > GRID.rows) return false;
  return panels.every((p) => {
    if (p.id === except || !p.at) return true;
    const o = SIZES[p.size];
    if (!o) return true;
    return at.col + s.cols <= p.at.col || p.at.col + o.cols <= at.col || at.row + s.rows <= p.at.row || p.at.row + o.rows <= at.row;
  });
}

/** The first place, row by row, where a panel of `size` fits; null when the page is full for it. */
export function freeSpot(panels: readonly PanelSpec[], size: PanelSize, except?: string): Cell | null {
  for (let row = 1; row <= GRID.rows; row++) {
    for (let col = 1; col <= GRID.columns; col++) if (fits(panels, size, { col, row }, except)) return { col, row };
  }
  return null;
}

/** What a page spends of the screen: reads and panels, against 24 and 8. */
export function pageBudget(page: Page, registry: WidgetRegistry): { reads: number; panels: number } {
  let reads = 0;
  for (const spec of page.panels) {
    const widget = registry.get(spec.widget);
    if (widget) reads += panelReads(spec, widget);
  }
  return { reads, panels: page.panels.length };
}

/** An id not yet used on any page: `stat`, then `stat-2`… */
export function freeId(pages: readonly Page[], base: string): string {
  const used = new Set(pages.flatMap((p) => p.panels.map((s) => s.id)).concat(pages.map((p) => p.id)));
  const clean = base.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'panel';
  for (let n = 1; ; n++) {
    const id = n === 1 ? clean : `${clean}-${n}`;
    if (!used.has(id)) return id;
  }
}

/**
 * A new panel of `widget` for `page`: its smallest size that still fits the grid and the budget,
 * its example props and its name as the title. Null with the reason when it can't go on the page.
 */
export function newPanel(pages: readonly Page[], page: Page, widget: WidgetDefinition, registry: WidgetRegistry): PanelSpec | string {
  if (page.panels.length >= SCREEN.panels) return `A page holds at most ${SCREEN.panels} panels. Add another page.`;
  const spent = pageBudget(page, registry).reads;
  for (const size of widget.sizes) {
    const at = freeSpot(page.panels, size);
    if (!at) continue;
    const spec: PanelSpec = { id: freeId(pages, widget.type.split('/').pop() ?? 'panel'), widget: widget.type, size, title: clip(widget.name, TEXT.title), props: structuredClone(widget.example ?? {}), at };
    const reads = panelReads(spec, widget);
    // The example must fit the panel's own budget too: a stat with context and a change is a tile, not a chip.
    if (reads <= SIZES[size].reads && spent + reads <= SCREEN.reads) return spec;
  }
  return widget.sizes.some((size) => freeSpot(page.panels, size)) ? `The page has ${SCREEN.reads - spent} reads left, too few for ${widget.name}. Add another page.` : `No room for ${widget.name} on this page. Make a panel smaller or add another page.`;
}

/** The panel moved by whole cells, or null when it would leave the grid or cover another. */
export function moved(panels: readonly PanelSpec[], spec: PanelSpec, dcol: number, drow: number): Cell | null {
  if (!spec.at) return null;
  const at = { col: spec.at.col + dcol, row: spec.at.row + drow };
  return fits(panels, spec.size, at, spec.id) ? at : null;
}

/** Sizes the panel can change to where it is (or nearby, moved left or up to stay on the grid). */
export function resized(panels: readonly PanelSpec[], spec: PanelSpec, size: PanelSize): Cell | null {
  const at = spec.at ?? { col: 1, row: 1 };
  const s = SIZES[size];
  const start = { col: Math.min(at.col, GRID.columns - s.cols + 1), row: Math.min(at.row, GRID.rows - s.rows + 1) };
  return fits(panels, size, start, spec.id) ? start : freeSpot(panels, size, spec.id);
}

function clip(text: string, max: number): string {
  return [...text].length <= max ? text : `${[...text].slice(0, max - 1).join('').trimEnd()}…`;
}
