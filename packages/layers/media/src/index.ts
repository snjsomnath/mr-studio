import { defineLayer, tableFrame } from '@mrstudio/sdk';
import type { DrawingOverlay, LayerManifest } from '@mrstudio/sdk';

import manifest from '../layer.json';
import { fitSize, isVideo, parseBounds, quarterTurn } from './fit.ts';
import type { Bounds, Fit } from './fit.ts';

interface Params {
  file: string;
  fit: Fit;
  rotation: string;
  loop: boolean;
  opacity: number;
  bounds: string;
}

type Picture = { element: HTMLImageElement | HTMLVideoElement; width: number; height: number };

/** A file of the site (`data/media/x.png`) as the address the host serves it at. */
function addressOf(file: string): string | null {
  const path = file.trim().replace(/^\/+/, '');
  if (!path || path.split('/').includes('..')) return null;
  return `/site/${path.split('/').map(encodeURIComponent).join('/')}`;
}

function load(url: string, video: boolean, loop: boolean): Promise<Picture> {
  return new Promise((resolve, reject) => {
    if (video) {
      const element = document.createElement('video');
      Object.assign(element, { muted: true, loop, playsInline: true, preload: 'auto', src: url });
      element.onloadeddata = () => resolve({ element, width: element.videoWidth, height: element.videoHeight });
      element.onerror = () => reject(new Error('the video could not be loaded'));
    } else {
      const element = new Image();
      element.onload = () => resolve({ element, width: element.naturalWidth, height: element.naturalHeight });
      element.onerror = () => reject(new Error('the picture could not be loaded'));
      element.src = url;
    }
  });
}

/** `[lon, lat]` to table metres. */
type ToTable = (lonLat: [number, number]) => [number, number];

function paint(canvas: DrawingOverlay, picture: Picture, fit: Fit, rotation: number, placed: { bounds: Bounds; toTable: ToTable } | null): void {
  const g = canvas.ctx;
  canvas.clear();
  if (picture.width < 1 || picture.height < 1) return;
  if (placed) {
    // Placed on the map by its edges (#52): its top left, top right and bottom left corners,
    // wherever they fall on a turned table, and cut off where it runs past the table.
    const { west, south, east, north } = placed.bounds;
    const [x0, y0] = placed.toTable([west, north]);
    const [x1, y1] = placed.toTable([east, north]);
    const [x2, y2] = placed.toTable([west, south]);
    g.save();
    g.transform((x1 - x0) / picture.width, (y1 - y0) / picture.width, (x2 - x0) / picture.height, (y2 - y0) / picture.height, x0, y0);
    g.drawImage(picture.element, 0, 0, picture.width, picture.height);
    g.restore();
    return;
  }
  const [w, h] = fitSize(picture.width, picture.height, canvas.width, canvas.height, fit, rotation);
  g.save();
  g.translate(canvas.width / 2, canvas.height / 2);
  g.rotate((rotation * Math.PI) / 180);
  g.drawImage(picture.element, -w / 2, -h / 2, w, h);
  g.restore();
}

/**
 * A picture or a video laid over the whole table (#197), or placed on the map by its edges (#52): a slideshow step next to maps and
 * layers, or a layer with its own button. A video plays while the layer is on show, from
 * the start each time, and stops when it goes.
 */
export default defineLayer<Params>({
  manifest: manifest as LayerManifest,

  async table(ctx) {
    const canvas = ctx.map.addDrawing('media', { opacity: ctx.params.opacity, resolution: 2560 });
    const frame = tableFrame(ctx.site);
    const placed = () => {
      const bounds = parseBounds(ctx.params.bounds);
      return bounds ? { bounds, toTable: (lonLat: [number, number]) => frame.toTable(lonLat) as [number, number] } : null;
    };
    let picture: Picture | null = null;
    let request = 0;
    let dirty = false;

    const stopVideo = () => {
      if (picture?.element instanceof HTMLVideoElement) {
        picture.element.pause();
        picture.element.removeAttribute('src');
        picture.element.load();
      }
    };

    async function open(): Promise<void> {
      const mine = ++request;
      const url = addressOf(ctx.params.file ?? '');
      stopVideo();
      picture = null;
      canvas.clear();
      canvas.commit();
      if (!url) {
        ctx.publish({ problem: ctx.params.file ? 'This file is not in the table' : 'No picture or video chosen yet' });
        return;
      }
      try {
        const loaded = await load(url, isVideo(url), ctx.params.loop !== false);
        if (mine !== request) {
          if (loaded.element instanceof HTMLVideoElement) loaded.element.pause();
          return;
        }
        picture = loaded;
        ctx.publish({ problem: '' });
        if (loaded.element instanceof HTMLVideoElement) {
          loaded.element.currentTime = 0;
          void loaded.element.play().catch(() => {});
        }
        dirty = true;
      } catch (error) {
        if (mine !== request) return;
        ctx.publish({ problem: `${ctx.params.file}: ${(error as Error).message}` });
      }
    }

    ctx.onCleanup(() => {
      request++;
      stopVideo();
    });

    ctx.onFrame(() => {
      const playing = picture?.element instanceof HTMLVideoElement && !picture.element.paused;
      if (!picture || (!dirty && !playing)) return;
      dirty = false;
      paint(canvas, picture, ctx.params.fit, quarterTurn(ctx.params.rotation), placed());
      canvas.commit();
    });

    await open();

    return {
      update(changed) {
        if (changed.includes('opacity')) canvas.setOpacity(ctx.params.opacity);
        if (changed.includes('file')) void open();
        if (changed.includes('loop') && picture?.element instanceof HTMLVideoElement) picture.element.loop = ctx.params.loop !== false;
        if (changed.includes('fit') || changed.includes('rotation') || changed.includes('bounds')) dirty = true;
      },
    };
  },
});
