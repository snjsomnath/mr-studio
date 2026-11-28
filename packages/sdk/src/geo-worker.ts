// The SDK's data worker (#263, #484): reads GeoJSON into table metres off the page's thread, so a
// large file doesn't stall the table or the editor, and builds street graphs and walking networks
// from it. See geo-pack.ts, street-network.ts, walk-network.ts and site-geometry.ts.
import { rowsOf } from './data-query.ts';
import { packedBuffers, packGeojson, unpackGeometry } from './geo-pack.ts';
import type { PackedGeometry, SitePlacement } from './geo-pack.ts';
import { siteProjection } from './geo.ts';
import { rasteriseMask } from './mask.ts';
import { StreetGraph, packedGraphBuffers, specOptions } from './street-network.ts';
import type { StreetGraphSpec } from './street-network.ts';
import { buildWalkNetwork, packWalkNetwork, walkNetworkBuffers } from './walk-network.ts';

type Job =
  | { id: number; kind?: 'pack'; bytes: ArrayBuffer; place: SitePlacement; keep?: string }
  | { id: number; kind: 'graph'; keep: string; spec: StreetGraphSpec }
  | { id: number; kind: 'walk'; bytes: ArrayBuffer; origin: { lon: number; lat: number } }
  | { id: number; kind: 'rows'; bytes: ArrayBuffer; csv: boolean }
  | { id: number; kind: 'mask'; keep: string; grid: { width: number; height: number }; extent: { width_m: number; height_m: number } };

/** Packed files kept here for the graphs built from them, by the page's key for the file. */
const kept = new Map<string, PackedGeometry>();

const copy = (packed: PackedGeometry): PackedGeometry => {
  const shapes = (s: PackedGeometry['lines']) => ({ coords: s.coords.slice(), ends: s.ends.slice(), parts: s.parts.slice(), feature: s.feature.slice() });
  return { polygons: shapes(packed.polygons), lines: shapes(packed.lines), points: shapes(packed.points), properties: packed.properties };
};

const scope = self as unknown as { onmessage: ((event: MessageEvent<Job>) => void) | null; postMessage(message: unknown, transfer: Transferable[]): void };
scope.onmessage = ({ data: job }) => {
  try {
    if (job.kind === 'graph') {
      const packed = kept.get(job.keep);
      if (!packed) throw new Error('not kept');
      const graph = new StreetGraph(unpackGeometry(packed).lines, specOptions(job.spec)).toPacked();
      scope.postMessage({ id: job.id, result: graph }, packedGraphBuffers(graph));
    } else if (job.kind === 'mask') {
      const packed = kept.get(job.keep);
      if (!packed || typeof OffscreenCanvas === 'undefined') throw new Error('not kept');
      const mask = rasteriseMask(packed, job.grid, job.extent);
      scope.postMessage({ id: job.id, result: mask }, [mask.buffer]);
    } else if (job.kind === 'rows') {
      // A dataset's rows for panels that reduce it (#670).
      const rows = rowsOf(new TextDecoder().decode(job.bytes), job.csv);
      scope.postMessage({ id: job.id, result: rows }, []);
    } else if (job.kind === 'walk') {
      const geojson = JSON.parse(new TextDecoder().decode(job.bytes));
      const distance = siteProjection({ origin: job.origin, grid: { width: 1, height: 1, cell_m: 1, rotation_deg: 0 } }).distance;
      const network = packWalkNetwork(buildWalkNetwork(geojson, distance));
      scope.postMessage({ id: job.id, result: network }, walkNetworkBuffers(network));
    } else {
      const packed = packGeojson(job.bytes, job.place);
      // The copy stays here; the original's buffers go to the page.
      if (job.keep) kept.set(job.keep, copy(packed));
      scope.postMessage({ id: job.id, result: packed }, packedBuffers(packed));
    }
  } catch (error) {
    scope.postMessage({ id: job.id, error: (error as Error).message || String(error) }, []);
  }
};
