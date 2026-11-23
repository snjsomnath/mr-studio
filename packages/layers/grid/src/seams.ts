import type { SiteInfo } from '@mrstudio/sdk';

/** Tile size when the table does not say: the Chalmers model's 20 cm tiles. */
const DEFAULT_TILE_CM = 20;

/**
 * Where the tile seams lie, in table metres: the x of each vertical line and the y of each
 * horizontal one, both edges included. A table that is not a whole number of tiles ends
 * with a part tile, as the model does.
 */
export function seams(site: Pick<SiteInfo, 'extent' | 'table'>, tileCm: number): { xs: number[]; ys: number[] } {
  const { width_m, height_m } = site.extent;
  const widthCm = site.table?.width_cm ?? 100;
  const heightCm = site.table?.height_cm ?? (widthCm * height_m) / width_m;
  const tile = tileCm > 0 ? tileCm : (site.table?.tile_cm ?? DEFAULT_TILE_CM);
  const lines = (cm: number, metres: number) => {
    const out: number[] = [];
    for (let at = 0; at < cm - 1e-6; at += tile) out.push((at / cm) * metres);
    out.push(metres);
    return out;
  };
  return { xs: lines(widthCm, width_m), ys: lines(heightCm, height_m) };
}
