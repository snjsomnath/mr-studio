// Fields made from data rather than from a kernel: a heat map of points, the combined
// pull of attractors. They come out as a FieldFrame, the same thing a kernel stream
// delivers, so they are drawn with `ctx.map.addField` and coloured on the GPU, and
// everything that reads a field (probes, particles) works on both kinds.

import type { FieldFrame, SiteInfo } from '../types.ts';
import type { Point } from './geo.ts';
import type { Particle, Steering } from './motion.ts';

/** A raster covering the table: `width` by `height` cells of `cell_m` metres, row 0 at the top. */
export interface Raster {
  width: number;
  height: number;
  cell_m: number;
}

/** A raster over the site's extent. `cell_m` defaults to four engine cells, plenty for a smooth data field. */
export function siteRaster(site: Pick<SiteInfo, 'extent' | 'grid'>, cell_m = site.grid.cell_m * 4): Raster {
  return { width: Math.max(1, Math.round(site.extent.width_m / cell_m)), height: Math.max(1, Math.round(site.extent.height_m / cell_m)), cell_m };
}

function frame(raster: Raster, data: Float32Array): FieldFrame {
  let min = Infinity;
  let max = -Infinity;
  for (const v of data) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min > max) min = max = 0;
  return { stream: 0, field: 0, width: raster.width, height: raster.height, revision: 0, min, max, progress: 1, data };
}

/**
 * A heat field: every point spreads its weight over its surroundings with a smooth
 * bump of `radius_m`, and overlapping bumps add up. Density of anything countable:
 * visitors, trips, complaints, trees.
 */
export function heatField(points: readonly { point: Point; weight?: number }[], raster: Raster, radius_m: number): FieldFrame {
  const data = new Float32Array(raster.width * raster.height);
  const reach = Math.max(1, Math.ceil(radius_m / raster.cell_m));
  for (const { point, weight = 1 } of points) {
    const cx = point[0] / raster.cell_m - 0.5;
    const cy = point[1] / raster.cell_m - 0.5;
    const col0 = Math.max(0, Math.floor(cx - reach));
    const col1 = Math.min(raster.width - 1, Math.ceil(cx + reach));
    const row0 = Math.max(0, Math.floor(cy - reach));
    const row1 = Math.min(raster.height - 1, Math.ceil(cy + reach));
    for (let row = row0; row <= row1; row++) {
      for (let col = col0; col <= col1; col++) {
        const d2 = ((col - cx) ** 2 + (row - cy) ** 2) / (reach * reach);
        if (d2 >= 1) continue;
        // (1 - d²)², a compact bump that reaches zero exactly at the radius.
        data[row * raster.width + col]! += weight * (1 - d2) * (1 - d2);
      }
    }
  }
  return frame(raster, data);
}

/**
 * The pull of a set of attractors at every cell: each contributes its weight,
 * falling off with distance as `1 / (1 + (d / radius)²)`. High where places compete
 * for attention, and its uphill direction is where a crowd would drift.
 */
export function gravityField(attractors: readonly { point: Point; weight: number }[], raster: Raster, radius_m: number): FieldFrame {
  const data = new Float32Array(raster.width * raster.height);
  for (let row = 0; row < raster.height; row++) {
    const y = (row + 0.5) * raster.cell_m;
    for (let col = 0; col < raster.width; col++) {
      const x = (col + 0.5) * raster.cell_m;
      let sum = 0;
      for (const a of attractors) {
        const d2 = ((a.point[0] - x) ** 2 + (a.point[1] - y) ** 2) / (radius_m * radius_m);
        sum += a.weight / (1 + d2);
      }
      data[row * raster.width + col] = sum;
    }
  }
  return frame(raster, data);
}

function value(field: FieldFrame, index: number): number {
  const raw = field.data[index] ?? 0;
  return field.data instanceof Uint8Array ? field.min + (raw / 255) * (field.max - field.min) : raw;
}

/**
 * The value of a field at a point on the table, in field units, interpolated
 * between cells. Works for kernel frames and data fields alike; the field is
 * assumed to cover the whole table, as every engine field does.
 */
export function sampleField(field: FieldFrame, tableWidth_m: number, point: Point): number {
  const cell = tableWidth_m / field.width;
  const fx = Math.min(field.width - 1, Math.max(0, point[0] / cell - 0.5));
  const fy = Math.min(field.height - 1, Math.max(0, point[1] / cell - 0.5));
  const col = Math.min(field.width - 2, Math.floor(fx));
  const row = Math.min(field.height - 2, Math.floor(fy));
  if (field.width < 2 || field.height < 2) return value(field, Math.round(fy) * field.width + Math.round(fx));
  const tx = fx - col;
  const ty = fy - row;
  const i = row * field.width + col;
  const top = value(field, i) * (1 - tx) + value(field, i + 1) * tx;
  const bottom = value(field, i + field.width) * (1 - tx) + value(field, i + field.width + 1) * tx;
  return top * (1 - ty) + bottom * ty;
}

/** The uphill direction and steepness of a field at a point, per metre. */
export function fieldGradient(field: FieldFrame, tableWidth_m: number, point: Point): [number, number] {
  const h = tableWidth_m / field.width;
  const at = (dx: number, dy: number) => sampleField(field, tableWidth_m, [point[0] + dx, point[1] + dy]);
  return [(at(h, 0) - at(-h, 0)) / (2 * h), (at(0, h) - at(0, -h)) / (2 * h)];
}

/**
 * Steering that climbs (or with `downhill`, descends) a field: particles drift
 * towards high attraction, or run downhill over terrain. The field can be swapped
 * at any time by returning a new one from `current`.
 */
export function followField(current: () => FieldFrame | null, tableWidth_m: number, options: { speed: number; downhill?: boolean }): Steering {
  return (p: Particle) => {
    const field = current();
    if (!field) return [0, 0];
    const [gx, gy] = fieldGradient(field, tableWidth_m, [p.x, p.y]);
    const size = Math.hypot(gx, gy);
    if (size < 1e-12) return [0, 0];
    const sign = options.downhill ? -1 : 1;
    return [(gx / size) * options.speed * sign, (gy / size) * options.speed * sign];
  };
}

/**
 * Contour lines of a field at the given levels, as line segments in table metres
 * (marching squares). Draw them over a field to make its shape readable from the
 * far side of a table.
 */
export function contours(field: FieldFrame, tableWidth_m: number, levels: readonly number[]): { level: number; segments: [Point, Point][] }[] {
  const cell = tableWidth_m / field.width;
  const at = (col: number, row: number) => value(field, row * field.width + col);
  const position = (col: number, row: number): [number, number] => [(col + 0.5) * cell, (row + 0.5) * cell];
  return levels.map((level) => {
    const segments: [Point, Point][] = [];
    for (let row = 0; row < field.height - 1; row++) {
      for (let col = 0; col < field.width - 1; col++) {
        const v = [at(col, row), at(col + 1, row), at(col + 1, row + 1), at(col, row + 1)] as const;
        const corners = [position(col, row), position(col + 1, row), position(col + 1, row + 1), position(col, row + 1)] as const;
        const crossings: Point[] = [];
        for (let e = 0; e < 4; e++) {
          const a = v[e]!;
          const b = v[(e + 1) % 4]!;
          if (a >= level === b >= level) continue;
          const t = (level - a) / (b - a);
          const p = corners[e]!;
          const q = corners[(e + 1) % 4]!;
          crossings.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
        }
        if (crossings.length === 2) segments.push([crossings[0]!, crossings[1]!]);
        else if (crossings.length === 4) {
          // A saddle: pair the crossings by the cell's average so lines do not cross.
          const high = (v[0] + v[1] + v[2] + v[3]) / 4 >= level;
          const first = v[0] >= level === high ? [0, 1, 2, 3] : [0, 3, 1, 2];
          segments.push([crossings[first[0]!]!, crossings[first[1]!]!], [crossings[first[2]!]!, crossings[first[3]!]!]);
        }
      }
    }
    return { level, segments };
  });
}
