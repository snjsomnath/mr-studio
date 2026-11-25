// Site datasets as shapes in table metres, read off the page's thread (#263). Layers that only
// need a dataset's polygons, lines and points use `readSiteGeometry` instead of `readSiteData`
// followed by `geojsonPolygons` and friends: the file is parsed and moved into table metres in the
// SDK's data worker, and kept per file and per place of the table, so the second layer that reads
// the buildings, or the same layer turned off and on again, doesn't parse them again.

import { dataProblem, fetchFromHost } from './data.ts';
import { packGeojson, unpackGeometry } from './geo-pack.ts';
import type { PackedGeometry, SiteGeometry, SitePlacement } from './geo-pack.ts';
import { siteDataUrl } from './table-space.ts';
import type { SiteInfo } from './types.ts';

export type { SiteGeometry } from './geo-pack.ts';

// ---- The worker -------------------------------------------------------------

let worker: Worker | null | undefined;
let nextJob = 1;
const jobs = new Map<number, { done: (packed: PackedGeometry) => void; fail: (error: Error) => void }>();

function startWorker(): Worker | null {
  if (worker !== undefined) return worker;
  worker = null;
  if (typeof Worker === 'undefined') return null;
  try {
    // Written out in full so the bundler finds the worker and builds it.
    const started = new Worker(new URL('./geo-worker.ts', import.meta.url), { type: 'module' });
    started.onmessage = ({ data }: MessageEvent<{ id: number; packed?: PackedGeometry; error?: string }>) => {
      const job = jobs.get(data.id);
      jobs.delete(data.id);
      if (data.packed) job?.done(data.packed);
      else job?.fail(new Error(data.error ?? 'the data worker failed'));
    };
    // A worker that can't start (a page that forbids them) leaves the work on the page, as before.
    started.onerror = (event) => {
      event.preventDefault?.();
      worker = null;
      for (const job of jobs.values()) job.fail(new Error('the data worker stopped'));
      jobs.clear();
    };
    worker = started;
  } catch {
    worker = null;
  }
  return worker;
}

/** Packs GeoJSON bytes into table metres: in the data worker when there is one, otherwise here. */
export async function packInWorker(bytes: ArrayBuffer, place: SitePlacement): Promise<PackedGeometry> {
  const plain: SitePlacement = { corners: place.corners, extent: place.extent };
  const running = startWorker();
  if (running) {
    const copy = bytes.slice(0);
    try {
      return await new Promise<PackedGeometry>((done, fail) => {
        const id = nextJob++;
        jobs.set(id, { done, fail });
        running.postMessage({ id, bytes: copy, place: plain }, [copy]);
      });
    } catch (error) {
      // Bad JSON is the file's trouble, and the page would say the same; anything else, try here.
      if (/JSON|Unexpected|token/i.test((error as Error).message)) throw error;
    }
  }
  return packGeojson(bytes, plain);
}

// ---- Kept results -----------------------------------------------------------

interface Kept {
  /** What the server said about the file: changed when the file changes. */
  stamp: string;
  packed: Promise<PackedGeometry | null>;
}
const kept = new Map<string, Kept>();
const reading = new Map<string, Promise<PackedGeometry | null>>();

const stampOf = (response: Response) =>
  [response.headers.get('etag'), response.headers.get('last-modified'), response.headers.get('content-length')].join('|');

async function readPacked(site: Pick<SiteInfo, 'data' | 'corners' | 'extent'>, name: string): Promise<PackedGeometry | null> {
  const url = siteDataUrl(site as SiteInfo, name);
  if (!url) return null;
  const key = `${url}|${JSON.stringify(site.corners)}|${site.extent.width_m}x${site.extent.height_m}`;
  // Layers that start together share one read.
  const already = reading.get(key);
  if (already) return already;
  const read = (async () => {
    const file = url.split('/').pop() || url;
    let response: Response;
    try {
      response = await fetchFromHost(url, undefined, 5, { cache: 'no-cache' });
    } catch (error) {
      console.warn(`site data '${name}' could not be loaded: ${(error as Error).message}`);
      dataProblem({ name, reason: `couldn't reach the table's server for ${file}` });
      return null;
    }
    if (!response.ok) {
      console.warn(`site data '${name}' could not be loaded: HTTP ${response.status}`);
      dataProblem({ name, reason: `couldn't read ${file} (HTTP ${response.status})` });
      return null;
    }
    const stamp = stampOf(response);
    const before = kept.get(key);
    if (before && before.stamp === stamp && !/^\|\|/.test(stamp)) {
      void response.body?.cancel().catch(() => {});
      return before.packed;
    }
    const packed = (async () => {
      try {
        return await packInWorker(await response.arrayBuffer(), site);
      } catch {
        dataProblem({ name, reason: `${file} is not valid JSON` });
        return null;
      }
    })();
    kept.set(key, { stamp, packed });
    const result = await packed;
    if (!result) kept.delete(key);
    return result;
  })();
  reading.set(key, read);
  try {
    return await read;
  } finally {
    reading.delete(key);
  }
}

/**
 * A named site dataset's polygons, lines and points in table metres, as `geojsonPolygons`,
 * `geojsonLines` and `geojsonPoints` would give them. Null when the site doesn't have the dataset
 * or it can't be read (reported as for `readSiteData`). The parsing happens in the SDK's data
 * worker, and the result is kept until the file changes.
 */
export async function readSiteGeometry(site: SiteInfo, name: string): Promise<SiteGeometry | null> {
  const packed = await readPacked(site, name);
  return packed ? unpackGeometry(packed) : null;
}

/** Forgets every kept dataset (tests, and a table that was switched). */
export function forgetSiteGeometry(): void {
  kept.clear();
}
