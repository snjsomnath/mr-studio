// The field walk's spots (#445), as the host keeps them: GET /api/field on the studio computer.
// Pure helpers here, so they are tested without a browser.

export interface Walker {
  id: string;
  name?: string;
  avatar?: string;
  mood?: string;
  colour?: string;
}

export interface Spot {
  id: string;
  kind: 'photo' | 'sound';
  /** When it was taken, Unix milliseconds by the phone's clock. */
  at: number;
  lon: number;
  lat: number;
  accuracy?: number;
  placed: 'gps' | 'map';
  note?: string;
  file: string;
  mime: string;
  bytes: number;
  duration?: number;
  walker: Walker;
}

/** A spot a phone has started sending and the table does not have all of yet. */
export interface Arriving {
  id: string;
  kind: 'photo' | 'sound';
  walker: Walker;
  share: number;
}

export interface Walk {
  revision: number;
  spots: Spot[];
  pending: Arriving[];
}

/** A walker's spots in the order they were taken, and their colour. */
export interface Track {
  walker: Walker;
  colour: string;
  spots: Spot[];
}

/** Colours for walkers whose phone had none, in the phones' own order. */
const SPARE = ['#ff6b6b', '#4dabf7', '#ffd43b', '#69db7c', '#da77f2', '#ffa94d', '#38d9a9', '#f783ac'];

export async function fetchWalk(): Promise<Walk> {
  try {
    const response = await fetch('/api/field', { cache: 'no-store' });
    if (!response.ok) return { revision: 0, spots: [], pending: [] };
    const walk = (await response.json()) as Walk;
    return {
      revision: walk.revision ?? 0,
      spots: Array.isArray(walk.spots) ? walk.spots : [],
      pending: Array.isArray(walk.pending) ? walk.pending : [],
    };
  } catch {
    return { revision: 0, spots: [], pending: [] };
  }
}

export function mediaUrl(spot: Spot): string {
  return `/api/field/${encodeURIComponent(spot.file)}`;
}

/** Spots grouped by walker, each walker's in time order; walkers in the order they first marked a spot. */
export function tracks(spots: readonly Spot[]): Track[] {
  const byWalker = new Map<string, Track>();
  for (const spot of [...spots].sort((a, b) => a.at - b.at)) {
    let track = byWalker.get(spot.walker.id);
    if (!track) {
      track = {
        walker: spot.walker,
        colour: spot.walker.colour ?? SPARE[byWalker.size % SPARE.length]!,
        spots: [],
      };
      byWalker.set(spot.walker.id, track);
    }
    // The latest name and animal the walker had.
    track.walker = { ...track.walker, ...spot.walker };
    track.spots.push(spot);
  }
  return [...byWalker.values()];
}

/** Every spot in the order the controller walks them with Previous and Next: walker by walker, in time. */
export function ordered(spots: readonly Spot[]): Spot[] {
  return tracks(spots).flatMap((t) => t.spots);
}

/** The spot next to `id` in that order, wrapping round. */
export function step(spots: readonly Spot[], id: string, by: 1 | -1): Spot | null {
  const list = ordered(spots);
  if (list.length === 0) return null;
  const at = list.findIndex((s) => s.id === id);
  if (at < 0) return list[by > 0 ? 0 : list.length - 1]!;
  return list[(at + by + list.length) % list.length]!;
}

/** The spot nearest `point` within `reach` (same units as `toXY` gives), or null. */
export function nearest(spots: readonly Spot[], point: readonly [number, number], reach: number, toXY: (s: Spot) => readonly [number, number]): Spot | null {
  let best: Spot | null = null;
  let bestD = reach * reach;
  for (const spot of spots) {
    const [x, y] = toXY(spot);
    const d = (x - point[0]) ** 2 + (y - point[1]) ** 2;
    if (d <= bestD) {
      best = spot;
      bestD = d;
    }
  }
  return best;
}

/** "14:32", in the place's own time zone as the controller's clock has it. */
export function clockTime(at: number, language = 'en'): string {
  if (!at) return '';
  return new Date(at).toLocaleTimeString(language === 'sv' ? 'sv-SE' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
}
