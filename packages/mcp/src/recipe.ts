// What a custom layer recipe may say, taken from the SDK the recipe player draws with
// (packages/sdk/src/recipe.ts, palette.ts, marks.ts, place-motions.ts) and the controller's
// icon set. The bundle carries the vocabulary of the commit it was built from, so the server
// refuses exactly what the player would ignore or draw wrongly (#321).

import { ARROWS, ICON_NAMES as MARK_ICONS, POINT_SHAPES } from '../../sdk/src/marks.ts';
import { PALETTE_SETS, PALETTE_SLOTS } from '../../sdk/src/palette.ts';
import { PLACE_MOTION_IDS } from '../../sdk/src/place-motions.ts';
import { LOOK_DEFAULTS, MOTION_DEFAULTS, MOTIONS_FOR, compileLook, lookLegend } from '../../sdk/src/recipe.ts';
import { readShapes } from '../../sdk/src/blocks/sources.ts';
import { resolvePalette } from '../../sdk/src/palette.ts';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ICON_NAMES as BUTTON_ICONS } from '../../runtime/src/editor/icons.ts';

import type { Issue } from './site.ts';

type Look = keyof typeof LOOK_DEFAULTS;

const RAMPS = [...new Set(PALETTE_SETS.flatMap((set) => Object.keys(set.ramps)))];

/** The recipe vocabulary, for the schema resource and for messages. */
export const RECIPE_VOCABULARY = {
  look: Object.fromEntries(Object.entries(LOOK_DEFAULTS).map(([k, v]) => [k, [...Object.keys(v), 'legend']])) as Record<Look, string[]>,
  motion: Object.fromEntries(Object.entries(MOTION_DEFAULTS).map(([k, v]) => [k, Object.keys(v)])) as Record<string, string[]>,
  motions_for: MOTIONS_FOR as Record<Look, string[]>,
  place_motions: [...PLACE_MOTION_IDS],
  palette_slots: [...PALETTE_SLOTS],
  ramps: RAMPS,
  classes: ['continuous', 'equal', 'quantile', 'natural'],
  point_shapes: [...POINT_SHAPES],
  point_icons: [...MARK_ICONS],
  dash: ['solid', 'dashed', 'dotted'],
  arrows: [...ARROWS],
  button_icons: [...BUTTON_ICONS],
  enter: ['cut', 'fade'],
};

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Why a colour is not one the player can draw, or null. `nullable` for stroke, which may be off. */
export function checkPaint(value: unknown, nullable = false): string | null {
  if (value === null && nullable) return null;
  if (typeof value === 'string') {
    if (HEX.test(value)) return null;
    if (value.startsWith('@')) return PALETTE_SLOTS.includes(value.slice(1) as any) ? null : `'${value}' is not a palette slot (${PALETTE_SLOTS.map((s) => `@${s}`).join(', ')})`;
    return `'${value}' is not a colour: use a palette slot such as "@accent", "#rrggbb", or { "by": "<column>", "kind": "category" | "number" }`;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    if (typeof v.by !== 'string' || !v.by) return "a colour by a column needs 'by': the column's name";
    if (v.kind !== 'category' && v.kind !== 'number') return "a colour by a column needs 'kind': \"category\" or \"number\"";
    if (v.ramp !== undefined && !RAMPS.includes(String(v.ramp))) return `'${v.ramp}' is not a ramp; the ramps are ${RAMPS.join(', ')}`;
    if (v.classes !== undefined && !RECIPE_VOCABULARY.classes.includes(String(v.classes))) return `classes is one of ${RECIPE_VOCABULARY.classes.join(', ')}`;
    if (v.count !== undefined && !(Number.isInteger(v.count) && (v.count as number) >= 2 && (v.count as number) <= 7)) return 'count is a whole number from 2 to 7';
    if (v.colors !== undefined) {
      if (!v.colors || typeof v.colors !== 'object') return 'colors maps each value to a colour';
      for (const [k, c] of Object.entries(v.colors as Record<string, unknown>)) {
        const why = checkPaint(c);
        if (why) return `colors.${k}: ${why}`;
      }
    }
    return null;
  }
  return 'is not a colour';
}

/** Why an icon name is not one the controller draws (it would fall back to the layers icon), or null. */
export function checkIcon(value: unknown): string | null {
  if (typeof value !== 'string') return 'an icon is a name, such as "sun"';
  return BUTTON_ICONS.includes(value) ? null : `'${value}' is not in the icon set, so the controller draws its fallback; use one of ${BUTTON_ICONS.join(', ')}`;
}

/** Checks a recipe's blocks and props against the player. Data and `on` references are checked by the caller. */
export function checkRecipe(recipe: Record<string, any>, at: string): Issue[] {
  const issues: Issue[] = [];
  const err = (path: string, message: string) => issues.push({ level: 'error', path, message });
  const warn = (path: string, message: string) => issues.push({ level: 'warning', path, message });

  if (recipe.icon !== undefined) {
    const why = checkIcon(recipe.icon);
    if (why) warn(`${at}.icon`, why);
  }
  if (recipe.enter !== undefined && !RECIPE_VOCABULARY.enter.includes(recipe.enter)) err(`${at}.enter`, "is 'cut' or 'fade'");

  const kinds = new Map<string, Look>();
  (Array.isArray(recipe.look) ? recipe.look : []).forEach((block: any, n: number) => {
    const here = `${at}.look[${n}]`;
    if (typeof block?.block !== 'string') return;
    if (block.block === 'raster') return warn(`${here}.block`, "a raster look (a WMS or tile map) is saved, but the recipe player does not draw it yet; show the map with the wms layer instead");
    if (!(block.block in LOOK_DEFAULTS)) return err(`${here}.block`, `'${block.block}' is not a look block; the looks are ${Object.keys(LOOK_DEFAULTS).join(', ')} (the table is 2D, so there is no extrusion)`);
    const kind = block.block as Look;
    if (typeof block.id === 'string') kinds.set(block.id, kind);
    const props = block.props ?? {};
    if (!props || typeof props !== 'object' || Array.isArray(props)) return err(`${here}.props`, 'must be an object');
    const known = RECIPE_VOCABULARY.look[kind];
    for (const [key, value] of Object.entries(props as Record<string, unknown>)) {
      const p = `${here}.props.${key}`;
      if (!known.includes(key)) {
        err(p, `a ${kind} look has no '${key}'; its props are ${known.join(', ')}`);
        continue;
      }
      if (key === 'color') {
        const why = checkPaint(value);
        if (why) err(p, why);
      } else if (key === 'stroke') {
        const why = checkPaint(value, true);
        if (why) err(p, why);
      } else if (key === 'shape' && !POINT_SHAPES.includes(value as any)) err(p, `is one of ${POINT_SHAPES.join(', ')}`);
      else if (key === 'icon' && !MARK_ICONS.includes(String(value))) err(p, `'${value}' is not a pictogram; they are ${MARK_ICONS.join(', ')}`);
      else if (key === 'dash' && !RECIPE_VOCABULARY.dash.includes(String(value))) err(p, `is one of ${RECIPE_VOCABULARY.dash.join(', ')}`);
      else if (key === 'arrows' && !ARROWS.includes(value as any)) err(p, `is one of ${ARROWS.join(', ')}`);
      else if (['opacity', 'glow', 'edge_glow'].includes(key) && !(typeof value === 'number' && value >= 0 && value <= 1)) err(p, 'is a number from 0 to 1');
    }
  });

  (Array.isArray(recipe.motion) ? recipe.motion : []).forEach((block: any, n: number) => {
    const here = `${at}.motion[${n}]`;
    if (typeof block?.block !== 'string') return;
    const known = RECIPE_VOCABULARY.motion[block.block];
    if (!known) return err(`${here}.block`, `'${block.block}' is not a motion block; the motions are ${Object.keys(MOTION_DEFAULTS).join(', ')}`);
    const look = typeof block.on === 'string' ? kinds.get(block.on) : undefined;
    if (look && !MOTIONS_FOR[look].includes(block.block)) err(`${here}.block`, `'${block.block}' does not act on a ${look} look; a ${look} look takes ${MOTIONS_FOR[look].join(', ')}`);
    const props = block.props ?? {};
    if (!props || typeof props !== 'object' || Array.isArray(props)) return err(`${here}.props`, 'must be an object');
    if (block.block === 'place') {
      if (props.motion !== undefined && !PLACE_MOTION_IDS.includes(String(props.motion))) err(`${here}.props.motion`, `'${props.motion}' is not a place motion; they are ${PLACE_MOTION_IDS.join(', ')}`);
      return; // A place motion's other props are its own knobs.
    }
    for (const key of Object.keys(props)) if (!known.includes(key)) err(`${here}.props.${key}`, `a ${block.block} motion has no '${key}'; its props are ${known.join(', ')}`);
  });

  if (Array.isArray(recipe.interaction) && recipe.interaction.length) {
    warn(`${at}.interaction`, "the recipe player does not draw interaction blocks yet; they are saved but do nothing on the table (a sound motion's tap works without one)");
  }
  return issues;
}

/** GeoJSON (or a CSV of points) from a site file, or null when it cannot be read. */
function readGeo(file: string): any | null {
  try {
    const text = readFileSync(file, 'utf8');
    if (/\.csv$/i.test(file)) {
      const [head, ...rows] = text.trim().split(/\r?\n/);
      const keys = (head ?? '').split(',').map((k) => k.trim().replace(/^"|"$/g, ''));
      const lon = keys.findIndex((k) => ['lon', 'lng', 'long', 'longitude', 'x'].includes(k.toLowerCase()));
      const lat = keys.findIndex((k) => ['lat', 'latitude', 'y'].includes(k.toLowerCase()));
      if (lon < 0 || lat < 0) return null;
      return {
        type: 'FeatureCollection',
        features: rows.map((r) => r.split(',')).map((cells) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [Number(cells[lon]), Number(cells[lat])] }, properties: Object.fromEntries(keys.map((k, i) => [k, cells[i]])) })),
      };
    }
    const parsed = JSON.parse(text);
    return parsed?.type === 'FeatureCollection' && Array.isArray(parsed.features) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The legend the controller shows for a recipe, worked out as the editor's layer builder does:
 * each look compiled against its data, so every colour on the table has its swatch. Null when
 * no look could be read (data missing, a WMS map, or no looks), or when a look is a raster:
 * the table works that legend out from the raster itself (#622).
 */
export function legendFor(recipe: Record<string, any>, dir: string, siteData: Record<string, unknown> = {}, palette?: unknown): { id: string; label: string; color?: string; shape?: string }[] | null {
  const data: any[] = Array.isArray(recipe.data) ? recipe.data : [];
  const frame = { toTable: (c: [number, number]) => c } as any;
  const blocks: any[] = Array.isArray(recipe.look) ? recipe.look : [];
  if (blocks.some((block) => block?.block === 'raster')) return null;
  const parts: { block: any; rows: any[] }[] = [];
  for (const block of blocks) {
    if (!block || !(block.block in LOOK_DEFAULTS)) continue;
    const entry = data.find((d) => d?.id === block.data);
    const path = entry?.dataset ? siteData[entry.dataset] : entry?.path;
    if (typeof path !== 'string' || !existsSync(join(dir, path))) continue;
    const geo = readGeo(join(dir, path));
    if (!geo) continue;
    try {
      const look = compileLook(block, readShapes(geo, frame), resolvePalette(palette as any), 1);
      if (look) parts.push({ block, rows: look.legend });
    } catch {
      // A look the player cannot compile gives no swatch; checkRecipe reports why.
    }
  }
  if (!parts.length) return null;
  return lookLegend(parts).slice(0, 12) as any;
}
