/**
 * What each column of a dataset holds (#52), worked out as it comes in, so the author sees how
 * MR Studio will read it before anything is made from it: the one that names each row, the
 * values to colour or size by, kinds to group by, when each row happens, and where it is.
 * Plain data with no page code, so the tests can read it.
 */

export type ColumnRole = 'id' | 'time' | 'value' | 'category' | 'place' | 'text';

export interface ColumnReading {
  name: string;
  role: ColumnRole;
}

/** How each role reads to an author, for the import report. */
export const ROLE_WORDS: Record<ColumnRole, string> = {
  id: 'names each row',
  time: 'when',
  value: 'a value',
  category: 'kinds',
  place: 'where',
  text: 'text',
};

const PLACE = /^(lat|lon|lng|long|latitude|longitude|x|y|easting|northing)$/i;
const TIME = /(^|[_\s-])(year|date|time|hour|day|month|week|when|timestamp|datetime)($|[_\s-])/i;
/** One column of a series through time: pop_1990, noise_2030, 2020. */
const SERIES = /(^|[_\s-])(1[89]\d\d|2[01]\d\d)$/;
const ID = /(^|[_\s-])(id|code|key|ref|zone|name|nr|no)($|[_\s-])/i;
const ISO_DATE = /^\d{4}-\d{2}(-\d{2})?([T ]\d{2}:\d{2}(:\d{2})?)?/;

function filled(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

/** Reads every column of `rows` (the first 500 are enough), in the order they first appear. */
export function columnRoles(rows: readonly (Record<string, unknown> | null | undefined)[]): ColumnReading[] {
  const sample = rows.slice(0, 500).filter((r): r is Record<string, unknown> => Boolean(r));
  const names: string[] = [];
  for (const row of sample) for (const key of Object.keys(row)) if (!names.includes(key)) names.push(key);
  const out: ColumnReading[] = [];
  for (const name of names) {
    const values = sample.map((r) => r[name]).filter(filled);
    if (values.length === 0 || values.some((v) => typeof v === 'object')) continue;
    const numbers = values.map(Number).filter(Number.isFinite);
    const numeric = numbers.length === values.length;
    const distinct = new Set(values.map(String)).size;
    let role: ColumnRole;
    if (PLACE.test(name) && numeric) role = 'place';
    else if (TIME.test(name) || SERIES.test(name) || values.every((v) => typeof v === 'string' && ISO_DATE.test(v))) role = 'time';
    else if (distinct === values.length && values.length > 1 && (ID.test(name) || !numeric)) role = 'id';
    else if (numeric && distinct > 2) role = 'value';
    else if (distinct <= 40) role = 'category';
    else role = 'text';
    out.push({ name, role });
  }
  return out;
}
