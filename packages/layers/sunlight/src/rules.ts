import type { Colormap, FieldFrame, SiteInfo } from '@mrstudio/sdk';
import { zonedTimeToUtc } from '@mrstudio/sdk';

/**
 * Daylight rules for open ground (#498, #81): enough sun on enough of the area, on one day of the year.
 * The hours and share are only where a rule starts; the controller can set a municipality's own numbers.
 */
export interface DaylightRule {
  /** Month and day the sun is summed for. */
  monthDay: string;
  /** Wall-clock hours the sun counts in, or null for the whole day. */
  window: [number, number] | null;
  /** Hours of sun a place needs to pass. */
  hours: number;
  /** Percent of the open ground that must pass. */
  share: number;
}

export const RULES: Record<string, DaylightRule> = {
  // Boverket's guidance for play and school yards, used by most Swedish municipalities:
  // at least half the open ground with at least 5 hours of sun between 9 and 17 at the spring equinox.
  se: { monthDay: '03-20', window: [9, 17], hours: 5, share: 50 },
  // BRE, Site layout planning for daylight and sunlight (BR 209): at least half the area with at least 2 hours of sun on 21 March.
  bre: { monthDay: '03-21', window: null, hours: 2, share: 50 },
};

export const DEFAULT_RULE = 'se';

export const ruleOf = (id: string): DaylightRule => RULES[id] ?? RULES[DEFAULT_RULE]!;

/** The rule's day in the year of `date` (YYYY-MM-DD). */
export function ruleDate(id: string, date: string): string {
  const year = /^\d{4}/.exec(date)?.[0] ?? String(new Date().getUTCFullYear());
  return `${year}-${ruleOf(id).monthDay}`;
}

/** The kernel's `from` and `until` for the rule on its day; nulls for the whole day. */
export function ruleWindow(site: Pick<SiteInfo, 'timezone'>, id: string, date: string): { from: string | null; until: string | null } {
  const window = ruleOf(id).window;
  const day = ruleDate(id, date);
  return window ? { from: zonedTimeToUtc(day, window[0], site.timezone), until: zonedTimeToUtc(day, window[1], site.timezone) } : { from: null, until: null };
}

const FAIL: [number, number, number, number] = [226, 54, 76, 235];
const PASS: [number, number, number, number] = [250, 204, 90, 215];

/** The key on the TV: fail on the left, pass on the right. */
export const passKey: Colormap = { stops: [[0, ...FAIL], [0.496, ...FAIL], [0.504, ...PASS], [1, ...PASS]] };

/** The table's colours for a verdict frame: buildings clear, fail and pass flat. */
export const verdictColormap: Colormap = {
  stops: [[0, 0, 0, 0, 0], [0.24, 0, 0, 0, 0], [0.26, ...FAIL], [0.74, ...FAIL], [0.76, ...PASS], [1, ...PASS]],
};

/** A sun-hours value from a frame cell, quantised or not. */
function reader(frame: Pick<FieldFrame, 'min' | 'max' | 'data'>): { at: (i: number) => number; slack: number } {
  const { data, min, max } = frame;
  if (!(data instanceof Uint8Array)) return { at: (i) => data[i]!, slack: 1e-6 };
  const scale = (max - min) / 255;
  // A quantised field is off by up to half a step; a place right at the rule passes.
  return { at: (i) => min + data[i]! * scale, slack: scale / 2 };
}

/**
 * Pass or fail for each cell of a sun-hours frame, for the table: 0 on buildings (drawn clear, they are not
 * ground), 0.5 for too little sun, 1 for enough.
 */
export function verdictFrame<F extends FieldFrame>(frame: F, hours: number, buildings: Uint8Array | null): F {
  const cells = frame.width * frame.height;
  const { at, slack } = reader(frame);
  const mask = buildings && buildings.length === cells ? buildings : null;
  const data = new Float32Array(cells);
  for (let i = 0; i < cells; i++) data[i] = mask?.[i] ? 0 : at(i) >= hours - slack ? 1 : 0.5;
  return { ...frame, min: 0, max: 1, data };
}

/**
 * Percent of the open ground (cells outside `buildings`) with at least `hours` of sun, from a sun-hours frame.
 * Null when there is no open ground to judge.
 */
export function passingShare(frame: Pick<FieldFrame, 'width' | 'height' | 'min' | 'max' | 'data'>, hours: number, buildings: Uint8Array | null): number | null {
  const cells = frame.width * frame.height;
  const { at, slack } = reader(frame);
  const need = hours - slack;
  const mask = buildings && buildings.length === cells ? buildings : null;
  let open = 0;
  let pass = 0;
  for (let i = 0; i < cells; i++) {
    if (mask?.[i]) continue;
    open++;
    if (at(i) >= need) pass++;
  }
  return open ? (pass / open) * 100 : null;
}
