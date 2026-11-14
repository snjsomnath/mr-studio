import type { CanvasOverlay, Colormap, FieldOverlay, FieldOverlayStyle, MapHandle, ModelHandle, Shape, ShapeOverlay, SiteInfo, TablePointer } from '@mrstudio/sdk';
import maplibregl from 'maplibre-gl';
import type { StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import { MapFieldOverlay } from './field-overlay.ts';
import { ModelView } from './model/view.ts';
import { tablePointer } from './table-pointer.ts';

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
  /** The model surface, once `attachModel` has loaded the twin. Null on a host or a device without one. */
  model: ModelView | null = null;
  private map: maplibregl.Map;
  readonly site: SiteInfo;
  readonly container: HTMLElement;
  /** Map layer ids each scene layer has added, in the order it added them. */
  private owned = new Map<string, string[]>();
  /** What each layer has drawn, so its intensity can be applied to all of it. */
  private drawn = new Map<string, { overlays: Set<MapFieldOverlay>; elements: Set<HTMLElement>; canvases: Map<string, number>; intensity: number }>();

  constructor(container: HTMLElement, site: SiteInfo) {
    this.site = site;
    this.container = container;
    const blank: StyleSpecification = {
      version: 8,
      sources: {},
      layers: [],
    };
    // The background is the surface's own, so the map stays clear where it draws nothing and the twin can show through.
    container.style.backgroundColor = site.basemap.background;
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
    const drawn = this.drawnBy(instance);
    const add = (id: string, layer: maplibregl.AddLayerObject) => {
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
        overlay.setGain(drawn.intensity);
        drawn.overlays.add(overlay);
        track(() => {
          drawn.overlays.delete(overlay);
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
        // The layer's own opacity, which its intensity scales.
        drawn.canvases.set(id, options.opacity ?? 1);
        add(id, { id, type: 'raster', source: id, paint: { 'raster-opacity': canvasOpacity(options.opacity ?? 1, drawn.intensity), 'raster-fade-duration': 0 } });
        let removed = false;
        const remove = () => {
          if (removed) return;
          removed = true;
          drawn.canvases.delete(id);
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
            if (removed) return;
            drawn.canvases.set(id, opacity);
            map.setPaintProperty(id, 'raster-opacity', canvasOpacity(opacity, drawn.intensity));
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
        styleElement(element, drawn.intensity);
        drawn.elements.add(element);
        track(() => {
          drawn.elements.delete(element);
          element.remove();
        });
        return element;
      },
      addShapes: (name: string, style?: { opacity?: number }): ShapeOverlay => {
        const overlay = this.shapes(`shapes:${instance}:${name}`, style?.opacity ?? 1, add, forget);
        track(() => overlay.remove());
        return overlay;
      },
    };
  }

  /** Points, lines and areas as one GeoJSON source, drawn in the layer's slot. */
  private shapes(
    source: string,
    opacity: number,
    add: (id: string, layer: maplibregl.AddLayerObject) => void,
    forget: (id: string) => void,
  ): ShapeOverlay {
    const map = this.map;
    const colour = ['coalesce', ['get', 'colour'], '#ffffff'] as unknown as string;
    map.addSource(source, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    const is = (type: string) => ['==', ['geometry-type'], type] as maplibregl.FilterSpecification;
    add(`${source}:fill`, { id: `${source}:fill`, type: 'fill', source, filter: is('Polygon'), paint: { 'fill-color': colour } });
    add(`${source}:line`, {
      id: `${source}:line`,
      type: 'line',
      source,
      filter: ['!=', ['geometry-type'], 'Point'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': colour, 'line-width': 4 },
    });
    add(`${source}:point`, {
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
        for (const kind of ['fill', 'line', 'point']) {
          map.removeLayer(`${source}:${kind}`);
          forget(`${source}:${kind}`);
        }
        map.removeSource(source);
      },
    };
  }

  /** Pointer input on the table surface for one layer. */
  pointer(track: (cleanup: () => void) => void): TablePointer {
    return tablePointer(this.container, this.site, track);
  }

  /** Applies a layer's intensity (0 to 2) to everything it has drawn and will draw. */
  setIntensity(instance: string, intensity: number): void {
    const drawn = this.drawnBy(instance);
    drawn.intensity = intensity;
    for (const overlay of drawn.overlays) overlay.setGain(intensity);
    for (const element of drawn.elements) styleElement(element, intensity);
    for (const [id, opacity] of drawn.canvases) this.map.setPaintProperty(id, 'raster-opacity', canvasOpacity(opacity, intensity));
    this.model?.setIntensity(instance, intensity);
  }

  private drawnBy(instance: string) {
    let drawn = this.drawn.get(instance);
    if (!drawn) this.drawn.set(instance, (drawn = { overlays: new Set(), elements: new Set(), canvases: new Map(), intensity: 1 }));
    return drawn;
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
    this.drawn.delete(instance);
  }

  private ensureSlot(instance: string): void {
    if (this.owned.has(instance)) return;
    this.owned.set(instance, []);
    this.map.addLayer({ id: slot(instance), type: 'background', layout: { visibility: 'none' } });
  }

  /** Loads the site's twin and lays the model surface over the map. Resolves to null when that is not possible. */
  async attachModel(): Promise<ModelView | null> {
    try {
      this.model = await ModelView.create(this.container, this.site, this.map);
      for (const [layer, drawn] of this.drawn) this.model.setIntensity(layer, drawn.intensity);
    } catch (error) {
      console.warn('model surface is off; the table stays flat:', (error as Error).message);
    }
    return this.model;
  }

  /** A layer's `ctx.model`. Without a twin, fields go to the flat map and the rest does nothing. */
  modelHandle(layer: string, track: (cleanup: () => void) => void): ModelHandle {
    if (this.model) return this.model.handle(layer, track);
    const map = this.handle(layer, track);
    return {
      calibrated: false,
      addField: (id, style) => map.addField(`model:${id}`, style),
      addLight: () => ({ set: () => {}, remove: () => {} }),
      setMaterial: () => {},
      focus: () => {},
      pick: () => null,
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
}

/** Below 1 a decoration fades; above 1 it brightens. The filter is on the layer's own element, never the root. */
function styleElement(element: HTMLElement, intensity: number): void {
  element.style.opacity = String(Math.min(1, intensity));
  element.style.filter = intensity > 1 ? `brightness(${intensity})` : '';
}

/** A canvas fades below intensity 1. It is already drawn at full strength, so above 1 it stays as it is. */
function canvasOpacity(opacity: number, intensity: number): number {
  return opacity * Math.min(1, Math.max(0, intensity));
}
