// Fails when something has been built that the docs or the MCP server do not know about (#269).
// Runs in CI on every pull request; each problem says which file to add it to.
//
//   node scripts/check-docs.mjs
//
// It checks that:
// - every core layer (packages/layers/*/layer.json) is in README.md, docs/ROADMAP.md and the Help's feature list
//   (docs/guide/features.md), by id or name;
// - every engine kernel (crates/mrs-engine/src/kernels/*) is in docs/contracts/engine.md;
// - every site.json setting (the SiteManifest, Table and Branding structs in mrs-site) is in docs/contracts/site.md;
// - every MCP tool (packages/mcp/src/server.ts) is in docs/MCP.md;
// - every SDK module (packages/sdk/src/*.ts) is named in packages/mcp/src/blocks.ts or docs/blocks.md,
//   so the MCP server can offer it as a building block.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (...p) => readFileSync(join(root, ...p), 'utf8');
const dirs = (...p) => (existsSync(join(root, ...p)) ? readdirSync(join(root, ...p), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : []);
const problems = [];
const mentions = (text, ...names) => names.filter(Boolean).some((n) => text.toLowerCase().includes(String(n).toLowerCase()));

// Layers
const readme = read('README.md');
// The Help window's feature list (#271).
const features = read('docs', 'guide', 'features.md');
const roadmap = read('docs', 'ROADMAP.md');
for (const dir of dirs('packages', 'layers')) {
  const path = join(root, 'packages', 'layers', dir, 'layer.json');
  if (!existsSync(path)) continue;
  const layer = JSON.parse(readFileSync(path, 'utf8'));
  const names = [layer.id, layer.name, dir, `packages/layers/${dir}`];
  if (!mentions(readme, ...names)) problems.push(`README.md does not mention the layer "${layer.name ?? layer.id}" (packages/layers/${dir}). Add it to the list of layers.`);
  if (!mentions(roadmap, ...names)) problems.push(`docs/ROADMAP.md does not mention the layer "${layer.name ?? layer.id}". Mark it built there.`);
  if (!mentions(features, layer.name, `\`${layer.id}\``)) problems.push(`docs/guide/features.md (the app's Help) does not list the layer "${layer.name ?? layer.id}". Add a section with a picture.`);
  if (!layer.description) problems.push(`packages/layers/${dir}/layer.json has no "description"; the MCP server and the editor show it.`);
}

// Kernels
const engine = read('docs', 'contracts', 'engine.md');
for (const kernel of dirs('crates', 'mrs-engine', 'src', 'kernels')) {
  if (!mentions(engine, `\`${kernel}\``, kernel)) problems.push(`docs/contracts/engine.md does not describe the kernel "${kernel}".`);
}

// Site settings, read from the structs the host parses site.json with.
const manifest = read('crates', 'mrs-site', 'src', 'manifest.rs');
const site = read('docs', 'contracts', 'site.md');
const fields = (struct) => {
  const body = new RegExp(`pub struct ${struct} \\{([\\s\\S]*?)\\n\\}`).exec(manifest)?.[1] ?? '';
  return [...body.matchAll(/^\s*pub (?:r#)?(\w+):/gm)].map((m) => m[1]);
};
for (const [struct, prefix] of [['SiteManifest', ''], ['Table', 'table.'], ['Branding', 'branding.']]) {
  const list = fields(struct);
  if (!list.length) problems.push(`scripts/check-docs.mjs could not read "pub struct ${struct}" in crates/mrs-site/src/manifest.rs; update the check.`);
  for (const f of list) {
    if (!mentions(site, `\`${f}\``, `"${f}"`, `\`${prefix}${f}\``)) problems.push(`docs/contracts/site.md does not describe the site setting "${prefix}${f}".`);
  }
}

// MCP tools
const server = read('packages', 'mcp', 'src', 'server.ts');
const mcpDoc = read('docs', 'MCP.md');
for (const [, tool] of server.matchAll(/registerTool\(\s*'([a-z_]+)'/g)) {
  if (!mentions(mcpDoc, `\`${tool}\``)) problems.push(`docs/MCP.md does not list the MCP tool "${tool}".`);
}

// SDK modules are building blocks the MCP server can offer.
const blocks = read('packages', 'mcp', 'src', 'blocks.ts') + read('docs', 'blocks.md');
const sdk = join(root, 'packages', 'sdk', 'src');
// Plumbing every layer uses, not blocks to offer: the layer API, controls, site data helpers, the projector solve, the phones' link (#275).
const internal = new Set(['index', 'types', 'layer', 'connection', 'frame', 'controls', 'data', 'projector', 'link']);
for (const file of readdirSync(sdk).filter((f) => f.endsWith('.ts'))) {
  const name = file.replace(/\.ts$/, '');
  if (internal.has(name)) continue;
  const text = readFileSync(join(sdk, file), 'utf8');
  const exported = [...text.matchAll(/^export (?:function|class|const) (\w+)/gm)].map((m) => m[1]);
  if (exported.length && !exported.some((e) => blocks.includes(e)) && !blocks.includes(file)) {
    problems.push(`packages/sdk/src/${file} (${exported.slice(0, 3).join(', ')}) is not a building block the MCP server knows. Add it to packages/mcp/src/blocks.ts or docs/blocks.md.`);
  }
}

if (problems.length) {
  console.error(`The docs or the MCP server are behind what is built (${problems.length}):\n\n- ${problems.join('\n- ')}\n`);
  process.exit(1);
}
console.log('Docs and the MCP server cover every layer, kernel, site setting, MCP tool and SDK module.');
