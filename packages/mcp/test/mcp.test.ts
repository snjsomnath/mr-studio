// Drives the built server over stdio as an MCP client would, in a scratch folder.
// Run with `pnpm --filter @mrstudio/mcp test` (builds first).

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseRoadmap, parseSiteSchema } from '../src/core.ts';
import { checkControlValue } from '../src/site.ts';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = join(pkg, 'dist', 'mrstudio-mcp.mjs');

// No GitHub credentials and no gh on PATH, so nothing can be posted by a test.
const safeEnv = { PATH: dirname(process.execPath), MRSTUDIO_REPO: 'example/not-a-repo', MRSTUDIO_CLI: join(tmpdir(), 'no-cli-here') };

async function connect(script: string, cwd: string, args: string[] = []): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [script, ...args], cwd, env: safeEnv, stderr: 'ignore' }));
  return client;
}

type Result = { content: { type: string; text: string }[]; isError?: boolean };
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean; data: any }> {
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
  return { text, isError: Boolean(result.isError), data };
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
    for (const name of ['overview', 'read_doc', 'list_layers', 'describe_layer', 'list_building_blocks', 'create_site', 'get_site', 'update_site', 'add_layer', 'set_layer', 'move_layer', 'remove_layer', 'validate_site', 'preview_site', 'check_layer_idea', 'draft_module_request', 'submit_module_request']) {
      assert.ok(tools.includes(name), `missing tool ${name}`);
    }
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name).sort();
    assert.deepEqual(prompts, ['brainstorm_layer', 'design_dashboard', 'new_project', 'request_module']);
    const prompt = await client.getPrompt({ name: 'brainstorm_layer', arguments: { idea: 'buses moving' } });
    assert.match((prompt.messages[0]!.content as { text: string }).text, /check_layer_idea/);
    const docs = await client.listResources();
    assert.ok(docs.resources.some((r) => r.uri === 'mrstudio://docs/contracts/site'));
    const site = await client.readResource({ uri: 'mrstudio://docs/contracts/site' });
    assert.match(String((site.contents[0] as { text: string }).text), /Site package contract/);
    const instructions = client.getInstructions() ?? '';
    assert.match(instructions, /Configure, do not code/);
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
    assert.equal(JSON.parse(readFileSync(join(dir, 'site.json'), 'utf8')).layers.length, 1);

    // A value is snapped like the host would, with a warning.
    const set = await call(client, 'set_layer', { site: 'harbour', use: 'sunlight', params: { hour: 17.03, date: '2026-09-22' } });
    assert.equal(set.isError, false, set.text);
    const manifest = JSON.parse(readFileSync(join(dir, 'site.json'), 'utf8'));
    assert.equal(manifest.layers[0].params.hour, 17.05);

    // A second sunlight is allowed but flagged, then moved and removed.
    assert.equal((await call(client, 'add_layer', { site: 'harbour', use: 'sunlight', params: { mode: 'day' }, position: 0 })).isError, false);
    const two = await call(client, 'get_site', { site: 'harbour' });
    assert.equal(two.data.scene.length, 2);
    assert.ok(two.data.issues.some((i: any) => /again/.test(i.message)));
    assert.equal((await call(client, 'move_layer', { site: 'harbour', index: 0, to: 1 })).isError, false);
    assert.equal((await call(client, 'set_layer', { site: 'harbour', use: 'sunlight', active: false })).isError, true, 'ambiguous use needs an index');
    assert.equal((await call(client, 'remove_layer', { site: 'harbour', index: 1 })).isError, false);

    // Settings: allowed keys merge; unknown keys point at a module request.
    assert.equal((await call(client, 'update_site', { site: 'harbour', set: { basemap: { background: '#101418' } } })).isError, false);
    const welcome = await call(client, 'update_site', { site: 'harbour', set: { welcome: { title: 'Hi' } } });
    assert.equal(welcome.isError, true);
    assert.match(welcome.text, /module request/);
    const badLogo = await call(client, 'update_site', { site: 'harbour', set: { branding: { logo: '../logo.png' } } });
    assert.equal(badLogo.isError, true);

    const valid = await call(client, 'validate_site', { site: 'harbour', run_cli: false });
    assert.equal(valid.isError, false, valid.text);
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
    assert.ok(invalid.data.issues.some((i: any) => i.path === 'layers[1].use'));
  });

  test('routes layer ideas to configuration or a core request', async () => {
    const sun = await call(client, 'check_layer_idea', {
      title: 'Afternoon shadows on the square', description: 'Show shadows and sun hours on the new square for an autumn date', kernels: ['sunlight'], blocks: ['field overlay', 'time control'],
    });
    assert.equal(sun.data.verdict, 'use-existing', sun.text);

    const buses = await call(client, 'check_layer_idea', {
      title: 'Buses on the table', description: 'Buses moving along their routes from the timetable', blocks: ['animated paths', 'live feed', 'markers'],
    });
    assert.equal(buses.data.verdict, 'needs-new-module', buses.text);
    assert.ok(buses.data.roadmap.some((r: any) => r.layer === 'Public transport'));

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
    assert.equal(submit.isError, false, submit.text);
    assert.match(submit.text, /Not sent/);
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
