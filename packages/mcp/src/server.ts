// The MR Studio MCP server: tools, prompts and resources over one core catalog.

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

import { loadCatalog, type Catalog, type CoreOptions } from './core.ts';
import { checkIdea } from './ideas.ts';
import { brainstormPrompt, dashboardPrompt, newProjectPrompt, requestPrompt, serverInstructions } from './prompts.ts';
import { REQUEST_KINDS, submitDraft, writeDraft, type RequestKind } from './requests.ts';
import {
  availableLayers,
  checkParams,
  createSite,
  findCli,
  findLayer,
  readSite,
  runCli,
  SITE_FORMAT,
  validateManifest,
  validateSiteDir,
  writeSite,
  type Issue,
  type SiteManifest,
} from './site.ts';

export const SERVER_VERSION = '0.1.0';

export interface ServerOptions extends CoreOptions {
  /** Folder that relative site paths are resolved against. */
  project?: string;
}

type Content = { content: { type: 'text'; text: string }[]; isError?: boolean };

function reply(summary: string, data?: unknown): Content {
  const text = data === undefined ? summary : `${summary}\n\n${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}`;
  return { content: [{ type: 'text', text }] };
}

function fail(message: string, data?: unknown): Content {
  return { ...reply(message, data), isError: true };
}

function counts(issues: Issue[]): string {
  const e = issues.filter((i) => i.level === 'error').length;
  const w = issues.filter((i) => i.level === 'warning').length;
  return e ? `${e} error${e > 1 ? 's' : ''}, ${w} warning${w === 1 ? '' : 's'}` : w ? `valid, ${w} warning${w > 1 ? 's' : ''}` : 'valid';
}

function layerSummary(l: { id: string; origin: string; use: string; manifest: any }) {
  const m = l.manifest;
  return {
    use: l.use,
    name: m.name,
    description: m.description,
    origin: l.origin,
    category: m.category,
    kernels: m.requires?.kernels ?? [],
    data: m.requires?.data ?? [],
    controls: (m.controls ?? []).map((c: any) => c.id),
    tools: (m.tools ?? []).map((t: any) => t.id ?? t.type),
    panels: (m.panels ?? []).map((p: any) => p.id),
  };
}

export function createServer(options: ServerOptions = {}): { server: McpServer; catalog: Catalog } {
  const project = resolve(options.project ?? process.env.MRSTUDIO_PROJECT ?? process.cwd());
  const catalog = loadCatalog({ ...options, searchFrom: [...(options.searchFrom ?? []), project] });
  const at = (p: string) => (isAbsolute(p) ? p : resolve(project, p));

  const server = new McpServer({ name: 'mrstudio', title: 'MR Studio', version: SERVER_VERSION }, { instructions: serverInstructions(catalog) });

  // ---- Knowledge ----

  server.registerTool(
    'overview',
    {
      title: 'MR Studio overview',
      description: 'Start here. What MR Studio is, how a project is structured, what this core offers, and the workflow for building a project with these tools.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      reply(serverInstructions(catalog), {
        core: { version: catalog.version, source: catalog.source, root: catalog.root, site_format: SITE_FORMAT },
        project_folder: project,
        layers: catalog.layers.map((l) => `${l.id}: ${l.manifest.description ?? ''}`),
        kernels: catalog.kernels,
        planned_kernels: catalog.plannedKernels,
        blocks: {
          built: catalog.blocks.filter((b) => b.status === 'built').map((b) => b.id),
          planned: catalog.blocks.filter((b) => b.status === 'planned').map((b) => b.id),
        },
        docs: Object.keys(catalog.docs),
        cli: findCli(catalog) ?? 'not found (install the MR Studio app, or set MRSTUDIO_CLI)',
      }),
  );

  server.registerTool(
    'read_doc',
    {
      title: 'Read an MR Studio doc',
      description: 'Read a core document: "architecture", "roadmap", or a contract such as "contracts/site", "contracts/layer", "contracts/session", "contracts/engine". Call with no name to list them.',
      inputSchema: { name: z.string().optional().describe('Doc name, e.g. "contracts/site"') },
      annotations: { readOnlyHint: true },
    },
    async ({ name }) => {
      if (!name) return reply('Docs in this core:', Object.keys(catalog.docs));
      const key = name.toLowerCase().replace(/\.md$/, '').replace(/^docs\//, '');
      const text = catalog.docs[key] ?? catalog.docs[`contracts/${key}`];
      return text ? reply(text) : fail(`No doc '${name}'. Docs: ${Object.keys(catalog.docs).join(', ')}`);
    },
  );

  server.registerTool(
    'list_layers',
    {
      title: 'List layers',
      description: 'Layers that can go into a scene: the core layers of this MR Studio version (plus a site\'s own, if a site is given), and the planned layers on the roadmap with what each reuses.',
      inputSchema: {
        site: z.string().optional().describe('Site folder, to include its own layers'),
        include_roadmap: z.boolean().optional().describe('Include planned roadmap layers (default true)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ site, include_roadmap }) => {
      const layers = availableLayers(catalog, site ? at(site) : null).map(layerSummary);
      const roadmap = include_roadmap === false ? undefined : catalog.roadmap.filter((r) => !r.built).map((r) => ({ section: r.section, layer: r.layer, kernel: r.kernel, blocks: r.blocks }));
      return reply(`${layers.length} layer${layers.length === 1 ? '' : 's'} available now${roadmap ? `, ${roadmap.length} planned` : ''}. Use describe_layer for controls before setting params.`, { available: layers, planned: roadmap });
    },
  );

  server.registerTool(
    'describe_layer',
    {
      title: 'Describe a layer',
      description: 'The full manifest of a layer: controls (with types, ranges, options and defaults), tools, required kernels and data, TV panels. Use it before choosing params.',
      inputSchema: {
        layer: z.string().describe('Core layer id, or ./layers/<name> for a site layer'),
        site: z.string().optional().describe('Site folder, needed for site layers'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ layer, site }) => {
      const found = findLayer(catalog, site ? at(site) : null, layer);
      if (!found) return fail(`No layer '${layer}'. Core layers: ${catalog.layers.map((l) => l.id).join(', ')}`);
      return reply(`${found.manifest.name} (${found.origin} layer). Params are the control ids; set them in the site's layer entry.`, found.manifest);
    },
  );

  server.registerTool(
    'list_building_blocks',
    {
      title: 'List building blocks',
      description: 'The shared primitives layers are composed from (visuals, data sources, interactions, TV panels), whether each is built or planned in this core, and the kernels. Use it to brainstorm layers as reuse.',
      inputSchema: { group: z.enum(['visual', 'data', 'interaction', 'tv']).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ group }) => {
      const blocks = catalog.blocks.filter((b) => !group || b.group === group).map(({ detect: _d, ...b }) => b);
      return reply('Building blocks. A planned block is a module request, not something to write in a site.', {
        blocks,
        kernels: { built: catalog.kernels, planned: catalog.plannedKernels },
      });
    },
  );

  // ---- Sites ----

  server.registerTool(
    'create_site',
    {
      title: 'Create a site',
      description: 'Create a new MR Studio site package (site.json, data/, requests/, README) in an empty folder. The table area is a width_m by height_m rectangle centred on lon/lat, rotated by rotation_deg.',
      inputSchema: {
        dir: z.string().describe('Folder to create the site in, e.g. "." for the current repository or "sites/harbour"'),
        name: z.string().describe('Display name, e.g. "Harbour district"'),
        id: z.string().optional().describe('Lower-case id; derived from the name if omitted'),
        lon: z.number().describe('Centre longitude, WGS84'),
        lat: z.number().describe('Centre latitude, WGS84'),
        width_m: z.number().positive().describe('Width of the area on the table, metres'),
        height_m: z.number().positive().describe('Height of the area on the table, metres'),
        rotation_deg: z.number().optional().describe("Bearing of the table's top edge, clockwise from north"),
        timezone: z.string().describe('IANA time zone, e.g. Europe/Stockholm'),
        table_width_cm: z.number().positive().optional().describe('Physical table width; height follows the aspect ratio'),
        cell_m: z.number().positive().optional().describe('Simulation cell size in metres (default 1, coarser for big areas)'),
        title: z.string().optional().describe('Title shown on the TV and in the window'),
        layers: z
          .array(z.object({ use: z.string(), active: z.boolean().optional(), params: z.record(z.string(), z.unknown()).optional() }))
          .optional()
          .describe('Initial scene, bottom to top. Default: sunlight, active'),
      },
    },
    async (args) => {
      try {
        const result = createSite({ ...args, dir: at(args.dir) }, catalog);
        if (!result.files.length) return fail('The site was not created:', result.issues);
        return reply(`Created ${result.manifest.name} in ${at(args.dir)} (${counts(result.issues)}). Next: add data to data/, compose the scene with add_layer, then validate_site.`, {
          files: result.files,
          site: result.manifest,
          issues: result.issues,
        });
      } catch (error) {
        return fail((error as Error).message);
      }
    },
  );

  server.registerTool(
    'get_site',
    {
      title: 'Read a site',
      description: "Read a site's site.json, its scene (layers bottom to top with effective params) and its current problems.",
      inputSchema: { site: z.string().describe('Site folder') },
      annotations: { readOnlyHint: true },
    },
    async ({ site }) => {
      const dir = at(site);
      const { manifest, issues } = validateSiteDir(dir, catalog);
      if (!manifest) return fail(issues[0]!.message);
      const scene = (manifest.layers ?? []).map((ref: any, index: number) => {
        const layer = findLayer(catalog, dir, ref.use);
        const defaults = Object.fromEntries((layer?.manifest.controls ?? []).filter((c: any) => c.type !== 'action').map((c: any) => [c.id, c.default]));
        return { index, use: ref.use, name: layer?.manifest.name ?? '(unknown layer)', active: Boolean(ref.active), params: { ...defaults, ...(ref.params ?? {}) }, overrides: ref.params ?? {} };
      });
      return reply(`${manifest.name}: ${scene.length} layer${scene.length === 1 ? '' : 's'}, ${counts(issues)}.`, { scene, issues, manifest });
    },
  );

  const editable = ['name', 'origin', 'extent', 'timezone', 'table', 'scene', 'basemap', 'branding', 'tv'] as const;

  server.registerTool(
    'update_site',
    {
      title: 'Update site settings',
      description:
        'Change site settings other than the scene: name, origin, extent, timezone, table, scene sources (buildings, terrain, trees, cell_m), basemap, branding (title, logo) and tv. Objects are merged one level deep; null removes a key. The change is refused if it makes the site invalid. Use the layer tools for the scene.',
      inputSchema: {
        site: z.string().describe('Site folder'),
        set: z.record(z.string(), z.unknown()).describe('e.g. { "branding": { "title": "Harbour 2040" }, "basemap": { "background": "#101418" } }'),
      },
    },
    async ({ site, set }) => {
      const dir = at(site);
      let manifest: SiteManifest;
      try {
        manifest = readSite(dir);
      } catch (error) {
        return fail((error as Error).message);
      }
      const next: SiteManifest = structuredClone(manifest);
      for (const [key, value] of Object.entries(set)) {
        if (key === 'layers') return fail('Use add_layer, set_layer, move_layer and remove_layer to change the scene.');
        if (key === 'format' || key === 'id') return fail(`'${key}' cannot be changed here.`);
        if (!(editable as readonly string[]).includes(key)) {
          return fail(`'${key}' is not a site.json setting in format ${SITE_FORMAT}. Settable: ${editable.join(', ')}. If the site needs it, draft a module request (kind "contract").`);
        }
        if (value === null) delete next[key];
        else if (value && typeof value === 'object' && !Array.isArray(value) && next[key] && typeof next[key] === 'object') {
          next[key] = { ...next[key] };
          for (const [k, v] of Object.entries(value)) {
            if (v === null && key !== 'basemap') delete next[key][k];
            else next[key][k] = v;
          }
        } else next[key] = value;
      }
      const issues = validateManifest(next, dir, catalog);
      const before = new Set(validateManifest(manifest, dir, catalog).filter((i) => i.level === 'error').map((i) => `${i.path}|${i.message}`));
      const added = issues.filter((i) => i.level === 'error' && !before.has(`${i.path}|${i.message}`));
      if (added.length) return fail('Not saved; the change would make the site invalid:', added);
      writeSite(dir, next);
      return reply(`Saved (${counts(issues)}).`, { issues, changed: Object.keys(set) });
    },
  );

  const target = {
    index: z.number().int().optional().describe('Position in the scene (0 is the bottom)'),
    use: z.string().optional().describe('Layer id, if it appears once in the scene'),
  };
  function locate(manifest: SiteManifest, index?: number, use?: string): number | string {
    const layers: any[] = manifest.layers ?? [];
    if (index !== undefined) return index >= 0 && index < layers.length ? index : `No layer at index ${index}; the scene has ${layers.length}.`;
    if (!use) return 'Give index or use.';
    const hits = layers.map((l, i) => (l.use === use ? i : -1)).filter((i) => i >= 0);
    if (hits.length === 1) return hits[0]!;
    return hits.length ? `'${use}' appears ${hits.length} times; give index (${hits.join(', ')}).` : `'${use}' is not in the scene (${layers.map((l) => l.use).join(', ') || 'empty'}).`;
  }

  function editScene(site: string, edit: (manifest: SiteManifest) => string | { message: string; issues?: Issue[] }): Content {
    const dir = at(site);
    let manifest: SiteManifest;
    try {
      manifest = readSite(dir);
    } catch (error) {
      return fail((error as Error).message);
    }
    manifest.layers = Array.isArray(manifest.layers) ? manifest.layers : [];
    const result = edit(manifest);
    if (typeof result === 'string') return fail(result);
    if (result.issues?.some((i) => i.level === 'error')) return fail(`Not saved: ${result.message}`, result.issues);
    writeSite(dir, manifest);
    const issues = validateManifest(manifest, dir, catalog);
    const scene = manifest.layers.map((l: any, i: number) => `${i}: ${l.use}${l.active ? ' (active)' : ''}`);
    return reply(`${result.message} Site is ${counts(issues)}.`, { scene_bottom_to_top: scene, issues: [...(result.issues ?? []), ...issues.filter((i) => i.level !== 'note')] });
  }

  server.registerTool(
    'add_layer',
    {
      title: 'Add a layer to the scene',
      description: 'Add a core layer (or ./layers/<name>) to the scene with optional params and start state. Params are checked against the layer\'s controls. Layers are drawn bottom to top; position defaults to the top.',
      inputSchema: {
        site: z.string(),
        use: z.string().describe('Core layer id'),
        active: z.boolean().optional().describe('Turn on at start'),
        params: z.record(z.string(), z.unknown()).optional().describe('Control id to value, overriding defaults'),
        position: z.number().int().optional().describe('Index to insert at (0 is the bottom); default top'),
      },
    },
    async ({ site, use, active, params, position }) =>
      editScene(site, (m) => {
        const layer = findLayer(catalog, at(site), use);
        if (!layer) return `No layer '${use}'. Core layers: ${catalog.layers.map((l) => l.id).join(', ')}. For something new, use check_layer_idea.`;
        const checked = params ? checkParams(layer, params, 'params') : { issues: [], cleaned: undefined };
        const entry: Record<string, unknown> = { use };
        if (active !== undefined) entry.active = active;
        if (checked.cleaned && Object.keys(checked.cleaned).length) entry.params = checked.cleaned;
        const pos = position === undefined ? m.layers.length : Math.max(0, Math.min(m.layers.length, position));
        m.layers.splice(pos, 0, entry);
        return { message: `Added ${layer.manifest.name} at index ${pos}.`, issues: checked.issues };
      }),
  );

  server.registerTool(
    'set_layer',
    {
      title: 'Change a layer in the scene',
      description: 'Set params and/or the start state of a layer already in the scene. Params merge into the existing overrides (null removes one) unless replace_params is true.',
      inputSchema: {
        site: z.string(),
        ...target,
        active: z.boolean().optional(),
        params: z.record(z.string(), z.unknown()).optional(),
        replace_params: z.boolean().optional(),
      },
    },
    async ({ site, index, use, active, params, replace_params }) =>
      editScene(site, (m) => {
        const i = locate(m, index, use);
        if (typeof i === 'string') return i;
        const entry = m.layers[i];
        const layer = findLayer(catalog, at(site), entry.use);
        if (!layer) return `Layer '${entry.use}' at index ${i} is unknown; remove it or fix its use.`;
        let issues: Issue[] = [];
        if (params) {
          const merged: Record<string, unknown> = replace_params ? {} : { ...(entry.params ?? {}) };
          for (const [k, v] of Object.entries(params)) if (v === null) delete merged[k];
          const toCheck = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== null));
          const checked = checkParams(layer, toCheck, `layers[${i}].params`);
          issues = checked.issues;
          Object.assign(merged, checked.cleaned);
          if (Object.keys(merged).length) entry.params = merged;
          else delete entry.params;
        }
        if (active !== undefined) entry.active = active;
        return { message: `Updated ${layer.manifest.name} (index ${i}).`, issues };
      }),
  );

  server.registerTool(
    'move_layer',
    {
      title: 'Reorder the scene',
      description: 'Move a layer to another position. Index 0 is drawn at the bottom, the last on top.',
      inputSchema: { site: z.string(), ...target, to: z.number().int().describe('New index') },
    },
    async ({ site, index, use, to }) =>
      editScene(site, (m) => {
        const i = locate(m, index, use);
        if (typeof i === 'string') return i;
        const [entry] = m.layers.splice(i, 1);
        const dest = Math.max(0, Math.min(m.layers.length, to));
        m.layers.splice(dest, 0, entry);
        return { message: `Moved ${entry.use} from ${i} to ${dest}.` };
      }),
  );

  server.registerTool(
    'remove_layer',
    {
      title: 'Remove a layer from the scene',
      description: 'Remove one layer entry from the scene.',
      inputSchema: { site: z.string(), ...target },
      annotations: { destructiveHint: true },
    },
    async ({ site, index, use }) =>
      editScene(site, (m) => {
        const i = locate(m, index, use);
        if (typeof i === 'string') return i;
        const [entry] = m.layers.splice(i, 1);
        return { message: `Removed ${entry.use} (was index ${i}).` };
      }),
  );

  server.registerTool(
    'validate_site',
    {
      title: 'Validate a site',
      description: 'Check a site against the site and layer contracts: keys, geometry, data paths, layer ids, params. Also runs `mrstudio validate` (the app\'s own check, which bakes the scene) when the CLI is installed.',
      inputSchema: { site: z.string(), run_cli: z.boolean().optional().describe('Run the mrstudio CLI too (default true when found)') },
      annotations: { readOnlyHint: true },
    },
    async ({ site, run_cli }) => {
      const dir = at(site);
      const { manifest, issues } = validateSiteDir(dir, catalog);
      let cli: { ran: boolean; ok?: boolean; output?: string; note?: string } = { ran: false };
      const exe = findCli(catalog);
      if (run_cli !== false && manifest) {
        if (exe) {
          const result = await runCli(exe, ['validate', dir]);
          cli = { ran: true, ok: result.ok, output: result.output };
        } else cli.note = 'mrstudio CLI not found; install the MR Studio app or set MRSTUDIO_CLI to also check the scene bake.';
      }
      const errors = issues.filter((i) => i.level === 'error').length;
      const ok = errors === 0 && cli.ok !== false;
      return { ...reply(`${manifest?.name ?? site}: ${counts(issues)}${cli.ran ? `; mrstudio validate ${cli.ok ? 'passed' : 'failed'}` : ''}.`, { issues, cli }), isError: !ok };
    },
  );

  server.registerTool(
    'preview_site',
    {
      title: 'How to preview a site',
      description: 'The commands to run the site on this computer (Windows or macOS) and the URLs of the table, TV, phone and dev views. Does not start anything.',
      inputSchema: { site: z.string(), lan: z.boolean().optional().describe('Let phones on the local network join') },
      annotations: { readOnlyHint: true },
    },
    async ({ site, lan }) => {
      const dir = at(site);
      const exe = findCli(catalog);
      const quote = (p: string) => (/\s/.test(p) ? `"${p}"` : p);
      const cmd = `${exe ? quote(exe) : 'mrstudio'} dev --site ${quote(dir)}${lan ? ' --lan' : ''}`;
      const fromCore = catalog.root ? `cd ${quote(catalog.root)} && pnpm dev   (runs the host and web dev server with hot reload; edit scripts/dev.mjs's site or pass --site)` : null;
      return reply('Run this in a terminal, then open the dev view:', {
        command: cmd,
        from_core_checkout: fromCore,
        open: { dev: 'http://localhost:4170/dev', table: 'http://localhost:4170/table', tv: 'http://localhost:4170/tv', phone: 'http://localhost:4170/phone' },
        notes: [
          exe ? `CLI found at ${exe}.` : 'The mrstudio CLI ships inside the MR Studio app; on macOS it is inside the .app bundle, on Windows next to MR Studio.exe. Add it to PATH or set MRSTUDIO_CLI.',
          'The installed app opens the same folder for a real table: choose the site folder in the app.',
        ],
      });
    },
  );

  // ---- Ideas and requests ----

  server.registerTool(
    'check_layer_idea',
    {
      title: 'Check a layer idea',
      description:
        'Check a sketched layer against the core: which existing layers already cover it, which kernels and building blocks exist or are planned, and whether it should be configured from an existing layer, requested as a new core layer from existing blocks, or needs new blocks or kernels first.',
      inputSchema: {
        title: z.string(),
        description: z.string().describe('What it shows and what people do with it'),
        kernels: z.array(z.string()).optional().describe('Kernel ids it needs, e.g. ["sunlight"]'),
        blocks: z.array(z.string()).optional().describe('Block ids or names from list_building_blocks, e.g. ["field-overlay", "animated-paths"]'),
        data: z.array(z.string()).optional().describe('Site data it reads'),
        tools: z.array(z.enum(['point', 'line', 'polygon'])).optional(),
        site: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const extra = args.site ? availableLayers(catalog, at(args.site)).filter((l) => l.origin === 'site') : [];
      const report = checkIdea(args, catalog, extra);
      return reply(`${report.verdict}: ${report.summary}\nNext: ${report.next_step}`, report);
    },
  );

  server.registerTool(
    'draft_module_request',
    {
      title: 'Draft a module request',
      description: `Write a request for the MR Studio core team when a project needs something the core lacks, instead of writing custom code. Saves a markdown draft in <site>/requests/ and returns a prefilled GitHub issue link for ${process.env.MRSTUDIO_REPO ?? 'snjsomnath/mr-studio'}. Nothing is sent. Kinds: ${Object.entries(REQUEST_KINDS).map(([k, v]) => `${k} (${v})`).join('; ')}.`,
      inputSchema: {
        kind: z.enum(Object.keys(REQUEST_KINDS) as [RequestKind, ...RequestKind[]]),
        title: z.string().describe('Short, specific: "Animated paths block for vehicles along road data"'),
        goal: z.string().describe('What the team wants to show or let people do'),
        why: z.string().describe('Who it is for and why existing layers and blocks fall short'),
        proposal: z.string().describe('How it could be built from reusable blocks'),
        reuses: z.array(z.string()).optional(),
        missing: z.array(z.string()).optional(),
        example: z.unknown().optional().describe('The layer.json or site.json fragment the team would write once it exists'),
        roadmap: z.array(z.string()).optional(),
        site: z.string().optional().describe('Site folder; the draft is saved in its requests/ folder'),
      },
    },
    async (args) => {
      const dir = args.site ? at(args.site) : null;
      let siteName: string | undefined;
      if (dir) {
        try {
          siteName = readSite(dir).name;
        } catch {
          siteName = undefined;
        }
      }
      const draft = writeDraft({ ...args, site: siteName ?? args.site }, catalog.version, dir);
      return reply(
        `Drafted "${draft.title}".${draft.path ? ` Saved to ${draft.path}.` : ''} Show it to the person. To file it: open the link, or call submit_module_request${draft.path ? '' : ' (needs a site, so the draft is saved first)'} once they agree.`,
        { path: draft.path, issue_link: draft.url, labels: draft.labels, body: draft.body },
      );
    },
  );

  server.registerTool(
    'submit_module_request',
    {
      title: 'Submit a module request',
      description: 'Open a drafted module request as a GitHub issue on the core repository. Only call this after the person has read the draft and agreed: it posts publicly. Uses GITHUB_TOKEN or GH_TOKEN, else a signed-in gh CLI, else returns the link to file by hand.',
      inputSchema: { path: z.string().describe('Path of the draft in <site>/requests/') },
      annotations: { openWorldHint: true },
    },
    async ({ path }) => {
      try {
        const result = await submitDraft(at(path));
        return result.submitted ? reply(`Opened ${result.url} (${result.how}).`) : reply(`Not sent: ${result.how}.`, { issue_link: result.url });
      } catch (error) {
        return fail((error as Error).message);
      }
    },
  );

  // ---- Prompts ----

  server.registerPrompt(
    'new_project',
    {
      title: 'New MR Studio project',
      description: 'Guided assembly of a new project: story, place, scene of layers, data, branding and welcome, TV, validation.',
      argsSchema: { place: z.string().optional(), purpose: z.string().optional() },
    },
    ({ place, purpose }) => ({ messages: [{ role: 'user', content: { type: 'text', text: newProjectPrompt(place, purpose) } }] }),
  );

  server.registerPrompt(
    'brainstorm_layer',
    {
      title: 'Brainstorm a layer',
      description: 'Turn a layer idea into a composition of existing layers, kernels and building blocks; configure it or draft a core request.',
      argsSchema: { idea: z.string().optional() },
    },
    ({ idea }) => ({ messages: [{ role: 'user', content: { type: 'text', text: brainstormPrompt(idea) } }] }),
  );

  server.registerPrompt(
    'design_dashboard',
    {
      title: 'Design the TV dashboard',
      description: 'Decide what the TV shows, within the dashboard rules, using existing widgets.',
      argsSchema: { site: z.string().optional() },
    },
    ({ site }) => ({ messages: [{ role: 'user', content: { type: 'text', text: dashboardPrompt(site, catalog) } }] }),
  );

  server.registerPrompt(
    'request_module',
    {
      title: 'Request a core module',
      description: 'Write a well-formed request to the MR Studio core for a layer, block, kernel or contract change.',
      argsSchema: { need: z.string().optional() },
    },
    ({ need }) => ({ messages: [{ role: 'user', content: { type: 'text', text: requestPrompt(need) } }] }),
  );

  // ---- Resources ----

  server.registerResource(
    'docs',
    new ResourceTemplate('mrstudio://docs/{+name}', {
      list: async () => ({
        resources: Object.keys(catalog.docs).map((name) => ({ uri: `mrstudio://docs/${name}`, name, mimeType: 'text/markdown' })),
      }),
    }),
    { title: 'MR Studio docs', description: 'Architecture, roadmap and contracts of this core', mimeType: 'text/markdown' },
    async (uri, { name }) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: catalog.docs[String(name)] ?? `No doc ${name}` }] }),
  );

  server.registerResource(
    'layers',
    new ResourceTemplate('mrstudio://layers/{id}', {
      list: async () => ({ resources: catalog.layers.map((l) => ({ uri: `mrstudio://layers/${l.id}`, name: String(l.manifest.name ?? l.id), mimeType: 'application/json' })) }),
    }),
    { title: 'Core layer manifests', mimeType: 'application/json' },
    async (uri, { id }) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(catalog.layers.find((l) => l.id === id)?.manifest ?? null, null, 2) }],
    }),
  );

  return { server, catalog };
}

