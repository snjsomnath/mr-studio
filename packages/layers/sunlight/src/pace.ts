// How the sun study plays through a day (#302): how fast time passes and how soft the shadows are, by sun height.

/** Softening of the shadow-map mask with a high sun, in its pixels of about 0.3 m. */
const SHARP_SOFTEN = 1.2;

/** How much faster than the day the night plays once the sun is well down (#661): a winter night is 17 hours. */
export const NIGHT_PACE = 6;

/**
 * How fast the day plays at a sun height, as a share of the full speed (#302). Near the horizon shadows grow
 * hundreds of metres a minute and sweep the table, so the play lingers there: down to a third of the speed at
 * sunrise and sunset, back to full by 15° up and 3° under, or sooner on a day whose sun never climbs that high (#661): in a
 * Gothenburg winter it stays under 10° all day, and the whole day would play slowly. Once the sun is well under the
 * horizon the night hurries by at `NIGHT_PACE`, so a winter day and night take seconds, not half a minute.
 * `peak` is the day's highest sun, in degrees.
 */
export function playPace(altitude: number, peak = 90): number {
  const slowest = 0.35;
  const full = Math.max(2, Math.min(15, peak * 0.5));
  if (altitude >= 0) return Math.min(1, Math.max(slowest, Math.sin((altitude * Math.PI) / 180) / Math.sin((full * Math.PI) / 180)));
  if (altitude > -3) return slowest + ((1 - slowest) * -altitude) / 3;
  // From full speed at 3° under to the night's pace by 9° under.
  return Math.min(NIGHT_PACE, 1 + ((NIGHT_PACE - 1) * (-altitude - 3)) / 6);
}

/** The speeds a visitor can pick for the play, as multiples of an hour a second (#661). */
export const PLAY_SPEEDS = [0.5, 1, 2, 4];

/** Seconds a whole day and night takes to play at `speed`, for a list of sun heights a few minutes apart. */
export function playSeconds(samples: { hour: number; altitude: number }[], peak: number, speed = 1, hoursPerSecond = 1): number {
  let seconds = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    seconds += (b.hour - a.hour) / (hoursPerSecond * speed * playPace((a.altitude + b.altitude) / 2, peak));
  }
  return seconds;
}

/**
 * Softening of the shadow-map mask for a sun height, in its pixels. A low sun stretches each shadow-map texel into a
 * long streak on the ground that crawls as the sun moves; a real penumbra that far from its building is wide too.
 */
export function sharpSoften(altitude: number): number {
  const rise = Math.tan((Math.max(1, altitude) * Math.PI) / 180);
  return Math.min(5, SHARP_SOFTEN + 0.25 / rise);
}
