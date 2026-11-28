// Writes target/third-party-notices.json (#730): every Rust crate and npm package the app ships,
// with its licence and licence text, for Settings › Licence › Open-source licences. build.rs
// bundles it when it is there. `pnpm app:build` runs this first; a plain `cargo build` goes
// without, and the Licence page says so.
//
// Rust: the crates the app and the mrstudio command depend on (normal dependencies only, for
// every platform), from `cargo metadata`. npm: the production dependencies of the workspace,
// from `pnpm licenses list --prod`. Licence texts are the LICENSE/COPYING/NOTICE files each
// package ships, stored once each however many packages share them.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'target', 'third-party-notices.json');
const ROOTS = ['mr-studio-app', 'mrs-cli'];

const texts = [];
const textIndex = new Map();
function licenceText(dir) {
  if (!dir || !existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => /^(licen[cs]e|copying|notice)/i.test(f)).sort();
  if (!files.length) return null;
  const text = files.map((f) => readFileSync(join(dir, f), 'utf8').trim()).join('\n\n---\n\n');
  if (!textIndex.has(text)) {
    textIndex.set(text, texts.length);
    texts.push(text);
  }
  return textIndex.get(text);
}

function rust() {
  const meta = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--locked'], { cwd: root, maxBuffer: 256 << 20, encoding: 'utf8' }));
  const byId = new Map(meta.packages.map((p) => [p.id, p]));
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const members = new Set(meta.workspace_members);
  const seen = new Set();
  const queue = meta.packages.filter((p) => ROOTS.includes(p.name) && members.has(p.id)).map((p) => p.id);
  while (queue.length) {
    const id = queue.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of nodes.get(id)?.deps ?? []) {
      if (dep.dep_kinds.some((k) => k.kind === null)) queue.push(dep.pkg);
    }
  }
  return [...seen]
    .filter((id) => !members.has(id))
    .map((id) => byId.get(id))
    .map((p) => ({ name: p.name, version: p.version, licence: p.license ?? (p.license_file ? 'see licence text' : 'unknown'), source: 'crate', url: p.repository ?? null, text: licenceText(dirname(p.manifest_path)) }));
}

function npm() {
  const list = JSON.parse(execFileSync('pnpm', ['licenses', 'list', '--prod', '--json', '--recursive'], { cwd: root, maxBuffer: 256 << 20, encoding: 'utf8', shell: process.platform === 'win32' }));
  const packages = [];
  for (const [licence, entries] of Object.entries(list)) {
    for (const entry of entries) {
      entry.versions.forEach((version, i) => {
        packages.push({ name: entry.name, version, licence, source: 'npm', url: entry.homepage ?? null, text: licenceText(entry.paths?.[i] ?? entry.paths?.[0]) });
      });
    }
  }
  // The workspace's own packages are MR Studio.
  return packages.filter((p) => !p.name.startsWith('@mrstudio/'));
}

const crates = rust();
const npms = npm();
const packages = [...crates, ...npms].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ generated: new Date().toISOString().slice(0, 10), rust: crates.length, npm: npms.length, packages, texts }));
console.log(`Wrote ${out}: ${crates.length} crates, ${npms.length} npm packages, ${texts.length} licence texts.`);
