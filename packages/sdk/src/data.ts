import type { SiteInfo } from './types.ts';

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
