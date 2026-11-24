// Builds the Help window's content (#271) from the docs, so the app's help always matches
// its version: the guides in docs/guide/, a page per core layer (#291), troubleshooting, and
// CHANGELOG.md.
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
const featuresPage = page('features', read('docs', 'guide', 'features.md'), 'features');
// Each layer in the feature list links to its own page.
featuresPage.body = featuresPage.body.replace(/^Layer `([a-z0-9-]+)`.*$/gm, (line, id) =>
  existsSync(join(guideDir, 'layers', `${id}.md`)) ? `${line} [How to use it](#layer-${id})` : line,
);
pages.push(featuresPage);

// A page per core layer (#291): the written guide in docs/guide/layers/<id>.md, then what it needs
// and every setting, read from the layer's own layer.json so they never fall behind.
const NEEDS = {
  buildings: 'Buildings: Edit tab, **Add data**, **Buildings** (from OpenStreetMap or a file).',
  roads: 'Streets: Edit tab, **Add data**, **Streets** (from OpenStreetMap or a file).',
  walkways: 'Walking paths: Edit tab, **Add data**, **Walking paths** (from OpenStreetMap or a file).',
  trees: 'Trees: Edit tab, **Add data**, **Trees** (from OpenStreetMap or a file).',
  trips: 'Trips: Edit tab, **Add data**, **Trips** (a trips file).',
};
const KERNELS = {
  sunlight: 'The buildings, and the ground heights and trees if the table has them; the shade is worked out on this computer.',
  wind: 'The buildings, and the trees if the table has them; the wind is worked out on this computer.',
  stormwater: 'The ground heights and buildings: Edit tab, **Add data**, **Ground**. The water is worked out on this computer.',
};
const number = (n) => String(n);
function setting(c) {
  const unit = c.unit ? ` ${c.unit}` : '';
  let what = '';
  if (c.type === 'range') what = `from ${number(c.min)} to ${number(c.max)}${unit}, starts at ${number(c.default)}${unit}`;
  else if (c.type === 'toggle') what = `on or off, starts ${c.default ? 'on' : 'off'}`;
  else if (c.type === 'select') {
    const first = c.options?.find((o) => o.value === c.default)?.label;
    what = `${c.options?.map((o) => o.label).join(', ')}${first ? `; starts at ${first}` : ''}`;
  } else if (c.type === 'action') what = 'a button';
  else if (c.type === 'color') what = `a colour, starts at ${c.default}`;
  else if (c.type === 'date') what = `a day, starts at ${c.default}`;
  else if (c.default) what = `starts as \`${c.default}\``;
  return `- **${c.label}**${what ? `: ${what}` : ''}.${c.phone ? ' Visitors can change it from their phones too.' : ''}`;
}
// In the order of the feature list, so the Help window reads as the list does.
const order = (id) => {
  const at = featuresPage.body.indexOf(`\`${id}\``);
  return at < 0 ? Infinity : at;
};
for (const dir of readdirSync(join(root, 'packages', 'layers')).sort((a, b) => order(a) - order(b))) {
  const manifestPath = join(root, 'packages', 'layers', dir, 'layer.json');
  const guidePath = join(guideDir, 'layers', `${dir}.md`);
  if (!existsSync(manifestPath) || !existsSync(guidePath)) continue;
  const layer = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const written = page(`layer-${layer.id}`, readFileSync(guidePath, 'utf8'), 'layer');
  const parts = [written.body];
  const needs = [
    ...(layer.requires?.data ?? []).map((d) => NEEDS[d] ?? `The \`${d}\` dataset: Edit tab, **Add data**.`),
    ...(layer.requires?.kernels ?? []).map((k) => KERNELS[k]).filter(Boolean),
  ];
  parts.push(`## What it needs\n\n${needs.length ? needs.map((n) => `- ${n}`).join('\n') : 'Nothing beyond the table itself.'}`);
  const controls = (layer.controls ?? []).filter((c) => c.tier !== 'state');
  const main = controls.filter((c) => c.tier !== 'more');
  const more = controls.filter((c) => c.tier === 'more');
  const settings = ['## Its settings', 'Select the layer in the editor to change them; the eye beside each one decides whether visitors get it on the controller.'];
  if (main.length) settings.push('### Main settings', main.map(setting).join('\n'));
  if (more.length) settings.push('### More settings', 'On the controller these wait behind **More settings**.', more.map(setting).join('\n'));
  if (controls.length) parts.push(settings.join('\n\n'));
  if (layer.tools?.length) {
    parts.push(`## On the table and phones\n\nPoint at the table with the mouse, or use these on a phone:\n\n${layer.tools.map((t) => `- **${t.label ?? t.id}**`).join('\n')}`);
  }
  pages.push({ id: written.id, kind: 'layer', title: layer.name ?? layer.id, summary: layer.description ?? '', body: parts.join('\n\n') });
}

if (existsSync(join(guideDir, 'troubleshooting.md'))) pages.push(page('troubleshooting', read('docs', 'guide', 'troubleshooting.md'), 'trouble'));

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
