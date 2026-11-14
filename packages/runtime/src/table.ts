import type { Colormap, FieldOverlay, FieldOverlayStyle, MapHandle, SiteInfo } from '@mrstudio/sdk';
import maplibregl from 'maplibre-gl';
import type { StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import { MapFieldOverlay } from './field-overlay.ts';

const EARTH_CIRCUMFERENCE_M = 40_075_016.686;
/** Field overlays are inserted below the site's buildings, so roofs and outlines stay readable. */
const FILL_LAYER = 'site-buildings-fill';
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
  /** What each layer has drawn, so its intensity can be applied to all of it. */
  private drawn = new Map<string, { overlays: Set<MapFieldOverlay>; elements: Set<HTMLElement>; intensity: number }>();

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
    const drawn = this.drawnBy(layer);
    return {
      addField: (id: string, style: FieldOverlayStyle & { colormap: Colormap }): FieldOverlay => {
        const overlay = new MapFieldOverlay(this.map, `field:${layer}:${id}`, this.site, style);
        this.map.addLayer(overlay, this.map.getLayer(FILL_LAYER) ? FILL_LAYER : undefined);
        overlay.setGain(drawn.intensity);
        drawn.overlays.add(overlay);
        track(() => {
          drawn.overlays.delete(overlay);
          overlay.remove();
        });
        return overlay;
      },
      addElement: (): HTMLElement => {
        const element = document.createElement('div');
        element.className = 'table-decoration';
        element.dataset.layer = layer;
        this.container.append(element);
        styleElement(element, drawn.intensity);
        drawn.elements.add(element);
        track(() => {
          drawn.elements.delete(element);
          element.remove();
        });
        return element;
      },
    };
  }

  /** Applies a layer's intensity (0 to 2) to everything it has drawn and will draw. */
  setIntensity(layer: string, intensity: number): void {
    const drawn = this.drawnBy(layer);
    drawn.intensity = intensity;
    for (const overlay of drawn.overlays) overlay.setGain(intensity);
    for (const element of drawn.elements) styleElement(element, intensity);
  }

  private drawnBy(layer: string) {
    let drawn = this.drawn.get(layer);
    if (!drawn) this.drawn.set(layer, (drawn = { overlays: new Set(), elements: new Set(), intensity: 1 }));
    return drawn;
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
    this.map.addLayer({ id: FILL_LAYER, type: 'fill', source: 'site-buildings', paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.07 } });
    this.map.addLayer({ id: OUTLINE_LAYER, type: 'line', source: 'site-buildings', paint: { 'line-color': '#ffffff', 'line-opacity': 0.28, 'line-width': 1 } });
  }
}

/** Below 1 a decoration fades; above 1 it brightens. The filter is on the layer's own element, never the root. */
function styleElement(element: HTMLElement, intensity: number): void {
  element.style.opacity = String(Math.min(1, intensity));
  element.style.filter = intensity > 1 ? `brightness(${intensity})` : '';
}
