// Writes src/site-types.ts, the TypeScript types of site.json, from docs/contracts/site.schema.json
// (which mrs-site writes from its own types, #537), so the MCP server reads sites typed (#543).
// `node scripts/site-types.mjs --check` fails when the file is out of date; the tests run it.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const out = join(here, '..', 'src', 'site-types.ts');
const schema = JSON.parse(readFileSync(join(root, 'docs', 'contracts', 'site.schema.json'), 'utf8'));

const doc = (text, indent) => (text ? `${indent}/** ${String(text).trim().replace(/\*\//g, '*\\/').replace(/\n\s*/g, `\n${indent} * `)} */\n` : '');
const lit = (v) => (typeof v === 'string' ? `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : JSON.stringify(v));
const key = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : lit(k));

function type(s, indent) {
  if (s === true || s === undefined) return 'unknown';
  if (s === false) return 'never';
  if (s.$ref) return s.$ref.replace('#/$defs/', '');
  if ('const' in s) return lit(s.const);
  if (Array.isArray(s.enum)) return s.enum.map(lit).join(' | ');
  const options = s.anyOf ?? s.oneOf;
  if (options) return [...new Set(options.map((o) => type(o, indent)))].join(' | ');
  const types = [].concat(s.type ?? []);
  if (types.length > 1) return types.map((t) => type({ ...s, type: t }, indent)).join(' | ');
  switch (types[0]) {
    case 'null':
      return 'null';
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array':
      if (Array.isArray(s.prefixItems)) return `[${s.prefixItems.map((i) => type(i, indent)).join(', ')}]`;
      return `${wrap(type(s.items, indent))}[]`;
    case 'object':
      return object(s, indent);
    default:
      return 'unknown';
  }
}

const wrap = (t) => (/[|&]/.test(t) ? `(${t})` : t);

function object(s, indent) {
  const props = Object.entries(s.properties ?? {});
  const extra = s.additionalProperties;
  if (!props.length) return extra === false ? 'Record<string, never>' : `Record<string, ${type(extra, indent)}>`;
  const required = new Set(s.required ?? []);
  const inner = `${indent}  `;
  const lines = props.map(([k, v]) => `${doc(v.description, inner)}${inner}${key(k)}${required.has(k) ? '' : '?'}: ${type(v, inner)};`);
  return `{\n${lines.join('\n')}\n${indent}}`;
}

const defs = Object.entries(schema.$defs ?? {}).map(([name, s]) => {
  const body = type(s, '');
  return `${doc(s.description, '')}export ${body.startsWith('{') ? `interface ${name} ` : `type ${name} = `}${body}${body.startsWith('{') ? '' : ';'}`;
});
const { $defs, $schema, $id, title, description, ...top } = schema;
const text = `// Written by scripts/site-types.mjs from docs/contracts/site.schema.json (#537, #543). Do not edit.

${doc(description, '')}export interface SiteJson ${object(top, '')}

${defs.join('\n\n')}
`;

if (process.argv.includes('--check')) {
  // A Windows checkout may have turned the line ends into CRLF.
  const saved = readFileSync(out, 'utf8').replaceAll('\r\n', '\n');
  if (saved !== text) {
    console.error('packages/mcp/src/site-types.ts is out of date: run `node packages/mcp/scripts/site-types.mjs`');
    process.exit(1);
  }
} else writeFileSync(out, text);
