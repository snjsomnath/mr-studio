// Drives the built server over stdio as an MCP client would, in a scratch folder.
// Run with `pnpm --filter @mrstudio/mcp test` (builds first).

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildCapabilities, parsePatterns, rank } from '../src/capabilities.ts';
import { loadLive, parseRoadmap, parseSiteSchema, plannedKernelsFrom } from '../src/core.ts';
import { checkPaint, checkRecipe } from '../src/recipe.ts';
import { checkControlValue, previewPlan } from '../src/site.ts';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = join(pkg, 'dist', 'mrstudio-mcp.mjs');

// No GitHub credentials and no gh on PATH, so nothing can be posted by a test.
// GitHub is a dead local address unless a test stands one in, so a test can never reach the real one.
const safeEnv = { PATH: dirname(process.execPath), MRSTUDIO_REPO: 'example/not-a-repo', MRSTUDIO_CLI: join(tmpdir(), 'no-cli-here'), MRSTUDIO_GITHUB_API: 'http://127.0.0.1:9', MRSTUDIO_NO_GH: '1' };

async function connect(script: string, cwd: string, args: string[] = [], env: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [script, ...args], cwd, env: { ...safeEnv, ...env }, stderr: 'ignore' }));
  return client;
}

type Result = { content: { type: string; text: string }[]; isError?: boolean; structuredContent?: any };
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean; data: any; structured: any }> {
  const result = (await client.callTool({ name, arguments: args })) as Result;
  const text = result.content.map((c) => c.text).join('\n');
  const brace = text.indexOf('\n\n{');
  let data: any = null;
  if (brace >= 0) {
    try {
      data = JSON.parse(text.slice(brace + 2));
    } catch {
      data = null;
    }
  }
  return { text, isError: Boolean(result.isError), data, structured: result.structuredContent ?? null };
}

describe('unit', () => {
  test('controls follow the host rules', () => {
    const range = { type: 'range', min: 0, max: 24, step: 0.25 };
    assert.deepEqual(checkControlValue(range, 12.5), { ok: true, value: 12.5 });
    assert.equal(checkControlValue(range, 30).value, 24);
    assert.equal(checkControlValue(range, 12.3).value, 12.25);
    assert.equal(checkControlValue(range, '12').ok, false);
    assert.equal(checkControlValue({ type: 'select', options: [{ value: 'a' }] }, 'b').ok, false);
    assert.equal(checkControlValue({ type: 'date' }, '2026-13-01').ok, false);
    assert.equal(checkControlValue({ type: 'color' }, '#00ff00').ok, true);
  });

  test('site keys come from the core manifest structs', () => {
    const schema = parseSiteSchema(`
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Mesh {
    pub path: String,
    #[serde(default)]
    pub unit_m: f64,
}
pub struct SceneSpec {
    pub cell_m: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh: Option<Mesh>,
}
pub struct LayerRef {
    pub r#use: String,
}
pub struct SiteManifest {
    pub id: String,
    pub scene: SceneSpec,
    #[serde(default)]
    pub layers: Vec<LayerRef>,
}
impl Mesh {
    pub fn area(&self) -> f64 { 0.0 }
}
`)!;
    assert.deepEqual(schema[''], { fields: ['id', 'scene', 'layers'], required: ['id', 'scene'] });
    assert.deepEqual(schema['scene.mesh'], { fields: ['path', 'unit_m'], required: ['path'] });
    assert.deepEqual(schema['layers[]'], { fields: ['use'], required: ['use'] });
  });

  test('roadmap tables become rows', () => {
    const rows = parseRoadmap('## Climate\n\n| Layer | Kernel | Blocks |\n| --- | --- | --- |\n| Sun | `sunlight` (built) | field overlay |\n| Wind | **`wind`** | particles |\n');
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.built, true);
    assert.equal(rows[1]!.section, 'Climate');
  });

  test('the Built table is read by its headers, so packages are never planned kernels (#319)', () => {
    const rows = parseRoadmap('## Climate\n\n| Layer | Kernel | Blocks |\n| --- | --- | --- |\n| Heat | **`thermal`** | field overlay |\n\n## Built\n\n| Layer | Package | Kernel | Notes |\n| --- | --- | --- | --- |\n| Public transport | `transit` | none | live |\n| Sunlight | `sunlight` | `sunlight` | shadows |\n');
    const transit = rows.find((r) => r.layer === 'Public transport')!;
    assert.equal(transit.kernel, 'none');
    assert.equal(transit.package, 'transit');
    assert.equal(transit.built, true);
    assert.deepEqual(plannedKernelsFrom(rows, ['sunlight'], ['transit', 'sunlight']), ['thermal']);

    const live = loadLive(resolve(pkg, '..', '..'));
    const layerIds = live.layers.map((l) => l.id);
    assert.deepEqual(live.plannedKernels.filter((k) => layerIds.includes(k)), [], 'no core layer is a planned kernel');
    for (const k of ['thermal', 'plume', 'drift', 'noise', 'isochrone']) assert.ok(live.plannedKernels.includes(k), `${k} is planned`);
  });

  test('recipes are checked against the recipe player (#321)', () => {
    const issues = checkRecipe(
      {
        name: 'Junk',
        icon: 'unicorn',
        look: [
          { id: 'a', block: 'extrude', data: 'd', props: { wobble: 3 } },
          { id: 'b', block: 'fill', data: 'd', props: { color: 'red', wobble: 3 } },
          { id: 'c', block: 'points', data: 'd', props: { color: { by: 'kind', kind: 'number', ramp: 'green' }, icon: 'rocket' } },
          { id: 'e', block: 'lines', data: 'd', props: { color: '@accent', dash: 'dashed' } },
        ],
        motion: [
          { id: 'm', block: 'flow', on: 'c', props: {} },
          { id: 'n', block: 'wiggle', on: 'e', props: {} },
          { id: 'o', block: 'draw-in', on: 'e', props: { duration_s: 1, speed: 2 } },
        ],
      },
      'custom.junk',
    );
    const at = (path: string) => issues.filter((i) => i.path === path);
    assert.match(at('custom.junk.look[0].block')[0]!.message, /not a look block/);
    assert.equal(at('custom.junk.look[1].props.color')[0]!.level, 'error');
    assert.equal(at('custom.junk.look[1].props.wobble')[0]!.level, 'error');
    assert.match(at('custom.junk.look[2].props.color')[0]!.message, /not a ramp/);
    assert.match(at('custom.junk.look[2].props.icon')[0]!.message, /not a pictogram/);
    assert.equal(at('custom.junk.look[3].props.color').length + at('custom.junk.look[3].props.dash').length, 0, 'good props pass');
    assert.match(at('custom.junk.motion[0].block')[0]!.message, /does not act on a points look/);
    assert.match(at('custom.junk.motion[1].block')[0]!.message, /not a motion block/);
    assert.equal(at('custom.junk.motion[2].props.speed')[0]!.level, 'error');
    assert.equal(at('custom.junk.icon')[0]!.level, 'warning');
    assert.equal(checkPaint('@accent'), null);
    assert.equal(checkPaint('#12ab9f'), null);
    assert.match(checkPaint('@nope')!, /palette slot/);
  });

  test('the capability catalogue is honest and every pattern resolves (#326)', () => {
    const catalog = loadLive(resolve(pkg, '..', '..'));
    const caps = buildCapabilities(catalog);
    const byId = new Map(caps.map((c) => [c.id, c]));
    // Every core layer is a capability, available or needing setup, with its purpose from layer.json.
    for (const l of catalog.layers) {
      const c = byId.get(`layer:${l.id}`);
      assert.ok(c, `layer ${l.id} missing`);
      assert.ok(['available', 'needs_setup'].includes(c!.status), `${l.id} is ${c!.status}`);
      assert.ok(c!.purpose, `${l.id} has no about.purpose`);
      assert.ok(c!.evidence.length, `${l.id} has no evidence`);
    }
    // Constraints are unsupported; nothing built is also listed as planned.
    assert.equal(byId.get('constraint:table-3d')?.status, 'unsupported');
    assert.equal(byId.get('constraint:hand-tracking')?.status, 'unsupported');
    const planned = caps.filter((c) => c.status === 'planned').map((c) => c.name.toLowerCase());
    for (const built of ['ambient cars and people', 'guided tours']) assert.ok(!planned.includes(built), `${built} is built, not planned`);
    // Every capability a pattern names exists.
    const patterns = parsePatterns(catalog.docs['experience-design'] ?? '');
    assert.ok(patterns.length >= 8);
    for (const p of patterns) for (const id of p.capabilities) assert.ok(byId.has(id), `pattern ${p.id} names unknown ${id}`);
    // Plain-language goals reach the layers that serve them.
    const top = (q: string, n = 6) => rank(caps, q).slice(0, n).map((m) => m.capability.id);
    assert.ok(top('pedestrian comfort in summer heat').includes('layer:coolpaths'));
    assert.ok(top('what can people see from this square').includes('layer:isovist'));
    assert.ok(top('flooding in a cloudburst').includes('layer:stormwater'));
    assert.ok(top('residents place ideas on the map').includes('layer:sketch'));
  });

  test('the preview avoids the app port and serves surfaces it can find (#322)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mrstudio-core-'));
    const cli = join(root, 'mrstudio');
    for (const d of ['packages/runtime/dist', 'packages/layers']) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(cli, '');
    const before = process.env.MRSTUDIO_CLI;
    process.env.MRSTUDIO_CLI = cli;
    try {
      const plan = await previewPlan(join(root, 'site'), { root } as any, { lan: false });
      assert.equal(plan.how, 'cli');
      assert.notEqual(plan.port, 4170);
      assert.match(plan.command!, /--port \d+ --web .*runtime.dist --layers .*layers/);
      assert.match(plan.urls!.editor, /\/edit$/);
      assert.match(plan.urls!.guide, /\/guide$/);
      assert.match(plan.urls!.controller, /\/tv$/);
    } finally {
      if (before === undefined) delete process.env.MRSTUDIO_CLI;
      else process.env.MRSTUDIO_CLI = before;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('server over stdio', () => {
  let work: string;
  let client: Client;

  before(async () => {
    assert.ok(existsSync(bundle), 'run the build first');
    work = mkdtempSync(join(tmpdir(), 'mrstudio-mcp-'));
    client = await connect(bundle, work, ['--project', work]);
  });
  after(async () => {
    await client?.close();
    rmSync(work, { recursive: true, force: true });
  });

  test('offers tools, prompts and docs', async () => {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    for (const name of ['overview', 'read_doc', 'list_layers', 'describe_layer', 'list_building_blocks', 'find_capabilities', 'describe_capability', 'assess_experience', 'build_experience', 'list_site_files', 'find_related_issues', 'draft_development_request', 'submit_development_request', 'create_site', 'get_site', 'update_site', 'add_layer', 'set_layer', 'move_layer', 'remove_layer', 'validate_site', 'preview_site', 'check_layer_idea', 'draft_module_request', 'submit_module_request', 'whats_new']) {
      assert.ok(tools.includes(name), `missing tool ${name}`);
    }
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name).sort();
    assert.deepEqual(prompts, ['brainstorm_layer', 'build_from_data', 'compare_scenarios', 'design_dashboard', 'design_experience', 'new_project', 'plan_workshop', 'request_module']);
    const design = await client.getPrompt({ name: 'design_experience', arguments: { goal: 'residents see the new blocks' } });
    assert.match((design.messages[0]!.content as { text: string }).text, /assess_experience/);
    const prompt = await client.getPrompt({ name: 'brainstorm_layer', arguments: { idea: 'buses moving' } });
    assert.match((prompt.messages[0]!.content as { text: string }).text, /check_layer_idea/);
    const docs = await client.listResources();
    assert.ok(docs.resources.some((r) => r.uri === 'mrstudio://docs/contracts/site'));
    const site = await client.readResource({ uri: 'mrstudio://docs/contracts/site' });
    assert.match(String((site.contents[0] as { text: string }).text), /Site package contract/);
    const instructions = client.getInstructions() ?? '';
    assert.match(instructions, /Configure, do not code/);
  });

  test('every tool says what it touches and returns structured results (#325)', async () => {
    const tools = (await client.listTools()).tools;
    for (const t of tools) {
      assert.equal(typeof t.annotations?.readOnlyHint, 'boolean', `${t.name} has readOnlyHint`);
      assert.equal(typeof t.annotations?.openWorldHint, 'boolean', `${t.name} has openWorldHint`);
      if (!t.annotations?.readOnlyHint) assert.equal(typeof t.annotations?.destructiveHint, 'boolean', `${t.name} has destructiveHint`);
      assert.ok(t.outputSchema, `${t.name} has an output schema`);
    }
    const steps = tools.find((t) => t.name === 'set_steps')!;
    assert.match(steps.description!, /notes/, 'set_steps documents presenter notes (#323)');
    const overview = await call(client, 'overview');
    assert.equal(overview.structured.ok, true);
    assert.equal(typeof overview.structured.summary, 'string');
    const missing = await call(client, 'describe_layer', { layer: 'teleporter' });
    assert.equal(missing.structured.ok, false);
    assert.equal(missing.structured.error.code, 'unknown_layer');
    assert.equal(missing.structured.error.recoverable, true);
    assert.ok(Array.isArray(missing.structured.error.next));
    const v = (await client.getServerVersion())!.version;
    assert.match(v, /^\d+\.\d+\.\d+/);
    assert.notEqual(v, '0.1.0');
  });

  test('finds capabilities for a goal and reads them as resources (#326)', async () => {
    const found = await call(client, 'find_capabilities', { goal: 'show residents how a new building changes sunlight', limit: 8 });
    assert.equal(found.isError, false, found.text);
    const ids = found.structured.matches.map((m: any) => m.id);
    assert.ok(ids.includes('layer:sunlight'), ids.join(', '));
    const sun = found.structured.matches.find((m: any) => m.id === 'layer:sunlight');
    assert.ok(sun.matched.length && sun.surfaces.table && sun.evidence.length);
    const missing = await call(client, 'find_capabilities', { kind: 'constraint' });
    assert.ok(missing.structured.matches.every((m: any) => m.status === 'unsupported'));
    const one = await call(client, 'describe_capability', { id: 'sunlight' });
    assert.equal(one.structured.id, 'layer:sunlight');
    assert.ok(one.structured.controls.length);
    const bad = await call(client, 'describe_capability', { id: 'layer:sunlite' });
    assert.equal(bad.structured.error.code, 'unknown_capability');
    assert.ok(bad.structured.similar.includes('layer:sunlight'));

    const read = async (uri: string) => String(((await client.readResource({ uri })).contents[0] as { text: string }).text);
    assert.match(await read('mrstudio://concepts'), /three surfaces/);
    assert.match(await read('mrstudio://patterns/map-it-together'), /layer:sketch/);
    assert.ok(JSON.parse(await read('mrstudio://capabilities')).length > 50);
    assert.equal(JSON.parse(await read('mrstudio://capabilities/layer:sketch')).id, 'layer:sketch');
    assert.ok(JSON.parse(await read('mrstudio://schema/recipe')).look.points);
    assert.ok(JSON.parse(await read('mrstudio://schema/site')));
    const listed = (await client.listResources()).resources.map((r) => r.uri);
    assert.ok(listed.some((u) => u.startsWith('mrstudio://examples/')), 'no example sites listed');
  });

  test('designs an experience from a goal, builds what exists and lists the gaps (#327)', async () => {
    const plan = {
      title: 'Harbour 2040',
      goal: 'Residents understand how the proposed development changes sunlight and wind, and contribute ideas',
      at_rest: ['cars', 'trees'],
      steps: [
        { title: 'The harbour today', want: "today's place with the proposal plan revealed phase by phase", notes: 'Ask where people live.' },
        { title: 'Winter shadows', use: 'sunlight', with: ['transit'], controller: 'Shadows on 21 December', notes: 'Which spots lose sun?' },
        { title: 'Wind between the blocks', want: 'how wind moves between the new buildings, draughty corners' },
        { title: 'Your ideas', want: 'residents place ideas and draw routes from their phones' },
        { title: 'Buildings in 3D', want: 'the new buildings extruded in 3D so people see their height' },
      ],
      needs: ["people vote on each other's ideas", 'export the ideas to a report'],
    };
    const a = await call(client, 'assess_experience', plan);
    assert.equal(a.isError, false, a.text);
    assert.equal(a.structured.verdict, 'partly_buildable');
    assert.deepEqual(a.structured.steps.map((s: any) => s.layer?.use ?? null), ['plan', 'sunlight', 'wind', 'sketch', null]);
    assert.equal(a.structured.steps[4].status, 'unsupported');
    assert.equal(a.structured.steps[4].constraint.id, 'constraint:table-3d');
    const vote = a.structured.needs[0];
    assert.equal(vote.gap.kind, 'layer-enhancement');
    assert.deepEqual(vote.gap.related, ['layer:sketch']);
    assert.equal(a.structured.needs[1].status, 'needs_development', 'Sketch does not export reports');

    // A step naming a block, not a layer, is refused with layers to use instead.
    const wrong = await call(client, 'assess_experience', { title: 'x', goal: 'x', steps: [{ title: 'Pick a spot', use: 'block:engine-probe' }] });
    assert.equal(wrong.structured.verdict, 'needs_development');
    assert.match(wrong.structured.steps[0].issues[0].message, /is a block, not a layer/);

    assert.equal((await call(client, 'create_site', { dir: 'harbour-2040', name: 'Harbour 2040', lon: 11.94, lat: 57.7, width_m: 1200, height_m: 720, timezone: 'Europe/Stockholm' })).isError, false);
    const b = await call(client, 'build_experience', { site: 'harbour-2040', ...plan });
    assert.equal(b.isError, false, b.text);
    assert.deepEqual(b.structured.skipped.map((s: any) => s.step), ['Buildings in 3D']);
    assert.equal(b.structured.gaps.length, 2);
    const site = JSON.parse(readFileSync(join(work, 'harbour-2040', 'site.json'), 'utf8'));
    const story = site.layers.find((l: any) => l.use === 'slideshow');
    assert.equal(story.button.name, 'Harbour 2040');
    assert.deepEqual(story.steps.sequence.map((s: any) => s.layer), ['plan', 'sunlight', 'wind', 'sketch']);
    assert.equal(story.steps.sequence[1].notes, 'Which spots lose sun?');
    assert.equal(story.steps.sequence[1].description, 'Shadows on 21 December');
    assert.deepEqual(site.layers.find((l: any) => l.id === 'sunlight').items.map((i: any) => i.use), ['transit']);
    assert.equal(site.layers.find((l: any) => l.use === 'cars').active, true);
    assert.ok(!site.layers.some((l: any) => l.use === 'blocks-demo'));
    // Building twice changes nothing new.
    const again = await call(client, 'build_experience', { site: 'harbour-2040', ...plan });
    assert.deepEqual(again.structured.built, []);
    assert.equal((await call(client, 'validate_site', { site: 'harbour-2040' })).isError, false);

    const idea = await call(client, 'check_layer_idea', { title: 'Ambient trams', description: 'Trams moving along their lines' });
    assert.equal(idea.structured.assessment.step.layer.use, 'transit');
  });

  test('knows the core layers and docs', async () => {
    const layers = await call(client, 'list_layers');
    assert.ok(layers.data.available.some((l: any) => l.use === 'sunlight'));
    assert.ok(layers.data.planned.length > 10);
    const sun = await call(client, 'describe_layer', { layer: 'sunlight' });
    assert.ok(sun.data.controls.some((c: any) => c.id === 'hour'));
    const doc = await call(client, 'read_doc', { name: 'site' });
    assert.match(doc.text, /A site is a folder/);
    const missing = await call(client, 'describe_layer', { layer: 'teleporter' });
    assert.equal(missing.isError, true);
  });

  test("says what's new and knows the recent building blocks", async () => {
    const news = await call(client, 'whats_new');
    assert.ok(!news.isError, news.text);
    const blocks = await call(client, 'list_building_blocks');
    const built = new Set(blocks.data.blocks.filter((b: any) => b.status === 'built').map((b: any) => b.id));
    for (const id of ['marks', 'place-motions', 'palette', 'ribbons', 'engine-probe', 'street-network', 'thermal-comfort', 'view-analysis', 'sound', 'languages', 'guided-tour', 'attract-loop']) {
      assert.ok(built.has(id), `block ${id} should be found in the core source`);
    }
  });

  test('assembles a site through the tools', async () => {
    const created = await call(client, 'create_site', {
      dir: 'harbour', name: 'Harbour district', lon: 11.94, lat: 57.705, width_m: 1200, height_m: 720, timezone: 'Europe/Stockholm', title: 'Harbour 2040',
    });
    assert.equal(created.isError, false, created.text);
    const dir = join(work, 'harbour');
    assert.ok(existsSync(join(dir, 'site.json')) && existsSync(join(dir, 'README.md')) && existsSync(join(dir, 'requests')));
    assert.equal((await call(client, 'create_site', { dir: 'harbour', name: 'x', lon: 0, lat: 0, width_m: 1, height_m: 1, timezone: 'UTC' })).isError, true);

    // Bad params are refused and nothing is written.
    const bad = await call(client, 'add_layer', { site: 'harbour', use: 'sunlight', params: { mode: 'night', nope: 1 } });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /no control 'nope'/);
    assert.equal(JSON.parse(readFileSync(join(dir, 'site.json'), 'utf8')).layers.length, 2);

    // A value is snapped like the host would, with a warning.
    const set = await call(client, 'set_layer', { site: 'harbour', use: 'sunlight', params: { hour: 17.03, date: '2026-09-22' } });
    assert.equal(set.isError, false, set.text);
    const manifest = JSON.parse(readFileSync(join(dir, 'site.json'), 'utf8'));
    // A new site starts with the base map under the sunlight.
    assert.deepEqual(manifest.layers.map((l: any) => l.use), ['basemap', 'sunlight']);
    assert.equal(manifest.layers[1].params.hour, 17.05);

    // A second sunlight gets its own id; then it is moved and removed by that id.
    assert.deepEqual(manifest.layers.map((l: any) => l.id), ['basemap', 'sunlight'], 'every entry has its id');
    assert.equal((await call(client, 'add_layer', { site: 'harbour', use: 'sunlight', params: { mode: 'day' }, position: 0 })).isError, false);
    const two = await call(client, 'get_site', { site: 'harbour' });
    assert.equal(two.data.scene.length, 3);
    assert.equal(two.data.scene[0].id, 'sunlight-2');
    assert.equal((await call(client, 'move_layer', { site: 'harbour', id: 'sunlight-2', to: 1 })).isError, false);
    assert.equal((await call(client, 'set_layer', { site: 'harbour', use: 'sunlight', active: false })).isError, true, 'ambiguous use needs an id');
    assert.equal((await call(client, 'add_layer', { site: 'harbour', use: 'trees', id: 'sunlight' })).isError, true, 'ids are unique');

    // Items: trees that show only with the sun study, and a button in a group.
    const item = await call(client, 'add_layer', { site: 'harbour', use: 'trees', parent: 'sunlight' });
    assert.equal(item.isError, false, item.text);
    assert.equal((await call(client, 'set_layer', { site: 'harbour', id: 'trees', button: { name: 'Trees' } })).isError, true, 'an item has no button');
    assert.equal((await call(client, 'set_layer', { site: 'harbour', id: 'sunlight', button: { group: 'Simulations', order: 1 } })).isError, false);
    let saved = JSON.parse(readFileSync(join(dir, 'site.json'), 'utf8'));
    const sun = saved.layers.find((l: any) => l.id === 'sunlight');
    assert.deepEqual(sun.items, [{ use: 'trees', id: 'trees' }]);
    assert.deepEqual(sun.button, { group: 'Simulations', order: 1 });

    // A sequence: only the slideshow may show other layers, and only layers that exist.
    assert.equal((await call(client, 'add_layer', { site: 'harbour', use: 'slideshow', id: 'tour' })).isError, false);
    const steps = { mode: 'manual', loop: true, sequence: [{ layer: 'sunlight', params: { hour: 9 }, title: 'Morning' }, { layer: 'sunlight-2' }] };
    const setSteps = await call(client, 'set_steps', { site: 'harbour', id: 'tour', steps });
    assert.equal(setSteps.isError, false, setSteps.text);
    assert.equal((await call(client, 'set_steps', { site: 'harbour', id: 'tour', steps: { sequence: [{ layer: 'ghost' }] } })).isError, true);
    // Presenter notes are kept (#323).
    const noted = await call(client, 'set_steps', { site: 'harbour', id: 'tour', steps: { ...steps, sequence: [{ ...steps.sequence[0], notes: 'Ask who walks here at nine.' }, steps.sequence[1]] } });
    assert.equal(noted.isError, false, noted.text);
    assert.equal(JSON.parse(readFileSync(join(dir, 'site.json'), 'utf8')).layers.find((l: any) => l.id === 'tour').steps.sequence[0].notes, 'Ask who walks here at nine.');
    // A picture that is not in the site is refused (#321).
    const pic = await call(client, 'add_layer', { site: 'harbour', use: 'media', id: 'pic', params: { file: 'data/media/missing.mp4' } });
    assert.equal(pic.isError, true, pic.text);
    assert.match(pic.text, /missing\.mp4 does not exist/);
    // A refusal never reads as a success.
    assert.doesNotMatch(pic.structured.summary, /Added/);
    assert.equal(pic.structured.error.code, 'would_invalidate');
    assert.equal((await call(client, 'set_steps', { site: 'harbour', id: 'sunlight', steps: { sequence: [{ layer: 'tour' }] } })).isError, true);

    // Custom layers: saved recipes, used as custom:<id>, refused while in use.
    const recipe = { name: 'Bright paths', data: [{ id: 'aerial', wms: { url: 'https://example.org/wms', layers: 'ortho' } }], look: [{ id: 'photo', block: 'raster', data: 'aerial' }] };
    assert.equal((await call(client, 'save_custom_layer', { site: 'harbour', id: 'bright', recipe })).isError, false);
    // The legend is worked out from the looks and their data, as the editor does (#326).
    mkdirSync(join(dir, 'data', 'zones'), { recursive: true });
    const square = (x: number) => [[[x, 57.7], [x + 0.001, 57.7], [x + 0.001, 57.701], [x, 57.701], [x, 57.7]]];
    writeFileSync(join(dir, 'data', 'zones', 'use.geojson'), JSON.stringify({ type: 'FeatureCollection', features: ['homes', 'shops', 'park'].map((use, i) => ({ type: 'Feature', properties: { use }, geometry: { type: 'Polygon', coordinates: square(11.9 + i * 0.002) } })) }));
    const zones = await call(client, 'save_custom_layer', { site: 'harbour', id: 'zones', recipe: { name: 'Land use', data: [{ id: 'z', path: 'data/zones/use.geojson' }], look: [{ id: 'fill', block: 'fill', data: 'z', props: { color: { by: 'use', kind: 'category' } } }] } });
    assert.equal(zones.isError, false, zones.text);
    const legend = JSON.parse(readFileSync(join(dir, 'site.json'), 'utf8')).custom.zones.legend;
    assert.deepEqual(legend.map((r: any) => r.label).sort(), ['homes', 'park', 'shops']);
    assert.match(zones.structured.summary, /legend has 3 rows/);
    // The files tool sees the dataset, its category column and who uses it (#320).
    writeFileSync(join(dir, 'data', 'zones', 'spots.csv'), 'name,lon,lat,visitors\nPier,11.90,57.70,120\n"Old, dock",11.91,57.701,40\n');
    const files = await call(client, 'list_site_files', { site: 'harbour' });
    assert.equal(files.isError, false, files.text);
    const use = files.structured.files.find((f: any) => f.path === 'data/zones/use.geojson');
    assert.equal(use.features, 3);
    assert.deepEqual(use.geometry, ['Polygon']);
    assert.deepEqual(use.columns.find((c: any) => c.name === 'use').values, ['homes', 'park', 'shops']);
    assert.deepEqual(use.used_by, ['custom.zones.data.z']);
    const spots = files.structured.files.find((f: any) => f.path === 'data/zones/spots.csv');
    assert.equal(spots.points, true);
    assert.equal(spots.features, 2);
    assert.deepEqual(spots.columns.find((c: any) => c.name === 'visitors').range, [40, 120]);
    assert.deepEqual(spots.used_by, []);
    assert.equal((await call(client, 'save_custom_layer', { site: 'harbour', id: 'broken', recipe: { name: 'x', look: [{ id: 'a', block: 'lines', data: 'nope' }] } })).isError, true);
    const junk = await call(client, 'save_custom_layer', { site: 'harbour', id: 'junk', recipe: { name: 'Junk', data: [{ id: 'd', wms: { url: 'https://example.org/wms', layers: 'x' } }], look: [{ id: 'a', block: 'extrude', data: 'd', props: { wobble: 3 } }] } });
    assert.equal(junk.isError, true, 'unknown blocks are refused (#321)');
    assert.equal(junk.structured.error.code, 'would_invalidate');
    assert.doesNotMatch(junk.structured.summary, /Saved/);
    const custom = await call(client, 'add_layer', { site: 'harbour', use: 'custom:bright' });
    assert.equal(custom.isError, false, custom.text);
    assert.equal((await call(client, 'save_custom_layer', { site: 'harbour', id: 'bright', recipe: null })).isError, true, 'still in use');
    const listed = await call(client, 'list_layers', { site: 'harbour', include_roadmap: false });
    assert.ok(listed.data.available.some((l: any) => l.use === 'custom:bright'));

    // Removing a layer takes its items and the steps that showed it.
    assert.equal((await call(client, 'remove_layer', { site: 'harbour', id: 'sunlight-2' })).isError, false);
    saved = JSON.parse(readFileSync(join(dir, 'site.json'), 'utf8'));
    assert.deepEqual(saved.layers.find((l: any) => l.id === 'tour').steps.sequence.map((s: any) => s.layer), ['sunlight']);

    // Settings: allowed keys merge; unknown keys point at a module request.
    assert.equal((await call(client, 'update_site', { site: 'harbour', set: { basemap: { background: '#101418' } } })).isError, false);
    const welcome = await call(client, 'update_site', { site: 'harbour', set: { welcome: { title: 'Hi' } } });
    assert.equal(welcome.isError, true);
    assert.match(welcome.text, /draft_development_request/);
    assert.equal(welcome.structured.error.code, "unknown_setting");
    const badLogo = await call(client, 'update_site', { site: 'harbour', set: { branding: { logo: '../logo.png' } } });
    assert.equal(badLogo.isError, true);

    const valid = await call(client, 'validate_site', { site: 'harbour', run_cli: false });
    assert.equal(valid.isError, false, valid.text);
    assert.ok(!valid.data.issues.some((i: any) => /check the layer's docs/.test(i.message)), 'no boilerplate data notes (#321)');
    assert.equal(valid.data.cli.ran, false);

    // With the real CLI built (cargo build -p mrs-cli), the app's own check agrees.
    const exe = join(pkg, '..', '..', 'target', 'debug', process.platform === 'win32' ? 'mrstudio.exe' : 'mrstudio');
    if (existsSync(exe)) {
      const withCli = await call(client, 'validate_site', { site: 'harbour' });
      assert.equal(withCli.data.cli.ran, true);
      assert.equal(withCli.data.cli.ok, true, withCli.data.cli.output);
    }

    // Hand edits are caught.
    const broken = JSON.parse(readFileSync(join(dir, 'site.json'), 'utf8'));
    broken.extra = true;
    broken.layers.push({ use: 'no-such-layer' });
    writeFileSync(join(dir, 'site.json'), JSON.stringify(broken));
    const invalid = await call(client, 'validate_site', { site: 'harbour' });
    assert.equal(invalid.isError, true);
    if (invalid.data.cli.ran) assert.equal(invalid.data.cli.ok, false, 'mrstudio validate refuses the unknown key too');
    assert.ok(invalid.data.issues.some((i: any) => i.path === 'extra'));
    assert.ok(invalid.data.issues.some((i: any) => /^layers\[\d+\]\.use$/.test(i.path)));
  });

  test('routes layer ideas to configuration or a core request', async () => {
    const sun = await call(client, 'check_layer_idea', {
      title: 'Afternoon shadows on the square', description: 'Show shadows and sun hours on the new square for an autumn date', kernels: ['sunlight'], blocks: ['field overlay', 'time control'],
    });
    assert.equal(sun.data.verdict, 'use-existing', sun.text);

    // A layer named as a kernel is that layer, not a missing kernel (#319).
    const trams = await call(client, 'check_layer_idea', { title: 'Ambient trams', description: 'Trams moving along their lines while nobody touches the table', kernels: ['transit'] });
    assert.equal(trams.data.verdict, 'use-existing', trams.text);
    assert.equal(trams.data.existing_layers[0].id, 'transit');
    assert.deepEqual(trams.data.missing, []);

    // The service gateway is built (#278): a model behind a layer needs no new module.
    const energy = await call(client, 'check_layer_idea', {
      title: 'Energy use per building', description: 'Energy use of each building computed by an energy model service', blocks: ['service gateway', 'choropleth'],
    });
    assert.notEqual(energy.data.verdict, 'needs-new-module', energy.text);
    assert.ok(!energy.data.missing.some((m: string) => m.includes('service')), energy.text);
    // Something the core does not have still becomes a request.
    const lidar = await call(client, 'check_layer_idea', {
      title: 'Live lidar crowd', description: 'People counted by a lidar scanner', kernels: ['lidar-crowd'],
    });
    assert.equal(lidar.data.verdict, 'needs-new-module', lidar.text);

    const draft = await call(client, 'draft_module_request', {
      site: 'harbour', kind: 'contract', title: 'Welcome screen for the TV and table',
      goal: 'Show a welcome screen with the project title, a short intro and the phone QR code when nobody has touched the table for a while.',
      why: 'site.json has branding (title, logo) but no welcome or attract screen.',
      proposal: 'A "welcome" section in site.json with title, text, image and idle_s, rendered by the runtime on the TV and table.',
      example: { welcome: { title: 'Harbour 2040', text: 'Explore how the harbour changes', idle_s: 120 } },
    });
    assert.equal(draft.isError, false, draft.text);
    assert.ok(existsSync(draft.data.path));
    assert.match(draft.data.issue_link, /^https:\/\/github\.com\/example\/not-a-repo\/issues\/new\?/);
    assert.match(readFileSync(draft.data.path, 'utf8'), /status: draft/);

    // No token and no gh: the server hands back the link and sends nothing.
    const submit = await call(client, 'submit_module_request', { path: draft.data.path });
    assert.equal(submit.isError, true, submit.text);
    assert.match(submit.text, /Not sent/);
    assert.equal(submit.structured.error.code, 'not_submitted');
    assert.equal(submit.structured.submitted, false);
    assert.match(submit.structured.issue_link, /issues\/new/);
  });

  test('works from the embedded snapshot outside a core checkout', async () => {
    const copy = join(work, 'mrstudio-mcp.mjs');
    copyFileSync(bundle, copy);
    const standalone = await connect(copy, work);
    try {
      const overview = await call(standalone, 'overview');
      assert.equal(overview.data.core.source, 'snapshot');
      assert.ok(overview.data.layers.some((l: string) => l.startsWith('sunlight')));
    } finally {
      await standalone.close();
    }
  });
});

describe('development requests against a stand-in GitHub (#328)', () => {
  let work: string;
  let api: Server;
  let base: string;
  const created: any[] = [];
  const existing = [
    { number: 401, title: 'Voting on sketch marks from phones', state: 'open', html_url: 'https://github.com/example/not-a-repo/issues/401', body: 'People want to vote on each other\'s sketch marks.', labels: [{ name: 'phones' }] },
    { number: 402, title: 'Sketch layer polish', state: 'closed', html_url: 'https://github.com/example/not-a-repo/issues/402', body: 'Colours of marks.', labels: [] },
    { number: 403, title: 'Voting PR', state: 'open', html_url: 'https://github.com/example/not-a-repo/pull/403', body: '', labels: [], pull_request: {} },
  ];

  before(async () => {
    work = mkdtempSync(join(tmpdir(), 'mrstudio-dev-'));
    api = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const json = (status: number, body: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        if (req.method === 'GET' && req.url?.startsWith('/search/issues')) {
          assert.match(decodeURIComponent(req.url), /repo:example\/not-a-repo is:issue/);
          return json(200, { items: existing });
        }
        if (req.method === 'POST' && req.url === '/repos/example/not-a-repo/issues') {
          if (req.headers.authorization === 'Bearer forbidden') return json(403, { message: 'Resource not accessible by integration' });
          const body = JSON.parse(raw);
          created.push(body);
          return json(201, { number: 500 + created.length, html_url: `https://github.com/example/not-a-repo/issues/${500 + created.length}`, title: body.title });
        }
        json(404, { message: 'Not Found' });
      });
    });
    await new Promise<void>((done) => api.listen(0, '127.0.0.1', () => done()));
    base = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  });
  after(() => {
    api.close();
    rmSync(work, { recursive: true, force: true });
  });

  const request = (title: string) => ({
    kind: 'layer-change',
    title,
    context: 'Residents at an open evening sketch ideas for the harbour.',
    user_story: 'As a resident, I want to support other people\'s ideas, so that the group sees what matters most.',
    proposal: 'A vote on each sketch mark from the phone; the table grows the mark with its votes.',
    experience: { table: 'Marks grow with votes', controller: 'The most supported ideas', phone: 'A heart on each mark' },
    acceptance: ['A phone can vote once per mark', 'The controller lists the top five marks'],
    related_capabilities: ['layer:sketch'],
    site: 'harbour',
  });

  test('finds an existing issue, refuses a duplicate, sends a batch, and reports only what GitHub returned', async () => {
    const client = await connect(bundle, work, ['--project', work], { MRSTUDIO_GITHUB_API: base, GITHUB_TOKEN: 'test-token' });
    try {
      assert.equal((await call(client, 'create_site', { dir: 'harbour', name: 'Harbour', lon: 11.94, lat: 57.7, width_m: 800, height_m: 500, timezone: 'Europe/Stockholm' })).isError, false);

      const found = await call(client, 'find_related_issues', { title: 'Voting on sketch marks from phones' });
      assert.equal(found.isError, false, found.text);
      assert.deepEqual(found.structured.likely_duplicates, [401]);
      assert.ok(!found.structured.issues.some((i: any) => i.number === 403), 'pull requests are not issues');
      assert.ok(found.structured.capabilities.some((c: any) => c.id === 'layer:sketch'));

      const dup = await call(client, 'draft_development_request', request('Vote on sketch marks from phones'));
      assert.equal(dup.isError, false, dup.text);
      assert.match(dup.text, /#401/);
      assert.deepEqual(dup.structured.labels, ['development-request', 'layer-enhancement', 'needs-triage']);
      for (const heading of ['Context', 'User story', 'Proposed functionality', 'Experience across the table, controller and phones', 'Acceptance criteria', 'Current limitations']) assert.match(dup.structured.body, new RegExp(`### ${heading}`));

      const other = await call(client, 'draft_development_request', { ...request('Export the group\'s ideas as a PDF report'), kind: 'data-integration', context: 'After the evening the planners want the ideas.' });
      assert.deepEqual(other.structured.likely_duplicates, []);

      // One yes for both: the duplicate is held back, the other is sent.
      const batch = await call(client, 'submit_development_request', { paths: [dup.structured.path, other.structured.path] });
      assert.equal(batch.isError, false, batch.text);
      assert.deepEqual(batch.structured.submitted.map((s: any) => s.number), [501]);
      assert.equal(batch.structured.results[0].error.code, 'possible_duplicate');
      assert.equal(batch.structured.results[0].duplicates[0].number, 401);
      assert.equal(created.length, 1);
      assert.deepEqual(created[0].labels, ['development-request', 'data-integration', 'needs-triage']);
      assert.match(readFileSync(other.structured.path, 'utf8'), /status: submitted\nissue: https:\/\/github.com\/example\/not-a-repo\/issues\/501/);

      // The person says it differs from #401: it is sent, and a second send is refused.
      const confirmed = await call(client, 'submit_development_request', { paths: [dup.structured.path], not_duplicate_of: [401] });
      assert.deepEqual(confirmed.structured.submitted, [{ number: 502, url: 'https://github.com/example/not-a-repo/issues/502', title: 'Vote on sketch marks from phones' }]);
      const again = await call(client, 'submit_development_request', { paths: [dup.structured.path], not_duplicate_of: [401] });
      assert.equal(again.isError, true);
      assert.equal(again.structured.error.code, 'already_submitted');
    } finally {
      await client.close();
    }
  });

  test('a refused or missing sign-in sends nothing and hands back the link', async () => {
    const forbidden = await connect(bundle, work, ['--project', work], { MRSTUDIO_GITHUB_API: base, GITHUB_TOKEN: 'forbidden' });
    try {
      const draft = await call(forbidden, 'draft_development_request', { ...request('Sound of the harbour at dawn'), kind: 'new-layer' });
      const sent = await call(forbidden, 'submit_development_request', { paths: [draft.structured.path] });
      assert.equal(sent.isError, true);
      assert.equal(sent.structured.error.code, 'github_forbidden');
      assert.match(sent.structured.results[0].issue_link, /^https:\/\/github\.com\/example\/not-a-repo\/issues\/new\?/);
      assert.doesNotMatch(sent.text, /#5\d\d/);
      assert.match(readFileSync(draft.structured.path, 'utf8'), /status: draft/);
    } finally {
      await forbidden.close();
    }
    const signedOut = await connect(bundle, work, ['--project', work], { MRSTUDIO_GITHUB_API: base });
    try {
      const draft = await call(signedOut, 'draft_development_request', { ...request('Night lighting walk'), kind: 'new-layer' });
      const sent = await call(signedOut, 'submit_development_request', { paths: [draft.structured.path] });
      assert.equal(sent.structured.error.code, 'github_not_signed_in');
      const bad = await call(signedOut, 'draft_development_request', { ...request('x'), kind: 'wish' });
      assert.equal(bad.structured.error.code, 'invalid_params');
    } finally {
      await signedOut.close();
    }
  });
});
