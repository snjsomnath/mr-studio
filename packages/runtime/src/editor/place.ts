/**
 * Reads a place from what someone pasted: plain coordinates ("57.6898, 11.9742") or a
 * link from a map site, which carries them as `@57.6898,11.9742` or `#map=15/57.6898/11.9742`.
 */
export function parsePlace(text: string): { lat: number; lon: number } | null {
  const match = /(-?\d{1,2}\.\d+)\s*[,/\s]\s*(-?\d{1,3}\.\d+)/.exec(text);
  if (!match) return null;
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}
