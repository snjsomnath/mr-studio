// Safe expressions (#669): the bit of logic a table needs without writing code. A small formula
// language in JSON, in the spirit of MapLibre's style expressions: `["/", ["get", "kwh"],
// ["get", "area"]]` is a building's use per square metre. It is data, so it travels in the
// table's files, the MCP can write it, and it can never reach anything but the values it is given:
// there are no loops, no functions and no way out. Every surface evaluates it the same way.
//
// An expression is a literal (a number, text, true, false or null) or a list whose first item
// names the operator. A list as a value is written `["literal", [1, 2, 3]]`.

/** An expression: a literal, or `[operator, ...arguments]`. */
export type Expression = number | string | boolean | null | readonly [string, ...unknown[]];

/** What an expression reads: the feature or row it is about, and the layer's live values. */
export interface ExpressionScope {
  /** The feature's properties or the row: `["get", "kwh"]`. Dotted names reach inside (`ecom.kwh`). */
  item?: Readonly<Record<string, unknown>>;
  /** The live values: `["bind", "shared.import_kw"]`, `params.year`, `site.name`. */
  vars?: Readonly<{ params?: Record<string, unknown>; shared?: Record<string, unknown>; site?: Record<string, unknown> }>;
}

/** A panel prop or look setting worked out by an expression: `{ "expr": [...] }`. */
export interface ExpressionValue {
  expr: Expression;
}

/** How deep an expression may nest, and how many parts it may have, so it is always cheap. */
export const EXPRESSION_LIMITS = { depth: 24, nodes: 500 } as const;

type Fn = (scope: ExpressionScope) => unknown;

interface Operator {
  /** How many arguments: at least, and at most (Infinity for any). */
  args: [number, number];
  /** Builds the evaluator from its compiled arguments. `raw` is the expression's own arguments. */
  make(args: Fn[], raw: unknown[], path: string, problems: string[]): Fn;
  /** Arguments that are not expressions but plain values (a name, a list of labels). */
  plain?: (index: number, count: number) => boolean;
  /** One line for the docs and the MCP. */
  help: string;
}

const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  return null;
};
const finite = (v: number): number | null => (Number.isFinite(v) ? v : null);
const truthy = (v: unknown): boolean => v !== null && v !== undefined && v !== false && v !== 0 && v !== '';

function readPath(record: unknown, path: string): unknown {
  if (typeof record !== 'object' || record === null) return undefined;
  const direct = (record as Record<string, unknown>)[path];
  if (direct !== undefined || !path.includes('.')) return direct;
  let value: unknown = record;
  for (const key of path.split('.')) {
    if (typeof value !== 'object' || value === null) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

const HEX = /^#([0-9a-f]{6})$/i;
function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (shift: number) => Math.round(((pa >> shift) & 255) * (1 - t) + ((pb >> shift) & 255) * t);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`;
}

/** Math on numbers: anything that is not a number makes the answer null. */
function math(args: [number, number], help: string, op: (...n: number[]) => number): Operator {
  return {
    args,
    help,
    make: (fns) => (scope) => {
      const values: number[] = [];
      for (const fn of fns) {
        const n = num(fn(scope));
        if (n === null) return null;
        values.push(n);
      }
      return finite(op(...values));
    },
  };
}

function compare(help: string, op: (a: number | string, b: number | string) => boolean): Operator {
  return {
    args: [2, 2],
    help,
    make:
      ([a, b]) =>
      (scope) => {
        const [x, y] = [a!(scope), b!(scope)];
        if (x === null || x === undefined || y === null || y === undefined) return false;
        const [nx, ny] = [num(x), num(y)];
        return nx !== null && ny !== null ? op(nx, ny) : op(String(x), String(y));
      },
  };
}

const OPERATORS: Record<string, Operator> = {
  literal: { args: [1, 1], help: 'a value as it is, such as a list: ["literal", [1, 2]]', plain: () => true, make: (_fns, [value]) => () => value },
  get: {
    args: [1, 1],
    help: 'a property of the feature or row: ["get", "kwh"]; dotted names reach inside',
    plain: () => true,
    make: (_fns, [name], path, problems) => {
      if (typeof name !== 'string' || !name) problems.push(`${path}: "get" takes a property name`);
      return (scope) => readPath(scope.item, String(name)) ?? null;
    },
  },
  has: {
    args: [1, 1],
    help: 'whether the feature or row has the property: ["has", "kwh"]',
    plain: () => true,
    make: (_fns, [name]) => (scope) => {
      const v = readPath(scope.item, String(name));
      return v !== undefined && v !== null && v !== '';
    },
  },
  bind: {
    args: [1, 1],
    help: 'a live value of the layer: ["bind", "shared.import_kw"], params.<control> or site.<field>',
    plain: () => true,
    make: (_fns, [name], path, problems) => {
      const text = String(name);
      if (!/^(params|shared|site)\.[^.]/.test(text)) problems.push(`${path}: "bind" reads params.<name>, shared.<name> or site.<name>`);
      return (scope) => readPath(scope.vars, text) ?? null;
    },
  },

  '+': math([1, Infinity], 'adds numbers', (...n) => n.reduce((a, b) => a + b, 0)),
  '-': math([1, 2], 'subtracts, or makes one number negative', (a, b) => (b === undefined ? -a : a - b)),
  '*': math([1, Infinity], 'multiplies numbers', (...n) => n.reduce((a, b) => a * b, 1)),
  '/': math([2, 2], 'divides; by zero is null', (a, b) => (b === 0 ? NaN : a / b)),
  '%': math([2, 2], 'the remainder', (a, b) => (b === 0 ? NaN : a % b)),
  '^': math([2, 2], 'a power', (a, b) => a ** b),
  min: math([1, Infinity], 'the smallest', (...n) => Math.min(...n)),
  max: math([1, Infinity], 'the largest', (...n) => Math.max(...n)),
  abs: math([1, 1], 'without its sign', Math.abs),
  floor: math([1, 1], 'rounded down', Math.floor),
  ceil: math([1, 1], 'rounded up', Math.ceil),
  sqrt: math([1, 1], 'the square root', Math.sqrt),
  ln: math([1, 1], 'the natural logarithm', Math.log),
  log10: math([1, 1], 'the logarithm to base 10', Math.log10),
  round: math([1, 2], 'rounded, to a number of decimals if given: ["round", x, 1]', (a, d = 0) => {
    const f = 10 ** Math.max(0, Math.min(6, Math.round(d)));
    return Math.round(a * f) / f;
  }),
  clamp: math([3, 3], 'held between a low and a high: ["clamp", x, 0, 1]', (x, lo, hi) => Math.min(Math.max(x, lo), hi)),

  '==': {
    args: [2, 2],
    help: 'equal (numbers as numbers, the rest as text)',
    make:
      ([a, b]) =>
      (scope) => {
        const [x, y] = [a!(scope), b!(scope)];
        if (x === null || y === null || x === undefined || y === undefined) return (x ?? null) === (y ?? null);
        const [nx, ny] = [num(x), num(y)];
        return nx !== null && ny !== null && typeof x !== 'boolean' && typeof y !== 'boolean' ? nx === ny : String(x) === String(y);
      },
  },
  '!=': {
    args: [2, 2],
    help: 'not equal',
    make: (fns, raw, path, problems) => {
      const eq = OPERATORS['==']!.make(fns, raw, path, problems);
      return (scope) => !eq(scope);
    },
  },
  '<': compare('less than', (a, b) => a < b),
  '<=': compare('at most', (a, b) => a <= b),
  '>': compare('more than', (a, b) => a > b),
  '>=': compare('at least', (a, b) => a >= b),
  all: { args: [1, Infinity], help: 'true when every part is', make: (fns) => (scope) => fns.every((fn) => truthy(fn(scope))) },
  any: { args: [1, Infinity], help: 'true when any part is', make: (fns) => (scope) => fns.some((fn) => truthy(fn(scope))) },
  '!': { args: [1, 1], help: 'not', make: ([a]) => (scope) => !truthy(a!(scope)) },

  case: {
    args: [3, Infinity],
    help: 'the first answer whose test holds, else the last: ["case", test, answer, ..., otherwise]',
    make: (fns, _raw, path, problems) => {
      if (fns.length % 2 === 0) problems.push(`${path}: "case" takes pairs of a test and an answer, then what to give otherwise`);
      return (scope) => {
        for (let i = 0; i + 1 < fns.length; i += 2) if (truthy(fns[i]!(scope))) return fns[i + 1]!(scope);
        return fns[fns.length - 1]!(scope);
      };
    },
  },
  match: {
    args: [4, Infinity],
    help: 'the answer for the value: ["match", value, "A", answer, ["B", "C"], answer, otherwise]',
    plain: (i, count) => i > 0 && i % 2 === 1 && i < count - 1,
    make: (fns, raw, path, problems) => {
      if (raw.length % 2 !== 0) problems.push(`${path}: "match" takes a value, then pairs of labels and an answer, then what to give otherwise`);
      const labels: Set<string>[] = [];
      for (let i = 1; i + 1 < raw.length; i += 2) labels.push(new Set((Array.isArray(raw[i]) ? (raw[i] as unknown[]) : [raw[i]]).map(String)));
      return (scope) => {
        const value = String(fns[0]!(scope));
        for (let k = 0; k < labels.length; k++) if (labels[k]!.has(value)) return fns[2 + k * 2]!(scope);
        return fns[fns.length - 1]!(scope);
      };
    },
  },
  coalesce: {
    args: [1, Infinity],
    help: 'the first part that has a value',
    make: (fns) => (scope) => {
      for (const fn of fns) {
        const v = fn(scope);
        if (v !== null && v !== undefined && v !== '') return v;
      }
      return null;
    },
  },

  interpolate: {
    args: [4, Infinity],
    help: 'a smooth value between stops: ["interpolate", ["linear"], x, 0, "#2b83ba", 100, "#d7191c"] (numbers or #rrggbb colours)',
    plain: (i) => i === 0 || (i >= 2 && i % 2 === 0),
    make: (fns, raw, path, problems) => {
      const kind = raw[0];
      const base = Array.isArray(kind) && kind[0] === 'exponential' ? Number(kind[1]) : 1;
      if (!Array.isArray(kind) || (kind[0] !== 'linear' && kind[0] !== 'exponential')) problems.push(`${path}: "interpolate" starts with ["linear"] or ["exponential", base]`);
      const stops: number[] = [];
      for (let i = 2; i < raw.length; i += 2) stops.push(Number(raw[i]));
      if (raw.length % 2 !== 0 || stops.length < 1) problems.push(`${path}: "interpolate" takes a value, then pairs of a stop and an answer`);
      if (stops.some((s, i) => !Number.isFinite(s) || (i > 0 && s <= stops[i - 1]!))) problems.push(`${path}: "interpolate" stops are numbers, lowest first`);
      const outs = fns.slice(2).filter((_, i) => i % 2 === 1);
      return (scope) => {
        const x = num(fns[1]!(scope));
        if (x === null) return null;
        if (x <= stops[0]!) return outs[0]!(scope);
        for (let i = 1; i < stops.length; i++) {
          if (x <= stops[i]!) {
            const [s0, s1] = [stops[i - 1]!, stops[i]!];
            const t = base === 1 ? (x - s0) / (s1 - s0) : (base ** (x - s0) - 1) / (base ** (s1 - s0) - 1);
            const [a, b] = [outs[i - 1]!(scope), outs[i]!(scope)];
            if (typeof a === 'string' && typeof b === 'string' && HEX.test(a) && HEX.test(b)) return mixHex(a, b, t);
            const [na, nb] = [num(a), num(b)];
            return na !== null && nb !== null ? na + (nb - na) * t : t < 0.5 ? a : b;
          }
        }
        return outs[outs.length - 1]!(scope);
      };
    },
  },
  step: {
    args: [2, Infinity],
    help: 'steps at stops: ["step", x, below, 10, from10, 20, from20]',
    plain: (i) => i >= 2 && i % 2 === 0,
    make: (fns, raw, path, problems) => {
      const stops: number[] = [];
      for (let i = 2; i < raw.length; i += 2) stops.push(Number(raw[i]));
      if (raw.length % 2 !== 0) problems.push(`${path}: "step" takes a value, what to give below the first stop, then pairs of a stop and an answer`);
      if (stops.some((s, i) => !Number.isFinite(s) || (i > 0 && s <= stops[i - 1]!))) problems.push(`${path}: "step" stops are numbers, lowest first`);
      const outs = [fns[1]!, ...fns.slice(2).filter((_, i) => i % 2 === 1)];
      return (scope) => {
        const x = num(fns[0]!(scope));
        if (x === null) return null;
        let k = 0;
        while (k < stops.length && x >= stops[k]!) k++;
        return outs[k]!(scope);
      };
    },
  },

  concat: { args: [1, Infinity], help: 'joins text', make: (fns) => (scope) => fns.map((fn) => fn(scope) ?? '').join('') },
  'to-string': { args: [1, 1], help: 'as text', make: ([a]) => (scope) => String(a!(scope) ?? '') },
  'to-number': { args: [1, 1], help: 'as a number, or null', make: ([a]) => (scope) => num(a!(scope)) },
  upcase: { args: [1, 1], help: 'in capitals', make: ([a]) => (scope) => String(a!(scope) ?? '').toUpperCase() },
  downcase: { args: [1, 1], help: 'in small letters', make: ([a]) => (scope) => String(a!(scope) ?? '').toLowerCase() },
  length: {
    args: [1, 1],
    help: 'how many letters, or items in a list',
    make:
      ([a]) =>
      (scope) => {
        const v = a!(scope);
        return Array.isArray(v) ? v.length : typeof v === 'string' ? [...v].length : null;
      },
  },
  in: {
    args: [2, 2],
    help: 'whether a value is in a list or a text: ["in", ["get", "use"], ["literal", ["school", "office"]]]',
    make:
      ([needle, hay]) =>
      (scope) => {
        const [n, h] = [needle!(scope), hay!(scope)];
        if (Array.isArray(h)) return h.map(String).includes(String(n));
        return typeof h === 'string' && n !== null && n !== undefined ? h.includes(String(n)) : false;
      },
  },
};

/** The operators, with one line on each, for the docs, the editor and the MCP. */
export const EXPRESSION_OPERATORS: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(OPERATORS).map(([name, op]) => [name, op.help]));

/** A compiled expression: evaluate it as often as needed. It never throws. */
export interface CompiledExpression {
  evaluate(scope?: ExpressionScope): unknown;
  /** What is wrong with it; empty when it is fine. A faulty expression evaluates to null. */
  problems: string[];
  /** The feature properties it reads with `get` or `has`, and the live values it reads with `bind`. */
  reads: { properties: string[]; values: string[] };
}

/**
 * Checks and compiles an expression. A faulty one comes back with its problems and evaluates to
 * null, so a mistake shows as an empty value and a message, never as a broken table.
 */
export function compileExpression(expr: unknown): CompiledExpression {
  const problems: string[] = [];
  const reads = { properties: new Set<string>(), values: new Set<string>() };
  let nodes = 0;
  const build = (node: unknown, path: string, depth: number): Fn => {
    nodes += 1;
    if (nodes === EXPRESSION_LIMITS.nodes + 1) problems.push(`the expression has more than ${EXPRESSION_LIMITS.nodes} parts`);
    if (depth > EXPRESSION_LIMITS.depth) {
      problems.push(`${path}: nested more than ${EXPRESSION_LIMITS.depth} deep`);
      return () => null;
    }
    if (node === null || typeof node === 'number' || typeof node === 'string' || typeof node === 'boolean') {
      if (typeof node === 'number' && !Number.isFinite(node)) problems.push(`${path}: not a number`);
      return () => node;
    }
    if (!Array.isArray(node) || node.length === 0 || typeof node[0] !== 'string') {
      problems.push(`${path}: an expression is a number, a text, true, false, null or ["operator", ...]; write a list as ["literal", [...]]`);
      return () => null;
    }
    const [name, ...raw] = node as [string, ...unknown[]];
    const op = Object.prototype.hasOwnProperty.call(OPERATORS, name) ? OPERATORS[name]! : undefined;
    if (!op) {
      problems.push(`${path}: "${name}" is not an operator (${Object.keys(OPERATORS).join(', ')})`);
      return () => null;
    }
    if (raw.length < op.args[0] || raw.length > op.args[1]) {
      const [lo, hi] = op.args;
      problems.push(`${path}: "${name}" takes ${lo === hi ? lo : hi === Infinity ? `at least ${lo}` : `${lo} to ${hi}`} argument${hi === 1 ? '' : 's'}, not ${raw.length}`);
      return () => null;
    }
    if ((name === 'get' || name === 'has') && typeof raw[0] === 'string') reads.properties.add(raw[0]);
    if (name === 'bind' && typeof raw[0] === 'string') reads.values.add(raw[0]);
    const fns = raw.map((arg, i) => (op.plain?.(i, raw.length) ? () => arg : build(arg, `${path}[${i + 1}]`, depth + 1)));
    return op.make(fns, raw, `${path}`, problems);
  };
  const root = build(expr, 'expr', 0);
  const ok = problems.length === 0;
  return {
    problems,
    reads: { properties: [...reads.properties], values: [...reads.values] },
    evaluate(scope: ExpressionScope = {}) {
      if (!ok) return null;
      try {
        const value = root(scope);
        return value === undefined ? null : value;
      } catch {
        return null;
      }
    },
  };
}

/** Whether a value is `{ "expr": ... }`. */
export function isExpressionValue(value: unknown): value is ExpressionValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'expr' in value && Object.keys(value).length === 1;
}

const cache = new Map<string, CompiledExpression>();
/** Compiles once per distinct expression, so evaluating per frame or per feature costs nothing more. */
export function expression(expr: unknown): CompiledExpression {
  const key = JSON.stringify(expr) ?? 'null';
  let found = cache.get(key);
  if (!found) {
    if (cache.size > 500) cache.clear();
    found = compileExpression(expr);
    cache.set(key, found);
  }
  return found;
}

/** Evaluates an expression once: for a value read now and then, not per feature. */
export function evaluateExpression(expr: unknown, scope?: ExpressionScope): unknown {
  return expression(expr).evaluate(scope);
}
