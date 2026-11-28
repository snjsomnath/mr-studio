// MapLibre, with its worker set up. MapLibre 6 looks for its worker file next to its own
// module, which a bundle does not keep, so the worker is shipped as an asset and named here.
// Every module imports MapLibre from this file, never from 'maplibre-gl' directly.
import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';

maplibregl.setWorkerUrl(workerUrl);

export default maplibregl;
