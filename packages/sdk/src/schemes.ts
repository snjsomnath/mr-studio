// Category schemes (#207): colours a category already has outside MR Studio, which a layer
// uses instead of the table palette. Energy classes are green A to red G everywhere, so an
// EPC map coloured with the palette's category colours, in file order, cannot be read.

export interface CategoryScheme {
  id: string;
  label: string;
  /** The categories in order, with their colours. */
  classes: { value: string; color: string }[];
  /** A value as the scheme spells it, or null when it is not one of the scheme's. */
  normalise(value: unknown): string | null;
}

/** EU energy performance classes, as on the label. */
const EPC: CategoryScheme = {
  id: 'epc',
  label: 'Energy classes (A to G)',
  classes: [
    { value: 'A', color: '#00a651' },
    { value: 'B', color: '#50b848' },
    { value: 'C', color: '#bed630' },
    { value: 'D', color: '#fff200' },
    { value: 'E', color: '#fdb913' },
    { value: 'F', color: '#f37021' },
    { value: 'G', color: '#ed1c24' },
  ],
  normalise(value) {
    if (value === null || value === undefined) return null;
    // "A", " b", "Class C", "Energiklass D", "energy class e".
    const m = /^(?:(?:energy\s*)?class|energiklass|klass)?\s*([a-g])\s*$/i.exec(String(value).trim());
    return m ? m[1]!.toUpperCase() : null;
  },
};

const MISSING = /^(?:|-+|\?|n\/?a|none|null|unknown|okänd|saknas|ej\s+angiven|not\s+rated)$/i;

export const CATEGORY_SCHEMES: readonly CategoryScheme[] = [EPC];

export function categoryScheme(id: string | null | undefined): CategoryScheme | null {
  return CATEGORY_SCHEMES.find((s) => s.id === id) ?? null;
}

/** The scheme every non-empty value belongs to, if any: what a layer is offered without asking. */
export function schemeFor(values: readonly unknown[]): CategoryScheme | null {
  // "Unknown", "N/A", "saknas" and the like mean no class yet; they go to Others, not against the scheme.
  const present = values.filter((v) => v !== null && v !== undefined && !MISSING.test(String(v).trim()));
  if (present.length < 2) return null;
  return CATEGORY_SCHEMES.find((s) => present.every((v) => s.normalise(v) !== null)) ?? null;
}

/** A value's colour in a scheme, or null when the value is not one of its classes. */
export function schemeColour(scheme: CategoryScheme, value: unknown): string | null {
  const v = scheme.normalise(value);
  return v === null ? null : (scheme.classes.find((c) => c.value === v)?.color ?? null);
}

/** Values sorted in the scheme's order (A before B), values outside it last, in their own order. */
export function schemeOrder(scheme: CategoryScheme, values: readonly string[]): string[] {
  const rank = (v: string) => {
    const n = scheme.normalise(v);
    const i = n === null ? -1 : scheme.classes.findIndex((c) => c.value === n);
    return i < 0 ? scheme.classes.length : i;
  };
  return values.map((v, i) => [v, i] as const).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([v]) => v);
}

/**
 * Which scheme a layer uses: `palette` turns schemes off, a scheme's id picks it, and
 * `auto` (or nothing) picks the one every value belongs to.
 */
export function pickScheme(setting: string | null | undefined, values: readonly unknown[]): CategoryScheme | null {
  if (setting === 'palette') return null;
  return categoryScheme(setting) ?? (setting && setting !== 'auto' ? null : schemeFor(values));
}
