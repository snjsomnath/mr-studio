// Builds the Help window's content (#271) from the docs, so the app's help always matches
// its version: the guides in docs/guide/, the core layers, and CHANGELOG.md.
//
//   node scripts/build-help.mjs        writes packages/runtime/public/help.json
//
// Runs before every build of the runtime (packages/runtime/package.json). Pictures stay in
// the repository and are shown from GitHub at the commit the app was built from, so the
// app does not carry them; without internet the guides still read, without pictures.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (...p) => readFileSync(join(root, ...p), 'utf8');
const REPO = 'snjsomnath/mr-studio';

function commit() {
  if (process.env.MRS_BUILD_COMMIT) return process.env.MRS_BUILD_COMMIT.trim();
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return 'main';
  }
}

/** A guide file: `# Title`, an italic summary line, then the body. */
function page(id, text, kind) {
  const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? id;
  const summary = /^\*([^*\n]+)\*\s*$/m.exec(text)?.[1]?.trim() ?? '';
  const body = text
    .replace(/^#\s+.+\n/m, '')
    .replace(/^\*[^*\n]+\*\s*\n/m, '')
    .trim();
  return { id, kind, title, summary, body };
}

const guideDir = join(root, 'docs', 'guide');
const pages = [];
for (const file of readdirSync(guideDir).sort()) {
  if (!/^\d+-.+\.md$/.test(file)) continue;
  pages.push(page(file.replace(/^\d+-|\.md$/g, ''), readFileSync(join(guideDir, file), 'utf8'), 'guide'));
}
pages.push(page('features', read('docs', 'guide', 'features.md'), 'features'));

// What's new: the newest versions from the changelog, each a page.
const changelog = existsSync(join(root, 'CHANGELOG.md')) ? read('CHANGELOG.md') : '';
for (const part of changelog.split(/^## /m).slice(1, 6)) {
  const head = /^(\d+\.\d+\.\d+\S*)(?:\s*\(([^)]*)\))?/.exec(part);
  if (!head) continue;
  const body = part.replace(/^.*\n/, '').replace(/^### /gm, '## ').replace(/^#### /gm, '### ').trim();
  pages.push({ id: `v${head[1]}`, kind: 'release', title: `MR Studio ${head[1]}`, summary: head[2] ?? '', body });
}

const version = /^version\s*=\s*"([^"]+)"/m.exec(read('Cargo.toml').slice(read('Cargo.toml').indexOf('[workspace.package]')))?.[1] ?? '0.0.0';
const help = { version, pictures: `https://raw.githubusercontent.com/${REPO}/${commit()}/`, fallback: `https://raw.githubusercontent.com/${REPO}/main/`, pages };
const out = join(root, 'packages', 'runtime', 'public');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'help.json'), JSON.stringify(help));
console.log(`help.json: ${pages.length} pages for MR Studio ${version}`);
