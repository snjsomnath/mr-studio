// Tests for scripts/release.mjs (#544): what it decides reaches every installed app.
// Run with `node --test scripts/release.test.mjs`. Each case works on a small repository of
// its own in a temporary folder, with a copy of the script, so nothing here is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextVersion, notesFor, parseNote, section } from './release.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** A repository at 1.2.3 with one crate, a lock file, two packages and the given notes. */
function repository(notes = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mrs-release-'));
  const put = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  copyFileSync(join(here, 'release.mjs'), (mkdirSync(join(dir, 'scripts')), join(dir, 'scripts', 'release.mjs')));
  put('Cargo.toml', '[workspace]\nmembers = ["crates/one"]\n\n[workspace.package]\nversion = "1.2.3"\nedition = "2021"\n');
  put('crates/one/Cargo.toml', '[package]\nname = "one"\nversion.workspace = true\n');
  put(
    'Cargo.lock',
    '[[package]]\nname = "one"\nversion = "1.2.3"\n\n[[package]]\nname = "other"\nversion = "1.2.3"\nsource = "registry"\n',
  );
  put('package.json', '{\n  "name": "root",\n  "version": "1.2.3"\n}\n');
  put('packages/sdk/package.json', '{\n  "name": "sdk",\n  "version": "1.2.3",\n  "dependencies": { "x": "1.2.3" }\n}\n');
  put('docs/screenshots/1-thing.png', 'png');
  mkdirSync(join(dir, 'changes'));
  for (const [name, text] of Object.entries(notes)) put(`changes/${name}.md`, text);
  const run = (...args) => spawnSync(process.execPath, [join(dir, 'scripts', 'release.mjs'), ...args], { cwd: dir, encoding: 'utf8' });
  const text = (path) => readFileSync(join(dir, path), 'utf8');
  return { dir, run, text, put, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const note = (bump, title, extra = '') => `---\nbump: ${bump}\nissues: 7\n---\n### ${title}\n\nWhat changed.${extra}\n`;

test('no notes, or only notes that release nothing, give no version', () => {
  const empty = repository();
  assert.equal(empty.run('pending').stdout, '');
  empty.done();

  const quiet = repository({ docs: '---\nbump: none\n---\nDocs only.\n' });
  assert.equal(quiet.run('pending').stdout, '');
  const applied = quiet.run('apply');
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(applied.stdout, '', 'nothing is printed, so the workflow makes no release');
  assert.match(quiet.text('Cargo.toml'), /version = "1\.2\.3"/);
  assert.deepEqual(readdirSync(join(quiet.dir, 'changes')), [], 'the note is cleared all the same');
  assert.ok(!existsSync(join(quiet.dir, 'CHANGELOG.md')));
  quiet.done();
});

test('the biggest bump among the notes decides the version', () => {
  const at = (bumps) => nextVersion('1.2.3', bumps.map((bump) => ({ bump })));
  assert.equal(at(['patch']), '1.2.4');
  assert.equal(at(['patch', 'minor', 'none']), '1.3.0');
  assert.equal(at(['minor', 'major', 'patch']), '2.0.0');
  assert.equal(at(['none']), null);
  assert.equal(at([]), null);
});

test('a note says what is wrong with it', () => {
  const repo = repository();
  const bad = (text, pattern) => {
    repo.put('changes/bad.md', text);
    const result = repo.run('pending');
    assert.notEqual(result.status, 0, text);
    assert.match(result.stderr, pattern);
  };
  bad('### No head\n', /start with a --- block/);
  bad('---\nbump: huge\n---\n### T\n', /bump must be one of/);
  bad('---\nbump: patch\nissue: 3\n---\n### T\n', /unknown "issue:"/);
  bad('---\nbump: patch\nissues: three\n---\n### T\n', /issues must be numbers/);
  bad('---\nbump: patch\n---\nNo title.\n', /title line that starts with ###/);
  bad(note('minor', 'T', '\n\n![Gone](docs/screenshots/2-gone.png)'), /the picture docs\/screenshots\/2-gone\.png is not in the repository/);
  repo.put('changes/bad.md', note('minor', 'T', '\n\n![There](docs/screenshots/1-thing.png)\n\n![Elsewhere](https://example.org/a.png)'));
  assert.equal(repo.run('pending').stdout.trim(), '1.3.0');
  repo.done();
});

test('a note is read: bump, issues, breaking, and minor when no bump is given', () => {
  const read = parseNote('---\nissues: #4, 5 6\nbreaking: Old tables need opening once.\n---\n### Title\n\nBody.\n');
  assert.equal(read.bump, 'minor');
  assert.deepEqual(read.issues, [4, 5, 6]);
  assert.equal(read.breaking, 'Old tables need opening once.');
  assert.equal(read.body, '### Title\n\nBody.');
  // A file saved on Windows: a byte order mark and CRLF line ends.
  assert.equal(parseNote('﻿---\r\nbump: patch\r\n---\r\n### T\r\n').bump, 'patch');
});

test('applying writes the version everywhere, the changelog in order, and clears the notes', () => {
  const repo = repository({
    'b-fix': note('patch', 'A fix'),
    'a-new': note('minor', 'Something new', '\n\n![It](docs/screenshots/1-thing.png)'),
    'c-docs': '---\nbump: none\n---\nDocs.\n',
  });
  repo.put('CHANGELOG.md', '# Changelog\n\nOld words at the top.\n\n## 1.2.3 (2026-01-01)\n\n### Fixes\n\n#### Earlier\n');
  const applied = repo.run('apply');
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(applied.stdout.trim(), '1.3.0');

  assert.match(repo.text('Cargo.toml'), /\[workspace\.package\]\nversion = "1\.3\.0"/);
  const lock = repo.text('Cargo.lock');
  assert.match(lock, /name = "one"\nversion = "1\.3\.0"/, 'the workspace crate in the lock file');
  assert.match(lock, /name = "other"\nversion = "1\.2\.3"/, 'a crate from elsewhere with the same number is left alone');
  assert.match(repo.text('package.json'), /"version": "1\.3\.0"/);
  const sdk = repo.text('packages/sdk/package.json');
  assert.match(sdk, /"version": "1\.3\.0"/);
  assert.match(sdk, /"x": "1\.2\.3"/, 'only the package\'s own version changes');

  const log = repo.text('CHANGELOG.md');
  const order = ['## 1.3.0 (', '### New', '#### Something new (#7)', '### Fixes', '#### A fix (#7)', '## 1.2.3 (2026-01-01)', '#### Earlier'];
  let from = 0;
  for (const part of order) {
    const found = log.indexOf(part, from);
    assert.notEqual(found, -1, `"${part}" is missing or out of order in:\n${log}`);
    from = found + part.length;
  }
  assert.ok(!log.includes('Docs.'), 'a note that releases nothing is not in the changelog');
  assert.deepEqual(readdirSync(join(repo.dir, 'changes')), []);

  // The notes the app and the release page show: pictures as links that work outside the repository.
  const shown = repo.run('notes', 'v1.3.0', 'someone/table').stdout;
  assert.match(shown, /^## New\n\n### Something new \(#7\)/);
  assert.match(shown, /!\[It\]\(https:\/\/raw\.githubusercontent\.com\/someone\/table\/v1\.3\.0\/docs\/screenshots\/1-thing\.png\)/);
  assert.ok(!shown.includes('1.2.3'), 'only the one version');
  assert.equal(repo.run('notes', '9.9.9').stdout, 'MR Studio 9.9.9.\n');
  repo.done();
});

test('breaking changes come first in a version', () => {
  const text = section('2.0.0', [
    { bump: 'minor', issues: [], breaking: '', body: '### New thing' },
    { bump: 'major', issues: [3], breaking: 'Tables from 1.x are converted on opening.', body: '### A new format' },
  ], '2026-11-26');
  assert.ok(text.startsWith('## 2.0.0 (2026-11-26)\n\n### Breaking changes\n\n- Tables from 1.x are converted on opening. (#3)\n\n### New'));
  assert.equal(notesFor('# Changelog\n', '2.0.0', 'a/b'), null);
});

test('notes for developers sit last, under their own heading, which What\'s new leaves out (#593)', () => {
  const dev = parseNote('---\nbump: minor\naudience: developers\n---\n### Layers get the SDK types\n', 'changes/dev.md');
  assert.equal(dev.audience, 'developers');
  assert.throws(() => parseNote('---\nbump: minor\naudience: robots\n---\n### X\n', 'changes/x.md'), /audience must be/);
  const text = section('1.1.0', [dev, { bump: 'minor', issues: [], breaking: '', audience: 'everyone', body: '### A new layer' }], '2026-11-27');
  assert.ok(text.indexOf('### New') < text.indexOf('### For developers'));
  assert.ok(text.indexOf('#### A new layer') < text.indexOf('### For developers'));
  assert.ok(text.indexOf('#### Layers get the SDK types') > text.indexOf('### For developers'));
});

test('a pull request without a note of its own fails the check, and with one passes', () => {
  const repo = repository({ old: note('patch', 'Already on main') });
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.org', '-c', 'commit.gpgsign=false', ...args], { cwd: repo.dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'main');
  git('checkout', '-qb', 'work');
  repo.put('README.md', 'A change.\n');
  git('add', '-A');
  git('commit', '-qm', 'no note');
  const without = repo.run('check', 'main');
  assert.equal(without.status, 1);
  assert.match(without.stderr, /has no release note/);

  repo.put('changes/mine.md', note('minor', 'Mine'));
  git('add', '-A');
  git('commit', '-qm', 'note');
  const withNote = repo.run('check', 'main');
  assert.equal(withNote.status, 0, withNote.stderr);
  assert.match(withNote.stdout, /changes\/mine\.md \(minor\)\. Merging makes version 1\.3\.0\./);
  repo.done();
});
