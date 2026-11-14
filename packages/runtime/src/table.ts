import type { CanvasOverlay, Colormap, FieldOverlay, FieldOverlayStyle, MapHandle, SiteInfo } from '@mrstudio/sdk';
import maplibregl from 'maplibre-gl';
import type { StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import { MapFieldOverlay } from './field-overlay.ts';

const EARTH_CIRCUMFERENCE_M = 40_075_016.686;
/** Width in pixels of a layer's canvas unless it asks for another. */
const CANVAS_WIDTH = 2048;
/** Each scene layer has an invisible marker in the map's stack; what the layer draws goes just below it. */
const slot = (instance: string) => `slot:${instance}`;

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
  /** Map layer ids each scene layer has added, in the order it added them. */
  private owned = new Map<string, string[]>();

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
      this.map.once('load', () => resolve());
    });
  }

  /** What a scene layer may draw. Ids are namespaced by the layer, and everything lands in its slot. */
  handle(instance: string, track: (cleanup: () => void) => void): MapHandle {
    const map = this.map;
    const add = (id: string, layer: Parameters<typeof map.addLayer>[0]) => {
      this.ensureSlot(instance);
      map.addLayer(layer, slot(instance));
      this.owned.get(instance)!.push(id);
    };
    const forget = (id: string) => {
      const owned = this.owned.get(instance);
      if (owned) owned.splice(owned.indexOf(id) >>> 0, 1);
    };
    return {
      addField: (name: string, style: FieldOverlayStyle & { colormap: Colormap }): FieldOverlay => {
        const id = `field:${instance}:${name}`;
        const overlay = new MapFieldOverlay(map, id, this.site, style);
        add(id, overlay);
        track(() => {
          overlay.remove();
          forget(id);
        });
        return overlay;
      },
      addCanvas: (name: string, options = {}): CanvasOverlay => {
        const id = `canvas:${instance}:${name}`;
        const { width_m, height_m } = this.site.extent;
        const element = document.createElement('canvas');
        element.width = Math.round(options.resolution ?? CANVAS_WIDTH);
        element.height = Math.max(1, Math.round((element.width * height_m) / width_m));
        const scale = element.width / width_m;
        const ctx = element.getContext('2d')!;
        ctx.setTransform(scale, 0, 0, scale, 0, 0);
        // The canvas is uploaded only on commit, so a static layer costs nothing per frame.
        map.addSource(id, { type: 'canvas', canvas: element, coordinates: this.site.corners, animate: false });
        add(id, { id, type: 'raster', source: id, paint: { 'raster-opacity': options.opacity ?? 1, 'raster-fade-duration': 0 } });
        let removed = false;
        const remove = () => {
          if (removed) return;
          removed = true;
          if (map.getLayer(id)) map.removeLayer(id);
          if (map.getSource(id)) map.removeSource(id);
          forget(id);
        };
        track(remove);
        return {
          ctx,
          width: width_m,
          height: height_m,
          scale,
          clear: () => ctx.clearRect(0, 0, width_m, height_m),
          commit: () => {
            if (removed) return;
            const source = map.getSource(id) as maplibregl.CanvasSource | undefined;
            // Playing and pausing makes the source read the canvas once.
            source?.play();
            source?.pause();
            map.triggerRepaint();
          },
          setOpacity: (opacity) => {
            if (!removed) map.setPaintProperty(id, 'raster-opacity', opacity);
          },
          remove,
        };
      },
      // Decorations are page elements above the map, so they are not part of the draw order.
      addElement: (): HTMLElement => {
        const element = document.createElement('div');
        element.className = 'table-decoration';
        element.dataset.layer = instance;
        this.container.append(element);
        track(() => element.remove());
        return element;
      },
    };
  }

  /** Stacks the scene's layers in this order, bottom first. */
  setOrder(scene: string[]): void {
    for (const instance of scene) {
      this.ensureSlot(instance);
      for (const id of this.owned.get(instance)!) if (this.map.getLayer(id)) this.map.moveLayer(id);
      this.map.moveLayer(slot(instance));
    }
  }

  /** Forgets a layer that left the scene. */
  dropSlot(instance: string): void {
    if (this.map.getLayer(slot(instance))) this.map.removeLayer(slot(instance));
    this.owned.delete(instance);
  }

  private ensureSlot(instance: string): void {
    if (this.owned.has(instance)) return;
    this.owned.set(instance, []);
    this.map.addLayer({ id: slot(instance), type: 'background', layout: { visibility: 'none' } });
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
}
