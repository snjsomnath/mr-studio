import type { SiteInfo } from '@mrstudio/sdk';

/** The longest side of the image asked for. */
const SIDE = 2048;

/** The box around the table in lon/lat, and the image size that keeps the table's metres square. */
export function request(
  site: SiteInfo,
  params: { url: string; layers: string; styles: string; signin?: string; format?: string },
): { href: string; bbox: [number, number, number, number]; width: number; height: number } {
  const lons = site.corners.map((c) => c[0]);
  const lats = site.corners.map((c) => c[1]);
  const bbox: [number, number, number, number] = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
  const midLat = ((bbox[1] + bbox[3]) / 2) * (Math.PI / 180);
  const wide = (bbox[2] - bbox[0]) * Math.cos(midLat);
  const tall = bbox[3] - bbox[1];
  const width = wide >= tall ? SIDE : Math.max(1, Math.round((SIDE * wide) / tall));
  const height = wide >= tall ? Math.max(1, Math.round((SIDE * tall) / wide)) : SIDE;
  const query = new URLSearchParams({ url: params.url.trim(), layers: params.layers.trim(), styles: params.styles.trim(), bbox: bbox.join(','), width: String(width), height: String(height) });
  if (params.format) query.set('format', params.format);
  // A source from the Sources manager signs the request on the host; without an address of its own the source's is used.
  if (params.signin?.trim()) query.set('source', params.signin.trim());
  return { href: `/api/wms?${query}`, bbox, width, height };
}
