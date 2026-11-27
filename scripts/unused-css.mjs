#!/usr/bin/env node
// Lists class names in MR Studio's style sheets that no code or page uses any more (#546).
//
//   node scripts/unused-css.mjs          list them; exits 1 if any is not on the allow-list
//
// A class counts as used when its name appears as a whole word in any TypeScript, JavaScript,
// HTML, Rust or JSON file, or when the code builds names with its prefix at run time
// (`is-${kind}`, 'control-' + type). The allow-list below is for names used in ways neither
// finds; say why beside each.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const skip = new Set(['node_modules', 'dist', 'target', '.git', 'e2e-results', 'screenshots']);
// The dashboard package checks its own styles (#681).
const sheetsSkip = [path.join('packages', 'dashboard')];

/** Names used in ways the search cannot see. */
const ALLOW = new Map([
  // Set by MapLibre itself on its own elements.
  ['maplibregl-ctrl', 'MapLibre'],
]);

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = ['packages', 'apps', 'crates', 'sites', 'templates'].flatMap((d) => (fs.existsSync(path.join(root, d)) ? walk(path.join(root, d), []) : []));
const sheets = files.filter((f) => f.endsWith('.css') && !sheetsSkip.some((s) => path.relative(root, f).startsWith(s)));
const code = files
  .filter((f) => /\.(ts|tsx|js|mjs|cjs|html|rs|json|svg)$/.test(f))
  .map((f) => fs.readFileSync(f, 'utf8'))
  .join('\n');

// Prefixes of names built at run time: `is-${x}`, 'control-' + x, `ed-${a}-${b}`.
const prefixes = new Set();
for (const m of code.matchAll(/([a-z][\w-]*-)\$\{/g)) prefixes.add(m[1]);
for (const m of code.matchAll(/['"`]([a-z][\w-]*-)['"`]\s*\+/g)) prefixes.add(m[1]);

const words = new Set(code.match(/[A-Za-z_][\w-]*/g));
const unused = [];
for (const sheet of sheets) {
  const css = fs.readFileSync(sheet, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/url\([^)]*\)/g, '');
  const names = new Set();
  for (const m of css.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) names.add(m[1]);
  for (const name of names) {
    if (words.has(name) || ALLOW.has(name)) continue;
    if ([...prefixes].some((p) => name.startsWith(p))) continue;
    unused.push(`${path.relative(root, sheet)}: .${name}`);
  }
}
if (unused.length) {
  console.log(`${unused.length} class names no code uses:\n  ${unused.join('\n  ')}`);
  process.exit(1);
}
console.log(`No unused class names in ${sheets.length} style sheets.`);
