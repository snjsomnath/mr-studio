// The SDK's data worker (#263): reads GeoJSON into table metres off the page's thread, so a
// large file doesn't stall the table or the editor. See geo-pack.ts and site-geometry.ts.
import { packedBuffers, packGeojson } from './geo-pack.ts';
import type { SitePlacement } from './geo-pack.ts';

interface Job {
  id: number;
  bytes: ArrayBuffer;
  place: SitePlacement;
}

const scope = self as unknown as { onmessage: ((event: MessageEvent<Job>) => void) | null; postMessage(message: unknown, transfer: Transferable[]): void };
scope.onmessage = ({ data: { id, bytes, place } }) => {
  try {
    const packed = packGeojson(bytes, place);
    scope.postMessage({ id, packed }, packedBuffers(packed));
  } catch (error) {
    scope.postMessage({ id, error: (error as Error).message || String(error) }, []);
  }
};
