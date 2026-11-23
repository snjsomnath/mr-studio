import { el } from '../controls.ts';
import { COMMON_SCALES, scaleOf } from './place-map.ts';

/** The ground a table shows and the physical table it shows it on. */
export interface Ground {
  width_m: number;
  height_m: number;
  /** The physical table's width; its height follows the ground's shape. */
  table_cm: number;
}

const format = (n: number) => (Number.isInteger(n) ? n.toLocaleString('en-GB').replace(/,/g, ' ') : n.toLocaleString('en-GB', { maximumFractionDigits: 1 }));

/** "A 100 × 60 cm table shows 1000 × 600 m at 1 : 1000, so 1 cm on the table is 10 m." */
export function scaleWords({ width_m, height_m, table_cm }: Ground): string {
  if (!(width_m > 0 && height_m > 0 && table_cm > 0)) return '';
  const scale = scaleOf(width_m, table_cm);
  const table_h = Math.round(((table_cm * height_m) / width_m) * 10) / 10;
  return `A ${format(table_cm)} × ${format(table_h)} cm table shows ${format(width_m)} × ${format(height_m)} m at 1 : ${format(Math.round(scale))}, so 1 cm on the table is ${format(Math.round(scale) / 100)} m.`;
}

/**
 * The physical table's width and the model scale, beside the ground's width and height.
 * A scale typed or picked sets the ground's size, keeping its shape; a ground size changed
 * elsewhere (the fields, the map's corner) shows here as a new scale.
 */
export class ScaleFields {
  readonly element = el('div', 'wz-scale');
  private readonly table = el('input');
  private readonly scale = el('input');
  private readonly words = el('p', 'wz-hint wz-scale-words');
  private readonly chips: HTMLButtonElement[] = [];
  private readonly get: () => Ground;
  private readonly set: (ground: Ground) => void;

  constructor(get: () => Ground, set: (ground: Ground) => void) {
    this.get = get;
    this.set = set;
    Object.assign(this.table, { type: 'number', min: '10', max: '2000', step: '1', name: 'table' });
    Object.assign(this.scale, { type: 'number', min: '10', max: '1000000', step: '10', name: 'scale' });
    const field = (label: string, input: HTMLElement, hint: string) => {
      const row = el('label', 'wz-field');
      row.append(el('span', undefined, label), input, el('small', undefined, hint));
      return row;
    };
    const ratio = el('div', 'wz-ratio');
    ratio.append(el('span', 'wz-ratio-one', '1 :'), this.scale);
    const pair = el('div', 'wz-pair');
    pair.append(field('Table width, cm', this.table, 'The physical table, edge to edge.'), field('Scale', ratio, 'Metres of ground per metre of table.'));
    const chips = el('div', 'wz-chips');
    for (const n of COMMON_SCALES) {
      const chip = el('button', 'wz-chip', `1 : ${format(n)}`);
      chip.type = 'button';
      chip.dataset.scale = String(n);
      chip.addEventListener('click', () => this.toScale(n));
      this.chips.push(chip);
      chips.append(chip);
    }
    this.element.append(pair, chips, this.words);

    this.table.addEventListener('input', () => {
      const table_cm = Number(this.table.value);
      if (!(table_cm >= 10 && table_cm <= 2000)) return;
      this.set({ ...this.get(), table_cm });
      this.refresh();
    });
    this.scale.addEventListener('input', () => {
      const n = Number(this.scale.value);
      if (n >= 10) this.toScale(n, false);
    });
    this.refresh();
  }

  /** Shows the ground and table as they now are, leaving the field being typed in alone. */
  refresh(): void {
    const ground = this.get();
    const scale = ground.table_cm > 0 ? Math.round(scaleOf(ground.width_m, ground.table_cm)) : NaN;
    if (document.activeElement !== this.table) this.table.value = String(ground.table_cm);
    if (document.activeElement !== this.scale) this.scale.value = Number.isFinite(scale) ? String(scale) : '';
    for (const chip of this.chips) chip.classList.toggle('is-pressed', Number(chip.dataset.scale) === scale);
    this.words.textContent = scaleWords(ground);
  }

  private toScale(n: number, show = true): void {
    const ground = this.get();
    const width_m = Math.round((n * ground.table_cm) / 100);
    const height_m = Math.round((width_m * ground.height_m) / ground.width_m);
    this.set({ ...ground, width_m, height_m });
    if (show) this.scale.value = String(n);
    this.refresh();
  }
}
