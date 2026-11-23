// What a site may restyle. These are the style tokens; everything else about the
// dashboard (grid, sizes, type scale, spacing, budgets) is a rule and has no token.
// A theme is a flat map in site.json: "tv": { "theme": { "color.accent": "#ff5a36" } }.

import type { Issue } from './validate.ts';

type TokenSpec =
  | { kind: 'color'; css: string; default: string; label: string; contrast?: { against: string[]; min: number } }
  | { kind: 'font'; css: string; default: string; label: string }
  | { kind: 'enum'; css: string; default: string; label: string; options: Record<string, string> };

const FONT = "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
const onSurfaces = (min: number) => ({ against: ['color.background', 'color.panel'], min });

/** Every style token, with its default (the core dark theme). */
export const STYLE_TOKENS: Record<string, TokenSpec> = {
  'color.background': { kind: 'color', css: '--mrs-bg', default: '#0b0e14', label: 'Screen background' },
  'color.panel': { kind: 'color', css: '--mrs-panel', default: '#161b28', label: 'Panel surface' },
  'color.line': { kind: 'color', css: '--mrs-line', default: '#2a3246', label: 'Hairlines and tracks' },
  'color.text': { kind: 'color', css: '--mrs-text', default: '#eef1f7', label: 'Text', contrast: onSurfaces(7) },
  'color.muted': { kind: 'color', css: '--mrs-muted', default: '#a3aec4', label: 'Secondary text', contrast: onSurfaces(4.5) },
  'color.accent': { kind: 'color', css: '--mrs-accent', default: '#ffc857', label: 'Accent: now, active', contrast: onSurfaces(3) },
  'color.accent-ink': { kind: 'color', css: '--mrs-accent-ink', default: '#1c1505', label: 'Text on the accent', contrast: { against: ['color.accent'], min: 4.5 } },
  'color.good': { kind: 'color', css: '--mrs-good', default: '#0ca30c', label: 'Status: good', contrast: onSurfaces(3) },
  'color.warn': { kind: 'color', css: '--mrs-warn', default: '#fab219', label: 'Status: warning', contrast: onSurfaces(3) },
  'color.bad': { kind: 'color', css: '--mrs-bad', default: '#e66767', label: 'Status: bad', contrast: onSurfaces(3) },
  'data.1': { kind: 'color', css: '--mrs-data-1', default: '#3987e5', label: 'Data colour 1', contrast: onSurfaces(3) },
  'data.2': { kind: 'color', css: '--mrs-data-2', default: '#d95926', label: 'Data colour 2', contrast: onSurfaces(3) },
  'data.3': { kind: 'color', css: '--mrs-data-3', default: '#199e70', label: 'Data colour 3', contrast: onSurfaces(3) },
  'data.4': { kind: 'color', css: '--mrs-data-4', default: '#c98500', label: 'Data colour 4', contrast: onSurfaces(3) },
  'data.5': { kind: 'color', css: '--mrs-data-5', default: '#d55181', label: 'Data colour 5', contrast: onSurfaces(3) },
  'data.6': { kind: 'color', css: '--mrs-data-6', default: '#0ca30c', label: 'Data colour 6', contrast: onSurfaces(3) },
  'font.text': { kind: 'font', css: '--mrs-font', default: FONT, label: 'Typeface' },
  'font.number': { kind: 'font', css: '--mrs-font-number', default: FONT, label: 'Typeface for headline numbers' },
  'shape.radius': { kind: 'enum', css: '--mrs-radius', default: 'medium', label: 'Panel corners', options: { none: '0', small: 'calc(0.6 * var(--mrs-u))', medium: 'calc(1.2 * var(--mrs-u))', large: 'calc(2.2 * var(--mrs-u))' } },
  'panel.style': { kind: 'enum', css: '--mrs-panel-style', default: 'filled', label: 'Panel treatment', options: { filled: 'filled', outlined: 'outlined', glass: 'glass', plain: 'plain' } },
  // The look beyond colour (#126): how the controller's layer buttons are drawn, and how much chrome there is.
  'rail.look': { kind: 'enum', css: '--mrs-rail-look', default: 'tiles', label: 'Layer buttons', options: { tiles: 'tiles', bare: 'bare' } },
  density: { kind: 'enum', css: '--mrs-density', default: 'comfortable', label: 'Chrome', options: { comfortable: 'comfortable', minimal: 'minimal' } },
};

/** Enum tokens that are not lengths: the canvas and the controller show them as data attributes. */
export const LOOK_ATTRIBUTES: Record<string, string> = { '--mrs-panel-style': 'panelStyle', '--mrs-rail-look': 'railLook', '--mrs-density': 'density' };

const HEX = /^#[0-9a-fA-F]{6}$/;
/** Family names only. A font is a look, not a way to load something. */
const FAMILY = /^[A-Za-z0-9 ,'"-]{1,120}$/;

/** WCAG relative luminance of a #rrggbb colour. */
export function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG contrast ratio between two #rrggbb colours, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Checks a site's theme. A site may choose any colours and typefaces it likes,
 * as long as text stays readable from across the room and data colours stay
 * visible on the panels.
 */
export function validateTheme(theme: Record<string, unknown> | null | undefined): Issue[] {
  const issues: Issue[] = [];
  const merged: Record<string, string> = Object.fromEntries(Object.entries(STYLE_TOKENS).map(([name, spec]) => [name, spec.default]));
  for (const [name, value] of Object.entries(theme ?? {})) {
    const path = `theme.${name}`;
    const spec = STYLE_TOKENS[name];
    if (!spec) {
      issues.push({ path, rule: 'schema', message: 'is not a style token. Sizes, spacing and the grid are rules and cannot be themed' });
    } else if (typeof value !== 'string') {
      issues.push({ path, rule: 'schema', message: 'must be text' });
    } else if (spec.kind === 'color' && !HEX.test(value)) {
      issues.push({ path, rule: 'schema', message: 'must be a #rrggbb colour' });
    } else if (spec.kind === 'font' && !FAMILY.test(value)) {
      issues.push({ path, rule: 'schema', message: 'must be a list of font family names' });
    } else if (spec.kind === 'enum' && !(value in spec.options)) {
      issues.push({ path, rule: 'schema', message: `must be one of ${Object.keys(spec.options).join(', ')}` });
    } else {
      merged[name] = value;
    }
  }
  for (const [name, spec] of Object.entries(STYLE_TOKENS)) {
    if (spec.kind !== 'color' || !spec.contrast) continue;
    for (const other of spec.contrast.against) {
      const ratio = contrast(merged[name]!, merged[other]!);
      if (ratio < spec.contrast.min) {
        issues.push({ path: `theme.${name}`, rule: 'text', message: `has a contrast of ${ratio.toFixed(1)} against ${other}; it needs ${spec.contrast.min}` });
      }
    }
  }
  return issues;
}

/**
 * The CSS custom properties for a theme. A theme that breaks a rule cannot make
 * the screen unreadable: if any colour is refused the whole colour set falls back
 * to the default (colours only work as a set), and a refused font or shape falls
 * back on its own.
 */
export function themeVariables(theme: Record<string, unknown> | null | undefined): { variables: Record<string, string>; issues: Issue[] } {
  const issues = validateTheme(theme);
  const rejected = new Set(issues.map((issue) => issue.path.slice('theme.'.length)));
  const coloursRejected = [...rejected].some((name) => STYLE_TOKENS[name]?.kind === 'color');
  const variables: Record<string, string> = {};
  for (const [name, spec] of Object.entries(STYLE_TOKENS)) {
    const given = theme?.[name];
    const refused = rejected.has(name) || (spec.kind === 'color' && coloursRejected);
    const value = typeof given === 'string' && !refused ? given : spec.default;
    variables[spec.css] = spec.kind === 'enum' ? spec.options[value]! : value;
  }
  return { variables, issues };
}
