import type { Control, Params } from './types.ts';

/** Whether a control should be shown for the current params. A list in `visibleWhen` means any of those values. */
export function isVisible(control: Control, params: Params): boolean {
  if (!control.visibleWhen) return true;
  return Object.entries(control.visibleWhen).every(([key, value]) => (Array.isArray(value) ? value.includes(params[key]) : params[key] === value));
}
