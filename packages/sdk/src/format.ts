/**
 * One formatter for numbers, units, times and dates (#397), used by the Format pane, dialogs, the
 * table's ribbons, the controller and the phones. Visitors' screens follow the session's language
 * (#80): a decimal comma in Swedish (5,0 m/s), a point in English (5.0 m/s). The editor stays in
 * English. Typed numbers are read with either.
 */

/** The languages numbers are written in; anything else reads as English. */
export type NumberLanguage = 'en' | 'sv';

let current: NumberLanguage = 'en';
const locale = (): string => (current === 'sv' ? 'sv-SE' : 'en');
/** Dates are written day first in English too: 24 June 2026. */
const dateLocale = (): string => (current === 'sv' ? 'sv-SE' : 'en-GB');
const cache = new Map<string, Intl.NumberFormat>();
const numberFormat = (options: Intl.NumberFormatOptions): Intl.NumberFormat => {
  const key = `${locale()}|${JSON.stringify(options)}`;
  let format = cache.get(key);
  if (!format) cache.set(key, (format = new Intl.NumberFormat(locale(), options)));
  return format;
};

/** Sets the language numbers are written in. The runtime calls it when the session's language changes. */
export function setNumberLanguage(language: string): void {
  current = language === 'sv' ? 'sv' : 'en';
}

/** The language numbers are written in now. */
export function numberLanguage(): NumberLanguage {
  return current;
}

/** A number with exactly `decimals` decimals in the current language: 1 234,5 in Swedish, 1,234.5 in English. */
export function formatDecimal(value: number, decimals = 0): string {
  if (!Number.isFinite(value)) return '–';
  const d = Math.max(0, Math.min(6, Math.round(decimals)));
  return numberFormat({ minimumFractionDigits: d, maximumFractionDigits: d }).format(value);
}

/** A large number shortened, as 12k or 1,2 mn: for headlines a visitor takes in at a glance. */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '–';
  return numberFormat({ notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

/** Units written straight after the number, with no space: 270°, 3×. Every other unit has a space: 5 m/s, 21 °C, 40 %. */
const TIGHT = new Set(['°', '×', "'", '″']);

/**
 * A number with its unit. Metres of 1000 or more read as kilometres when `km` is set; hours of a
 * day ('h' up to 24 with `clock`) read as a clock.
 */
export function formatUnit(value: number, unit: string | undefined, decimals = 0, options: { km?: boolean; clock?: boolean } = {}): string {
  if (!Number.isFinite(value)) return '–';
  if (unit === 'h' && options.clock) return formatClock(value);
  if (unit === 'm' && options.km && Math.abs(value) >= 1000) return `${formatDecimal(value / 1000, Math.abs(value) >= 10_000 ? 0 : 1)}\u00a0km`;
  const number = formatDecimal(value, decimals);
  if (!unit) return number;
  return TIGHT.has(unit) ? `${number}${unit}` : `${number} ${unit}`;
}

/** A distance in metres: 40 m, 850 m, 1.2 km, 12 km. */
export function formatDistance(metres: number): string {
  return formatUnit(metres, 'm', Math.abs(metres) < 10 ? 1 : 0, { km: true });
}

/** A time of day in hours on the 24-hour clock: 12.5 is 12:30, 24 is 24:00. The same in every language. */
export function formatClock(hours: number): string {
  const minutes = Math.round(hours * 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** A date in the current language: 24 juni 2026, 24 June 2026; with `time`, its 24-hour time too. */
export function formatDate(date: Date | string | number, options: { time?: boolean; timeZone?: string } = {}): string {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '–';
  return new Intl.DateTimeFormat(dateLocale(), {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    ...(options.time ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' as const } : {}),
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  }).format(d);
}

/** A typed number, with a decimal point or comma and any spaces between thousands: null when it is none. */
export function parseNumber(text: string): number | null {
  const clean = text.trim().replace(/[\s  ]/g, '').replace(/^−/, '-');
  // One comma and no point is a decimal comma; a comma among points (1,234.5) groups thousands.
  const normal = clean.includes('.') ? clean.replace(/,/g, '') : clean.replace(',', '.');
  const value = Number.parseFloat(normal);
  return Number.isFinite(value) ? value : null;
}
