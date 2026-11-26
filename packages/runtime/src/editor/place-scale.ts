import { el } from '../controls.ts';
import { COMMON_SCALES, scaleOf } from './place-map.ts';

/** The ground a table shows and the physical table it shows it on. */
export interface Ground {
  width_m: number;
  height_m: number;
  /** The physical table's width; its height is the ground's height at the same scale. */
  table_cm: number;
  /** The side of one square 3D-printed tile, or null when the table is not printed in tiles. */
  tile_cm?: number | null;
  /** How fine the analysis grid is (#513); left out, the table's own choice. */
  detail?: Detail;
}

/** How fine the grid is that sun, wind and shade are worked out on (#513). */
export type Detail = 'fine' | 'normal' | 'coarse';

/** The side of one square of that grid, in metres. The same rule as `mrs_site::detail`: about two million squares at normal. */
export function cellFor(width_m: number, height_m: number, detail: Detail): number {
  const area = width_m * height_m;
  const normal = area > 2_000_000 ? Math.ceil(Math.sqrt(area / 2_000_000)) : 1;
  return detail === 'fine' ? normal / 2 : detail === 'coarse' ? normal * 2 : normal;
}

/** The detail a table has now, from its cell and its ground. */
export function detailOf(width_m: number, height_m: number, cell_m: number): Detail {
  const ratio = cell_m / cellFor(width_m, height_m, 'normal');
  return ratio < 0.75 ? 'fine' : ratio > 1.5 ? 'coarse' : 'normal';
}

const DETAILS: Array<[Detail, string]> = [
  ['fine', 'Fine'],
  ['normal', 'Normal'],
  ['coarse', 'Coarse'],
];

/** "Sun, wind and shade are worked out on squares of 3 m, 1.1 million of them." and what the choice costs. */
export function detailWords(ground: Ground): string {
  const { width_m, height_m } = ground;
  if (!(width_m > 0 && height_m > 0)) return '';
  const detail = ground.detail ?? 'normal';
  const cell = cellFor(width_m, height_m, detail);
  const squares = Math.round(width_m / cell) * Math.round(height_m / cell);
  const count = squares >= 1e6 ? `${format(Math.round(squares / 1e5) / 10)} million` : format(Math.round(squares / 1000) * 1000);
  const cost = detail === 'fine' ? ' Fine is sharper, and about four times slower than Normal.' : detail === 'coarse' ? ' Coarse is blockier, and about four times faster than Normal.' : '';
  return `Sun, wind and shade are worked out on squares of ${format(cell)} m, ${count} of them.${cost}`;
}

const format = (n: number) => (Number.isInteger(n) ? n.toLocaleString('en-GB').replace(/,/g, ' ') : n.toLocaleString('en-GB', { maximumFractionDigits: 1 }));
const tenth = (n: number) => Math.round(n * 10) / 10;

/** The physical table's height: the ground's height at the scale its width sets. */
export const tableHeight = ({ width_m, height_m, table_cm }: Ground) => tenth((table_cm * height_m) / width_m);

/** "The table, 100 × 60 cm, shows 1 000 × 600 m at 1 : 1 000, so 1 cm on it is 10 m." */
export function scaleWords(ground: Ground): string {
  const { width_m, height_m, table_cm } = ground;
  if (!(width_m > 0 && height_m > 0 && table_cm > 0)) return '';
  const scale = scaleOf(width_m, table_cm);
  return `The table, ${format(table_cm)} × ${format(tableHeight(ground))} cm, shows ${format(width_m)} × ${format(height_m)} m at 1 : ${format(Math.round(scale))}, so 1 cm on it is ${format(Math.round(scale) / 100)} m.`;
}

const fits = (length: number, tile: number) => Math.abs(length / tile - Math.round(length / tile)) < 0.01;

/**
 * Whether the table divides into whole square tiles; null when it does, otherwise the
 * problem in words with tile sizes and table sizes that would fit.
 */
export function tileProblem(ground: Ground): string | null {
  const tile = ground.tile_cm;
  if (!tile) return null;
  const [w, h] = [ground.table_cm, tableHeight(ground)];
  if (!(tile > 0)) return 'A tile needs a size in centimetres.';
  if (tile > w || tile > h) return `A ${format(tile)} cm tile is bigger than the ${format(w)} × ${format(h)} cm table.`;
  if (fits(w, tile) && fits(h, tile)) return null;
  const sizes: number[] = [];
  for (let t = 50; t >= 5 && sizes.length < 3; t--) if (fits(w, t) && fits(h, t)) sizes.push(t);
  const across = `${format(tenth(w / tile))} × ${format(tenth(h / tile))}`;
  const nearest = (n: number) => format(Math.max(1, Math.round(n / tile)) * tile);
  const listed = sizes.map(format);
  const others = listed.length > 1 ? `${listed.slice(0, -1).join(', ')} or ${listed.at(-1)}` : listed[0];
  const instead = others ? ` Tiles of ${others} cm fit exactly, or make` : ' Make';
  return `The ${format(w)} × ${format(h)} cm table is ${across} tiles of ${format(tile)} cm, not a whole number.${instead} the table ${nearest(w)} × ${nearest(h)} cm.`;
}

/**
 * The physical table's width and height and the model scale, beside the ground's width and
 * height. The physical table is furniture and holds still (#580): more or less ground
 * changes the scale, and the other side of the ground follows so it keeps the table's shape.
 * The table's own fields resize the table at the scale; a scale typed or picked keeps the
 * ground and resizes the table.
 */
export class ScaleFields {
  readonly element = el('div', 'wz-scale');
  private readonly table = el('input');
  private readonly tableH = el('input');
  private readonly scale = el('input');
  private readonly words = el('p', 'wz-hint wz-scale-words');
  private readonly chips: HTMLButtonElement[] = [];
  private readonly tiled = el('input');
  private readonly tile = el('input');
  private readonly tileRow = el('div', 'wz-tiles');
  private readonly tileWords = el('p', 'wz-hint');
  private readonly detail = el('select');
  private readonly detailHint = el('small');
  private readonly get: () => Ground;
  private readonly set: (ground: Ground) => void;
  private readonly onTiles: (tile_m: number | null) => void;
  /** The model scale, 1 : n, which the other fields follow. */
  private n: number | null = null;
  private lastTile = 20;
  /** The ground as last shown, to tell which side was changed elsewhere. */
  private last: Ground | null = null;
  /** The change came from these fields (table size, scale, tiles), not from the ground. */
  private own = false;

  /** `tiles` hears the tile grid's step in metres of ground, for the map to draw; null for none. */
  constructor(get: () => Ground, set: (ground: Ground) => void, tiles: (tile_m: number | null) => void = () => {}) {
    this.get = get;
    this.set = set;
    this.onTiles = tiles;
    Object.assign(this.table, { type: 'number', min: '10', max: '2000', step: '1', name: 'table' });
    Object.assign(this.tableH, { type: 'number', min: '10', max: '2000', step: '1', name: 'table-height' });
    Object.assign(this.scale, { type: 'number', min: '10', max: '1000000', step: '10', name: 'scale' });
    Object.assign(this.tiled, { type: 'checkbox', name: 'tiled' });
    Object.assign(this.tile, { type: 'number', min: '1', max: '200', step: '0.5', name: 'tile' });
    const field = (label: string, input: HTMLElement, hint?: string) => {
      const row = el('label', 'wz-field');
      row.append(el('span', undefined, label), input);
      if (hint) row.append(el('small', undefined, hint));
      return row;
    };
    const ratio = el('div', 'wz-ratio');
    ratio.append(el('span', 'wz-ratio-one', '1 :'), this.scale);
    const pair = el('div', 'wz-pair');
    pair.append(field('Table width, cm', this.table), field('Table height, cm', this.tableH));
    const chips = el('div', 'wz-chips');
    for (const n of COMMON_SCALES) {
      const chip = el('button', 'wz-chip', `1 : ${format(n)}`);
      chip.type = 'button';
      chip.dataset.scale = String(n);
      chip.addEventListener('click', () => this.toScale(n));
      this.chips.push(chip);
      chips.append(chip);
    }
    const scaleRow = el('div', 'wz-scale-row');
    scaleRow.append(field('Scale', ratio), chips);
    const toggle = el('label', 'wz-check');
    toggle.append(this.tiled, el('span', undefined, 'Show 3D-printing tiles'));
    this.tileRow.append(field('Tile size, cm', this.tile, 'Square tiles, edge to edge.'), this.tileWords);
    this.detail.name = 'detail';
    for (const [value, label] of DETAILS) {
      const option = el('option', undefined, label);
      option.value = value;
      this.detail.append(option);
    }
    const detailRow = el('label', 'wz-field wz-detail');
    detailRow.append(el('span', undefined, 'Analysis detail'), this.detail, this.detailHint);
    this.detail.addEventListener('change', () => {
      this.set({ ...this.get(), detail: this.detail.value as Detail });
      this.refresh();
    });
    this.element.append(pair, scaleRow, this.words, toggle, this.tileRow, detailRow);

    this.table.addEventListener('input', () => {
      const table_cm = Number(this.table.value);
      if (!(table_cm >= 10 && table_cm <= 2000) || !this.n) return;
      this.own = true;
      this.set({ ...this.get(), table_cm, width_m: Math.round((table_cm * this.n) / 100) });
      this.refresh();
    });
    this.tableH.addEventListener('input', () => {
      const height_cm = Number(this.tableH.value);
      if (!(height_cm >= 10 && height_cm <= 2000) || !this.n) return;
      this.own = true;
      this.set({ ...this.get(), height_m: Math.round((height_cm * this.n) / 100) });
      this.refresh();
    });
    this.scale.addEventListener('input', () => {
      const n = Number(this.scale.value);
      if (n >= 10) this.toScale(n, false);
    });
    this.tiled.addEventListener('change', () => {
      this.set({ ...this.get(), tile_cm: this.tiled.checked ? this.lastTile : null });
      this.refresh();
    });
    this.tile.addEventListener('input', () => {
      const tile = Number(this.tile.value);
      if (!(tile > 0)) return;
      this.lastTile = tile;
      this.set({ ...this.get(), tile_cm: tile });
      this.refresh();
    });
    this.refresh();
  }

  /** The table's tiles, when it is printed in tiles and they fit; otherwise null. */
  problem(): string | null {
    return tileProblem(this.get());
  }

  /**
   * Shows the ground and table as they now are, leaving the field being typed in alone.
   * A ground resized elsewhere (the metre fields, the map's corner) keeps the table and changes
   * the scale; the other side follows, so the ground keeps the table's shape (#580).
   */
  refresh(): void {
    let ground = this.get();
    if (this.n === null && ground.table_cm > 0 && ground.width_m > 0) this.n = Math.round(scaleOf(ground.width_m, ground.table_cm));
    const last = this.last;
    if (last && !this.own && ground.table_cm > 0 && ground.table_cm === last.table_cm) {
      const table = { width_cm: ground.table_cm, height_cm: tableHeight(last) };
      // Both sides at once come from the map's corner, which keeps the shape itself: only the
      // scale follows, so rounding never fights a drag. One side typed brings the other along.
      const both = ground.width_m !== last.width_m && ground.height_m !== last.height_m;
      const off = (want: number, have: number) => Math.abs(want - have) > Math.max(2, want * 0.01);
      // Half-typed numbers (a "2" on the way to "2000") give no scale and change nothing yet.
      if (ground.width_m !== last.width_m && ground.width_m > 0) {
        const n = Math.round((ground.width_m * 100) / table.width_cm);
        const height_m = Math.round((table.height_cm * n) / 100);
        if (n >= 10 && height_m >= 100) {
          this.n = n;
          if (!both && off(height_m, ground.height_m)) this.set((ground = { ...ground, height_m }));
        }
      } else if (ground.height_m !== last.height_m && ground.height_m > 0 && table.height_cm > 0) {
        const n = Math.round((ground.height_m * 100) / table.height_cm);
        const width_m = Math.round((table.width_cm * n) / 100);
        if (n >= 10 && width_m >= 100) {
          this.n = n;
          if (off(width_m, ground.width_m)) this.set((ground = { ...ground, width_m }));
        }
      }
    }
    this.own = false;
    this.last = ground;
    const shown = (input: HTMLInputElement, value: string) => {
      if (document.activeElement !== input) input.value = value;
    };
    shown(this.table, String(ground.table_cm));
    shown(this.tableH, ground.width_m > 0 ? String(tableHeight(ground)) : '');
    shown(this.scale, this.n ? String(this.n) : '');
    for (const chip of this.chips) chip.classList.toggle('is-pressed', Number(chip.dataset.scale) === this.n);
    this.words.textContent = scaleWords(ground);
    const tile = ground.tile_cm ?? null;
    if (tile) this.lastTile = tile;
    this.tiled.checked = tile !== null;
    this.tileRow.hidden = tile === null;
    shown(this.tile, String(tile ?? this.lastTile));
    const problem = tileProblem(ground);
    this.tileWords.className = problem ? 'wz-problem' : 'wz-hint';
    this.tileWords.setAttribute('role', problem ? 'alert' : 'status');
    this.tileWords.textContent = tile
      ? (problem ?? `${format(Math.round(ground.table_cm / tile))} × ${format(Math.round(tableHeight(ground) / tile))} tiles, ${format(Math.round(ground.table_cm / tile) * Math.round(tableHeight(ground) / tile))} to print.`)
      : '';
    this.detail.value = ground.detail ?? 'normal';
    this.detailHint.textContent = detailWords(ground);
    this.onTiles(tile && ground.table_cm > 0 ? (tile * ground.width_m) / ground.table_cm : null);
  }

  /** A new scale keeps the ground and resizes the table to show it. */
  private toScale(n: number, show = true): void {
    this.n = n;
    this.own = true;
    const ground = this.get();
    const table_cm = tenth((ground.width_m * 100) / n);
    if (table_cm >= 10 && table_cm <= 2000) this.set({ ...ground, table_cm });
    if (show) this.scale.value = String(n);
    this.refresh();
  }
}
