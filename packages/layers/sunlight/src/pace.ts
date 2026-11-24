// How the sun study plays through a day (#302): how fast time passes and how soft the shadows are, by sun height.

/** Softening of the shadow-map mask with a high sun, in its pixels of about 0.3 m. */
const SHARP_SOFTEN = 1.2;

/**
 * How fast the day plays at a sun height, as a share of the full speed (#302). Near the horizon shadows grow
 * hundreds of metres a minute and sweep the table, so the play lingers there: down to a third of the speed at
 * sunrise and sunset, back to full by 15° up and 6° under the horizon. It also gives the golden hour its time.
 */
export function playPace(altitude: number): number {
  const slowest = 0.35;
  if (altitude >= 0) return Math.min(1, Math.max(slowest, Math.sin((altitude * Math.PI) / 180) / Math.sin((15 * Math.PI) / 180)));
  return Math.min(1, slowest + ((1 - slowest) * -altitude) / 6);
}
/**
 * Softening of the shadow-map mask for a sun height, in its pixels. A low sun stretches each shadow-map texel into a
 * long streak on the ground that crawls as the sun moves; a real penumbra that far from its building is wide too.
 */
export function sharpSoften(altitude: number): number {
  const rise = Math.tan((Math.max(1, altitude) * Math.PI) / 180);
  return Math.min(5, SHARP_SOFTEN + 0.25 / rise);
}
