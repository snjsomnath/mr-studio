import maplibregl from 'maplibre-gl';
import type { GeoJSONSource, StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import { el } from '../controls.ts';

/**
 * Free raster base maps an author can see a place on. The first is the default for
 * picking where a table goes; the base map picker (#37) offers the same list.
 */
export const BASEMAPS = [
  {
    id: 'positron',
    name: 'Light',
    tiles: ['a', 'b', 'c'].map((s) => `https://${s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png`),
    attribution: '© OpenStreetMap contributors © CARTO',
  },
  {
    id: 'osm',
    name: 'OpenStreetMap',
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    attribution: '© OpenStreetMap contributors',
  },
] as const;

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

/** Where the handle that turns the table sits: just beyond the middle of its top edge. */
const turnHandle = (place: Placement) => offset(place, 0, place.height_m / 2 + Math.max(place.width_m, place.height_m) * 0.12);

/** Rounds a size to 10 m, within what a table can be. */
const size = (metres: number) => Math.min(20_000, Math.max(100, Math.round(metres / 10) * 10));

/**
 * A small map for placing a table: the outline at its real size, which can be moved by
 * clicking or dragging its centre, scaled by dragging its corner and turned by dragging
 * the handle above its top edge. Fields elsewhere follow through `onChange`, and call
 * `set` when they are typed in. Without tiles (offline) the outline still works on a
 * plain ground, and a note says so.
 */
export class PlaceMap {
  readonly element = el('div', 'pm');
  private readonly map: maplibregl.Map;
  private place: Placement | null;
  private readonly centre: maplibregl.Marker;
  private readonly corner: maplibregl.Marker;
  private readonly turn: maplibregl.Marker;
  private readonly note = el('p', 'pm-note');
  private framed = false;
  private shown = false;

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
        { id: 'base', type: 'raster', source: 'base' },
      ],
    };
    const box = el('div', 'pm-map');
    this.note.hidden = true;
    this.element.append(box, this.note);
    this.map = new maplibregl.Map({
      container: box,
      style,
      center: start ? [start.lon, start.lat] : [11.97, 57.7],
      zoom: start ? 13 : 3,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
    });
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
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
    this.turn = handle('is-turn', 'Drag to turn the table');
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
    this.turn.on('drag', () => {
      const place = this.place!;
      const { lng, lat } = this.turn.getLngLat();
      const east = (lng - place.lon) * metresPerDegreeLon(place.lat);
      const north = (lat - place.lat) * METRES_PER_DEGREE_LAT;
      let bearing = Math.round((Math.atan2(east, north) * 180) / Math.PI);
      // Close to a right angle snaps to it.
      const nearest = Math.round(bearing / 90) * 90;
      if (Math.abs(bearing - nearest) <= 3) bearing = nearest;
      this.change({ rotation_deg: ((bearing % 360) + 360) % 360 });
    });
    // A table scaled or turned past the edge of the view comes back into it.
    this.corner.on('dragend', () => this.frame());
    this.turn.on('dragend', () => this.frame());
    this.map.on('click', (event) => this.change({ lon: event.lngLat.lng, lat: event.lngLat.lat }));

    // Once the style is read, not on load: load waits for tiles, which may never come offline.
    this.map.once('style.load', () => {
      this.map.addSource('table', { type: 'geojson', data: this.geojson() });
      if (options.data) {
        // What is already on the table, so it can be lined up with the map.
        this.map.addSource('data', { type: 'geojson', data: options.data });
        this.map.addLayer({ id: 'data-fill', type: 'fill', source: 'data', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#3557d4', 'fill-opacity': 0.25 } });
        this.map.addLayer({ id: 'data-line', type: 'line', source: 'data', paint: { 'line-color': '#3557d4', 'line-width': 0.8, 'line-opacity': 0.6 } });
      }
      this.map.addLayer({ id: 'table-fill', type: 'fill', source: 'table', paint: { 'fill-color': '#f3ad3d', 'fill-opacity': 0.12 } });
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
    const moved = !this.place || !place || Math.abs(place.lat - this.place.lat) > 1e-9 || Math.abs(place.lon - this.place.lon) > 1e-9;
    this.place = place;
    this.draw();
    if (frame || (moved && place)) this.frame();
  }

  private change(patch: Partial<Placement>): void {
    if (!this.place) {
      if (patch.lat === undefined || patch.lon === undefined) return;
      this.place = { lat: patch.lat, lon: patch.lon, width_m: 1000, height_m: 600, rotation_deg: 0 };
      this.frame();
    } else this.place = { ...this.place, ...patch };
    this.draw();
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
    const place = this.place;
    const markers = [this.centre, this.corner, this.turn];
    if (!place) {
      for (const marker of markers) marker.remove();
      this.shown = false;
      return;
    }
    // Moving a marker that is being dragged is harmless; adding it again would end the drag.
    this.centre.setLngLat([place.lon, place.lat]);
    this.corner.setLngLat(offset(place, place.width_m / 2, place.height_m / 2));
    this.turn.setLngLat(turnHandle(place));
    if (!this.shown) for (const marker of markers) marker.addTo(this.map);
    this.shown = true;
  }

  /** Zooms so the whole table is in view with some ground around it. */
  private frame(): void {
    if (!this.place || this.element.clientWidth === 0) return;
    const ring = [...outline(this.place), turnHandle(this.place)];
    const lons = ring.map((p) => p[0]);
    const lats = ring.map((p) => p[1]);
    this.map.fitBounds(
      [
        [Math.min(...lons), Math.min(...lats)],
        [Math.max(...lons), Math.max(...lats)],
      ],
      { padding: 40, duration: 0, maxZoom: 17 },
    );
    this.framed = true;
  }
}
