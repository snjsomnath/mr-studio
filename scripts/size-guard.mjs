// Keeps the repository from quietly growing out of reach (#738, part of #736).
//
//   node scripts/size-guard.mjs [base]      A pull request against base (default origin/main).
//   node scripts/size-guard.mjs --report    Lines of code per package, nothing checked.
//
// Fails when a pull request
//   - adds a code file over 1,500 lines, or grows one from under 1,500 lines to over it;
//   - adds a picture to docs/screenshots over 1 MB, or more than 5 MB of pictures there in all.
// Warns (never fails) when
//   - a code file already over 1,500 lines grows: split it when you next work in it (#542);
//   - a picture added to docs/screenshots is linked from nothing in the repository. Screenshots
//     for issues and pull requests belong on the `screenshots` branch (CONTRIBUTING.md); only
//     the pictures a release note shows live on main.
// With GITHUB_STEP_SUMMARY set, it also writes lines of code per package to the job summary.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MAX_LINES = 1500;
export const MAX_PICTURE = 1024 * 1024;
export const MAX_PICTURES = 5 * 1024 * 1024;
const CODE = /\.(ts|tsx|js|mjs|cjs|rs|css|wgsl|py)$/;
const PICTURE = /\.(png|jpe?g|webp|gif)$/i;
const SHOTS = 'docs/screenshots/';
const GENERATED = [/\.d\.ts$/, /(^|\/)(dist|target|node_modules)\//, /schema\.json$/];

const root = fileURLToPath(new URL('..', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
const lines = (text) => (text === null ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));
const show = (rev, path) => {
  try {
    return execFileSync('git', ['show', `${rev}:${path}`], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
};
const generated = (path) => GENERATED.some((re) => re.test(path));

/** What a change does to code file sizes and pictures. Pure, for the tests. */
export function judge({ code, pictures, linked }) {
  const errors = [];
  const warnings = [];
  for (const { path, before, after } of code) {
    if (after <= MAX_LINES || after <= before) continue;
    if (before === 0) errors.push(`${path} is a new file of ${after} lines, over ${MAX_LINES}. Split it into parts.`);
    else if (before <= MAX_LINES) errors.push(`${path} grows from ${before} to ${after} lines, past ${MAX_LINES}. Split it into parts.`);
    else warnings.push(`${path} grows from ${before} to ${after} lines; it is over ${MAX_LINES}, so split it when you next work in it (#542).`);
  }
  let total = 0;
  for (const { path, bytes } of pictures) {
    total += bytes;
    const mb = (bytes / 1048576).toFixed(1);
    if (bytes > MAX_PICTURE) errors.push(`${path} is ${mb} MB, over 1 MB. Save it at 1x or as JPEG.`);
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (!linked(name)) warnings.push(`${path} is linked from nothing in the repository. Put screenshots for issues and pull requests on the screenshots branch (CONTRIBUTING.md).`);
  }
  if (total > MAX_PICTURES) errors.push(`This adds ${(total / 1048576).toFixed(1)} MB of pictures to ${SHOTS}, over 5 MB. Keep only the ones release notes show.`);
  return { errors, warnings };
}

/** Lines of code per package, blank lines left out. */
export function report(rev = 'HEAD') {
  const counts = new Map();
  for (const path of git('ls-tree', '-r', '--name-only', rev).split('\n')) {
    if (!CODE.test(path) || generated(path)) continue;
    const parts = path.split('/');
    const pkg = ['packages', 'crates', 'apps'].includes(parts[0]) && parts.length > 2 ? (parts[1] === 'layers' ? 'packages/layers' : `${parts[0]}/${parts[1]}`) : parts.length > 1 ? parts[0] : '(root)';
    const text = show(rev, path) ?? '';
    counts.set(pkg, (counts.get(pkg) ?? 0) + text.split('\n').filter((l) => l.trim()).length);
  }
  return [...counts].sort((a, b) => b[1] - a[1]);
}

function main() {
  const args = process.argv.slice(2);
  const rows = report();
  const table = ['| Package | Lines |', '| --- | ---: |', ...rows.map(([p, n]) => `| ${p} | ${n.toLocaleString('en-US')} |`), `| **All** | **${rows.reduce((s, [, n]) => s + n, 0).toLocaleString('en-US')}** |`].join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Lines of code per package\n\n${table}\n`);
  if (args[0] === '--report') return console.log(table);

  const base = git('merge-base', args[0] || 'origin/main', 'HEAD').trim();
  const changed = git('diff', '--name-status', '--no-renames', base, 'HEAD')
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t'))
    .filter(([status]) => status === 'A' || status === 'M');
  const code = changed
    .filter(([, path]) => CODE.test(path) && !generated(path))
    .map(([, path]) => ({ path, before: lines(show(base, path)), after: lines(readFileSync(`${root}/${path}`, 'utf8')) }));
  const pictures = changed
    .filter(([status, path]) => status === 'A' && path.startsWith(SHOTS) && PICTURE.test(path))
    .map(([, path]) => ({ path, bytes: Number(git('cat-file', '-s', `HEAD:${path}`).trim()) }));
  const linked = (name) => {
    try {
      git('grep', '-q', '-F', name, 'HEAD', '--', '.', `:!${SHOTS}`);
      return true;
    } catch {
      return false;
    }
  };
  const { errors, warnings } = judge({ code, pictures, linked });
  for (const w of warnings) console.log(`::warning::${w}`);
  for (const e of errors) console.log(`::error::${e}`);
  if (errors.length) process.exit(1);
  console.log(`Size guard: ${code.length} code files and ${pictures.length} pictures checked, ${warnings.length} warnings.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
