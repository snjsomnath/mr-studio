// Release notes and version numbers. Every pull request adds one note to changes/; every
// merge to main turns the waiting notes into a new version. See docs/RELEASING.md.
//
//   node scripts/release.mjs check [base]     A pull request has a valid note (base: origin/main).
//   node scripts/release.mjs pending          The version the waiting notes would make, or nothing.
//   node scripts/release.mjs apply            Raise the version, write CHANGELOG.md, remove the notes.
//                                             Prints the new version; prints nothing when there is none.
//   node scripts/release.mjs notes <version> [owner/repo]
//                                             The release description for a version, from CHANGELOG.md,
//                                             with pictures as links GitHub and the app can show.
//
// A note is a Markdown file with a few lines on top:
//
//   ---
//   bump: minor            minor (something new, the default), patch (only fixes), major, or none
//   issues: 267, 268       the issues it closes (optional)
//   breaking: Older tables are upgraded when opened.   (optional; listed first, in red, in the app)
//   ---
//   ### A title people understand
//
//   A few sentences for the people who run a table.
//
//   ![What the picture shows](docs/screenshots/267-home.png)
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const at = (...parts) => join(root, ...parts);
const CHANGES = 'changes';
const BUMPS = ['none', 'patch', 'minor', 'major'];
const SECTIONS = { major: 'New', minor: 'New', patch: 'Fixes' };

/** Reads one note. Throws with a message that says how to fix it. */
export function parseNote(text, file = 'note') {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^﻿/, ''));
  if (!match) throw new Error(`${file}: start with a --- block that has a bump: line (see docs/RELEASING.md)`);
  const head = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const kv = /^([a-z]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) throw new Error(`${file}: cannot read "${line.trim()}" in the --- block`);
    head[kv[1]] = kv[2].trim();
  }
  for (const key of Object.keys(head)) {
    if (!['bump', 'issues', 'breaking'].includes(key)) throw new Error(`${file}: unknown "${key}:" (use bump, issues, breaking)`);
  }
  const bump = (head.bump || 'minor').toLowerCase();
  if (!BUMPS.includes(bump)) throw new Error(`${file}: bump must be one of ${BUMPS.join(', ')}, not "${head.bump}"`);
  const issues = (head.issues || '')
    .split(/[\s,]+/)
    .map((s) => s.replace(/^#/, ''))
    .filter(Boolean);
  for (const n of issues) if (!/^\d+$/.test(n)) throw new Error(`${file}: issues must be numbers, not "${n}"`);
  const body = match[2].trim();
  if (bump !== 'none') {
    if (!/^###\s+\S/m.test(body)) throw new Error(`${file}: give the change a title line that starts with ### `);
    for (const [, src] of body.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)) {
      if (/^https?:/.test(src)) continue;
      if (!existsSync(at(src))) throw new Error(`${file}: the picture ${src} is not in the repository (paths start at the repository root)`);
    }
  }
  return { file, bump, issues: issues.map(Number), breaking: head.breaking || '', body };
}

export function readNotes() {
  if (!existsSync(at(CHANGES))) return [];
  return readdirSync(at(CHANGES))
    .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
    .sort()
    .map((f) => parseNote(readFileSync(at(CHANGES, f), 'utf8'), `${CHANGES}/${f}`));
}

export function currentVersion() {
  const cargo = readFileSync(at('Cargo.toml'), 'utf8');
  const section = cargo.slice(cargo.indexOf('[workspace.package]'));
  const version = /^version\s*=\s*"([^"]+)"/m.exec(section)?.[1];
  if (!version) throw new Error('no version under [workspace.package] in Cargo.toml');
  return version;
}

/** The biggest bump among the notes decides. `null` when nothing is to be released. */
export function nextVersion(version, notes) {
  const bump = notes.reduce((top, n) => (BUMPS.indexOf(n.bump) > BUMPS.indexOf(top) ? n.bump : top), 'none');
  if (bump === 'none') return null;
  const [major, minor, patch] = version.split(/[.-]/).map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** The CHANGELOG.md section for a version: breaking changes first, then new things, then fixes. */
export function section(version, notes, date) {
  const issues = (n) => (n.issues.length ? ` (${n.issues.map((i) => `#${i}`).join(', ')})` : '');
  const out = [`## ${version} (${date})`, ''];
  const breaking = notes.filter((n) => n.breaking);
  if (breaking.length) {
    out.push('### Breaking changes', '');
    for (const n of breaking) out.push(`- ${n.breaking}${issues(n)}`);
    out.push('');
  }
  for (const title of ['New', 'Fixes']) {
    const group = notes.filter((n) => SECTIONS[n.bump] === title);
    if (!group.length) continue;
    out.push(`### ${title}`, '');
    for (const n of group) {
      // Each change keeps its own ### title, one level down so it sits under the group.
      const body = n.body.replace(/^###\s+(.+)$/m, (_, t) => `#### ${t.trim()}${issues(n)}`).replace(/^###\s/gm, '#### ');
      out.push(body, '');
    }
  }
  return out.join('\n').trim() + '\n';
}

const CHANGELOG_HEAD = `# Changelog

Every merge to main that carries a release note becomes a version. The newest is first.
The app shows these notes, with their pictures, on Home when a newer version is out.
How notes are written: docs/RELEASING.md.
`;

function setVersions(from, to) {
  const cargoPath = at('Cargo.toml');
  const cargo = readFileSync(cargoPath, 'utf8');
  const start = cargo.indexOf('[workspace.package]');
  const head = cargo.slice(0, start);
  const rest = cargo.slice(start).replace(/^version\s*=\s*"[^"]+"/m, `version = "${to}"`);
  writeFileSync(cargoPath, head + rest);

  // The workspace's own crates are listed in Cargo.lock with the version too.
  const lockPath = at('Cargo.lock');
  if (existsSync(lockPath)) {
    const members = new Set();
    const workspace = /members\s*=\s*\[([^\]]*)\]/.exec(cargo)?.[1] ?? '';
    for (const [, dir] of workspace.matchAll(/"([^"]+)"/g)) {
      const toml = readFileSync(at(dir, 'Cargo.toml'), 'utf8');
      const name = /^\[package\][\s\S]*?^name\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
      if (name && /^version\.workspace\s*=\s*true/m.test(toml)) members.add(name);
    }
    const lock = readFileSync(lockPath, 'utf8').replace(
      /(\[\[package\]\]\r?\nname = "([^"]+)"\r?\nversion = ")([^"]+)"/g,
      (all, pre, name, v) => (members.has(name) && v === from ? `${pre}${to}"` : all),
    );
    writeFileSync(lockPath, lock);
  }

  // The web packages carry the same number, so the MCP server and the SDK report the app's version.
  const packages = ['.', 'apps/studio', 'packages/sdk', 'packages/runtime', 'packages/dashboard', 'packages/mcp'];
  if (existsSync(at('packages/layers'))) for (const d of readdirSync(at('packages/layers'))) packages.push(`packages/layers/${d}`);
  for (const dir of packages) {
    const path = at(dir, 'package.json');
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    writeFileSync(path, text.replace(/^(\s*"version"\s*:\s*")[^"]+"/m, `$1${to}"`));
  }
}

function apply() {
  const notes = readNotes();
  const from = currentVersion();
  const to = nextVersion(from, notes);
  // Notes that release nothing (bump: none) are still cleared, so they do not pile up.
  if (!to) {
    for (const n of notes) rmSync(at(n.file));
    return;
  }
  const date = new Date().toISOString().slice(0, 10);
  const path = at('CHANGELOG.md');
  const old = existsSync(path) ? readFileSync(path, 'utf8') : CHANGELOG_HEAD;
  const body = old.startsWith('# Changelog') ? old.slice(old.indexOf('\n## ') === -1 ? old.length : old.indexOf('\n## ') + 1) : old;
  writeFileSync(path, `${CHANGELOG_HEAD}\n${section(to, notes.filter((n) => n.bump !== 'none'), date)}\n${body}`.replace(/\n{3,}/g, '\n\n'));
  setVersions(from, to);
  for (const n of notes) rmSync(at(n.file));
  console.log(to);
}

/** One version's part of CHANGELOG.md, with picture paths made into links that work outside the repository. */
export function notesFor(changelog, version, repository) {
  const v = version.replace(/^v/, '');
  const start = changelog.indexOf(`\n## ${v} `);
  if (start === -1) return null;
  const next = changelog.indexOf('\n## ', start + 4);
  let text = changelog.slice(start + 1, next === -1 ? undefined : next).replace(/^## .*\n/, '').trim();
  // The app and GitHub's release page show pictures from raw.githubusercontent.com.
  text = text.replace(/(!\[[^\]]*\]\()(?!https?:)\.?\/?([^)\s]+)/g, `$1https://raw.githubusercontent.com/${repository}/v${v}/$2`);
  // Change titles go back up to ###, the level the app looks for.
  return text.replace(/^####\s/gm, '### ').replace(/^### (New|Fixes|Breaking changes)$/gm, '## $1') + '\n';
}

function check(base) {
  const notes = readNotes(); // Every note must be readable, old or new.
  let added;
  try {
    added = execFileSync('git', ['diff', '--name-only', '--diff-filter=A', `${base}...HEAD`, '--', CHANGES], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter((f) => f.endsWith('.md'));
  } catch (e) {
    throw new Error(`could not compare with ${base}: ${e.message}`);
  }
  const ours = notes.filter((n) => added.includes(n.file));
  if (!ours.length) {
    console.error(`This pull request has no release note. Add a file to changes/, for example changes/my-change.md:

---
bump: minor
issues: 123
---
### What changed, in words people who run a table understand

One or two sentences, and a screenshot:

![The new thing](docs/screenshots/123-new-thing.png)

Use bump: patch for a fix only, and bump: none for a change nobody running a table notices (docs, CI).
See docs/RELEASING.md.`);
    process.exit(1);
  }
  const version = nextVersion(currentVersion(), notes);
  console.log(`${ours.map((n) => `${n.file} (${n.bump})`).join(', ')}. Merging makes ${version ? `version ${version}` : 'no new version'}.`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [command, arg, repo] = process.argv.slice(2);
  if (command === 'check') check(arg || 'origin/main');
  else if (command === 'pending') {
    const v = nextVersion(currentVersion(), readNotes());
    if (v) console.log(v);
  } else if (command === 'apply') apply();
  else if (command === 'notes') {
    if (!arg) throw new Error('usage: release.mjs notes <version> [owner/repo]');
    const text = existsSync(at('CHANGELOG.md')) ? notesFor(readFileSync(at('CHANGELOG.md'), 'utf8'), arg, repo || 'snjsomnath/mr-studio') : null;
    process.stdout.write(text ?? `MR Studio ${arg}.\n`);
  } else {
    console.error('usage: release.mjs check [base] | pending | apply | notes <version> [owner/repo]');
    process.exit(2);
  }
}
