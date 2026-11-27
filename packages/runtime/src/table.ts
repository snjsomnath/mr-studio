import { fitTable, revealPath, revealPolygon, sameReveal, tableFrame } from '@mrstudio/sdk';
import type { CanvasOverlay, DrawingOverlay, Colormap, FieldOverlay, FieldOverlayStyle, FlowOverlay, FlowOverlayStyle, MapHandle, ModelHandle, PixelRect, RevealShape, Shape, ShapeOverlay, SiteInfo, SpriteImage, SpriteOverlay, SpriteStyle, StrokeOverlay, TablePicture, TablePointer, DisplayQuality } from '@mrstudio/sdk';
import maplibregl from 'maplibre-gl';

type DetailRenderer = (g: CanvasRenderingContext2D, scale: number) => void;
import type { StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import { MapCanvasOverlay } from './canvas-overlay.ts';
import { MapFieldOverlay } from './field-overlay.ts';
import { MapFlowOverlay } from './flow-overlay.ts';
import { MapSpriteOverlay } from './sprite-overlay.ts';
import { MapStrokeOverlay } from './stroke-overlay.ts';
import { ModelView } from './model/view.ts';
import { pixelRatio } from './quality.ts';
import { tablePointer } from './table-pointer.ts';

const EARTH_CIRCUMFERENCE_M = 40_075_016.686;
/** Width in pixels of a layer's canvas unless it asks for another. */
const CANVAS_WIDTH = 2048;
/** Each scene layer has an invisible marker in the map's stack; what the layer draws goes just below it. */
const slot = (instance: string) => `slot:${instance}`;

/**
 * The table view: a map locked to the site. Without a calibration the extent
 * fills the container, so on a correctly shaped window one site metre is the
 * same number of pixels in both directions. On the projected table, the site's
 * calibration decides the view instead, so the image lands on the physical model.
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
  private calibrated: boolean;
  /** What each layer has drawn, so its intensity can be applied to all of it. */
  private drawn = new Map<string, Drawn>();
  /** Layers whose drawing is clipped to a revealing layer's shape (#287): the items of a Magnifier or a Reveal line. */
  private clippable = new Set<string>();
  /** The shape each clipped layer shows through; absent shows everything. */
  private clips = new Map<string, RevealShape>();
  /** Layers that draw a sharp picture for a magnifier (#351), and the scene's order to stack them in. */
  private details = new Map<string, DetailRenderer>();
  /** What layers ask of the ambient glow (#476), in the order they asked, the most recent last. */
  private glowWishes = new Map<string, 'off' | string>();
  private order: string[] = [];
  /** How many pointer listeners each layer has, so a click meant for a layer's own tool is left to it. */
  private listening = new Map<string, number>();
  private detailCanvas: HTMLCanvasElement | null = null;
  /** While the opening zoom plays: where the model will be when it lands, and the timer that starts it. */
  private intro: { footprint: [number, number][]; timer: number; resized: boolean } | null = null;

  /** `calibrated` applies the site's table calibration, when it has one. */
  constructor(container: HTMLElement, site: SiteInfo, calibrated = false) {
    this.site = site;
    this.container = container;
    this.calibrated = calibrated;
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
      ...this.view(),
      interactive: false,
      attributionControl: false,
      fadeDuration: 0,
    });
    new ResizeObserver(() => {
      this.fit();
      this.reclipElements();
    }).observe(container);
    this.map.on('move', this.reclipElements);
    this.ready = new Promise((resolve) => {
      void this.map.once('load', () => resolve());
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
        overlay.setClip(this.clips.get(instance) ?? null);
        drawn.overlays.add(overlay);
        drawn.fields.add(overlay);
        track(() => {
          drawn.fields.delete(overlay);
          drawn.overlays.delete(overlay);
          overlay.remove();
          forget(id);
        });
        return overlay;
      },
      addDrawing: (name: string, options = {}): DrawingOverlay => {
        const id = `drawing:${instance}:${name}`;
        const { width_m, height_m } = this.site.extent;
        const element = document.createElement('canvas');
        element.width = Math.round(options.resolution ?? CANVAS_WIDTH);
        element.height = Math.max(1, Math.round((element.width * height_m) / width_m));
        const scale = element.width / width_m;
        const ctx = element.getContext('2d')!;
        ctx.setTransform(scale, 0, 0, scale, 0, 0);
        // An item of a revealing layer draws on its own canvas; what the map shows is that canvas
        // clipped to the shape, made again on every commit and every change of the shape.
        let shown = element;
        if (this.clippable.has(instance)) {
          shown = document.createElement('canvas');
          shown.width = element.width;
          shown.height = element.height;
          const out = shown.getContext('2d')!;
          const compose = () => {
            const clip = this.clips.get(instance);
            out.setTransform(1, 0, 0, 1, 0, 0);
            out.clearRect(0, 0, shown.width, shown.height);
            if (clip?.kind === 'none') return;
            out.save();
            if (clip) {
              out.setTransform(scale, 0, 0, scale, 0, 0);
              revealPath(out, clip, width_m, height_m);
              out.clip();
              out.setTransform(1, 0, 0, 1, 0, 0);
            }
            out.drawImage(element, 0, 0);
            out.restore();
          };
          compose();
          const reclip = () => {
            compose();
            const source = map.getSource(id) as maplibregl.CanvasSource | undefined;
            source?.play();
            source?.pause();
            map.triggerRepaint();
          };
          drawn.reclip.add(reclip);
          track(() => drawn.reclip.delete(reclip));
          drawn.compose.set(id, compose);
          track(() => drawn.compose.delete(id));
        }
        drawn.pictures.set(shown, scale);
        track(() => drawn.pictures.delete(shown));
        // The canvas is uploaded only on commit, so a static layer costs nothing per frame.
        map.addSource(id, { type: 'canvas', canvas: shown, coordinates: this.site.corners, animate: false });
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
            drawn.compose.get(id)?.();
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
        drawn.clipped.add(element);
        this.clipElement(instance, element);
        track(() => {
          drawn.elements.delete(element);
          drawn.clipped.delete(element);
          element.remove();
        });
        return element;
      },
      addCanvas: (id: string, style?: { opacity?: number; top?: boolean }): CanvasOverlay => {
        const overlay = new MapCanvasOverlay(this.map, this.container, `canvas:${instance}:${id}`, this.site, style);
        overlay.setGain(drawn.intensity);
        drawn.overlays.add(overlay);
        drawn.clipped.add(overlay.element);
        drawn.surfaces.add(overlay.element);
        this.clipElement(instance, overlay.element);
        track(() => {
          drawn.overlays.delete(overlay);
          drawn.surfaces.delete(overlay.element);
          drawn.clipped.delete(overlay.element);
          overlay.remove();
        });
        return overlay;
      },
      addFlow: (id: string, style: FlowOverlayStyle & { colormap: Colormap }): FlowOverlay => {
        const overlay = new MapFlowOverlay(this.map, `flow:${instance}:${id}`, this.site, style);
        add(`flow:${instance}:${id}`, overlay);
        overlay.setGain(drawn.intensity);
        drawn.overlays.add(overlay);
        drawn.flows.add(overlay);
        track(() => {
          drawn.overlays.delete(overlay);
          drawn.flows.delete(overlay);
          overlay.remove();
          forget(`flow:${instance}:${id}`);
        });
        return overlay;
      },
      addSprites: (id: string, images: SpriteImage[], style?: SpriteStyle): SpriteOverlay => {
        const name = `sprites:${instance}:${id}`;
        const overlay = new MapSpriteOverlay(this.map, name, this.site, images, style);
        add(name, overlay);
        overlay.setGain(drawn.intensity);
        overlay.setClip(this.clips.get(instance) ?? null);
        drawn.cut.add(overlay);
        drawn.overlays.add(overlay);
        drawn.marks.add(overlay);
        track(() => {
          drawn.overlays.delete(overlay);
          drawn.marks.delete(overlay);
          drawn.cut.delete(overlay);
          overlay.remove();
          forget(name);
        });
        return overlay;
      },
      addStrokes: (id: string, style?: { opacity?: number }): StrokeOverlay => {
        const name = `strokes:${instance}:${id}`;
        const overlay = new MapStrokeOverlay(this.map, name, this.site, style);
        add(name, overlay);
        overlay.setGain(drawn.intensity);
        overlay.setClip(this.clips.get(instance) ?? null);
        drawn.cut.add(overlay);
        drawn.overlays.add(overlay);
        drawn.marks.add(overlay);
        track(() => {
          drawn.overlays.delete(overlay);
          drawn.marks.delete(overlay);
          drawn.cut.delete(overlay);
          overlay.remove();
          forget(name);
        });
        return overlay;
      },
      addPicture: (): TablePicture => {
        const picture = this.picture(instance);
        track(() => picture.remove());
        return picture;
      },
      addDetail: (render: DetailRenderer): void => {
        this.details.set(instance, render);
        track(() => {
          if (this.details.get(instance) === render) this.details.delete(instance);
        });
      },
      detail: (centre: [number, number], radius_m: number, size: number) => this.detail(instance, centre, radius_m, size),
      setGlow: (glow: 'off' | string | null): void => {
        this.glowWishes.delete(instance);
        if (glow) this.glowWishes.set(instance, glow);
      },
      addShapes: (name: string, style?: { opacity?: number }): ShapeOverlay => {
        const overlay = this.shapes(`shapes:${instance}:${name}`, style?.opacity ?? 1, add, forget, drawn.intensity);
        drawn.overlays.add(overlay);
        track(() => {
          drawn.overlays.delete(overlay);
          overlay.remove();
        });
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
    intensity: number,
  ): ShapeOverlay & { setGain(gain: number): void } {
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
    let base = opacity;
    let gain = Math.min(1, Math.max(0, intensity));
    const setOpacity = (raw: number) => {
      base = raw;
      const value = raw * gain;
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
      setGain: (value: number) => {
        gain = Math.min(1, Math.max(0, value));
        if (!removed) setOpacity(base);
      },
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
  /** A canvas above every layer, for what the runtime itself draws (the attention cue). */
  topCanvas(id: string): CanvasOverlay {
    return new MapCanvasOverlay(this.map, this.container, id, this.site);
  }

  pointer(track: (cleanup: () => void) => void, instance?: string): TablePointer {
    const pointer = tablePointer(this.container, this.site, track);
    if (!instance) return pointer;
    return {
      on: (callback) => {
        this.listening.set(instance, (this.listening.get(instance) ?? 0) + 1);
        track(() => {
          const left = (this.listening.get(instance) ?? 1) - 1;
          if (left > 0) this.listening.set(instance, left);
          else this.listening.delete(instance);
        });
        pointer.on(callback);
      },
    };
  }

  /** Whether a layer reads mouse clicks on the map itself (CoolPaths' ends, Sunlight's spot), so a click there is its input. */
  listens(instance: string): boolean {
    return this.listening.has(instance);
  }

  /**
   * The layers that drew something under a point of the page (#425), topmost first: a mark on a
   * canvas or drawing, a shape, a map feature, or a field. Within `slop` CSS pixels, so a thin
   * line is easy to hit. Decorations (`addElement`) and the 3D model are not counted.
   */
  hits(clientX: number, clientY: number, slop = 4): string[] {
    const rect = this.container.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return [];
    const frame = tableFrame(this.site);
    const fit = fitTable(frame, rect.width, rect.height);
    const metres: [number, number] = [(x - fit.x) / fit.scale, (y - fit.y) / fit.scale];
    const out: string[] = [];
    const box: [maplibregl.PointLike, maplibregl.PointLike] = [
      [x - slop, y - slop],
      [x + slop, y + slop],
    ];
    for (const instance of [...this.order].reverse()) {
      const drawn = this.drawn.get(instance);
      if (!drawn || drawn.intensity <= 0 || this.clips.get(instance)?.kind === 'none') continue;
      let hit = false;
      for (const canvas of drawn.surfaces) {
        if (hit) break;
        const ratio = canvas.width / Math.max(1, canvas.clientWidth || rect.width);
        hit = inked(canvas, x * ratio, y * ratio, slop * ratio);
      }
      for (const [canvas, scale] of drawn.pictures) {
        if (hit) break;
        hit = inked(canvas, metres[0] * scale, metres[1] * scale, (slop / fit.scale) * scale);
      }
      for (const mark of drawn.marks) {
        if (hit) break;
        hit = mark.hit(metres[0], metres[1], slop / fit.scale);
      }
      if (!hit) {
        const vector = (this.owned.get(instance) ?? []).filter((id) => VECTOR.has(this.map.getLayer(id)?.type ?? ''));
        hit = vector.length > 0 && this.map.queryRenderedFeatures(box, { layers: vector }).length > 0;
      }
      // A field or a flow covers the table, so it counts for the layer only where nothing above it was hit.
      if (!hit && drawn.fields.size + drawn.flows.size > 0 && metres[0] >= 0 && metres[1] >= 0 && metres[0] <= this.site.extent.width_m && metres[1] <= this.site.extent.height_m) hit = true;
      if (hit) out.push(instance);
    }
    return out;
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
    if (!drawn) this.drawn.set(instance, (drawn = { overlays: new Set(), pictures: new Map(), surfaces: new Set(), elements: new Set(), canvases: new Map(), intensity: 1, clipped: new Set(), fields: new Set(), flows: new Set(), marks: new Set(), cut: new Set(), reclip: new Set(), compose: new Map() }));
    return drawn;
  }

  /**
   * Makes a layer clippable by a revealing layer's shape (#287): call before it starts, so its
   * drawings get a canvas of their own to clip. Until a shape arrives it shows nowhere.
   */
  setClippable(instance: string, clippable: boolean): void {
    if (clippable) {
      this.clippable.add(instance);
      if (!this.clips.has(instance)) this.clips.set(instance, { kind: 'none' });
    } else {
      this.clippable.delete(instance);
      this.setClip(instance, null);
    }
  }

  /** Shows what a layer draws only inside `shape` (table metres); null shows all of it. */
  setClip(instance: string, shape: RevealShape | null): void {
    const before = this.clips.get(instance) ?? null;
    if (sameReveal(before, shape)) return;
    if (shape) this.clips.set(instance, shape);
    else this.clips.delete(instance);
    const drawn = this.drawn.get(instance);
    if (!drawn) return;
    for (const reclip of drawn.reclip) reclip();
    for (const field of drawn.fields) field.setClip(shape);
    for (const overlay of drawn.cut) overlay.setClip(shape);
    for (const element of drawn.clipped) this.clipElement(instance, element);
  }

  /** Clips a page element over the table (a canvas, a decoration) to its layer's shape, as a CSS polygon in the view's pixels. */
  private clipElement(instance: string, element: HTMLElement): void {
    const shape = this.clips.get(instance);
    if (!shape) {
      element.style.clipPath = '';
      return;
    }
    if (shape.kind === 'none') {
      element.style.clipPath = 'polygon(0 0, 0 0, 0 0)';
      return;
    }
    const frame = this.frame ?? (this.frame = tableFrame(this.site));
    const points = revealPolygon(shape, frame.width, frame.height).map((p) => {
      const at = this.map.project(frame.toLonLat(p));
      return `${at.x.toFixed(1)}px ${at.y.toFixed(1)}px`;
    });
    element.style.clipPath = `polygon(${points.join(', ')})`;
  }

  private frame: ReturnType<typeof tableFrame> | null = null;

  /** The view moved or resized: page elements of clipped layers are clipped again. */
  private reclipElements = (): void => {
    for (const [instance, drawn] of this.drawn) if (this.clips.has(instance)) for (const element of drawn.clipped) this.clipElement(instance, element);
  };

  /**
   * A copy of what the table shows inside a rectangle, for a magnifier (#287): the map with every
   * canvas over it, except those of the layer asking. Copied as the map draws, since a WebGL
   * picture is only readable during its frame.
   */
  private picture(instance: string): TablePicture {
    const { map, container } = this;
    const canvas = document.createElement('canvas');
    const g = canvas.getContext('2d')!;
    let wanted: PixelRect | null = null;
    let removed = false;
    const picture = {
      canvas,
      taken: null as PixelRect | null,
      revision: 0,
      want(rect: PixelRect) {
        if (removed) return;
        wanted = { ...rect };
        map.triggerRepaint();
      },
      remove() {
        if (removed) return;
        removed = true;
        map.off('render', grab);
        canvas.width = canvas.height = 1;
      },
    };
    const grab = () => {
      if (!wanted || removed) return;
      const rect = wanted;
      wanted = null;
      const source = map.getCanvas();
      const box = container.getBoundingClientRect();
      if (box.width < 1 || rect.width < 1 || rect.height < 1) return;
      const ratio = source.width / Math.max(1, source.clientWidth || box.width);
      const width = Math.max(1, Math.round(rect.width * ratio));
      const height = Math.max(1, Math.round(rect.height * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      } else g.clearRect(0, 0, width, height);
      g.fillStyle = this.site.basemap.background;
      g.fillRect(0, 0, width, height);
      const k = width / rect.width;
      try {
        for (const layer of container.querySelectorAll('canvas')) {
          if (layer.dataset.overlay?.startsWith(`canvas:${instance}:`) || layer.closest(`[data-layer="${instance}"]`)) continue;
          const r = layer.getBoundingClientRect();
          if (r.width < 1 || r.height < 1 || layer.width < 1) continue;
          const style = getComputedStyle(layer);
          if (style.visibility === 'hidden' || style.display === 'none') continue;
          g.globalAlpha = Number(style.opacity) || 1;
          const sx = layer.width / r.width;
          const sy = layer.height / r.height;
          // Only the part under the rectangle: source pixels of this canvas, then where they land.
          const left = rect.x - (r.left - box.left);
          const top = rect.y - (r.top - box.top);
          g.drawImage(layer, left * sx, top * sy, rect.width * sx, rect.height * sy, 0, 0, rect.width * k, rect.height * k);
        }
      } catch (error) {
        console.warn('[picture] the table could not be copied', error);
      }
      g.globalAlpha = 1;
      picture.taken = rect;
      picture.revision++;
    };
    map.on('render', grab);
    return picture;
  }

  /** The sharp pictures layers draw for a magnifier, other than `asking`'s own, in the scene's order (#351). */
  private detail(asking: string, centre: [number, number], radius_m: number, size: number): HTMLCanvasElement | null {
    const renderers = this.order.filter((id) => id !== asking && this.details.has(id) && !this.clips.has(id));
    if (renderers.length === 0 || radius_m <= 0 || size < 1) return null;
    const canvas = this.detailCanvas ??= document.createElement('canvas');
    if (canvas.width !== size || canvas.height !== size) canvas.width = canvas.height = size;
    const g = canvas.getContext('2d')!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, size, size);
    const scale = size / (2 * radius_m);
    for (const id of renderers) {
      g.save();
      g.setTransform(scale, 0, 0, scale, -(centre[0] - radius_m) * scale, -(centre[1] - radius_m) * scale);
      try {
        this.details.get(id)!(g, scale);
      } catch (error) {
        console.warn(`[${id}] detail`, error);
      }
      g.restore();
    }
    return canvas;
  }

  /** Stacks the scene's layers in this order, bottom first. */
  setOrder(scene: string[]): void {
    this.order = [...scene];
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

  private quality: DisplayQuality = 'good';

  /** How finely the table is drawn (#134): the map's and the model's pixel density, and the sun shadows' detail. */
  setQuality(quality: DisplayQuality): void {
    this.quality = quality;
    this.map.setPixelRatio(pixelRatio(quality));
    this.model?.setQuality(quality);
  }

  /** Loads the site's twin and lays the model surface over the map. Resolves to null when that is not possible. */
  async attachModel(): Promise<ModelView | null> {
    try {
      this.model = await ModelView.create(this.container, this.site, this.map);
      this.model.setQuality(this.quality);
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
      sunShadowMask: async () => null,
      setMaterial: () => {},
      focus: () => {},
      pick: () => null,
    };
  }

  /**
   * Where the site's extent (the physical model) is on this surface, as its four corners in CSS
   * pixels from the top left: through the projector when the model is calibrated, otherwise where
   * the flat map draws it. The table's ribbons go in the space around it (#78).
   */
  footprint(): [number, number][] {
    // During the opening zoom the ribbons stay where the model lands, not where it is on the way.
    if (this.intro) return this.intro.footprint;
    return this.model?.footprint() ?? this.site.corners.map((corner) => {
      const point = this.map.project(corner);
      return [point.x, point.y];
    });
  }

  /** Runs when the footprint may have moved: the window resized, the view or the calibration changed. */
  onViewChange(listener: () => void): () => void {
    const observer = new ResizeObserver(() => listener());
    observer.observe(this.container);
    this.map.on('moveend', listener);
    this.viewListeners.add(listener);
    const off = this.model?.onCalibrationChange(listener);
    return () => {
      observer.disconnect();
      this.viewListeners.delete(listener);
      this.map.off('moveend', listener);
      off?.();
    };
  }

  /**
   * A picture of the table as it is now, for the table's card on Home (#131): the map and
   * whatever is drawn over it, `width` pixels wide, as a JPEG. The map draws with WebGL,
   * whose picture is only readable during a frame, so it is taken as the map renders.
   * Null when there is nothing to take (the map never rendered).
   */
  /** What the open layers ask of the ambient glow, the most recent first (#476). */
  glowWish(): 'off' | string | null {
    let last: 'off' | string | null = null;
    for (const [instance, wish] of this.glowWishes) if (this.drawn.has(instance)) last = wish;
    return last;
  }

  /**
   * The table copied `width` pixels wide, for the ambient glow (#476): the map and every canvas
   * over it, taken as the map renders. Null when the map doesn't render within a second.
   */
  sample(width: number): Promise<ImageData | null> {
    const { map, container } = this;
    const out = (this.sampleCanvas ??= document.createElement('canvas'));
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 1000);
      void map.once('render', () => {
        clearTimeout(timer);
        try {
          const box = container.getBoundingClientRect();
          if (box.width < 1 || box.height < 1) return resolve(null);
          const scale = width / box.width;
          const height = Math.max(1, Math.round(box.height * scale));
          if (out.width !== width || out.height !== height) [out.width, out.height] = [width, height];
          const g = out.getContext('2d', { willReadFrequently: true })!;
          g.fillStyle = this.site.basemap.background;
          g.fillRect(0, 0, width, height);
          for (const canvas of container.querySelectorAll('canvas')) {
            if (canvas.classList.contains('table-glow') || canvas.closest('.table-ribbon')) continue;
            const r = canvas.getBoundingClientRect();
            if (r.width < 1 || r.height < 1 || canvas.width < 1) continue;
            const style = getComputedStyle(canvas);
            if (style.visibility === 'hidden' || style.display === 'none') continue;
            g.globalAlpha = Number(style.opacity) || 1;
            g.drawImage(canvas, (r.left - box.left) * scale, (r.top - box.top) * scale, r.width * scale, r.height * scale);
          }
          g.globalAlpha = 1;
          resolve(g.getImageData(0, 0, width, height));
        } catch (error) {
          console.warn('[glow] no copy of the table', error);
          resolve(null);
        }
      });
      map.triggerRepaint();
    });
  }
  private sampleCanvas: HTMLCanvasElement | null = null;

  snapshot(width = 640): Promise<Blob | null> {
    const { map, container } = this;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 1500);
      void map.once('render', () => {
        clearTimeout(timer);
        try {
          const box = container.getBoundingClientRect();
          if (box.width < 1 || box.height < 1) return resolve(null);
          const scale = width / box.width;
          const out = document.createElement('canvas');
          out.width = width;
          out.height = Math.round(box.height * scale);
          const g = out.getContext('2d')!;
          g.fillStyle = this.site.basemap.background;
          g.fillRect(0, 0, out.width, out.height);
          // Every canvas in the table, in the order they stack: the map, the model, overlays.
          for (const canvas of container.querySelectorAll('canvas')) {
            const r = canvas.getBoundingClientRect();
            if (r.width < 1 || r.height < 1 || canvas.width < 1) continue;
            g.globalAlpha = Number(getComputedStyle(canvas).opacity) || 1;
            g.drawImage(canvas, (r.left - box.left) * scale, (r.top - box.top) * scale, r.width * scale, r.height * scale);
          }
          g.globalAlpha = 1;
          out.toBlob((blob) => resolve(blob), 'image/jpeg', 0.85);
        } catch (error) {
          console.warn('No picture of the table:', error);
          resolve(null);
        }
      });
      map.triggerRepaint();
    });
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

  /** The camera: the calibrated table view, or the extent fitted to the container. */
  private view(): { center: [number, number]; bearing: number; zoom: number } {
    const calibration = this.calibrated ? this.site.calibration : null;
    if (!calibration) {
      return { center: [this.site.origin.lon, this.site.origin.lat], bearing: this.site.extent.rotation_deg, zoom: this.fitZoom() };
    }
    // The zoom was found at one window size. Scale it, so the same ground stays in view at another.
    const scale = calibration.window ? Math.max(1, this.container.clientWidth) / calibration.window.width_px : 1;
    return { center: [calibration.center.lon, calibration.center.lat], bearing: calibration.bearing, zoom: calibration.zoom + Math.log2(scale) };
  }

  private fit(): void {
    this.map.resize();
    // A resize during the opening zoom waits for it to land, so the zoom is not cut short.
    if (this.intro) this.intro.resized = true;
    else this.map.jumpTo(this.view());
  }

  /**
   * The opening zoom (#446): the table starts zoomed out over the city around it, holds a
   * moment, then slowly and smoothly zooms in to its own view, as the Lindholmen table did. It
   * plays when the table starts and when the controller's Reset puts the table back.
   *
   * On a flat or lit table the map itself zooms out (four times the ground, so the streets around
   * the model show) and eases back in. Through a projector calibration the map is draped on the
   * model and a map zoom would not show, so the model's picture grows into place instead.
   */
  playIntro(): void {
    this.endIntro();
    const footprint = this.footprint();
    const target = this.view();
    const projected = this.model?.calibrated ? this.model.canvas : null;
    const intro = { footprint, timer: 0, resized: false };
    this.intro = intro;
    // Decorations (the sun's path, for one) are page elements laid over the table at its own
    // view, so during the zoom they are scaled with it.
    const decorations = () => [...this.container.querySelectorAll<HTMLElement>(':scope > .table-decoration')];
    const follow = () => {
      const scale = 2 ** (this.map.getZoom() - target.zoom);
      for (const element of decorations()) element.style.transform = scale === 1 ? '' : `scale(${scale})`;
    };
    const land = () => {
      if (this.intro !== intro) return;
      this.intro = null;
      this.map.off('move', follow);
      for (const element of decorations()) element.style.transform = '';
      if (intro.resized) this.map.jumpTo(this.view());
      // The ribbons find their place again now the zoom has landed.
      for (const listener of this.viewListeners) listener();
    };
    if (projected) {
      const xs = footprint.map(([x]) => x);
      const ys = footprint.map(([, y]) => y);
      const origin = `${(Math.min(...xs) + Math.max(...xs)) / 2}px ${(Math.min(...ys) + Math.max(...ys)) / 2}px`;
      const animations = [projected, ...decorations()].map((element) => {
        element.style.transformOrigin = origin;
        return element.animate([{ transform: `scale(${2 ** -INTRO_ZOOM_OUT})` }, { transform: 'scale(1)' }], {
          duration: INTRO_MS,
          delay: INTRO_HOLD_MS,
          easing: 'cubic-bezier(0.65, 0, 0.35, 1)',
          fill: 'backwards',
        });
      });
      animations[0]!.onfinish = land;
      animations[0]!.oncancel = land;
      this.cancelIntro = () => animations.forEach((animation) => animation.cancel());
      return;
    }
    this.map.on('move', follow);
    this.map.jumpTo({ ...target, zoom: target.zoom - INTRO_ZOOM_OUT });
    intro.timer = window.setTimeout(() => {
      if (this.intro !== intro) return;
      follow();
      this.map.easeTo({ ...target, duration: INTRO_MS, easing: easeInOutCubic, essential: true });
      void this.map.once('moveend', land);
    }, INTRO_HOLD_MS);
    this.cancelIntro = () => {
      clearTimeout(intro.timer);
      this.map.stop();
      land();
    };
  }

  private cancelIntro: (() => void) | null = null;
  private viewListeners = new Set<() => void>();

  /** Lands an opening zoom that is still playing, at once. */
  private endIntro(): void {
    const cancel = this.cancelIntro;
    this.cancelIntro = null;
    cancel?.();
    if (this.intro) {
      this.intro = null;
      this.map.jumpTo(this.view());
    }
  }
}

/** How far out the opening zoom starts, in map zoom steps: 2 shows four times the ground across. */
const INTRO_ZOOM_OUT = 2;
/** How long the table holds zoomed out before it zooms in, and how long the zoom takes. */
const INTRO_HOLD_MS = 900;
const INTRO_MS = 6500;
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

interface Drawn {
  overlays: Set<{ setGain(gain: number): void }>;
  /** Pixels a click on the map can land on (#425): drawings in table metres, canvases in CSS pixels. */
  pictures: Map<HTMLCanvasElement, number>;
  surfaces: Set<HTMLCanvasElement>;
  elements: Set<HTMLElement>;
  canvases: Map<string, number>;
  intensity: number;
  /** Page elements a reveal clips: decorations and canvases. */
  clipped: Set<HTMLElement>;
  fields: Set<MapFieldOverlay>;
  flows: Set<MapFlowOverlay>;
  /** Sprites and lines the graphics card draws, in table metres, that a click can land on (#425, #609). */
  marks: Set<{ hit(x: number, y: number, radius: number): boolean }>;
  /** Sprites and strokes, cut in their shaders to a revealing layer's shape (#619). */
  cut: Set<{ setClip(shape: RevealShape | null): void }>;
  /** Makes each clipped drawing again after the shape changed. */
  reclip: Set<() => void>;
  /** By drawing: makes its clipped copy, before a commit. */
  compose: Map<string, () => void>;
}

/** Map layers whose features a click can find. */
const VECTOR = new Set(['fill', 'line', 'circle', 'symbol', 'fill-extrusion', 'heatmap']);

/** Whether a canvas has a visible pixel within `radius` of `(x, y)`, in its own pixels. */
function inked(canvas: HTMLCanvasElement, x: number, y: number, radius: number): boolean {
  const r = Math.max(1, Math.ceil(radius));
  const left = Math.max(0, Math.floor(x) - r);
  const top = Math.max(0, Math.floor(y) - r);
  const width = Math.min(canvas.width, Math.floor(x) + r + 1) - left;
  const height = Math.min(canvas.height, Math.floor(y) + r + 1) - top;
  if (width <= 0 || height <= 0) return false;
  try {
    const data = canvas.getContext('2d')!.getImageData(left, top, width, height).data;
    for (let i = 3; i < data.length; i += 4) if (data[i]! > 24) return true;
  } catch {
    // A canvas holding a picture from elsewhere cannot be read; it does not count.
  }
  return false;
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
