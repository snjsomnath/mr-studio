import type { SiteInfo } from '@mrstudio/sdk';

/** How the base map looks: drawn from the table's own data, a tile service, or plain ground. */
export type Style = 'dark' | 'light' | 'streets' | 'aerial' | 'plain';

export interface TileService {
  url: string;
  credit: string;
  maxzoom: number;
  /** Colours each pixel after the tiles are drawn, such as greying a map to a quiet backdrop. */
  tone?: (r: number, g: number, b: number) => [number, number, number];
}

/** Key-free tile services, each with the credit it asks for. */
export const TILE_STYLES: Record<'light' | 'streets' | 'aerial', TileService> = {
  light: {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    credit: '© OpenStreetMap contributors',
    maxzoom: 19,
    // Mostly grey and lifted, so data drawn over it stands out.
    tone: (r, g, b) => {
      const grey = 0.299 * r + 0.587 * g + 0.114 * b;
      const mix = (c: number) => 0.15 * c + 0.85 * grey;
      const lift = (c: number) => 70 + c * 0.75;
      return [lift(mix(r)), lift(mix(g)), lift(mix(b))];
    },
  },
  streets: {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    credit: '© OpenStreetMap contributors',
    maxzoom: 19,
  },
  aerial: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    credit: 'Esri, Maxar, Earthstar Geographics and the GIS user community',
    maxzoom: 19,
  },
};

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
export function tilesFor(site: SiteInfo, pxPerMetre: number, service: TileService): Tile[] {
  const lons = site.corners.map((c) => c[0]);
  const lats = site.corners.map((c) => c[1]);
  const [west, east, south, north] = [Math.min(...lons), Math.max(...lons), Math.min(...lats), Math.max(...lats)];
  const lat = (south + north) / 2;
  // A 256-pixel tile at zoom z is 40 075 km × cos(lat) / 2^z wide.
  let z = Math.ceil(Math.log2((156_543.03 * Math.cos((lat * Math.PI) / 180)) * Math.max(pxPerMetre, 1e-6)));
  z = Math.max(1, Math.min(service.maxzoom, z));
  const span = (zoom: number) => {
    const n = 2 ** zoom;
    return { n, x0: Math.floor(lonToX(west, n)), x1: Math.floor(lonToX(east, n)), y0: Math.floor(latToY(north, n)), y1: Math.floor(latToY(south, n)) };
  };
  let s = span(z);
  while (z > 1 && (s.x1 - s.x0 + 1) * (s.y1 - s.y0 + 1) > MOST_TILES) s = span(--z);
  const tiles: Tile[] = [];
  for (let x = s.x0; x <= s.x1; x++) {
    for (let y = s.y0; y <= s.y1; y++) {
      const url = service.url.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
      tiles.push({ url, west: xToLon(x, s.n), east: xToLon(x + 1, s.n), north: yToLat(y, s.n), south: yToLat(y + 1, s.n) });
    }
  }
  return tiles;
}
