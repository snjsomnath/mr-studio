// Site datasets as shapes in table metres, read off the page's thread (#263). Layers that only
// need a dataset's polygons, lines and points use `readSiteGeometry` instead of `readSiteData`
// followed by `geojsonPolygons` and friends: the file is parsed and moved into table metres in the
// SDK's data worker, and kept per file and per place of the table, so the second layer that reads
// the buildings, or the same layer turned off and on again, doesn't parse them again.

import { dataProblem, fetchFromHost } from './data.ts';
import { packGeojson, unpackGeometry } from './geo-pack.ts';
import type { PackedGeometry, SiteGeometry, SitePlacement } from './geo-pack.ts';
import { siteProjection } from './geo.ts';
import { StreetGraph, specOptions } from './street-network.ts';
import type { PackedStreetGraph, StreetGraphSpec } from './street-network.ts';
import { siteDataUrl } from './table-space.ts';
import type { Placed, XY } from './table-space.ts';
import { buildWalkNetwork, packWalkNetwork, unpackWalkNetwork } from './walk-network.ts';
import type { PackedWalkNetwork, WalkEdge, WalkNetwork } from './walk-network.ts';
import type { SiteInfo } from './types.ts';

export type { SiteGeometry } from './geo-pack.ts';

// ---- The worker -------------------------------------------------------------

let worker: Worker | null | undefined;
let nextJob = 1;
const jobs = new Map<number, { done: (result: any) => void; fail: (error: Error) => void }>();

function startWorker(): Worker | null {
  if (worker !== undefined) return worker;
  worker = null;
  if (typeof Worker === 'undefined') return null;
  try {
    // Written out in full so the bundler finds the worker and builds it.
    const started = new Worker(new URL('./geo-worker.ts', import.meta.url), { type: 'module' });
    started.onmessage = ({ data }: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
      const job = jobs.get(data.id);
      jobs.delete(data.id);
      if (data.result) job?.done(data.result);
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

/** Sends a job to the data worker; null when there is none, so the caller does the work here. */
function inWorker<T>(job: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> | null {
  const running = startWorker();
  if (!running) return null;
  return new Promise<T>((done, fail) => {
    const id = nextJob++;
    jobs.set(id, { done, fail });
    running.postMessage({ ...job, id }, transfer);
  });
}

/** Packs GeoJSON bytes into table metres: in the data worker when there is one, otherwise here. `keep` leaves a copy there for street graphs. */
export async function packInWorker(bytes: ArrayBuffer, place: SitePlacement, keep?: string): Promise<PackedGeometry> {
  const plain: SitePlacement = { corners: place.corners, extent: place.extent };
  const copy = bytes.slice(0);
  const job = inWorker<PackedGeometry>({ kind: 'pack', bytes: copy, place: plain, keep }, [copy]);
  if (job) {
    try {
      return await job;
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
/** The worker's name for the copy it keeps of each file, by the page's key. */
const packedKeys = new Map<string, string>();

const geometryKey = (site: Pick<SiteInfo, 'corners' | 'extent'>, url: string) => `${url}|${JSON.stringify(site.corners)}|${site.extent.width_m}x${site.extent.height_m}`;

const stampOf = (response: Response) =>
  [response.headers.get('etag'), response.headers.get('last-modified'), response.headers.get('content-length')].join('|');

async function readPacked(site: Pick<SiteInfo, 'data' | 'corners' | 'extent'>, name: string): Promise<PackedGeometry | null> {
  const url = siteDataUrl(site as SiteInfo, name);
  if (!url) return null;
  const key = geometryKey(site, url);
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
        return await packInWorker(await response.arrayBuffer(), site, `${key}|${stamp}`);
      } catch {
        dataProblem({ name, reason: `${file} is not valid JSON` });
        return null;
      }
    })();
    kept.set(key, { stamp, packed });
    packedKeys.set(key, `${key}|${stamp}`);
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

// ---- Street graphs and walking networks (#484) ------------------------------

/**
 * The site's streets as lines in table metres, from its `roads` dataset, read in the data worker
 * and kept. A site without one has no streets: nothing is made up, because a made-up grid on a
 * real place would put traffic through its buildings. Layers that need streets say so in `requires.data`.
 */
export async function streetLines(site: SiteInfo): Promise<Placed<XY[]>[]> {
  return (await readSiteGeometry(site, 'roads'))?.lines ?? [];
}

const graphs = new WeakMap<PackedGeometry, Map<string, Promise<StreetGraph>>>();

/**
 * A street graph of a site's lines (the `roads` dataset unless named), as `new StreetGraph(lines,
 * specOptions(spec))` would make it: built in the SDK's data worker and kept until the file
 * changes, so a second layer, or the same layer turned off and on, gets it at once. Layers
 * share the graph: read it, don't change it. Null when the site hasn't got the dataset.
 */
export async function readStreetGraph(site: SiteInfo, spec: StreetGraphSpec = {}, name = 'roads'): Promise<StreetGraph | null> {
  const packed = await readPacked(site, name);
  if (!packed) return null;
  let bySpec = graphs.get(packed);
  if (!bySpec) graphs.set(packed, (bySpec = new Map()));
  const specKey = JSON.stringify(spec);
  let graph = bySpec.get(specKey);
  if (!graph) {
    const url = siteDataUrl(site, name);
    const keep = url ? packedKeys.get(geometryKey(site, url)) : undefined;
    graph = (async () => {
      const job = keep ? inWorker<PackedStreetGraph>({ kind: 'graph', keep, spec }) : null;
      if (job) {
        try {
          return StreetGraph.fromPacked(await job);
        } catch {
          // Not kept there (packed on this page): build it here.
        }
      }
      return new StreetGraph(unpackGeometry(packed).lines, specOptions(spec));
    })();
    bySpec.set(specKey, graph);
  }
  return graph;
}

const walks = new Map<string, { stamp: string; packed: Promise<PackedWalkNetwork | null> }>();

/**
 * A site dataset of lines as a walking network in longitude and latitude (see walk-network.ts):
 * built in the SDK's data worker and kept until the file changes. Each call unpacks a fresh copy
 * that the layer may mark; `extra` adds the layer's own fields to every edge. Null when the site
 * hasn't got the dataset or it can't be read.
 */
export async function readWalkNetwork<X extends object = Record<never, never>>(site: SiteInfo, name: string, extra?: () => X): Promise<WalkNetwork<WalkEdge & X> | null> {
  const url = siteDataUrl(site, name);
  if (!url) return null;
  const file = url.split('/').pop() || url;
  let response: Response;
  try {
    response = await fetchFromHost(url, undefined, 5, { cache: 'no-cache' });
  } catch (error) {
    dataProblem({ name, reason: `couldn't reach the table's server for ${file}` });
    console.warn(`site data '${name}' could not be loaded: ${(error as Error).message}`);
    return null;
  }
  if (!response.ok) {
    dataProblem({ name, reason: `couldn't read ${file} (HTTP ${response.status})` });
    return null;
  }
  const stamp = stampOf(response);
  const key = `${url}|${site.origin.lon},${site.origin.lat}`;
  let entry = walks.get(key);
  if (entry && entry.stamp === stamp && !/^\|\|/.test(stamp)) void response.body?.cancel().catch(() => {});
  else {
    const bytes = await response.arrayBuffer();
    const origin = { lon: site.origin.lon, lat: site.origin.lat };
    entry = {
      stamp,
      packed: (async () => {
        const copy = bytes.slice(0);
        const job = inWorker<PackedWalkNetwork>({ kind: 'walk', bytes: copy, origin }, [copy]);
        if (job) {
          try {
            return await job;
          } catch (error) {
            if (/JSON|Unexpected|token/i.test((error as Error).message)) {
              dataProblem({ name, reason: `${file} is not valid JSON` });
              return null;
            }
          }
        }
        try {
          return packWalkNetwork(buildWalkNetwork(JSON.parse(new TextDecoder().decode(bytes)), siteProjection(site).distance));
        } catch {
          dataProblem({ name, reason: `${file} is not valid JSON` });
          return null;
        }
      })(),
    };
    walks.set(key, entry);
  }
  const packed = await entry.packed;
  if (!packed) {
    walks.delete(key);
    return null;
  }
  return unpackWalkNetwork(packed, extra);
}

/** Forgets every kept dataset (tests, and a table that was switched). */
export function forgetSiteGeometry(): void {
  kept.clear();
  packedKeys.clear();
  walks.clear();
}
