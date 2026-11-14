import type { Control, Params } from './types.ts';

/** Whether a control should be shown for the current params. */
export function isVisible(control: Control, params: Params): boolean {
  if (!control.visibleWhen) return true;
  return Object.entries(control.visibleWhen).every(([key, value]) => params[key] === value);
}
