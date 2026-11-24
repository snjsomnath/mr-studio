import type { Connection } from '@mrstudio/sdk';

/**
 * Errors in this window go to the host (#260), which writes them to the app's log: on an
 * installed app nobody has the developer tools open. The same error is sent once a minute at
 * most, and a window that keeps failing stops after a handful; the host also counts and limits.
 */

let connection: Connection | null = null;
let windowName: string | undefined;
const lastSent = new Map<string, number>();
let sentThisMinute = 0;
let minuteStart = 0;

const SAME_AGAIN_MS = 60_000;
const MOST_PER_MINUTE = 20;

/** Starts sending this window's errors, and every uncaught error and rejected promise, to the host. */
export function reportErrors(to: Connection, name?: string): void {
  connection = to;
  windowName = name;
  window.addEventListener('error', (event) => {
    // A picture or script that failed to load fires `error` too, without an error in it.
    if (!event.error && !event.message) return;
    reportError(event.error ?? event.message);
  });
  window.addEventListener('unhandledrejection', (event) => reportError(event.reason));
}

/** Sends one error to the host, from a layer when `layer` names its instance. */
export function reportError(error: unknown, layer?: string): void {
  if (!connection) return;
  const message = describe(error);
  if (!message) return;
  const now = Date.now();
  const key = `${layer ?? ''}\n${message}`;
  if (now - (lastSent.get(key) ?? -Infinity) < SAME_AGAIN_MS) return;
  if (now - minuteStart > 60_000) {
    minuteStart = now;
    sentThisMinute = 0;
  }
  if (++sentThisMinute > MOST_PER_MINUTE) return;
  lastSent.set(key, now);
  if (lastSent.size > 200) lastSent.clear();
  const stack = error instanceof Error && error.stack ? error.stack : undefined;
  connection.report({ message, stack, layer, window: windowName });
}

/** One line for an error of any kind. */
export function describe(error: unknown): string {
  if (error instanceof Error) return error.message ? `${error.name === 'Error' ? '' : `${error.name}: `}${error.message}` : error.name;
  if (typeof error === 'string') return error;
  if (error === undefined || error === null) return '';
  try {
    return JSON.stringify(error).slice(0, 500);
  } catch {
    return String(error);
  }
}
