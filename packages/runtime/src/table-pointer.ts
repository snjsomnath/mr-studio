import { fitTable, tableFrame } from '@mrstudio/sdk';
import type { InputSource, PointerSample, SiteInfo, TablePointer } from '@mrstudio/sdk';

const PHASES: Record<string, PointerSample['phase']> = {
  pointermove: 'move',
  pointerdown: 'down',
  pointerup: 'up',
  pointerleave: 'leave',
  pointercancel: 'leave',
};

/**
 * Pointer input on the table surface for one layer: DOM pointer events become
 * samples in table metres. Every mouse, finger and pen is its own pointer, so
 * several people can act at once. Listeners are removed through `track`.
 */
export function tablePointer(surface: HTMLElement, site: SiteInfo, track: (cleanup: () => void) => void): TablePointer {
  const frame = tableFrame(site);
  return {
    on(callback) {
      const listener = (event: Event) => {
        const e = event as PointerEvent;
        const rect = surface.getBoundingClientRect();
        const fit = fitTable(frame, rect.width, rect.height);
        const point: [number, number] = [(e.clientX - rect.left - fit.x) / fit.scale, (e.clientY - rect.top - fit.y) / fit.scale];
        const source: InputSource = e.pointerType === 'touch' || e.pointerType === 'pen' ? e.pointerType : 'mouse';
        const sample: PointerSample = {
          id: `${source}:${e.pointerId}`,
          source,
          phase: PHASES[e.type] ?? 'move',
          point,
          lonLat: frame.toLonLat(point),
          pressed: e.buttons !== 0 && e.type !== 'pointerup',
          time: e.timeStamp / 1000,
        };
        callback(sample);
        // A lifted finger is gone; a released mouse button is still a pointer.
        if (e.type === 'pointerup' && source !== 'mouse') callback({ ...sample, phase: 'leave', pressed: false });
      };
      const types = Object.keys(PHASES);
      for (const type of types) surface.addEventListener(type, listener);
      track(() => {
        for (const type of types) surface.removeEventListener(type, listener);
      });
    },
  };
}
