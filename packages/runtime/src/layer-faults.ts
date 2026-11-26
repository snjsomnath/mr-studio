/**
 * Trouble a running layer does not report by itself (#510): handlers that keep throwing, and a
 * start that never finishes. The layer manager acts on what these say.
 */

/** A layer that threw this many times in a row, with no quiet spell between, is stopped and started again. */
export const FAULT_LIMIT = 10;
/** A spell this long without a throw starts the count afresh: an occasional mistake is not a broken layer. */
export const FAULT_QUIET_MS = 2000;
/** A layer that has not finished starting after this long is shown as in trouble. */
export const START_LIMIT_MS = 20_000;

/** Counts the throws of each layer instance. */
export class FaultCount {
  private counts = new Map<string, { thrown: number; last: number }>();

  /** Instance `id` threw at `now` (ms). True when it has now thrown `FAULT_LIMIT` times with no quiet spell. */
  thrown(id: string, now: number): boolean {
    const count = this.counts.get(id);
    if (!count || now - count.last > FAULT_QUIET_MS) {
      this.counts.set(id, { thrown: 1, last: now });
      return false;
    }
    count.thrown += 1;
    count.last = now;
    return count.thrown >= FAULT_LIMIT;
  }

  /** Instance `id` stopped: its next run starts from nothing. */
  clear(id: string): void {
    this.counts.delete(id);
  }
}

/**
 * Waits for `work` as `await work` does, and calls `slow` once if it is still going after `ms`.
 * The work is not cut short: a start that is merely slow still finishes.
 */
export async function noticeSlow<T>(work: Promise<T> | T, ms: number, slow: () => void): Promise<T> {
  const timer = setTimeout(slow, ms);
  try {
    return await work;
  } finally {
    clearTimeout(timer);
  }
}
