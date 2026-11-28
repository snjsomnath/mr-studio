// A panel's numbers straight from a table dataset (#670): name a CSV or GeoJSON file of the site
// and reduce it, with no layer and no code. Written as data, like the expressions it uses for
// `where` and `at` (#669):
//
//   { "data": "energy", "sum": "kwh", "where": [">=", ["get", "year"], 2020], "group_by": "building" }
//
// The file is read once, in the data worker when there is one (site-geometry.ts); reducing it is
// one pass over the rows on the page, and the result is kept until a value it reads changes.

import { parseCsv } from './blocks/sources.ts';
import { compileExpression, expression } from './expression.ts';
import type { Expression, ExpressionScope } from './expression.ts';

/** How the rows become one number: a column's sum, average, smallest or largest value, the rows counted, or the newest row's value. */
export const DATA_REDUCTIONS = ['sum', 'average', 'min', 'max', 'count', 'latest'] as const;
export type DataReduction = (typeof DATA_REDUCTIONS)[number];

/** The order of a grouped list: biggest first (the default), smallest first, or by name (time and other ordered names). */
export const DATA_ORDERS = ['highest', 'lowest', 'name'] as const;

export interface DataQuery {
  /** The dataset's name in site.json `data`, or a CSV or GeoJSON file's path in the site folder. */
  data: string;
  /** A column to add up. Exactly one of sum, average, min, max, count and latest is given. */
  sum?: string;
  average?: string;
  min?: string;
  max?: string;
  /** `true` counts the rows; a column name counts the rows where it has a value. */
  count?: true | string;
  /** The value of this column in the last row, or with `time`, in the row nearest before `at`. */
  latest?: string;
  /** Only rows for which this expression is true. `["get", "col"]` reads the row, `["bind", ...]` the live values. */
  where?: Expression;
  /** One value per distinct value of this column, as a list of `{ label, value }` for bars, a list or a donut. */
  group_by?: string;
  /** With group_by: the order of the list. */
  order?: (typeof DATA_ORDERS)[number];
  /** A column holding time (an hour, a year, a step): only rows at or before `at` count. */
  time?: string;
  /** Where the time is now, usually the shared play head: `["bind", "params.hour"]`. */
  at?: Expression;
}

export type DataRow = Readonly<Record<string, unknown>>;
export type DataResult = number | string | { label: string; value: number }[] | null;

const KEYS = new Set(['data', ...DATA_REDUCTIONS, 'where', 'group_by', 'order', 'time', 'at']);

/** Whether a prop is a data query: an object with `data`. */
export function isDataQuery(value: unknown): value is DataQuery {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as DataQuery).data === 'string';
}

/** The reduction a query asks for, and its column (null for a plain count). */
export function queryReduction(query: DataQuery): { reduce: DataReduction; column: string | null } | null {
  const given = DATA_REDUCTIONS.filter((key) => query[key] !== undefined);
  if (given.length !== 1) return null;
  const reduce = given[0]!;
  const column = query[reduce];
  return { reduce, column: typeof column === 'string' ? column : null };
}

/** What is wrong with a query; empty when it is fine. The live values it reads are in `reads`. */
export function dataQueryProblems(query: DataQuery): { problems: string[]; reads: string[] } {
  const problems: string[] = [];
  const reads: string[] = [];
  for (const key of Object.keys(query)) if (!KEYS.has(key)) problems.push(`'${key}' is not part of a data query (${[...KEYS].join(', ')})`);
  if (!query.data.trim()) problems.push('data: name a dataset of the table, or a .csv or .geojson file in the site folder');
  const given = DATA_REDUCTIONS.filter((key) => query[key] !== undefined);
  if (given.length !== 1) problems.push(`give exactly one of ${DATA_REDUCTIONS.join(', ')}${given.length ? `, not ${given.join(' and ')}` : ''}`);
  for (const key of given) {
    const column = query[key];
    if (key === 'count' ? column !== true && (typeof column !== 'string' || !column) : typeof column !== 'string' || !column) {
      problems.push(key === 'count' ? 'count: true, or a column name' : `${key}: a column name`);
    }
  }
  if (query.latest !== undefined && query.group_by !== undefined && query.time === undefined) problems.push('latest with group_by needs time, to know which row is the latest in each group');
  for (const key of ['group_by', 'time'] as const) if (query[key] !== undefined && (typeof query[key] !== 'string' || !query[key])) problems.push(`${key}: a column name`);
  if (query.order !== undefined && !(DATA_ORDERS as readonly string[]).includes(query.order)) problems.push(`order: one of ${DATA_ORDERS.join(', ')}`);
  if (query.order !== undefined && query.group_by === undefined) problems.push('order only applies with group_by');
  if ((query.time === undefined) !== (query.at === undefined)) problems.push('time and at go together: the time column, and where the time is now');
  for (const key of ['where', 'at'] as const) {
    if (query[key] === undefined) continue;
    const compiled = compileExpression(query[key]);
    for (const problem of compiled.problems) problems.push(`${key}: ${problem}`);
    reads.push(...compiled.reads.values);
  }
  return { problems, reads };
}

const number = (value: unknown): number | null => {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

function reduceRows(rows: readonly DataRow[], reduce: DataReduction, column: string | null, time: string | undefined): number | string | null {
  if (reduce === 'count') return column === null ? rows.length : rows.filter((row) => row[column] !== undefined && row[column] !== null && row[column] !== '').length;
  if (reduce === 'latest') {
    let best: DataRow | undefined;
    let bestTime = -Infinity;
    for (const row of rows) {
      if (!time) best = row;
      else {
        const t = number(row[time]);
        if (t !== null && t >= bestTime) [best, bestTime] = [row, t];
      }
    }
    const value = best?.[column!];
    return typeof value === 'number' || typeof value === 'string' ? value : null;
  }
  let total = 0;
  let count = 0;
  let low = Infinity;
  let high = -Infinity;
  for (const row of rows) {
    const value = number(row[column!]);
    if (value === null) continue;
    total += value;
    count += 1;
    if (value < low) low = value;
    if (value > high) high = value;
  }
  if (count === 0) return reduce === 'sum' ? 0 : null;
  return reduce === 'sum' ? total : reduce === 'average' ? total / count : reduce === 'min' ? low : high;
}

/**
 * Runs a query over a dataset's rows. `vars` are the live values `where` and `at` read. A faulty
 * query gives null, like a faulty expression: an empty value, never a broken screen.
 */
export function runDataQuery(rows: readonly DataRow[], query: DataQuery, vars: ExpressionScope['vars'] = {}): DataResult {
  const how = queryReduction(query);
  if (!how || dataQueryProblems(query).problems.length) return null;
  let kept: readonly DataRow[] = rows;
  if (query.where !== undefined) {
    const where = expression(query.where);
    kept = kept.filter((row) => where.evaluate({ item: row, vars }) === true);
  }
  if (query.time !== undefined) {
    const at = number(expression(query.at).evaluate({ vars }));
    const time = query.time;
    kept = at === null ? [] : kept.filter((row) => {
      const t = number(row[time]);
      return t !== null && t <= at;
    });
  }
  if (query.group_by === undefined) return reduceRows(kept, how.reduce, how.column, query.time);
  const groups = new Map<string, DataRow[]>();
  for (const row of kept) {
    const key = row[query.group_by];
    if (key === undefined || key === null || key === '') continue;
    const name = String(key);
    let group = groups.get(name);
    if (!group) groups.set(name, (group = []));
    group.push(row);
  }
  const list: { label: string; value: number }[] = [];
  for (const [label, group] of groups) {
    const value = number(reduceRows(group, how.reduce, how.column, query.time));
    if (value !== null) list.push({ label, value });
  }
  const order = query.order ?? 'highest';
  const collator = new Intl.Collator(undefined, { numeric: true });
  list.sort((a, b) => (order === 'highest' ? b.value - a.value : order === 'lowest' ? a.value - b.value : collator.compare(a.label, b.label)));
  return list;
}

/** A GeoJSON file's features as rows (their properties), or a CSV's rows, from the file's text. */
export function rowsOf(text: string, csv: boolean): DataRow[] {
  if (csv) return parseCsv(text);
  const parsed = JSON.parse(text) as { type?: string; features?: { properties?: Record<string, unknown> | null }[] };
  if (parsed?.type !== 'FeatureCollection' || !Array.isArray(parsed.features)) throw new Error('not a CSV or a GeoJSON FeatureCollection');
  return parsed.features.map((feature) => feature.properties ?? {});
}
