import type { Colormap, FieldOverlay, FieldOverlayStyle, MapHandle, Shape, ShapeOverlay, SiteInfo } from '@mrstudio/sdk';
import maplibregl from 'maplibre-gl';
import type { StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import { MapFieldOverlay } from './field-overlay.ts';

const EARTH_CIRCUMFERENCE_M = 40_075_016.686;
/** Field overlays are inserted below this layer, so building outlines stay readable. */
const OUTLINE_LAYER = 'site-buildings-outline';

/**
 * The table view: a map locked to the site's extent. The extent fills the
 * container, so on a correctly shaped window one site metre is the same
 * number of pixels in both directions.
 */
export class TableView {
  readonly ready: Promise<void>;
  private map: maplibregl.Map;
  private site: SiteInfo;
  private container: HTMLElement;

  constructor(container: HTMLElement, site: SiteInfo) {
    this.site = site;
    this.container = container;
    const blank: StyleSpecification = {
      version: 8,
      sources: {},
      layers: [{ id: 'background', type: 'background', paint: { 'background-color': site.basemap.background } }],
    };
    this.map = new maplibregl.Map({
      container,
      style: site.basemap.style ?? blank,
      center: [site.origin.lon, site.origin.lat],
      bearing: site.extent.rotation_deg,
      zoom: this.fitZoom(),
      interactive: false,
      attributionControl: false,
      fadeDuration: 0,
    });
    new ResizeObserver(() => this.fit()).observe(container);
    this.ready = new Promise((resolve) => {
      this.map.once('load', () => {
        this.addContext();
        resolve();
      });
    });
  }

  /** What layers may draw. Overlay ids are namespaced by the layer. */
  handle(layer: string, track: (cleanup: () => void) => void): MapHandle {
    return {
      addField: (id: string, style: FieldOverlayStyle & { colormap: Colormap }): FieldOverlay => {
        const overlay = new MapFieldOverlay(this.map, `field:${layer}:${id}`, this.site, style);
        this.map.addLayer(overlay, this.map.getLayer(OUTLINE_LAYER) ? OUTLINE_LAYER : undefined);
        track(() => overlay.remove());
        return overlay;
      },
      addShapes: (id: string, style?: { opacity?: number }): ShapeOverlay => {
        const overlay = this.shapes(`shapes:${layer}:${id}`, style?.opacity ?? 1);
        track(() => overlay.remove());
        return overlay;
      },
    };
  }

  /** Points, lines and areas as one GeoJSON source, drawn above everything else. */
  private shapes(source: string, opacity: number): ShapeOverlay {
    const map = this.map;
    const colour = ['coalesce', ['get', 'colour'], '#ffffff'] as unknown as string;
    map.addSource(source, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    const is = (type: string) => ['==', ['geometry-type'], type] as maplibregl.FilterSpecification;
    map.addLayer({ id: `${source}:fill`, type: 'fill', source, filter: is('Polygon'), paint: { 'fill-color': colour } });
    map.addLayer({
      id: `${source}:line`,
      type: 'line',
      source,
      filter: ['!=', ['geometry-type'], 'Point'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': colour, 'line-width': 4 },
    });
    map.addLayer({
      id: `${source}:point`,
      type: 'circle',
      source,
      filter: is('Point'),
      paint: { 'circle-color': colour, 'circle-radius': 9, 'circle-stroke-color': '#000000', 'circle-stroke-width': 2 },
    });
    const setOpacity = (value: number) => {
      map.setPaintProperty(`${source}:fill`, 'fill-opacity', 0.25 * value);
      map.setPaintProperty(`${source}:line`, 'line-opacity', value);
      map.setPaintProperty(`${source}:point`, 'circle-opacity', value);
      map.setPaintProperty(`${source}:point`, 'circle-stroke-opacity', value);
    };
    setOpacity(opacity);
    let removed = false;
    return {
      set: (shapes: Shape[]) => {
        if (removed) return;
        (map.getSource(source) as maplibregl.GeoJSONSource).setData({
          type: 'FeatureCollection',
          features: shapes.map((shape) => ({ type: 'Feature', geometry: shape.geometry, properties: shape.colour ? { colour: shape.colour } : {} })),
        });
      },
      setOpacity: (value: number) => !removed && setOpacity(value),
      remove: () => {
        if (removed) return;
        removed = true;
        for (const kind of ['fill', 'line', 'point']) map.removeLayer(`${source}:${kind}`);
        map.removeSource(source);
      },
    };
  }

  /** The zoom at which the extent exactly fits the container. */
  private fitZoom(): number {
    const { width_m, height_m } = this.site.extent;
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    const metresPerPixel = Math.max(width_m / width, height_m / height);
    const latitude = (this.site.origin.lat * Math.PI) / 180;
    return Math.log2((EARTH_CIRCUMFERENCE_M * Math.cos(latitude)) / (512 * metresPerPixel));
  }

  private fit(): void {
    this.map.resize();
    this.map.jumpTo({ center: [this.site.origin.lon, this.site.origin.lat], bearing: this.site.extent.rotation_deg, zoom: this.fitZoom() });
  }

  /** Building footprints from the site package, as quiet context under and over the layers. */
  private addContext(): void {
    if (!this.site.buildings) return;
    this.map.addSource('site-buildings', { type: 'geojson', data: `/site/${this.site.buildings}` });
    this.map.addLayer({ id: 'site-buildings-fill', type: 'fill', source: 'site-buildings', paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.06 } });
    this.map.addLayer({ id: OUTLINE_LAYER, type: 'line', source: 'site-buildings', paint: { 'line-color': '#ffffff', 'line-opacity': 0.35, 'line-width': 1 } });
  }
}
