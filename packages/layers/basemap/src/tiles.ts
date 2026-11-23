import type { SiteInfo } from '@mrstudio/sdk';

/** How the base map looks: drawn from the table's own data, a tile service, a source, or plain ground. */
export type Style = 'dark' | 'darkmatter' | 'darkmap' | 'light' | 'grey' | 'streets' | 'topo' | 'aerial' | 'source' | 'plain';

/** The styles drawn from a key-free tile service. */
export type TileStyle = Exclude<Style, 'dark' | 'source' | 'plain'>;

export interface TileService {
  /**
   * The service as the host knows it (`crates/mrs-host/src/basemap.rs`). Tiles come through
   * `/api/basemap/<service>/…`, which keeps them in the site folder for use without a connection.
   */
  service: string;
  credit: string;
  maxzoom: number;
  /** Colours each pixel after the tiles are drawn, such as turning a map into a night map. */
  tone?: (r: number, g: number, b: number) => [number, number, number];
}

const OSM = '© OpenStreetMap contributors';
const ESRI_CANVAS = 'Esri, HERE, Garmin, © OpenStreetMap contributors';

/**
 * Key-free tile services, each with the credit it asks for (#37). CARTO's basemaps now answer
 * "API key required" without a key, so they come through Sources (a CARTO connection) instead.
 */
export const TILE_STYLES: Record<TileStyle, TileService> = {
  darkmatter: { service: 'esri-dark-grey', credit: ESRI_CANVAS, maxzoom: 16 },
  darkmap: {
    service: 'osm',
    credit: OSM,
    maxzoom: 19,
    // A night map: lightness turned over and kept low and blue-grey, so streets and blocks read faintly on dark ground.
    tone: (r, g, b) => {
      const night = 255 - (0.299 * r + 0.587 * g + 0.114 * b);
      return [12 + night * 0.32, 15 + night * 0.36, 22 + night * 0.46];
    },
  },
  light: {
    service: 'osm',
    credit: OSM,
    maxzoom: 19,
    // Mostly grey and lifted, so data drawn over it stands out.
    tone: (r, g, b) => {
      const grey = 0.299 * r + 0.587 * g + 0.114 * b;
      const mix = (c: number) => 0.15 * c + 0.85 * grey;
      const lift = (c: number) => 70 + c * 0.75;
      return [lift(mix(r)), lift(mix(g)), lift(mix(b))];
    },
  },
  grey: { service: 'esri-grey', credit: ESRI_CANVAS, maxzoom: 16 },
  streets: { service: 'osm', credit: OSM, maxzoom: 19 },
  topo: { service: 'opentopomap', credit: '© OpenStreetMap contributors, SRTM, © OpenTopoMap (CC-BY-SA)', maxzoom: 17 },
  aerial: { service: 'esri-imagery', credit: 'Esri, Maxar, Earthstar Geographics and the GIS user community', maxzoom: 19 },
};

/** The address of a tile: `{z}`, `{x}` and `{y}` are filled in by `tilesFor`. */
export function tileTemplate(style: TileStyle): string {
  return `/api/basemap/${TILE_STYLES[style].service}/{z}/{x}/{y}`;
}

/** A map from the Sources manager (Mapbox, CARTO with a key, Lantmäteriet, any tile address), signed by the host. */
export function sourceTemplate(source: string): string {
  return `/api/sources/${encodeURIComponent(source)}/tile/{z}/{x}/{y}`;
}

/**
 * A pixel recoloured by the tile settings: black and white, then brightness. Brightness under 1
 * dims the map towards black, so data drawn over it stands out; over 1 lifts it.
 */
export function adjust(grey: boolean, brightness: number): ((r: number, g: number, b: number) => [number, number, number]) | undefined {
  if (!grey && brightness === 1) return undefined;
  return (r, g, b) => {
    if (grey) r = g = b = 0.299 * r + 0.587 * g + 0.114 * b;
    return [Math.min(255, r * brightness), Math.min(255, g * brightness), Math.min(255, b * brightness)];
  };
}

export interface Tile {
  url: string;
  west: number;
  east: number;
  north: number;
  south: number;
}

/** Most tiles one table asks for: a fair load on a free service, and enough for a projector. */
const MOST_TILES = 64;

const lonToX = (lon: number, n: number) => ((lon + 180) / 360) * n;
const latToY = (lat: number, n: number) => ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * n;
const xToLon = (x: number, n: number) => (x / n) * 360 - 180;
const yToLat = (y: number, n: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;

/**
 * The tiles covering the table, at the zoom that matches `pxPerMetre` on the table's drawing,
 * or coarser when that would ask for too many.
 */
export function tilesFor(site: SiteInfo, pxPerMetre: number, template: string, maxzoom: number): Tile[] {
  const lons = site.corners.map((c) => c[0]);
  const lats = site.corners.map((c) => c[1]);
  const [west, east, south, north] = [Math.min(...lons), Math.max(...lons), Math.min(...lats), Math.max(...lats)];
  const lat = (south + north) / 2;
  // A 256-pixel tile at zoom z is 40 075 km × cos(lat) / 2^z wide.
  let z = Math.ceil(Math.log2((156_543.03 * Math.cos((lat * Math.PI) / 180)) * Math.max(pxPerMetre, 1e-6)));
  z = Math.max(1, Math.min(maxzoom, z));
  const span = (zoom: number) => {
    const n = 2 ** zoom;
    return { n, x0: Math.floor(lonToX(west, n)), x1: Math.floor(lonToX(east, n)), y0: Math.floor(latToY(north, n)), y1: Math.floor(latToY(south, n)) };
  };
  let s = span(z);
  while (z > 1 && (s.x1 - s.x0 + 1) * (s.y1 - s.y0 + 1) > MOST_TILES) s = span(--z);
  const tiles: Tile[] = [];
  for (let x = s.x0; x <= s.x1; x++) {
    for (let y = s.y0; y <= s.y1; y++) {
      const url = template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
      tiles.push({ url, west: xToLon(x, s.n), east: xToLon(x + 1, s.n), north: yToLat(y, s.n), south: yToLat(y + 1, s.n) });
    }
  }
  return tiles;
}
