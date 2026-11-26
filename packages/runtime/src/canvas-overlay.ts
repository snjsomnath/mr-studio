import type { CanvasOverlay, SiteInfo } from '@mrstudio/sdk';
import type { Map as MapLibreMap } from 'maplibre-gl';

/**
 * A 2D canvas over the table view. It follows the map, so whatever fits or
 * calibrates the map also places the drawing. Layers draw in CSS pixels.
 */
export class MapCanvasOverlay implements CanvasOverlay {
  readonly context: CanvasRenderingContext2D;
  width = 0;
  height = 0;
  pixelsPerMetre = 1;
  revision = 0;

  private canvas: HTMLCanvasElement;
  private map: MapLibreMap;
  private container: HTMLElement;
  private site: SiteInfo;
  private observer: ResizeObserver;
  private onMove = () => this.measure(false);
  private opacity = 1;
  private gain = 1;

  constructor(map: MapLibreMap, container: HTMLElement, id: string, site: SiteInfo, style?: { opacity?: number; top?: boolean }) {
    this.map = map;
    this.container = container;
    this.site = site;
    this.canvas = document.createElement('canvas');
    this.canvas.dataset.overlay = id;
    this.canvas.setAttribute('aria-hidden', 'true');
    // A `top` canvas sits over every other layer canvas, whatever order they were made in.
    this.canvas.style.cssText = `position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:${style?.top ? 3 : 2}`;
    if (style?.opacity !== undefined) this.setOpacity(style.opacity);
    this.context = this.canvas.getContext('2d')!;
    container.append(this.canvas);
    this.observer = new ResizeObserver(() => this.measure(true));
    this.observer.observe(container);
    map.on('move', this.onMove);
    this.measure(true);
  }

  /** The canvas itself, for the runtime to clip (#287). Not part of the layer API. */
  get element(): HTMLCanvasElement {
    return this.canvas;
  }

  project(lonLat: readonly number[]): [number, number] {
    const point = this.map.project([lonLat[0]!, lonLat[1]!]);
    return [point.x, point.y];
  }

  clear(): void {
    this.context.clearRect(0, 0, this.width, this.height);
  }

  setOpacity(opacity: number): void {
    this.opacity = opacity;
    this.canvas.style.opacity = String(opacity * this.gain);
  }

  /** The layer's intensity, set by the runtime from host state: below 1 fades. Not part of the layer API. */
  setGain(gain: number): void {
    this.gain = Math.min(1, Math.max(0, gain));
    this.setOpacity(this.opacity);
  }

  remove(): void {
    this.observer.disconnect();
    this.map.off('move', this.onMove);
    this.canvas.remove();
  }

  /** Matches the backing store to the container and works out the scale. */
  private measure(resized: boolean): void {
    if (resized) {
      const ratio = window.devicePixelRatio || 1;
      this.width = Math.max(1, this.container.clientWidth);
      this.height = Math.max(1, this.container.clientHeight);
      this.canvas.width = Math.round(this.width * ratio);
      this.canvas.height = Math.round(this.height * ratio);
      this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
    } else {
      this.clear();
    }
    const [left, right] = [this.project(this.site.corners[0]), this.project(this.site.corners[1])];
    this.pixelsPerMetre = Math.hypot(right[0] - left[0], right[1] - left[1]) / this.site.extent.width_m || 1;
    this.revision++;
  }
}
