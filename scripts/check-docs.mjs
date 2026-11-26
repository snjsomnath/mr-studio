// Fails when something has been built that the docs or the MCP server do not know about (#269).
// Runs in CI on every pull request; each problem says which file to add it to.
//
//   node scripts/check-docs.mjs
//
// It checks that:
// - every core layer (packages/layers/*/layer.json) is in README.md, docs/ROADMAP.md and the Help's feature list, and says what it is for (about)
//   (docs/guide/features.md), by id or name, and has its own Help page (docs/guide/layers/<id>.md);
// - every request the host answers (a `"x.y" =>` arm in crates/mrs-host/src) is in docs/contracts (#517);
// - every folder docs/ARCHITECTURE.md lists under Workspace exists (#517);
// - every engine kernel (crates/mrs-engine/src/kernels/*) is in docs/contracts/engine.md;
// - every site.json setting (the SiteManifest, Table and Branding structs in mrs-site) is in docs/contracts/site.md;
// - every site.json setting is on a feature card the MCP server suggests, or in NOT_SUGGESTED (packages/mcp/src/suggest.ts);
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
  // What the layer is for (#326): the MCP server's capability catalogue reads it.
  const about = layer.about;
  if (!about || typeof about.purpose !== 'string' || !Array.isArray(about.questions) || !about.questions.length) {
    problems.push(`packages/layers/${dir}/layer.json has no "about" with a purpose and questions (docs/contracts/layer.md): say what the layer helps a group see or do.`);
  } else {
    for (const other of about.pairs_with ?? []) if (!existsSync(join(root, 'packages', 'layers', other, 'layer.json'))) problems.push(`packages/layers/${dir}/layer.json about.pairs_with names '${other}', which is not a core layer.`);
  }
  if (!mentions(features, layer.name, `\`${layer.id}\``)) problems.push(`docs/guide/features.md (the app's Help) does not list the layer "${layer.name ?? layer.id}". Add a section with a picture.`);
  // Its own page in the Help window (#291): what it shows, how to set it up, tips.
  const guide = join(root, 'docs', 'guide', 'layers', `${dir}.md`);
  if (!existsSync(guide)) problems.push(`docs/guide/layers/${dir}.md is missing: the Help window has no page for the layer "${layer.name ?? layer.id}". Copy another layer's page and write what it shows, how to set it up and tips; its settings are added from layer.json.`);
  else {
    const text = readFileSync(guide, 'utf8');
    for (const part of ['## What it shows', '## Set it up']) if (!text.includes(part)) problems.push(`docs/guide/layers/${dir}.md has no "${part}" section.`);
  }
  if (!layer.description) problems.push(`packages/layers/${dir}/layer.json has no "description"; the MCP server and the editor show it.`);
}

// Host requests (#517): every request the host answers is in a contract. A request arm in the
// host's code looks like `"layer.activate" => {` or `"field.remove" | "field.clear" => {`.
const contracts = readdirSync(join(root, 'docs', 'contracts')).filter((f) => f.endsWith('.md')).map((f) => read('docs', 'contracts', f)).join('\n');
const requests = new Set();
for (const file of readdirSync(join(root, 'crates', 'mrs-host', 'src')).filter((f) => f.endsWith('.rs'))) {
  // Tests come last in a file and ask with made-up names.
  const code = read('crates', 'mrs-host', 'src', file).split('#[cfg(test)]')[0];
  for (const arm of code.matchAll(/^\s*((?:"[a-z_]+\.[a-z_.]+"\s*\|?\s*)+)(?:if [^=]*)?=>/gm)) {
    for (const name of arm[1].matchAll(/"([a-z_]+\.[a-z_.]+)"/g)) requests.add(name[1]);
  }
  // And the ones asked for by name: `if method == "history.list"`, `Some("scene.add") =>`.
  for (const name of code.matchAll(/(?:method == |Some\()"([a-z_]+\.[a-z_.]+)"/g)) requests.add(name[1]);
}
for (const name of [...requests].sort()) {
  if (!contracts.includes(`\`${name}\``) && !contracts.includes(`\`${name} `)) problems.push(`docs/contracts does not describe the host request "${name}" (answered in crates/mrs-host/src). Add it to session.md, or to the contract it belongs to.`);
}

// The workspace (#517): every folder docs/ARCHITECTURE.md lists is there.
const workspace = read('docs', 'ARCHITECTURE.md').match(/## Workspace[\s\S]*?```\n([\s\S]*?)```/)?.[1] ?? '';
let parent = '';
for (const line of workspace.split('\n')) {
  const entry = line.match(/^(\s*)([\w.-]+)\/(\s|$)/);
  if (!entry) continue;
  if (entry[1] === '') parent = entry[2];
  const path = entry[1] === '' ? [entry[2]] : [parent, entry[2]];
  if (!existsSync(join(root, ...path))) problems.push(`docs/ARCHITECTURE.md lists the folder ${path.join('/')}/ under Workspace, and there is none. Correct the list.`);
}
if (!workspace) problems.push('docs/ARCHITECTURE.md has no "## Workspace" section with the list of folders.');

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

// Feature cards (#477): every site setting is either a card the MCP server can suggest, or set up and listed in NOT_SUGGESTED.
const suggestTs = read('packages', 'mcp', 'src', 'suggest.ts');
const covered = new Set([...suggestTs.matchAll(/(?:covers: |NOT_SUGGESTED = )\[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])));
for (const [struct, prefix] of [['SiteManifest', ''], ['Table', 'table.'], ['Branding', 'branding.']]) {
  for (const f of fields(struct)) {
    if (!covered.has(`${prefix}${f}`)) problems.push(`packages/mcp/src/suggest.ts has no feature card that covers the site setting "${prefix}${f}". Add a card to FEATURE_CARDS (what, when it helps, needs, enable), or add it to NOT_SUGGESTED if nobody would want it suggested.`);
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
// Plumbing, not blocks to offer: the layer API, controls, site data helpers, the projector solve, the phones' link (#275), the Ready to present rules (#63).
const internal = new Set(['index', 'types', 'layer', 'connection', 'frame', 'controls', 'data', 'projector', 'link', 'readiness']);
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
