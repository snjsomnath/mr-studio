import { defineLayer, geojsonLines, geojsonPoints, geojsonPolygons, loadSiteData, siteDataUrl, tableSpace, traceLine, tracePolygon, withAlpha } from '@mrstudio/sdk';
import type { CanvasOverlay, LayerManifest, Placed, TableSpace, XY } from '@mrstudio/sdk';

import manifest from '../layer.json';

interface Params {
  slide: number;
  play: boolean;
  seconds: number;
  captions: boolean;
  opacity: number;
}

interface Slide {
  type: string;
  media?: string;
  duration?: number;
  fitMode?: 'stretch' | 'contain' | 'cover';
  rotation?: number;
  enabled?: boolean;
  metadata?: {
    title?: string;
    description?: string;
    source?: string;
    legend?: { items?: { color: string; label: string }[] };
    style?: { colorProperty?: string; colorMap?: Record<string, string>; fillOpacity?: number; strokeWidth?: number; strokeOpacity?: number };
  };
}

type Loaded =
  | { kind: 'picture'; element: HTMLImageElement | HTMLVideoElement; width: number; height: number }
  | { kind: 'shapes'; polygons: Placed<XY[][]>[]; lines: Placed<XY[]>[]; points: Placed<XY>[] };

const SUPPORTED = ['image', 'video', 'geojson'];
const DEFAULT_DURATION_MS = 8000;
const FADE_S = 0.7;
const DEFAULT_COLOUR = '#4dabf7';
const HEX = /^#[0-9a-f]{6}$/i;

function load(slide: Slide, url: string, space: TableSpace): Promise<Loaded> {
  if (slide.type === 'geojson') {
    return fetch(url)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((geojson) => ({ kind: 'shapes', polygons: geojsonPolygons(geojson, space), lines: geojsonLines(geojson, space), points: geojsonPoints(geojson, space) }));
  }
  return new Promise((resolve, reject) => {
    if (slide.type === 'video') {
      const video = document.createElement('video');
      Object.assign(video, { muted: true, loop: true, playsInline: true, preload: 'auto', src: url });
      video.onloadeddata = () => resolve({ kind: 'picture', element: video, width: video.videoWidth, height: video.videoHeight });
      video.onerror = () => reject(new Error('the video could not be loaded'));
    } else {
      const image = new Image();
      image.onload = () => resolve({ kind: 'picture', element: image, width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new Error('the image could not be loaded'));
      image.src = url;
    }
  });
}

function paint(canvas: CanvasOverlay, slide: Slide, loaded: Loaded, alpha: number): void {
  const g = canvas.ctx;
  g.save();
  g.globalAlpha = alpha;
  if (loaded.kind === 'picture') {
    const rotation = ((slide.rotation ?? 0) % 360 + 360) % 360;
    const sideways = rotation === 90 || rotation === 270;
    // The box the unrotated picture has to fit, so that it fills the table once turned.
    const [boxW, boxH] = sideways ? [canvas.height, canvas.width] : [canvas.width, canvas.height];
    let [w, h] = [boxW, boxH];
    if (slide.fitMode === 'contain' || slide.fitMode === 'cover') {
      const fit = slide.fitMode === 'contain' ? Math.min : Math.max;
      const scale = fit(boxW / loaded.width, boxH / loaded.height);
      [w, h] = [loaded.width * scale, loaded.height * scale];
    }
    g.beginPath();
    g.rect(0, 0, canvas.width, canvas.height);
    g.clip();
    g.translate(canvas.width / 2, canvas.height / 2);
    g.rotate((rotation * Math.PI) / 180);
    g.drawImage(loaded.element, -w / 2, -h / 2, w, h);
  } else {
    const style = slide.metadata?.style ?? {};
    const colour = (properties: Record<string, any>) => {
      const mapped = style.colorProperty ? style.colorMap?.[String(properties[style.colorProperty])] : undefined;
      return mapped && HEX.test(mapped) ? mapped : DEFAULT_COLOUR;
    };
    const stroke = style.strokeOpacity ?? 0.9;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    for (const polygon of loaded.polygons) {
      g.beginPath();
      tracePolygon(g, polygon.geometry);
      g.fillStyle = withAlpha(colour(polygon.properties), style.fillOpacity ?? 0.5);
      g.fill('evenodd');
      g.strokeStyle = withAlpha(colour(polygon.properties), stroke);
      g.lineWidth = style.strokeWidth ?? 1;
      g.stroke();
    }
    for (const line of loaded.lines) {
      g.beginPath();
      traceLine(g, line.geometry);
      g.strokeStyle = withAlpha(colour(line.properties), stroke);
      g.lineWidth = style.strokeWidth ?? 2;
      g.stroke();
    }
    for (const point of loaded.points) {
      g.beginPath();
      g.arc(point.geometry[0], point.geometry[1], 4, 0, Math.PI * 2);
      g.fillStyle = withAlpha(colour(point.properties), stroke);
      g.fill();
    }
  }
  g.restore();
}

export default defineLayer<Params>({
  manifest: manifest as LayerManifest,

  async table(ctx) {
    const canvas = ctx.map.addCanvas('slides', { opacity: ctx.params.opacity });
    const space = tableSpace(ctx.site);
    const configUrl = siteDataUrl(ctx.site, 'slideshow');
    const config = await loadSiteData<{ slides?: Slide[] }>(ctx.site, 'slideshow');
    const all = (config?.slides ?? []).filter((slide) => slide.enabled !== false);
    const slides = all.filter((slide) => SUPPORTED.includes(slide.type) && slide.media);
    const cache = new Map<number, Promise<Loaded>>();

    /** The slide the `slide` control points at. It wraps, so "next" on the last slide is the first. */
    const index = () => (slides.length === 0 ? -1 : (((Math.round(ctx.params.slide) - 1) % slides.length) + slides.length) % slides.length);
    const fetchSlide = (i: number) => {
      let pending = cache.get(i);
      if (!pending) {
        const url = new URL(slides[i]!.media!, new URL(configUrl!, location.href)).href;
        cache.set(i, (pending = load(slides[i]!, url, space)));
      }
      return pending;
    };

    let shown: { slide: Slide; loaded: Loaded } | null = null;
    let leaving: { slide: Slide; loaded: Loaded } | null = null;
    let fade = 1;
    let elapsed = 0;
    let dirty = true;
    let problem = '';
    let request = 0;

    function describe() {
      const slide = slides[index()];
      ctx.publish({
        index: index() + 1,
        count: slides.length,
        title: slide?.metadata?.title ?? '',
        description: slide?.metadata?.description ?? '',
        source: slide?.metadata?.source ?? '',
        legend: slide?.metadata?.legend?.items ?? [],
        note: problem || (slides.length === 0 ? 'This site has no slideshow yet' : all.length > slides.length ? `${all.length - slides.length} slides need map tiles and are skipped` : ''),
      });
    }

    async function show() {
      const i = index();
      const mine = ++request;
      elapsed = 0;
      problem = '';
      describe();
      if (i < 0) return;
      try {
        const loaded = await fetchSlide(i);
        if (mine !== request) return;
        if (leaving?.loaded.kind === 'picture' && leaving.loaded.element instanceof HTMLVideoElement) leaving.loaded.element.pause();
        leaving = shown;
        shown = { slide: slides[i]!, loaded };
        fade = leaving ? 0 : 1;
        if (loaded.kind === 'picture' && loaded.element instanceof HTMLVideoElement) {
          loaded.element.currentTime = 0;
          void loaded.element.play().catch(() => {});
        }
        dirty = true;
        // Have the next slide ready before it is needed.
        if (slides.length > 1) void fetchSlide((i + 1) % slides.length).catch(() => {});
      } catch (error) {
        if (mine !== request) return;
        cache.delete(i);
        problem = `Slide ${i + 1}: ${(error as Error).message}`;
        describe();
      }
    }

    const go = (step: number) => ctx.setParams({ slide: ((index() + step + slides.length) % slides.length) + 1 });

    ctx.onCleanup(() => {
      request++;
      for (const pending of cache.values()) {
        void pending.then((loaded) => loaded.kind === 'picture' && loaded.element instanceof HTMLVideoElement && loaded.element.pause()).catch(() => {});
      }
    });

    ctx.onFrame((dt) => {
      if (slides.length > 1 && ctx.params.play) {
        elapsed += dt;
        const seconds = ctx.params.seconds > 0 ? ctx.params.seconds : (slides[index()]?.duration ?? DEFAULT_DURATION_MS) / 1000;
        // Every table surface asks for the same next slide, so several of them do not skip ahead.
        if (elapsed >= seconds) {
          elapsed = 0;
          go(1);
        }
      }
      const fading = fade < 1;
      const moving = shown?.loaded.kind === 'picture' && shown.loaded.element instanceof HTMLVideoElement;
      if (!dirty && !fading && !moving) return;
      dirty = false;
      if (fading) fade = Math.min(1, fade + dt / FADE_S);
      canvas.clear();
      if (fade < 1 && leaving) paint(canvas, leaving.slide, leaving.loaded, 1 - fade);
      if (shown) paint(canvas, shown.slide, shown.loaded, fade);
      if (fade >= 1 && leaving) {
        if (leaving.loaded.kind === 'picture' && leaving.loaded.element instanceof HTMLVideoElement && leaving.loaded !== shown?.loaded) leaving.loaded.element.pause();
        leaving = null;
      }
      const title = shown?.slide.metadata?.title;
      if (ctx.params.captions && title) {
        const g = canvas.ctx;
        const size = canvas.height * 0.035;
        g.font = `600 ${size}px Inter, system-ui, sans-serif`;
        g.textBaseline = 'bottom';
        const width = g.measureText(title).width;
        g.fillStyle = 'rgb(0 0 0 / 0.6)';
        g.fillRect(size * 0.6, canvas.height - size * 2.2, width + size * 1.2, size * 1.6);
        g.fillStyle = '#ffffff';
        g.fillText(title, size * 1.2, canvas.height - size * 0.85);
      }
      canvas.commit();
    });

    await show();

    return {
      update(changed) {
        if (changed.includes('opacity')) canvas.setOpacity(ctx.params.opacity);
        if (changed.includes('slide')) void show();
        if (changed.includes('captions')) dirty = true;
      },
      action(action) {
        if (slides.length > 0) go(action === 'previous' ? -1 : 1);
      },
    };
  },

  panel(ctx, el) {
    el.innerHTML = `
      <style>
        .slideshow-panel { display: grid; gap: 8px; }
        .slideshow-panel h3 { margin: 0; font-size: 1.15rem; }
        .slideshow-panel p { margin: 0; opacity: 0.8; font-size: 0.9rem; }
        .slideshow-legend { display: grid; gap: 4px; font-size: 0.85rem; }
        .slideshow-legend span { display: flex; align-items: center; gap: 8px; }
        .slideshow-legend i { width: 12px; height: 12px; border-radius: 3px; flex: none; }
        .slideshow-foot { display: flex; justify-content: space-between; gap: 12px; font-size: 0.8rem; opacity: 0.65; }
      </style>
      <div class="slideshow-panel">
        <h3></h3><p class="slideshow-description"></p><div class="slideshow-legend"></div>
        <div class="slideshow-foot"><span class="slideshow-source"></span><span class="slideshow-count"></span></div>
      </div>`;
    const find = (selector: string) => el.querySelector<HTMLElement>(selector)!;
    function update() {
      const s = ctx.shared as { index?: number; count?: number; title?: string; description?: string; source?: string; note?: string; legend?: { color: string; label: string }[] };
      find('h3').textContent = s.title || (s.count ? `Slide ${s.index}` : 'Slideshow');
      find('.slideshow-description').textContent = [s.description, s.note].filter(Boolean).join(' · ');
      find('.slideshow-source').textContent = s.source ?? '';
      find('.slideshow-count').textContent = s.count ? `${s.index} / ${s.count}` : '';
      find('.slideshow-legend').replaceChildren(
        ...(s.legend ?? []).map((item) => {
          const row = document.createElement('span');
          const swatch = document.createElement('i');
          swatch.style.background = HEX.test(item.color) ? item.color : DEFAULT_COLOUR;
          row.append(swatch, item.label);
          return row;
        }),
      );
    }
    update();
    return { update };
  },
});
