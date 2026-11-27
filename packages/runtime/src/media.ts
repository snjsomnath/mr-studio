import type { MediaKind } from '@mrstudio/sdk';

/**
 * A table's media (#306): everything in its folder a layer can show, as `GET /api/media` lists
 * it, and the online sources of this computer (`GET /api/sources`). The editor's Media tab lists
 * them, and every setting that names one picks from them instead of having the name typed.
 */
export interface MediaItem {
  kind: MediaKind;
  /** The dataset name layers know it by, when it is one of the site's `data`. */
  name?: string;
  /** Relative to the table folder. */
  path: string;
  bytes?: number;
  /** Named in site.json but not in the folder. */
  missing?: boolean;
}

/** An online source as `/api/sources` lists it: never its key. */
export interface SourceItem {
  id: string;
  kind: string;
  name: string;
  ready: boolean;
  url?: string;
}

/** How each kind of media is named and drawn. `plural` heads its group in lists. */
export const MEDIA_KINDS: Record<MediaKind, { label: string; plural: string; icon: string }> = {
  map: { label: 'Map data', plural: 'Map data', icon: 'map' },
  table: { label: 'Table (CSV)', plural: 'Tables', icon: 'table2' },
  raster: { label: 'Raster (GeoTIFF)', plural: 'Rasters', icon: 'grid' },
  drawing: { label: 'Drawing', plural: 'Drawings', icon: 'brush' },
  picture: { label: 'Picture', plural: 'Pictures', icon: 'images' },
  video: { label: 'Video', plural: 'Video', icon: 'video' },
  sound: { label: 'Sound', plural: 'Sounds', icon: 'sound' },
  model: { label: '3D model', plural: '3D models', icon: 'cube' },
  data: { label: 'Other file', plural: 'Other files', icon: 'file' },
};

/** The names of the source kinds of the Sources manager, as people know them. */
export const SOURCE_KINDS: Record<string, string> = {
  wms: 'WMS service',
  wmts: 'WMTS tiles',
  arcgis: 'ArcGIS service',
  tiles: 'Map tiles',
  mapbox: 'Mapbox',
  carto: 'CARTO',
  lantmateriet: 'Lantmäteriet',
  vasttrafik: 'Västtrafik',
  streetview: 'Street View',
};

/** The file types Add media takes, and where each goes. */
export const ACCEPT = {
  /** Through the shared importer, as a dataset (#71); zipped shapefiles and GeoPackages pick a layer there (#600, #620). */
  dataset: ['.geojson', '.json', '.csv', '.svg', '.tif', '.tiff', '.zip', '.gpkg'],
  /** Kept as they came, under data/media. */
  media: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm', '.mov', '.m4v'],
  /** Kept as they came, under data/sounds. */
  sound: ['.mp3', '.wav', '.ogg', '.m4a'],
  /** Placed on the ground by the 3D model import. */
  model: ['.glb', '.obj', '.stl'],
};

/** Where Add media sends a file, by its name. */
export function routeOf(file: string): keyof typeof ACCEPT | null {
  const extension = /\.[^.]+$/.exec(file.toLowerCase())?.[0] ?? '';
  for (const [route, list] of Object.entries(ACCEPT) as [keyof typeof ACCEPT, string[]][]) if (list.includes(extension)) return route;
  return null;
}

/** The kinds of media a file of this name becomes. */
export function kindOf(file: string): MediaKind {
  const extension = /\.([^.]+)$/.exec(file.toLowerCase())?.[1] ?? '';
  if (extension === 'geojson' || extension === 'json' || extension === 'zip' || extension === 'gpkg') return 'map';
  if (extension === 'csv') return 'table';
  if (extension === 'tif' || extension === 'tiff') return 'raster';
  if (extension === 'svg') return 'drawing';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension)) return 'picture';
  if (['mp4', 'webm', 'mov', 'm4v'].includes(extension)) return 'video';
  if (['mp3', 'wav', 'ogg', 'm4a'].includes(extension)) return 'sound';
  if (['glb', 'gltf', 'obj', 'stl', 'ply'].includes(extension)) return 'model';
  return 'data';
}

/** What a setting stores for an item: the dataset's name, or the file's path when it has no name or the setting takes paths. */
export function valueOf(item: MediaItem, by: 'name' | 'path' = 'name'): string {
  return by === 'name' && item.name ? item.name : item.path;
}

/** What an item is called in lists: its dataset name, or its file name. */
export function titleOf(item: MediaItem): string {
  return item.name ?? item.path.split('/').pop() ?? item.path;
}

export function sizeOf(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

let items: Promise<MediaItem[]> | null = null;
let sourceItems: Promise<SourceItem[]> | null = null;
const listeners = new Set<() => void>();

/** The table's media, asked once and again after `mediaChanged`. */
export function mediaItems(): Promise<MediaItem[]> {
  items ??= fetch('/api/media', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : { items: [] }))
    .then((page: { items?: MediaItem[] }) => page.items ?? [])
    .catch(() => []);
  return items;
}

/** The online sources set up on this computer. A page that may not read them (a phone) gets none. */
export function onlineSources(): Promise<SourceItem[]> {
  sourceItems ??= fetch('/api/sources', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : { sources: [] }))
    .then((page: { sources?: SourceItem[] }) => page.sources ?? [])
    .catch(() => []);
  return sourceItems;
}

/** Something was added, or the sources changed: every list asks again. */
export function mediaChanged(): void {
  items = null;
  sourceItems = null;
  for (const listener of listeners) listener();
}

export function onMediaChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Back from the Sources window, or from the file manager: what is there may have changed.
if (typeof window !== 'undefined') window.addEventListener('focus', () => mediaChanged());

/**
 * Asks the window around a list to add media of these kinds (the editor's Add media), and
 * answers what was added, or null. A page without the editor has no way to add, and answers null.
 */
export function requestAddMedia(kinds: readonly MediaKind[]): Promise<MediaItem | null> {
  return new Promise((resolve) => {
    const event = new CustomEvent('mrs-media-add', { detail: { kinds, done: resolve }, cancelable: true });
    // The editor calls preventDefault when it takes the request.
    if (window.dispatchEvent(event)) resolve(null);
  });
}

/** Whether this page can add media (the editor listens for requests). */
export function canAddMedia(): boolean {
  return Boolean((window as { mrsAddsMedia?: boolean }).mrsAddsMedia);
}
