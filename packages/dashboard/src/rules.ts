// The rules of the TV dashboard. These are core: a site can restyle the dashboard
// (see theme.ts) but cannot change anything in this file.
// The reasoning behind each number is in docs/DASHBOARD.md.

import type { PanelSize } from '@mrstudio/sdk';

/** The canvas is always 12 columns by 6 rows, whatever the screen. */
export const GRID = { columns: 12, rows: 6 } as const;

/**
 * The closed set of panel sizes. `reads` is the panel's density budget: how many
 * separate things a visitor is asked to read in it (see `reads` in each widget).
 */
export const SIZES: Record<PanelSize, { cols: number; rows: number; reads: number; use: string }> = {
  chip: { cols: 2, rows: 1, reads: 1, use: 'One short value' },
  tile: { cols: 3, rows: 2, reads: 3, use: 'One headline number with context' },
  wide: { cols: 6, rows: 2, reads: 5, use: 'A small comparison or a short trend' },
  tall: { cols: 3, rows: 4, reads: 6, use: 'A ranked list' },
  block: { cols: 6, rows: 4, reads: 8, use: 'One chart' },
  hero: { cols: 9, rows: 4, reads: 10, use: 'The one chart the page is about' },
  band: { cols: 12, rows: 1, reads: 3, use: 'A timeline or a colour key across the screen' },
  strip: { cols: 12, rows: 2, reads: 6, use: 'A trend across the screen' },
};

export const PANEL_SIZES = Object.keys(SIZES) as PanelSize[];

/** What one screen may hold at once. More than this goes to another page; nothing shrinks. */
export const SCREEN = { reads: 24, panels: 8 } as const;

/** Longest text, in characters. Longer literals are refused; longer live values are cut with an ellipsis. */
export const TEXT = { title: 28, label: 20, unit: 6, caption: 40, value: 8, line: 64 } as const;

/** Categorical data colours a widget may use: slots 1 to 6 of the theme, in order. */
export const DATA_SLOTS = 6;

/** Seconds a page stays up when the panels need more than one. */
export const ROTATE_S = { default: 12, min: 6, max: 60 } as const;

/**
 * The table's ribbon (#78): a strip of a few small panels in the projector's blank space
 * beside the model. It is read in passing, standing at the table, so it holds less than a screen.
 */
export const RIBBON = { sizes: ['chip', 'tile', 'wide'] as PanelSize[], panels: 4, reads: 10 } as const;
