// The raster look of a custom layer (#601): a GeoTIFF of values (soil depth, rock surface
// height, noise, a temperature) laid on the table's grid by the host (`/api/data/field`) and
// coloured by value with the palette's ramps and classes, like a numeric column of a vector
// look. Two cut-offs hide the cells below or above a value, and a visitor's slider can move
// them: a soil-depth raster becomes "Dig", where the ground peels away metre by metre and the
// layers below show through. The cut's edge can glow, so the change reads on the table.
//
// The frames are drawn with `ctx.map.addField`, coloured on the GPU, and only rebuilt when a
// prop or the data changes, never per frame (#596). Everything stays 2D, from straight above.

import { LOOK_DEFAULTS, paintScale } from './recipe.ts';
import type { Paint, PaintBy } from './recipe.ts';
import type { Colormap } from './colormap.ts';
import { paletteColour } from './palette.ts';
import type { ResolvedPalette } from './palette.ts';
import type { FieldFrame, LegendItem } from './types.ts';

export interface RasterProps {
  /** By value (always `by: "value"`, `kind: "number"`): ramp, classes, middle. A fixed colour paints every cell alike. */
  color: Paint;
  opacity: number;
  /** Hide cells below this value (null: none hidden). A bound slider makes it Dig. */
  hide_below: number | null;
  /** Hide cells above this value (null: none hidden). */
  hide_above: number | null;
  /** A glow along the cut, 0 to 1, in `edge_color`. */
  edge_glow: number;
  edge_color: string;
  /** Words after numbers in the legend: `m`, `dB`. */
  unit: string;
}

export const RASTER_DEFAULTS: RasterProps = LOOK_DEFAULTS.raster;

/** The props of a raster look over its defaults, with control overrides applied. */
export function rasterProps(props: Record<string, unknown> | undefined, overrides: Record<string, unknown> = {}): RasterProps {
  const merged = { ...RASTER_DEFAULTS, ...(props ?? {}), ...overrides } as RasterProps;
  const number = (v: unknown) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  return { ...merged, hide_below: number(merged.hide_below), hide_above: number(merged.hide_above), opacity: Number(merged.opacity) || 0, edge_glow: Number(merged.edge_glow) || 0 };
}

/** What a raster look draws: its coloured frame, the glowing cut, and their legend. */
export interface RasterPicture {
  frame: FieldFrame;
  colormap: Colormap;
  /** Cells along the cut, 0 or 1; null when nothing is cut or the glow is off. */
  edge: FieldFrame | null;
  edgeColormap: Colormap;
  legend: LegendItem[];
  /** The values on the table, low and high, for sliders. */
  range: [number, number];
}

/** Levels of colour a frame carries: 0 is "hidden", 1 to 255 the values from low to high. */
const LEVELS = 255;

/** Up to `most` values of the field, spread evenly, for classes and a legend. */
export function rasterSample(field: Pick<FieldFrame, 'data'>, most = 4000): number[] {
  const out: number[] = [];
  const data = field.data;
  const step = Math.max(1, Math.floor(data.length / most));
  for (let i = 0; i < data.length; i += step) {
    const v = data[i]!;
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

function hex(n: number): string {
  return Math.round(Math.min(255, Math.max(0, n)))
    .toString(16)
    .padStart(2, '0');
}

/**
 * Colours a field of exact values for the table: each cell a level of the look's ramp (or its
 * class), the cells past a cut-off left empty, and the cells just inside the cut marked for the
 * glow. `field` is a frame of f32 values with NaN where there is no data.
 */
export function rasterPicture(field: FieldFrame, props: RasterProps, palette: ResolvedPalette): RasterPicture {
  const values = field.data;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (lo > hi) lo = hi = 0;
  const span = hi - lo || 1;
  const sample = rasterSample(field).map((value) => ({ value }));
  const paint: Paint = typeof props.color === 'string' ? props.color : ({ ...(props.color as PaintBy), by: 'value', kind: 'number' } as PaintBy);
  const scale = paintScale(paint, sample, palette);

  // One colour per level, from the scale at the level's middle value: classes, ramps and the middle all hold.
  const stops: Colormap['stops'] = [[0, 0, 0, 0, 0]];
  for (let level = 1; level <= LEVELS; level++) {
    const value = lo + ((level - 1) / (LEVELS - 1)) * span;
    const [r, g, b, a = 1] = scale.colour({ value });
    stops.push([level / LEVELS, r, g, b, Math.round(255 * Math.min(1, a))]);
  }
  const below = props.hide_below;
  const above = props.hide_above;
  const data = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (!Number.isFinite(v) || (below !== null && v < below) || (above !== null && v > above)) continue;
    data[i] = 1 + Math.round(((v - lo) / span) * (LEVELS - 1));
  }

  // The glow: cells within a band of the cut on the side that stays, a soft line where the ground was cut.
  let edge: FieldFrame | null = null;
  const cuts = (below !== null && below > lo) || (above !== null && above < hi);
  if (props.edge_glow > 0 && cuts) {
    const band = span / 40;
    const glow = new Uint8Array(values.length);
    let any = false;
    for (let i = 0; i < values.length; i++) {
      const v = values[i]!;
      if (!Number.isFinite(v) || data[i] === 0) continue;
      const near = (below !== null && v - below < band) || (above !== null && above - v < band);
      if (near) {
        glow[i] = 255;
        any = true;
      }
    }
    if (any) edge = { ...field, min: 0, max: 1, data: glow };
  }
  const [er, eg, eb] = paletteColour(props.edge_color, palette, 'focus');
  const edgeColormap: Colormap = { stops: [[0, er, eg, eb, 0], [1, er, eg, eb, Math.round(255 * Math.min(1, props.edge_glow))]] };

  const unit = props.unit ? ` ${props.unit}` : '';
  const legend: LegendItem[] = scale.legend.map((row, i) => ({ id: `raster-${i}`, label: `${row.label}${unit}`, color: row.color, shape: 'fill' }));
  if (typeof props.color === 'string') {
    const [r, g, b] = paletteColour(props.color, palette, 'accent');
    legend.push({ id: 'raster-0', label: props.unit || 'Value', color: `#${hex(r)}${hex(g)}${hex(b)}`, shape: 'fill' });
  }
  return { frame: { ...field, min: 0, max: 1, data }, colormap: { stops }, edge, edgeColormap, legend, range: [lo, hi] };
}
