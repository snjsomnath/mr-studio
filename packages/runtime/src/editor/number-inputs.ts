// Number fields shared by the import's "Show it on the table" step and the layer builder's Look (#94).

import { el } from '../controls.ts';

/** The author's own class edges (#94): numbers, comma separated, low to high. */
export function stopsInput(stops: number[], onChange: (stops: number[]) => void): HTMLInputElement {
  const input = el('input', 'lb-stops');
  input.type = 'text';
  input.inputMode = 'decimal';
  input.placeholder = 'For example 0, 10, 50';
  input.ariaLabel = 'Class edges';
  input.value = stops.join(', ');
  input.addEventListener('change', () => {
    const next = [...new Set(input.value.split(/[,;\s]+/).map((v) => Number(v.replace(/\u2212/g, '-'))).filter((v) => Number.isFinite(v)))].sort((a, b) => a - b).slice(0, 6);
    input.value = next.join(', ');
    onChange(next);
  });
  return input;
}

/** The value the ramp's middle colour stands for; empty is halfway (#94). */
export function middleInput(mid: number | undefined, onChange: (mid: number | undefined) => void): HTMLInputElement {
  const input = el('input', 'lb-stops');
  input.type = 'text';
  input.inputMode = 'decimal';
  input.placeholder = 'Halfway, or a value such as 0';
  input.ariaLabel = 'Middle value';
  input.value = mid === undefined ? '' : String(mid);
  input.addEventListener('change', () => {
    const text = input.value.trim().replace(/\u2212/g, '-');
    const value = text === '' ? undefined : Number(text);
    if (value !== undefined && !Number.isFinite(value)) {
      input.value = mid === undefined ? '' : String(mid);
      return;
    }
    mid = value;
    onChange(value);
  });
  return input;
}
