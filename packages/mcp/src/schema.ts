// The shape of site.json as the app reads it (#537): docs/contracts/site.schema.json, written by
// mrs-site from its own types (`site_schema()`), so the MCP server and the app agree on every key
// and every value's type. A small checker for the part of JSON Schema that schemars writes; the
// rules that are not shape (ids, ranges, files) stay in site.ts, and `mrstudio validate` is run as
// well when the app is found.

import type { SiteSchema } from './core.ts';
import type { Issue } from './site.ts';

/** The part of JSON Schema that schemars writes for site.json. */
interface SchemaObject {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  anyOf?: Schema[];
  oneOf?: Schema[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: Schema;
  propertyNames?: { pattern?: string };
  items?: Schema;
  prefixItems?: Schema[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  description?: string;
}
type Schema = boolean | SchemaObject;
/** docs/contracts/site.schema.json, as the catalog read it. */
export type JsonSchema = SchemaObject & { $defs?: Record<string, Schema> };

let ROOT: JsonSchema = {};

function resolveRef(schema: Schema): Schema {
  let at = schema;
  for (let hops = 0; typeof at === 'object' && typeof at.$ref === 'string' && hops < 32; hops++) {
    const name = at.$ref.replace(/^#\/\$defs\//, '');
    at = ROOT.$defs?.[name] ?? true;
  }
  return at;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function typeMatches(want: string, value: unknown): boolean {
  const got = typeOf(value);
  return want === got || (want === 'number' && got === 'integer');
}

const join = (path: string, key: string | number) => (typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key);

const TYPE_WORDS: Record<string, string> = {
  string: 'text',
  number: 'a number',
  integer: 'a whole number',
  boolean: 'true or false',
  object: 'an object',
  array: 'a list',
  null: 'null',
};

/** The patterns schemars writes for site.json, in words. */
function patternWords(pattern: string): string {
  if (pattern.startsWith('^[a-z0-9-]')) return 'must be lower-case letters, digits and dashes, at most 40';
  if (pattern.startsWith('^#[0-9a-fA-F]{6}')) return 'must be a colour as #rrggbb';
  return `does not match ${pattern}`;
}

/** What a value must be, in words, for an error message. */
function expected(schema: Schema): string {
  const s = resolveRef(schema);
  if (typeof s !== 'object') return 'something else';
  if (Array.isArray(s.enum)) return `one of ${s.enum.map((v: unknown) => JSON.stringify(v)).join(', ')}`;
  if ('const' in s) return JSON.stringify(s.const);
  const types = ([] as string[]).concat(s.type ?? []).filter((t) => t !== 'null');
  if (types.length) return types.map((t) => TYPE_WORDS[t] ?? t).join(' or ');
  // Option<T> is anyOf [T, null]: null goes without saying. A choice of words is one list.
  const options = (s.anyOf ?? s.oneOf)?.filter((o) => {
    const r = resolveRef(o);
    return !(typeof r === 'object' && r.type === 'null');
  });
  if (options?.length) {
    const words = options.flatMap((o) => {
      const r = resolveRef(o);
      return typeof r === 'object' && 'const' in r ? [r.const] : typeof r === 'object' && Array.isArray(r.enum) ? r.enum : [];
    });
    if (words.length >= options.length) return `one of ${words.map((v: unknown) => JSON.stringify(v)).join(', ')}`;
    return [...new Set(options.map(expected))].join(' or ');
  }
  return 'something else';
}

/** The errors in `value` against `schema`, at `path`. Stops at the first error in a branch. */
function check(value: unknown, schema: Schema, path: string, out: Issue[]): void {
  const s = resolveRef(schema);
  if (s === true) return;
  if (s === false) {
    out.push({ level: 'error', path, message: 'is not allowed here' });
    return;
  }
  const options = s.anyOf ?? s.oneOf;
  if (options) {
    const tries = options.map((option) => {
      const found: Issue[] = [];
      check(value, option, path, found);
      return found;
    });
    if (tries.some((found) => found.length === 0)) {
      // Constraints beside the anyOf still apply.
    } else {
      // The option whose errors go deepest is most likely the one meant.
      const best = tries.reduce((a, b) => (Math.max(0, ...b.map((i) => i.path.length)) > Math.max(0, ...a.map((i) => i.path.length)) ? b : a));
      const deep = best.some((i) => i.path !== path);
      if (deep) out.push(...best);
      else out.push({ level: 'error', path, message: `must be ${expected(s)}` });
      return;
    }
  }
  if (s.type !== undefined) {
    const types = ([] as string[]).concat(s.type);
    if (!types.some((t) => typeMatches(t, value))) {
      out.push({
        level: 'error',
        path,
        message: `must be ${expected(s)}, not ${TYPE_WORDS[typeOf(value)] ?? typeOf(value)}`,
      });
      return;
    }
  }
  if (Array.isArray(s.enum) && !s.enum.some((v: unknown) => JSON.stringify(v) === JSON.stringify(value))) {
    out.push({ level: 'error', path, message: `must be ${expected(s)}` });
    return;
  }
  if ('const' in s && JSON.stringify(s.const) !== JSON.stringify(value)) {
    out.push({
      level: 'error',
      path,
      message: `must be ${JSON.stringify(s.const)}`,
    });
    return;
  }
  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum)
      out.push({
        level: 'error',
        path,
        message: `must be at least ${s.minimum}`,
      });
    if (typeof s.maximum === 'number' && value > s.maximum)
      out.push({
        level: 'error',
        path,
        message: `must be at most ${s.maximum}`,
      });
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (typeof s.minLength === 'number' && length < s.minLength)
      out.push({
        level: 'error',
        path,
        message: s.minLength === 1 ? 'cannot be blank' : `needs at least ${s.minLength} characters`,
      });
    if (typeof s.maxLength === 'number' && length > s.maxLength)
      out.push({
        level: 'error',
        path,
        message: `is at most ${s.maxLength} characters (this is ${length})`,
      });
    if (typeof s.pattern === 'string' && !new RegExp(s.pattern, 'u').test(value))
      out.push({
        level: 'error',
        path,
        message: `'${value}' ${patternWords(s.pattern)}`,
      });
  }
  if (Array.isArray(value)) {
    const prefix = (s.prefixItems ?? []) as Schema[];
    value.forEach((item, i) => {
      const itemSchema = i < prefix.length ? prefix[i]! : s.items;
      if (itemSchema !== undefined) check(item, itemSchema, join(path, i), out);
    });
    if (typeof s.minItems === 'number' && value.length < s.minItems)
      out.push({
        level: 'error',
        path,
        message: `needs at least ${s.minItems} entries`,
      });
    if (typeof s.maxItems === 'number' && value.length > s.maxItems)
      out.push({
        level: 'error',
        path,
        message: `takes at most ${s.maxItems} entries`,
      });
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    const properties = s.properties ?? {};
    for (const key of s.required ?? []) {
      if (!(key in object))
        out.push({
          level: 'error',
          path: join(path, key),
          message: `'${key}' is required`,
        });
    }
    const names = s.propertyNames;
    for (const [key, item] of Object.entries(object)) {
      if (names?.pattern && !new RegExp(names.pattern, 'u').test(key))
        out.push({
          level: 'error',
          path: join(path, key),
          message: `the name '${key}' ${patternWords(names.pattern)}`,
        });
      if (key in properties) check(item, properties[key]!, join(path, key), out);
      else if (s.additionalProperties === false) {
        const allowed = Object.keys(properties);
        out.push({
          level: 'error',
          path: join(path, key),
          message: `'${key}' is not allowed here${allowed.length ? ` (allowed: ${allowed.join(', ')})` : ''}. If the site needs it, it is a core change: draft a module request.`,
        });
      } else if (s.additionalProperties && typeof s.additionalProperties === 'object') check(item, s.additionalProperties, join(path, key), out);
    }
  }
}

/** Every shape error in a site.json, as the app would refuse it (#537). */
export function checkSiteShape(manifest: unknown, schema: JsonSchema): Issue[] {
  const out: Issue[] = [];
  ROOT = schema;
  check(manifest, schema, '', out);
  return out;
}

/** The object behind a schema: through $ref, and through Option's anyOf [T, null]. */
function objectOf(schema: Schema): SchemaObject | null {
  const s = resolveRef(schema);
  if (typeof s !== 'object') return null;
  if (s.properties) return s;
  const options = s.anyOf ?? s.oneOf;
  for (const option of options ?? []) {
    const found = objectOf(option);
    if (found) return found;
  }
  return null;
}

/** The list item behind a schema, through $ref and Option. */
function itemsOf(schema: Schema): Schema | null {
  const s = resolveRef(schema);
  if (typeof s !== 'object') return null;
  if (s.items && ([] as string[]).concat(s.type ?? []).includes('array')) return s.items;
  for (const option of (s.anyOf ?? s.oneOf ?? []) as Schema[]) {
    const found = itemsOf(option);
    if (found) return found;
  }
  return null;
}

/** The keys each level of site.json takes ("layers[]" is a layer entry), for help and the editable list. */
export function fieldsOf(schema: JsonSchema): SiteSchema {
  ROOT = schema;
  const out: SiteSchema = {};
  const visit = (at: Schema, path: string, depth: number) => {
    if (depth > 8) return;
    const object = objectOf(at);
    if (object) {
      if (out[path]) return;
      out[path] = {
        fields: Object.keys(object.properties ?? {}),
        required: [...(object.required ?? [])],
      };
      for (const [key, sub] of Object.entries(object.properties ?? {})) visit(sub, path ? `${path}.${key}` : key, depth + 1);
      return;
    }
    const items = itemsOf(at);
    if (items) visit(items, `${path}[]`, depth + 1);
  };
  visit(schema, '', 0);
  return out;
}
