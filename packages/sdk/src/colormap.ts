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
  /** Standing water by depth: clear on dry ground, a deepening blue in puddles, bright where it pools deep. */
  water: {
    stops: [[0, 20, 70, 160, 0], [0.01, 25, 80, 175, 0], [0.04, 30, 100, 200, 110], [0.15, 35, 135, 230, 175], [0.4, 70, 190, 250, 215], [1, 200, 245, 255, 235]],
  },
  /** Running water by speed: teal where it barely moves (pooling, as in the Chalmers demo), blue as it runs, white when fast. */
  runoff: { stops: [[0, 50, 215, 175, 230], [0.15, 50, 160, 255, 240], [0.5, 90, 200, 255, 250], [1, 235, 255, 255, 255]] },
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

/**
 * The same ramp reaching its top colour at `fraction` of the range instead of at the end.
 * Use it to show a field quantised over 0..max on a legend that ends at `fraction * max`.
 */
export function stretch(colormap: Colormap, fraction: number): Colormap {
  if (!(fraction > 0)) return colormap;
  const table = lut(colormap);
  const steps = 32;
  const stops: Colormap['stops'] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const k = Math.round(Math.min(1, t / fraction) * 255) * 4;
    stops.push([t, table[k]!, table[k + 1]!, table[k + 2]!, table[k + 3]!]);
  }
  return { stops };
}
