/** Categorical colours, and how Next reveals categories one at a time. Pure, for tests. */

/** Categorical colours that hold up on a dark projected table. */
export const PALETTE = ['#4dabf7', '#ff922b', '#51cf66', '#f06595', '#fcc419', '#9775fa', '#20c997', '#ff6b6b', '#66d9e8', '#d8f5a2', '#e599f7', '#ffd8a8'];
/** The category colours with the table palette's categories first, then the rest of `PALETTE`. */
export function categoryColours(slots: readonly string[]): string[] {
  const out = [...slots];
  for (const extra of PALETTE.slice(slots.length)) out.push(extra);
  return out.slice(0, PALETTE.length);
}
/** More categories than this are drawn as one, in the layer's colour. */
const MAX_CATEGORIES = PALETTE.length;
/** How faint the categories still to come are, as context. */
const WAITING = 0.18;
/** How long a newly revealed category pulses. */
export const PULSE_S = 1.2;

/** The categories of a property, in order of first appearance, or none when there are too many to tell apart. */
export function categories(features: { properties: Record<string, unknown> }[], property: string): string[] {
  if (!property) return [];
  const seen: string[] = [];
  for (const feature of features) {
    const value = feature.properties?.[property];
    if (value === undefined || value === null) continue;
    const name = String(value);
    if (!seen.includes(name)) seen.push(name);
    if (seen.length > MAX_CATEGORIES) return [];
  }
  return seen;
}

/** How strongly category `n` is drawn when `revealed` of `count` are revealed. 0 revealed is the overview. */
export function strength(n: number, revealed: number, count: number): number {
  if (revealed <= 0 || revealed >= count) return 1;
  return n < revealed ? 1 : WAITING;
}

