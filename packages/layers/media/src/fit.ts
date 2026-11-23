/** How a picture is fitted to the table: stretched to its edges, whole with margins, or filling it cropped. */
export type Fit = 'stretch' | 'contain' | 'cover';

/** The file types a media layer shows as video, by extension. Everything else is a picture. */
export function isVideo(file: string): boolean {
  return /\.(mp4|webm|mov|m4v)$/i.test(file.split(/[?#]/)[0] ?? '');
}

/** A quarter turn the picture is shown at: 0, 90, 180 or 270 degrees clockwise. */
export function quarterTurn(value: unknown): 0 | 90 | 180 | 270 {
  const n = ((Math.round(Number(value) / 90) * 90) % 360 + 360) % 360;
  return (Number.isFinite(n) ? n : 0) as 0 | 90 | 180 | 270;
}

/**
 * The size, in table units, to draw a `width` × `height` picture at, centred on a `boxW` × `boxH`
 * table and turned by `rotation`. Turned a quarter, the picture's width runs along the table's height.
 */
export function fitSize(width: number, height: number, boxW: number, boxH: number, fit: Fit, rotation: number): [number, number] {
  const sideways = rotation === 90 || rotation === 270;
  const [w, h] = sideways ? [boxH, boxW] : [boxW, boxH];
  if (fit !== 'contain' && fit !== 'cover') return [w, h];
  const scale = (fit === 'contain' ? Math.min : Math.max)(w / width, h / height);
  return [width * scale, height * scale];
}
