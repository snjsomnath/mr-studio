/**
 * What one version of the table changed (#395), in plain lines for the History panel:
 * "Wind: wind speed 5 → 8", "Added Sun study", "Name: Old → New". Pure, so it is tested alone.
 */

/** Names the editor knows: a layer package's name and a control's label and unit. */
export interface DiffNames {
  layer(use: string): string | undefined;
  control(use: string, id: string): { label: string; unit?: string; default?: unknown } | undefined;
}

type Json = Record<string, unknown>;
interface Layer {
  id?: string;
  use?: string;
  params?: Json;
  active?: boolean;
  button?: Json;
  items?: Layer[];
}

const short = (value: unknown): string => {
  if (value === undefined || value === null || value === '') return 'nothing';
  if (typeof value === 'number') return String(Number(value.toFixed(3)));
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (typeof value === 'string') return value.length > 28 ? `${value.slice(0, 27)}…` : value;
  return 'a new value';
};

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Every layer and item by its id, with the layer it sits in. */
function flatten(layers: Layer[] | undefined, into = new Map<string, Layer>()): Map<string, Layer> {
  for (const layer of layers ?? []) {
    into.set(layer.id ?? layer.use ?? '?', layer);
    flatten(layer.items, into);
  }
  return into;
}

const TOP: Record<string, string> = {
  name: 'Name',
  timezone: 'Time zone',
  table: 'the table’s size and place',
  tv: 'the controller',
  display: 'the display',
  branding: 'the welcome and languages',
  palette: 'the palette',
  data: 'the table’s data',
  custom: 'the custom layers',
  scene: 'the 3D model',
};

/** The lines that say what changed from `before` to `after` (two versions of site.json), at most `limit`. */
export function describeChange(before: Json | null, after: Json, names: DiffNames, limit = 8): string[] {
  const lines: string[] = [];
  if (!before) return ['The table as it was when it was first opened'];
  const name = (layer: Layer, id: string) => names.layer(layer.use ?? '') ?? layer.use ?? id;
  const was = flatten(before.layers as Layer[] | undefined);
  const now = flatten(after.layers as Layer[] | undefined);
  for (const [id, layer] of now) if (!was.has(id)) lines.push(`Added ${name(layer, id)}`);
  for (const [id, layer] of was) if (!now.has(id)) lines.push(`Removed ${name(layer, id)}`);
  for (const [id, layer] of now) {
    const old = was.get(id);
    if (!old) continue;
    const label = name(layer, id);
    const keys = new Set([...Object.keys(old.params ?? {}), ...Object.keys(layer.params ?? {})]);
    for (const key of keys) {
      const control = names.control(layer.use ?? '', key);
      // A setting not written down yet is at its default.
      const [a, b] = [old.params?.[key] ?? control?.default, layer.params?.[key] ?? control?.default];
      if (same(a, b)) continue;
      const unit = control?.unit && typeof b === 'number' ? ` ${control.unit}` : '';
      lines.push(`${label}: ${control?.label.toLowerCase() ?? key} ${short(a)} → ${short(b)}${unit}`);
    }
    if (Boolean(old.active) !== Boolean(layer.active)) lines.push(`${label}: starts ${layer.active ? 'on' : 'off'}`);
    if (!same(old.button, layer.button)) lines.push(`${label}: its button`);
  }
  const was_order = [...was.keys()].filter((id) => now.has(id));
  const now_order = [...now.keys()].filter((id) => was.has(id));
  if (lines.length === 0 && !same(was_order, now_order)) lines.push('The order of the layers');
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === 'layers' || same(before[key], after[key])) continue;
    const label = TOP[key] ?? key;
    const [a, b] = [before[key], after[key]];
    lines.push(typeof a === 'object' || typeof b === 'object' ? `Changed ${label}` : `${label}: ${short(a)} → ${short(b)}`);
  }
  if (lines.length > limit) return [...lines.slice(0, limit - 1), `and ${lines.length - limit + 1} more changes`];
  return lines.length ? lines : ['No visible change'];
}
