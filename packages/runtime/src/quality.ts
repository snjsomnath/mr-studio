import type { DisplayQuality } from '@mrstudio/sdk';

/** Canvas pixels per CSS pixel for the table's map and model at each quality (#134). */
export function pixelRatio(quality: DisplayQuality): number {
  const screen = window.devicePixelRatio || 1;
  if (quality === 'draft') return 1;
  if (quality === 'best') return Math.min(3, screen);
  return Math.min(2, screen);
}

/** Metres per pixel of the sun's shadow mask, and the largest texture it may use. */
export function shadowDetail(quality: DisplayQuality): { metres: number; maxSize: number } {
  if (quality === 'draft') return { metres: 0.6, maxSize: 2048 };
  if (quality === 'best') return { metres: 0.15, maxSize: 8192 };
  return { metres: 0.3, maxSize: 4096 };
}
