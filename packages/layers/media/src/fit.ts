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

/** A picture's place on the map: its west, south, east and north edges in WGS84 degrees. */
export type Bounds = { west: number; south: number; east: number; north: number };

/**
 * Bounds typed as `west,south,east,north` (a GeoJSON bbox), or as the `bounds` object of a
 * picture's side file (`{"west":…,"south":…,"east":…,"north":…}`). Null when empty or not four
 * numbers with west < east and south < north, so the picture fits the table instead.
 */
export function parseBounds(value: unknown): Bounds | null {
  let parts: unknown[] | null = null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    if (text.startsWith('{')) {
      try {
        return parseBounds(JSON.parse(text));
      } catch {
        return null;
      }
    }
    parts = text.split(/[\s,;]+/).filter(Boolean);
  } else if (Array.isArray(value)) parts = value;
  else if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const box = (o.bounds ?? o) as Record<string, unknown>;
    parts = [box.west, box.south, box.east, box.north];
  }
  if (!parts || parts.length !== 4) return null;
  const [west, south, east, north] = parts.map(Number) as [number, number, number, number];
  if (![west, south, east, north].every(Number.isFinite) || west >= east || south >= north) return null;
  if (Math.abs(west) > 180 || Math.abs(east) > 180 || Math.abs(south) > 90 || Math.abs(north) > 90) return null;
  return { west, south, east, north };
}
