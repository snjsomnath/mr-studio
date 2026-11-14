/** Minutes that `timeZone` is ahead of UTC at the given instant. */
export function zoneOffsetMinutes(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((local - Math.floor(utcMs / 1000) * 1000) / 60000);
}

/**
 * The UTC instant of a wall-clock time in a time zone, as an RFC 3339 string.
 * `date` is YYYY-MM-DD and `hour` is decimal hours, 0 to 24.
 */
export function zonedTimeToUtc(date: string, hour: number, timeZone: string | null): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const wall = Date.UTC(year, month - 1, day) + Math.round(hour * 3600) * 1000;
  let utc = wall;
  if (timeZone) {
    // Two passes settle the offset across a daylight saving change.
    utc = wall - zoneOffsetMinutes(wall, timeZone) * 60000;
    utc = wall - zoneOffsetMinutes(utc, timeZone) * 60000;
  }
  return new Date(utc).toISOString().replace('.000Z', 'Z');
}

/** Formats decimal hours as HH:MM. */
export function formatHour(hour: number): string {
  const minutes = Math.round(hour * 60);
  return `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
