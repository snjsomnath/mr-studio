// Polygons filled into a mask of the site grid (#492): roofs and water for layers that need to know
// what covers each cell. Used by the data worker and, without one, on the page. See `readSiteMask`.
import type { PackedGeometry } from './geo-pack.ts';

/** Fills a packed file's polygons (even-odd) into a mask of the site grid: 1 inside, 0 outside. */
export function rasteriseMask(packed: PackedGeometry, grid: { width: number; height: number }, extent: { width_m: number; height_m: number }): Uint8Array {
  const { width, height } = grid;
  const mask = new Uint8Array(width * height);
  if (typeof OffscreenCanvas === 'undefined') return mask;
  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | null;
  if (!g) return mask;
  g.setTransform(width / extent.width_m, 0, 0, height / extent.height_m, 0, 0);
  const { coords, ends } = packed.polygons;
  g.beginPath();
  let start = 0;
  for (const end of ends) {
    for (let i = start; i < end; i++) {
      if (i === start) g.moveTo(coords[i * 2]!, coords[i * 2 + 1]!);
      else g.lineTo(coords[i * 2]!, coords[i * 2 + 1]!);
    }
    g.closePath();
    start = end;
  }
  g.fill('evenodd');
  const pixels = g.getImageData(0, 0, width, height).data;
  for (let i = 0; i < mask.length; i++) mask[i] = pixels[i * 4 + 3]! > 127 ? 1 : 0;
  return mask;
}
