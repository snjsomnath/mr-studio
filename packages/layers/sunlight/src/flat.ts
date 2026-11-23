// Telling whether anything on the table casts shade, from the frames the sun study draws (#55).
import type { FieldFrame } from '@mrstudio/sdk';

/**
 * True when a frame holds the same value everywhere: nothing on the table casts shade (#55).
 * The light would then cover the whole table in one colour, so the layer leaves the map dark instead.
 */
export function isFlat(frame: FieldFrame): boolean {
  const { data } = frame;
  if (data.length === 0 || frame.max - frame.min <= 1e-6) return true;
  const first = data[0]!;
  // Quantised frames may wobble by one step; float frames by rounding.
  const tolerance = data instanceof Uint8Array ? 1 : 1e-4 * (frame.max - frame.min);
  for (let i = 1; i < data.length; i++) if (Math.abs(data[i]! - first) > tolerance) return false;
  return true;
}

/** True when a tree-shade frame has some shade somewhere. */
export function hasShade(frame: FieldFrame): boolean {
  if (frame.max <= 1e-6) return false;
  const { data } = frame;
  if (frame.min > 1e-6) return data.length > 0;
  for (let i = 0; i < data.length; i++) if (data[i]! > 0) return true;
  return false;
}
