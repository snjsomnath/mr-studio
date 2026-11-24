// The controller's theme from the table's palette (#93): the map's accent and category colours on
// the controller and the dashboard too, so the two read as one piece. It is a theme like the
// built-in ones, kept in `tv.theme` under the name `palette`, and rewritten when the palette changes.

import { THEMES, validateTheme } from '@mrstudio/dashboard';
import { resolvePalette } from '@mrstudio/sdk';
import type { SitePalette } from '@mrstudio/sdk';

export const PALETTE_THEME = 'palette';

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** The theme tokens for a palette: Midnight's surfaces with the palette's accent and categories. */
export function paletteTheme(palette: SitePalette | null | undefined): { id: string; name: string; description: string; tokens: Record<string, string> } {
  const { slots, set } = resolvePalette(palette);
  const tokens: Record<string, string> = { ...THEMES[0]!.tokens, 'color.accent': slots.accent };
  // Text on the accent: whichever of dark or white reads better on it.
  tokens['color.accent-ink'] = luminance(slots.accent) > 0.25 ? '#0b0e14' : '#ffffff';
  for (const n of [1, 2, 3, 4, 5, 6] as const) tokens[`data.${n}`] = slots[`cat${n}`];
  // A token the palette makes unreadable falls back to the default theme's, so the controller stays legible.
  for (const issue of validateTheme(tokens)) {
    const name = issue.path.replace(/^theme\./, '');
    if (name in tokens && THEMES[0]!.tokens[name]) tokens[name] = THEMES[0]!.tokens[name]!;
  }
  return { id: PALETTE_THEME, name: 'Table palette', description: `The map's own colours (${set.name}) on the controller too.`, tokens };
}

/** The `site.tv` change that makes the controller follow the palette. */
export function paletteThemeChoice(palette: SitePalette | null | undefined): { tv: object } {
  return { tv: { theme: paletteTheme(palette).tokens, theme_name: PALETTE_THEME } };
}
