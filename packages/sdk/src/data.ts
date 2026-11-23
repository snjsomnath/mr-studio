import type { FieldFrame, SiteInfo } from './types.ts';
import { parseFrame } from './frame.ts';

/** Whether the site provides a named dataset. */
export function hasSiteData(site: Pick<SiteInfo, 'data'>, name: string): boolean {
  return typeof site.data?.[name] === 'string';
}

/**
 * Loads a named dataset from the site package as JSON. The name comes from the
 * layer's `requires.data`; the site maps it to a file under `data` in site.json.
 */
export async function loadSiteData<T = unknown>(site: Pick<SiteInfo, 'data'>, name: string, signal?: AbortSignal): Promise<T> {
  const path = site.data?.[name];
  if (typeof path !== 'string') throw new Error(`the site has no '${name}' dataset; add it under "data" in site.json`);
  const response = await fetch(`/site/${path}`, { signal });
  if (!response.ok) throw new Error(`could not load the '${name}' dataset (${response.status})`);
  return (await response.json()) as T;
}

/**
 * Loads a raster dataset laid on the site grid (#196): a GeoTIFF, or a folder of one GeoTIFF per hour
 * (`pet_08.tif` .. `pet_20.tif`), in any coordinate system the host reads. Values are exact (f32), NaN where
 * the raster has no data. Null when a folder has no raster for `hour`.
 */
export async function loadSiteField(site: Pick<SiteInfo, 'data'>, name: string, hour?: number, signal?: AbortSignal): Promise<FieldFrame | null> {
  if (!hasSiteData(site, name)) throw new Error(`the site has no '${name}' dataset; add it under "data" in site.json`);
  const query = new URLSearchParams({ name });
  if (hour !== undefined) query.set('hour', String(Math.floor(hour)));
  const response = await fetch(`/api/data/field?${query}`, { signal });
  if (response.status === 404) return null;
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(`could not load the '${name}' raster: ${body?.error ?? response.status}`);
  }
  return parseFrame(await response.arrayBuffer());
}
