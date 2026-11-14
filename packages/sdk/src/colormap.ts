/** A colour ramp: stops at positions 0..1 with RGBA 0..255. */
export interface Colormap {
  stops: [position: number, r: number, g: number, b: number, a: number][];
}

export const colormaps = {
  /** Shadow mask for projection: dark where shaded, a warm wash where lit. */
  daylight: { stops: [[0, 6, 10, 28, 225], [0.5, 70, 66, 80, 150], [1, 255, 222, 140, 105]] },
  /** Sequential, dark to bright, for accumulated quantities. */
  sun: {
    stops: [[0, 12, 8, 40, 235], [0.2, 70, 20, 110, 235], [0.45, 180, 50, 90, 235], [0.7, 245, 125, 40, 235], [0.88, 252, 200, 70, 235], [1, 255, 250, 200, 235]],
  },
  /** Blue to red through green, for speeds. */
  speed: { stops: [[0, 59, 130, 246, 220], [0.25, 45, 212, 191, 220], [0.5, 163, 230, 53, 220], [0.75, 251, 191, 36, 220], [1, 239, 68, 68, 220]] },
} satisfies Record<string, Colormap>;

/** Renders a colormap to a 256-entry RGBA lookup table. */
export function lut(colormap: Colormap): Uint8Array {
  const stops = colormap.stops;
  const out = new Uint8Array(256 * 4);
  let k = 0;
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    while (k < stops.length - 2 && t > stops[k + 1]![0]) k++;
    const a = stops[k]!;
    const b = stops[Math.min(k + 1, stops.length - 1)]!;
    const span = b[0] - a[0];
    const f = span > 0 ? Math.min(1, Math.max(0, (t - a[0]) / span)) : 0;
    for (let c = 0; c < 4; c++) out[i * 4 + c] = Math.round(a[c + 1]! + (b[c + 1]! - a[c + 1]!) * f);
  }
  return out;
}

/** A CSS gradient of the colormap, for legends. */
export function cssGradient(colormap: Colormap, direction = 'to right'): string {
  const parts = colormap.stops.map(([p, r, g, b]) => `rgb(${r} ${g} ${b}) ${(p * 100).toFixed(0)}%`);
  return `linear-gradient(${direction}, ${parts.join(', ')})`;
}
