/**
 * Platform conventions (#399): on a Mac the confirming button is last, at the right, with Cancel
 * before it; on Windows and Linux it comes first and Cancel is last. Every dialog orders its buttons here.
 */
export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** The confirm and cancel buttons in this platform's order. */
export function okCancel<T extends HTMLElement>(ok: T, cancel: T): T[] {
  return isMac ? [cancel, ok] : [ok, cancel];
}
