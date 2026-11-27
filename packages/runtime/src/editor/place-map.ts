import maplibregl from '../maplibre';
import type { GeoJSONSource, RasterTileSource, StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import { el } from '../controls.ts';

/**
 * Raster base maps an author can see a place on. The first is the default for picking
 * where a table goes: OpenStreetMap needs no key, and is drawn light so the table's
 * outline stands out. CARTO's light map watermarks its tiles in the desktop app unless
 * it is given a key, which belongs in the Sources manager (#111), never in the repo.
 */
export const BASEMAPS = [
  {
    id: 'osm-light',
    name: 'Light',
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    attribution: '© OpenStreetMap contributors',
    needsKey: false,
  },
  {
    id: 'carto-positron',
    name: 'CARTO light',
    tiles: ['a', 'b', 'c'].map((s) => `https://${s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png`),
    attribution: '© OpenStreetMap contributors © CARTO',
    needsKey: true,
  },
] as const;

/**
 * A base map with a key from the Sources manager, when one is set up and ready: CARTO's
 * light map first, then Mapbox. The tiles come through the host, which adds the key, so
 * the key never reaches this page (#111). `null` without one, or in a page with no host.
 */
export async function keyedBasemap(): Promise<{ tiles: string[]; attribution: string } | null> {
  try {
    const response = await fetch('/api/sources', { cache: 'no-store' });
    if (!response.ok) return null;
    const page = (await response.json()) as { sources?: { id: string; kind: string; ready: boolean; auth: string }[] };
    for (const [kind, attribution] of [
      ['carto', '© OpenStreetMap contributors © CARTO'],
      ['mapbox', '© Mapbox © OpenStreetMap contributors'],
    ] as const) {
      const source = page.sources?.find((s) => s.kind === kind && s.ready && s.auth !== 'none');
      if (source) return { tiles: [`${location.origin}/api/sources/${encodeURIComponent(source.id)}/tile/{z}/{x}/{y}`], attribution };
    }
  } catch {
    // No host, or not on this computer: the keyless map stays.
  }
  return null;
}

/** Where the map opens before a place is given: Gothenburg, at city zoom. */
export const START = { lat: 57.7089, lon: 11.9746, zoom: 11 };

/** Model scales a table is often built at, offered as one click. */
export const COMMON_SCALES = [500, 1000, 2000, 5000];

/** The model scale, 1 : N, of a table `table_cm` wide showing `width_m` of ground. */
export const scaleOf = (width_m: number, table_cm: number) => (width_m * 100) / table_cm;

/** Where a table is and how much ground it covers. */
export interface Placement {
  lat: number;
  lon: number;
  width_m: number;
  height_m: number;
  /** Bearing of the table's top edge, clockwise from north. */
  rotation_deg: number;
}

const METRES_PER_DEGREE_LAT = 110_540;
const metresPerDegreeLon = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);

/** A point `x` metres right and `y` metres up from the table's centre, in lon/lat. */
export function offset(place: Placement, x: number, y: number): [number, number] {
  const r = (place.rotation_deg * Math.PI) / 180;
  const east = x * Math.cos(r) + y * Math.sin(r);
  const north = -x * Math.sin(r) + y * Math.cos(r);
  return [place.lon + east / metresPerDegreeLon(place.lat), place.lat + north / METRES_PER_DEGREE_LAT];
}

/** A lon/lat in metres on the table's axes from its centre: x right, y up. */
export function onTable(place: Placement, lon: number, lat: number): [number, number] {
  const r = (place.rotation_deg * Math.PI) / 180;
  const east = (lon - place.lon) * metresPerDegreeLon(place.lat);
  const north = (lat - place.lat) * METRES_PER_DEGREE_LAT;
  return [east * Math.cos(r) - north * Math.sin(r), east * Math.sin(r) + north * Math.cos(r)];
}

/** The table's outline as a closed ring: top left, top right, bottom right, bottom left. */
export function outline(place: Placement): [number, number][] {
  const w = place.width_m / 2;
  const h = place.height_m / 2;
  const ring = [offset(place, -w, h), offset(place, w, h), offset(place, w, -h), offset(place, -w, -h)];
  return [...ring, ring[0]!];
}

/** Lines between square tiles `tile_m` on a side, inside the table's outline. */
export function tileLines(place: Placement, tile_m: number): [number, number][][] {
  const w = place.width_m / 2;
  const h = place.height_m / 2;
  const lines: [number, number][][] = [];
  // Too many lines to read (or a tile no bigger than a hair) draws none.
  if (!(tile_m > 0) || place.width_m / tile_m > 200 || place.height_m / tile_m > 200) return lines;
  for (let x = -w + tile_m; x < w - tile_m * 0.01; x += tile_m) lines.push([offset(place, x, h), offset(place, x, -h)]);
  for (let y = h - tile_m; y > -h + tile_m * 0.01; y -= tile_m) lines.push([offset(place, -w, y), offset(place, w, y)]);
  return lines;
}

/** Degrees as a whole bearing from 0 up to 360. */
const bearingOf = (degrees: number) => ((Math.round(degrees) % 360) + 360) % 360;

/** Two buttons that turn the map 5° at a time, under the zoom buttons. */
class TurnControl implements maplibregl.IControl {
  private readonly node = el('div', 'maplibregl-ctrl maplibregl-ctrl-group pm-turn');
  constructor(turn: (degrees: number) => void) {
    for (const [label, degrees, glyph] of [['Turn the map left', -5, '↺'], ['Turn the map right', 5, '↻']] as const) {
      const button = el('button', undefined, glyph);
      button.type = 'button';
      button.title = label;
      button.setAttribute('aria-label', label);
      button.addEventListener('click', () => turn(degrees));
      this.node.append(button);
    }
  }
  onAdd(): HTMLElement {
    return this.node;
  }
  onRemove(): void {
    this.node.remove();
  }
}

/** Rounds a size to 10 m, within what a table can be. */
const size = (metres: number) => Math.min(20_000, Math.max(100, Math.round(metres / 10) * 10));

/**
 * A small map for placing a table: the outline at its real size, always upright as the
 * real table stands, moved by clicking or dragging its centre and scaled by dragging its
 * corner. Turning turns the map under it. Fields elsewhere follow through `onChange`, and call
 * `set` when they are typed in. Without tiles (offline) the outline still works on a
 * plain ground, and a note says so.
 */
export class PlaceMap {
  readonly element = el('div', 'pm');
  private readonly map: maplibregl.Map;
  private place: Placement | null;
  private readonly centre: maplibregl.Marker;
  private readonly corner: maplibregl.Marker;
  private readonly note = el('p', 'pm-note');
  private framed = false;
  private shown = false;
  /** The side of a 3D-printed tile in metres of ground, or null for no tile grid. */
  private tile_m: number | null = null;

  private readonly onChange: (place: Placement) => void;

  constructor(start: Placement | null, onChange: (place: Placement) => void, options: { data?: string } = {}) {
    this.place = start;
    this.onChange = onChange;
    const basemap = BASEMAPS[0];
    const style: StyleSpecification = {
      version: 8,
      sources: { base: { type: 'raster', tiles: [...basemap.tiles], tileSize: 256, attribution: basemap.attribution, maxzoom: 19 } },
      layers: [
        { id: 'ground', type: 'background', paint: { 'background-color': '#eef0f3' } },
        // Desaturated and lifted, so the map reads as quiet ground under the table.
        { id: 'base', type: 'raster', source: 'base', paint: { 'raster-saturation': -0.85, 'raster-brightness-min': 0.3, 'raster-contrast': -0.2 } },
      ],
    };
    const box = el('div', 'pm-map');
    this.note.hidden = true;
    this.element.append(box, this.note);
    this.map = new maplibregl.Map({
      container: box,
      style,
      center: start ? [start.lon, start.lat] : [START.lon, START.lat],
      zoom: start ? 13 : START.zoom,
      bearing: start?.rotation_deg ?? 0,
      attributionControl: { compact: false },
      pitchWithRotate: false,
      touchPitch: false,
      maxPitch: 0,
    });
    // The table never turns: turning the map chooses which way the world faces on it. Right-drag,
    // Ctrl-drag or two fingers turn it, as do the buttons; the compass brings north back up.
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: false }), 'top-right');
    this.map.addControl(new TurnControl((by) => this.turnBy(by)), 'top-right');
    this.map.on('rotate', (event) => {
      if (!(event as { originalEvent?: Event }).originalEvent) return;
      this.change({ rotation_deg: bearingOf(this.map.getBearing()) }, false);
    });
    this.map.on('rotateend', (event) => {
      if (!(event as { originalEvent?: Event }).originalEvent) return;
      // Close to a right angle snaps to it.
      const bearing = bearingOf(this.map.getBearing());
      const nearest = Math.round(bearing / 90) * 90;
      if (bearing !== nearest && Math.abs(bearing - nearest) <= 3) this.change({ rotation_deg: nearest % 360 });
      else this.change({ rotation_deg: bearing });
    });
    // With a base map key in Sources, its tiles replace the keyless ones.
    void keyedBasemap().then((keyed) => {
      if (!keyed) return;
      const swap = () => (this.map.getSource('base') as RasterTileSource | undefined)?.setTiles(keyed.tiles);
      if (this.map.isStyleLoaded()) swap();
      else void this.map.once('load', swap);
    });
    let failed = 0;
    this.map.on('error', (event) => {
      if ((event as { sourceId?: string }).sourceId !== 'base' || ++failed < 3) return;
      this.note.textContent = 'The map could not be loaded, so there is no background. The outline still works, and the fields beside it do too.';
      this.note.hidden = false;
    });

    const handle = (className: string, title: string) => {
      const node = el('div', `pm-handle ${className}`);
      node.title = title;
      return new maplibregl.Marker({ element: node, draggable: true });
    };
    this.centre = handle('is-centre', 'Drag to move the table');
    this.corner = handle('is-corner', 'Drag to make the table cover more or less ground');
    this.centre.on('drag', () => {
      const { lng, lat } = this.centre.getLngLat();
      this.change({ lon: lng, lat });
    });
    // Scaled from the size the drag started at, so small steps are not lost to rounding.
    let base: Placement | null = null;
    this.corner.on('dragstart', () => (base = this.place));
    this.corner.on('drag', () => {
      const place = base ?? this.place!;
      const { lng, lat } = this.corner.getLngLat();
      const [x, y] = onTable(place, lng, lat);
      // Along the diagonal, so the table keeps its shape.
      const [w, h] = [place.width_m / 2, place.height_m / 2];
      const scale = Math.max(0.01, (x * w + y * h) / (w * w + h * h));
      this.change({ width_m: size(place.width_m * scale), height_m: size(place.height_m * scale) });
    });
    // A table scaled past the edge of the view comes back into it.
    this.corner.on('dragend', () => this.frame());
    this.map.on('click', (event) => this.change({ lon: event.lngLat.lng, lat: event.lngLat.lat }));

    // Once the style is read, not on load: load waits for tiles, which may never come offline.
    void this.map.once('style.load', () => {
      this.map.addSource('table', { type: 'geojson', data: this.geojson() });
      this.map.addSource('tiles', { type: 'geojson', data: this.tileGeojson() });
      if (options.data) {
        // What is already on the table, so it can be lined up with the map.
        this.map.addSource('data', { type: 'geojson', data: options.data });
        this.map.addLayer({ id: 'data-fill', type: 'fill', source: 'data', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#3557d4', 'fill-opacity': 0.25 } });
        this.map.addLayer({ id: 'data-line', type: 'line', source: 'data', paint: { 'line-color': '#3557d4', 'line-width': 0.8, 'line-opacity': 0.6 } });
      }
      this.map.addLayer({ id: 'table-fill', type: 'fill', source: 'table', paint: { 'fill-color': '#f3ad3d', 'fill-opacity': 0.12 } });
      this.map.addLayer({ id: 'tiles-line', type: 'line', source: 'tiles', paint: { 'line-color': '#c77d00', 'line-width': 1, 'line-opacity': 0.7 } });
      this.map.addLayer({ id: 'table-line', type: 'line', source: 'table', paint: { 'line-color': '#c77d00', 'line-width': 2, 'line-dasharray': [3, 2] } });
      this.draw();
    });
    // The handles do not wait for the map to load: without tiles it may load late or not at all.
    this.draw();
    new ResizeObserver(() => {
      this.map.resize();
      if (!this.framed) this.frame();
    }).observe(box);
  }

  /** The placement as the map has it. */
  get value(): Placement | null {
    return this.place;
  }

  /** Takes a placement typed elsewhere. */
  set(place: Placement | null, frame = false): void {
    const was = this.place;
    const moved = !was || !place || Math.abs(place.lat - was.lat) > 1e-9 || Math.abs(place.lon - was.lon) > 1e-9;
    const resized = !!was && !!place && (place.width_m !== was.width_m || place.height_m !== was.height_m || place.rotation_deg !== was.rotation_deg);
    this.place = place;
    this.draw();
    if (frame || (place && (moved || resized))) this.frame();
  }

  /** Draws the 3D-printing tile grid, `tile_m` metres of ground on a side; null hides it. */
  tiles(tile_m: number | null): void {
    this.tile_m = tile_m && tile_m > 0 ? tile_m : null;
    (this.map.getSource('tiles') as GeoJSONSource | undefined)?.setData(this.tileGeojson());
  }

  private tileGeojson(): { type: 'FeatureCollection'; features: { type: 'Feature'; properties: object; geometry: { type: 'MultiLineString'; coordinates: [number, number][][] } }[] } {
    const lines = this.place && this.tile_m ? tileLines(this.place, this.tile_m) : [];
    return { type: 'FeatureCollection', features: lines.length ? [{ type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: lines } }] : [] };
  }

  private turnBy(degrees: number): void {
    if (!this.place) return;
    this.change({ rotation_deg: bearingOf(this.place.rotation_deg + degrees) });
    this.frame();
  }

  private change(patch: Partial<Placement>, redraw = true): void {
    if (!this.place) {
      if (patch.lat === undefined || patch.lon === undefined) return;
      this.place = { lat: patch.lat, lon: patch.lon, width_m: 1000, height_m: 600, rotation_deg: bearingOf(this.map.getBearing()) };
      this.frame();
    } else this.place = { ...this.place, ...patch };
    if (redraw) this.draw();
    else {
      (this.map.getSource('table') as GeoJSONSource | undefined)?.setData(this.geojson());
      (this.map.getSource('tiles') as GeoJSONSource | undefined)?.setData(this.tileGeojson());
    }
    this.onChange(this.place);
  }

  private geojson(): { type: 'FeatureCollection'; features: { type: 'Feature'; properties: object; geometry: { type: 'Polygon'; coordinates: [number, number][][] } }[] } {
    return {
      type: 'FeatureCollection',
      features: this.place ? [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [outline(this.place)] } }] : [],
    };
  }

  private draw(): void {
    (this.map.getSource('table') as GeoJSONSource | undefined)?.setData(this.geojson());
    (this.map.getSource('tiles') as GeoJSONSource | undefined)?.setData(this.tileGeojson());
    const place = this.place;
    const markers = [this.centre, this.corner];
    if (!place) {
      for (const marker of markers) marker.remove();
      this.shown = false;
      return;
    }
    // Moving a marker that is being dragged is harmless; adding it again would end the drag.
    this.centre.setLngLat([place.lon, place.lat]);
    this.corner.setLngLat(offset(place, place.width_m / 2, place.height_m / 2));
    if (!this.shown) for (const marker of markers) marker.addTo(this.map);
    this.shown = true;
  }

  /** Turns the map so the table stands upright, and zooms so all of it is in view with some ground around it. */
  private frame(): void {
    const box = this.map.getContainer();
    if (!this.place || box.clientWidth === 0) return;
    const { lat, lon, width_m, height_m, rotation_deg } = this.place;
    const padding = 48;
    const metresPerPixel = Math.max(width_m / Math.max(1, box.clientWidth - 2 * padding), height_m / Math.max(1, box.clientHeight - 2 * padding));
    // Web Mercator at MapLibre's 512-pixel world: metres per pixel = C cos(lat) / (512 · 2^zoom).
    const zoom = Math.log2((40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * metresPerPixel));
    this.map.jumpTo({ center: [lon, lat], zoom: Math.min(18, zoom), bearing: rotation_deg });
    this.framed = true;
  }
}
