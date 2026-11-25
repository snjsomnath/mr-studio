import type { FieldFrame, SiteInfo } from './types.ts';
import { parseFrame } from './frame.ts';

/** A dataset the site names that could not be read (#259). */
export interface DataProblem {
  /** The dataset's name in site.json `data`. */
  name: string;
  /** What went wrong, in words: "couldn't read trees.geojson (HTTP 404)". */
  reason: string;
}

const problemListeners = new Set<(problem: DataProblem) => void>();

/**
 * Hears about every site dataset the SDK's helpers could not read, after their retries. The
 * runtime uses it to mark the layers that need the dataset as in trouble and start them again,
 * so a layer does not have to: it reads its data as usual and gets null or an error.
 */
export function onDataProblem(listener: (problem: DataProblem) => void): () => void {
  problemListeners.add(listener);
  return () => problemListeners.delete(listener);
}

/** Tells the runtime a site dataset could not be read. For helpers outside the SDK that read site data themselves. */
export function dataProblem(problem: DataProblem): void {
  for (const listener of problemListeners) {
    try {
      listener(problem);
    } catch {
      // A listener's trouble is its own.
    }
  }
}

/** The file name at the end of a path, for messages. */
function fileName(path: string): string {
  return path.split('/').pop() || path;
}

/**
 * Fetches from the host, trying again when the connection fails or the host answers with a
 * server error: a host that is starting (the desktop app switching tables) briefly answers
 * nothing (#222). A missing file (404) and other answers come back at once.
 */
export async function fetchFromHost(url: string, signal?: AbortSignal, attempts = 5, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, { ...init, signal });
      if (response.status < 500 || attempt >= attempts - 1) return response;
    } catch (error) {
      if (signal?.aborted || attempt >= attempts - 1) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
  }
}

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
  let response: Response;
  try {
    response = await fetchFromHost(`/site/${path}`, signal);
  } catch (error) {
    if (!signal?.aborted) dataProblem({ name, reason: `couldn't reach the table's server for ${fileName(path)}` });
    throw error;
  }
  if (!response.ok) {
    dataProblem({ name, reason: `couldn't read ${fileName(path)} (HTTP ${response.status})` });
    throw new Error(`could not load the '${name}' dataset (${response.status})`);
  }
  try {
    return (await response.json()) as T;
  } catch (error) {
    dataProblem({ name, reason: `${fileName(path)} is not valid JSON` });
    throw error;
  }
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
  let response: Response;
  try {
    response = await fetchFromHost(`/api/data/field?${query}`, signal);
  } catch (error) {
    if (!signal?.aborted) dataProblem({ name, reason: `couldn't reach the table's server for the '${name}' raster` });
    throw error;
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    dataProblem({ name, reason: `couldn't read the '${name}' raster: ${body?.error ?? `HTTP ${response.status}`}` });
    throw new Error(`could not load the '${name}' raster: ${body?.error ?? response.status}`);
  }
  return parseFrame(await response.arrayBuffer());
}
