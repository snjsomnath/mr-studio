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
  CUSTOM_PREFIX,
  findCli,
  findLayer,
  freeId,
  instanceIds,
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
      const describe = (ref: any) => {
        const layer = findLayer(catalog, dir, ref.use, manifest);
        const defaults = Object.fromEntries((layer?.manifest.controls ?? []).filter((c: any) => c.type !== 'action').map((c: any) => [c.id, c.default]));
        return { id: ref.id, use: ref.use, name: layer?.manifest.name ?? '(unknown layer)', active: ref.active !== false && (ref.active === true || ref.items === undefined), params: { ...defaults, ...(ref.params ?? {}) }, overrides: ref.params ?? {} };
      };
      const scene = (manifest.layers ?? []).map((ref: any, index: number) => ({
        index,
        ...describe(ref),
        active: Boolean(ref.active),
        ...(ref.items?.length ? { items: ref.items.map((item: any) => ({ ...describe(item), active: item.active !== false })) } : {}),
        ...(ref.steps ? { steps: ref.steps } : {}),
      }));
      return reply(`${manifest.name}: ${scene.length} layer${scene.length === 1 ? '' : 's'}, ${counts(issues)}.`, { scene, issues, manifest });
    },
  );

  const editable = (catalog.siteSchema?.['']?.fields ?? ['name', 'origin', 'extent', 'timezone', 'table', 'scene', 'basemap', 'branding', 'tv']).filter(
    (k) => !['format', 'id', 'layers', 'custom'].includes(k),
  );

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
        if (key === 'layers') return fail('Use add_layer, set_layer, move_layer, remove_layer and set_steps to change the scene.');
        if (key === 'custom') return fail('Use save_custom_layer to save or remove a custom layer.');
        if (key === 'format' || key === 'id') return fail(`'${key}' cannot be changed here.`);
        if (!editable.includes(key)) {
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
    id: z.string().optional().describe('Instance id of a layer or item (from get_site); the surest way to name one'),
    index: z.number().int().optional().describe('Position in the scene (0 is the bottom)'),
    use: z.string().optional().describe('Layer id, if it appears once in the scene'),
  };
  /** Where an entry is: the list that holds it (the scene, or a layer's items), its index there, and its layer for an item. */
  type Place = { list: any[]; i: number; parent?: any };
  function locate(manifest: SiteManifest, id?: string, index?: number, use?: string): Place | string {
    const layers: any[] = manifest.layers ?? [];
    if (id !== undefined) {
      for (const [i, layer] of layers.entries()) {
        if (layer?.id === id) return { list: layers, i };
        const j = Array.isArray(layer?.items) ? layer.items.findIndex((item: any) => item?.id === id) : -1;
        if (j >= 0) return { list: layer.items, i: j, parent: layer };
      }
      return `No layer or item '${id}'. Ids: ${instanceIds(manifest).join(', ') || 'none'}.`;
    }
    if (index !== undefined) return index >= 0 && index < layers.length ? { list: layers, i: index } : `No layer at index ${index}; the scene has ${layers.length}.`;
    if (!use) return 'Give id, index or use.';
    const hits = layers.map((l, i) => (l.use === use ? i : -1)).filter((i) => i >= 0);
    if (hits.length === 1) return { list: layers, i: hits[0]! };
    return hits.length ? `'${use}' appears ${hits.length} times; give its id (${hits.map((i) => layers[i].id).join(', ')}).` : `'${use}' is not in the scene (${layers.map((l) => l.use).join(', ') || 'empty'}).`;
  }

  function editScene(site: string, edit: (manifest: SiteManifest) => string | { message: string; issues?: Issue[] }): Content {
    const dir = at(site);
    let manifest: SiteManifest;
    try {
      manifest = readSite(dir);
    } catch (error) {
      return fail((error as Error).message);
    }
    if (typeof manifest.format === 'number' && manifest.format < SITE_FORMAT) {
      return fail(`This site is in the older site format ${manifest.format}. Run \`mrstudio migrate <site folder>\` (or open it once in the MR Studio app) to bring it to format ${SITE_FORMAT}, then try again.`);
    }
    manifest.layers = Array.isArray(manifest.layers) ? manifest.layers : [];
    const result = edit(manifest);
    if (typeof result === 'string') return fail(result);
    if (result.issues?.some((i) => i.level === 'error')) return fail(`Not saved: ${result.message}`, result.issues);
    const issues = validateManifest(manifest, dir, catalog);
    const errors = issues.filter((i) => i.level === 'error' && /^(layers|custom)/.test(i.path));
    if (errors.length) return fail(`Not saved: ${result.message} It would leave the scene invalid:`, errors);
    writeSite(dir, manifest);
    const scene = manifest.layers.map(
      (l: any, i: number) => `${i}: ${l.id} (${l.use})${l.active ? ' active' : ''}${l.items?.length ? `, items ${l.items.map((item: any) => item.id).join(', ')}` : ''}${l.steps?.sequence?.length ? `, ${l.steps.sequence.length} steps` : ''}`,
    );
    return reply(`${result.message} Site is ${counts(issues)}.`, { scene_bottom_to_top: scene, issues: [...(result.issues ?? []), ...issues.filter((i) => i.level !== 'note')] });
  }

  server.registerTool(
    'add_layer',
    {
      title: 'Add a layer to the scene',
      description:
        "Add a core layer, a site layer (./layers/<name>) or a custom layer (custom:<id>) to the scene with optional params and start state. Params are checked against the layer's controls. Layers are drawn bottom to top; position defaults to the top. With parent, the layer becomes an item of that layer instead: it shows only while that layer is open (for example public transport inside a sun study) and has no button of its own.",
      inputSchema: {
        site: z.string(),
        use: z.string().describe('Core layer id, ./layers/<name> or custom:<id>'),
        id: z.string().optional().describe('Instance id; default the layer id, then -2, -3…'),
        parent: z.string().optional().describe('Id of the layer this becomes an item of'),
        active: z.boolean().optional().describe('Turn on at start; for an item, whether it comes on with its layer (default true)'),
        params: z.record(z.string(), z.unknown()).optional().describe('Control id to value, overriding defaults'),
        position: z.number().int().optional().describe('Index to insert at in the scene, or in the parent\'s items (0 is the bottom); default top'),
      },
    },
    async ({ site, use, id, parent, active, params, position }) =>
      editScene(site, (m) => {
        const layer = findLayer(catalog, at(site), use, m);
        if (!layer) return `No layer '${use}'. Core layers: ${catalog.layers.map((l) => l.id).join(', ')}. For something new, use check_layer_idea.`;
        const checked = params ? checkParams(layer, params, 'params') : { issues: [], cleaned: undefined };
        const name = id ?? freeId(m, use);
        if (instanceIds(m).includes(name)) return `'${name}' is already the id of a layer or item; give another id.`;
        const entry: Record<string, unknown> = { use, id: name };
        if (active !== undefined && !(parent && active)) entry.active = active;
        if (checked.cleaned && Object.keys(checked.cleaned).length) entry.params = checked.cleaned;
        let list: any[] = m.layers;
        if (parent) {
          const owner = m.layers.find((l: any) => l.id === parent);
          if (!owner) return `No layer '${parent}' in the scene to hold it (items cannot hold items).`;
          owner.items = Array.isArray(owner.items) ? owner.items : [];
          list = owner.items;
        }
        const pos = position === undefined ? list.length : Math.max(0, Math.min(list.length, position));
        list.splice(pos, 0, entry);
        return { message: `Added ${layer.manifest.name} as '${name}'${parent ? ` inside '${parent}'` : ''} at index ${pos}.`, issues: checked.issues };
      }),
  );

  server.registerTool(
    'set_layer',
    {
      title: 'Change a layer in the scene',
      description:
        "Set params, the start state and the controller button of a layer or item already in the scene. Params merge into the existing overrides (null removes one) unless replace_params is true. The button's fields (name, description, icon, side, group, order) merge the same way; items have no button.",
      inputSchema: {
        site: z.string(),
        ...target,
        active: z.boolean().optional(),
        params: z.record(z.string(), z.unknown()).optional(),
        replace_params: z.boolean().optional(),
        button: z.record(z.string(), z.unknown()).optional().describe('e.g. { "name": "Sun study", "group": "Simulations", "order": 1, "side": "left" }'),
      },
    },
    async ({ site, id, index, use, active, params, replace_params, button }) =>
      editScene(site, (m) => {
        const place = locate(m, id, index, use);
        if (typeof place === 'string') return place;
        const entry = place.list[place.i];
        const layer = findLayer(catalog, at(site), entry.use, m);
        if (!layer) return `Layer '${entry.use}' ('${entry.id}') is unknown; remove it or fix its use.`;
        let issues: Issue[] = [];
        if (params) {
          const merged: Record<string, unknown> = replace_params ? {} : { ...(entry.params ?? {}) };
          for (const [k, v] of Object.entries(params)) if (v === null) delete merged[k];
          const toCheck = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== null));
          const checked = checkParams(layer, toCheck, `${entry.id}.params`);
          issues = checked.issues;
          Object.assign(merged, checked.cleaned);
          if (Object.keys(merged).length) entry.params = merged;
          else delete entry.params;
        }
        if (active !== undefined) {
          if (place.parent && active) delete entry.active;
          else entry.active = active;
        }
        if (button) {
          if (place.parent) return `'${entry.id}' is an item of '${place.parent.id}': it has no button and comes on with its layer.`;
          const next: Record<string, unknown> = { ...(entry.button ?? {}) };
          for (const [k, v] of Object.entries(button)) {
            if (!['name', 'description', 'icon', 'side', 'group', 'order'].includes(k)) return `A button has no '${k}' (name, description, icon, side, group, order).`;
            if (v === null) delete next[k];
            else next[k] = v;
          }
          if (Object.keys(next).length) entry.button = next;
          else delete entry.button;
        }
        return { message: `Updated ${layer.manifest.name} ('${entry.id}').`, issues };
      }),
  );

  server.registerTool(
    'move_layer',
    {
      title: 'Reorder the scene',
      description:
        "Move a layer or item to another position. Index 0 is drawn at the bottom, the last on top; a layer's items move with it. With parent, the entry becomes an item of that layer; with parent null, an item becomes a layer of the scene.",
      inputSchema: {
        site: z.string(),
        ...target,
        to: z.number().int().describe('New index in the target list'),
        parent: z.string().nullable().optional().describe('Layer to move it into; null for the scene itself; left out keeps it where it is'),
      },
    },
    async ({ site, id, index, use, to, parent }) =>
      editScene(site, (m) => {
        const place = locate(m, id, index, use);
        if (typeof place === 'string') return place;
        const entry = place.list[place.i];
        let list: any[] = place.list;
        if (parent === null) list = m.layers;
        else if (parent !== undefined) {
          const owner = m.layers.find((l: any) => l.id === parent);
          if (!owner || owner === entry) return `No other layer '${parent}' in the scene to hold it.`;
          if (entry.items?.length || entry.steps || entry.button) return `'${entry.id}' has items, steps or a button, so it cannot become an item.`;
          owner.items = Array.isArray(owner.items) ? owner.items : [];
          list = owner.items;
        }
        place.list.splice(place.i, 1);
        if (place.parent && !place.parent.items.length) delete place.parent.items;
        const dest = Math.max(0, Math.min(list.length, to));
        list.splice(dest, 0, entry);
        return { message: `Moved '${entry.id}' to ${dest}${parent ? ` inside '${parent}'` : parent === null ? ' in the scene' : ''}.` };
      }),
  );

  server.registerTool(
    'remove_layer',
    {
      title: 'Remove a layer from the scene',
      description: "Remove one layer (with its items) or one item. Sequence steps that showed it are removed too.",
      inputSchema: { site: z.string(), ...target },
      annotations: { destructiveHint: true },
    },
    async ({ site, id, index, use }) =>
      editScene(site, (m) => {
        const place = locate(m, id, index, use);
        if (typeof place === 'string') return place;
        const [entry] = place.list.splice(place.i, 1);
        if (place.parent && !place.parent.items.length) delete place.parent.items;
        const gone = new Set([entry.id, ...(entry.items ?? []).map((item: any) => item.id)]);
        let dropped = 0;
        for (const layer of m.layers) {
          const sequence = layer.steps?.sequence;
          if (!Array.isArray(sequence)) continue;
          layer.steps.sequence = sequence.filter((step: any) => !gone.has(step?.layer));
          dropped += sequence.length - layer.steps.sequence.length;
        }
        return { message: `Removed '${entry.id}' (${entry.use})${dropped ? ` and ${dropped} step${dropped === 1 ? '' : 's'} that showed it` : ''}.` };
      }),
  );

  server.registerTool(
    'set_steps',
    {
      title: 'Set how Next moves through a layer',
      description:
        'Set or clear a layer\'s steps: mode (manual or timed), loop, reveal (what Next does after a step\'s sub-steps: stop or then-next), the sequence\'s default transition and transition_s and, for a sequence such as the slideshow, the sequence of steps. Each step shows another layer of the scene or one of the sequence\'s own items, by id, with optional params for that step only, duration_s, transition (cut, fade or dip: through the empty map) and transition_s, next, title, description and source. Replaces the whole steps object; null clears it.',
      inputSchema: {
        site: z.string(),
        ...target,
        steps: z.record(z.string(), z.unknown()).nullable().describe('e.g. { "mode": "manual", "loop": true, "sequence": [{ "layer": "sunlight", "params": { "hour": 9 }, "title": "Morning" }] }'),
      },
    },
    async ({ site, id, index, use, steps }) =>
      editScene(site, (m) => {
        const place = locate(m, id, index, use);
        if (typeof place === 'string') return place;
        if (place.parent) return `'${place.list[place.i].id}' is an item; items have no steps.`;
        const entry = place.list[place.i];
        if (steps === null) delete entry.steps;
        else entry.steps = steps;
        return { message: steps === null ? `Cleared the steps of '${entry.id}'.` : `Set the steps of '${entry.id}'.` };
      }),
  );

  server.registerTool(
    'save_custom_layer',
    {
      title: 'Save a custom layer',
      description:
        'Save (or with recipe null, remove) a custom layer in the site: a recipe of blocks the runtime draws without code. A recipe has name, description, icon, category, data (each { id, and one of dataset | path | wms { url, layers, styles, format, source } | tiles }), look, motion and interaction (each a list of { id, block, data?, on?, props }), enter (cut or fade), controls (as in layer.json, with bind: "look.<block id>.<prop>"), legend and attract. The table is 2D only. Then add it to the scene with add_layer use "custom:<id>". The block names are in docs/blocks.md.',
      inputSchema: {
        site: z.string(),
        id: z.string().describe('Custom layer id: lowercase letters, digits and dashes'),
        recipe: z.record(z.string(), z.unknown()).nullable(),
      },
    },
    async ({ site, id, recipe }) =>
      editScene(site, (m) => {
        const use = `${CUSTOM_PREFIX}${id}`;
        if (recipe === null) {
          const users = m.layers.flatMap((l: any) => [l, ...(l.items ?? [])]).filter((e: any) => e?.use === use).map((e: any) => e.id);
          if (users.length) return `The custom layer '${id}' is used by ${users.join(', ')}; remove those first.`;
          if (!m.custom?.[id]) return `There is no custom layer '${id}'.`;
          delete m.custom[id];
          if (!Object.keys(m.custom).length) delete m.custom;
          return { message: `Removed the custom layer '${id}'.` };
        }
        m.custom = { ...(m.custom ?? {}), [id]: recipe };
        return { message: `Saved the custom layer '${id}'. Add it with add_layer use "${use}".` };
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

