// The MR Studio MCP server: tools, prompts and resources over one core catalog.

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';

import { changelogVersions, loadCatalog, type Catalog, type CoreOptions, type LayerEntry } from './core.ts';
import { buildCapabilities, closestIds, parsePatterns, rank, withSite, type Capability } from './capabilities.ts';
import { assessExperience, buildExperience, type BuildResult, type ExperiencePlan } from './experience.ts';
import { DEV_KINDS, DUPLICATE_AT, KIND_ALIASES, searchIssues, submitDevDraft, writeDevDraft, type DevKind, type DevRequest, type SubmitOutcome } from './devrequests.ts';
import { checkLayerPackage, searchSdk } from './devlayer.ts';
import { listSiteFiles } from './files.ts';
import { checkIdea } from './ideas.ts';
import { FEATURE_CARDS, layerCards, readSignals, suggest } from './suggest.ts';
import { RECIPE_VOCABULARY, legendFor } from './recipe.ts';
import { brainstormPrompt, buildCodeLayerPrompt, buildControllerAppPrompt, buildFromDataPrompt, compareScenariosPrompt, designExperiencePrompt, planWorkshopPrompt, dashboardPrompt, newProjectPrompt, requestPrompt, serverInstructions } from './prompts.ts';
import { CORE_REPO, REQUEST_KINDS, submitDraft, writeDraft, type RequestKind } from './requests.ts';
import { DATA_FORMATS } from '../../runtime/src/data-formats.ts';
import {
  availableLayers,
  checkParams,
  createSite,
  CUSTOM_PREFIX,
  findCli,
  findLayer,
  freeId,
  instanceIds,
  listVersions,
  previewPlan,
  readSite,
  restoreVersion,
  runCli,
  runCliJson,
  SITE_FORMAT,
  validateManifest,
  validateSiteDir,
  writeSite,
  type Issue,
  type SceneEntry,
  type SiteManifest,
} from './site.ts';
import type { CustomLayer, LayerRef, Service } from './site-types.ts';
import type { Control } from '../../sdk/src/types.ts';

// The package version (the core release it was built with), stamped in by scripts/build.mjs.
declare const __MRSTUDIO_SERVER_VERSION__: string | undefined;
export const SERVER_VERSION = typeof __MRSTUDIO_SERVER_VERSION__ === 'string' ? __MRSTUDIO_SERVER_VERSION__ : '0.0.0-dev';

export interface ServerOptions extends CoreOptions {
  /** Folder that relative site paths are resolved against. */
  project?: string;
}

type Content = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

/**
 * Why a tool refused, in one shape for every tool (#325): a code a model can branch on, the
 * message in words, whether trying again differently can work, and what to do next.
 */
export interface ToolError {
  code: string;
  message: string;
  recoverable: boolean;
  next: string[];
}

/** Every tool's result carries at least these; the rest of the fields are the tool's own. */
const RESULT = z.looseObject({
  ok: z.boolean().describe('false when the tool refused or failed; then error says why'),
  summary: z.string().describe('One line on what happened'),
  error: z
    .object({ code: z.string(), message: z.string(), recoverable: z.boolean(), next: z.array(z.string()) })
    .optional(),
});

function asFields(data: unknown): Record<string, unknown> {
  if (data === undefined) return {};
  if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
  return { result: data };
}

function text(summary: string, data?: unknown): string {
  return data === undefined ? summary : `${summary}\n\n${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}`;
}

function reply(summary: string, data?: unknown): Content {
  return { content: [{ type: 'text', text: text(summary, data) }], structuredContent: { ok: true, summary, ...asFields(data) } };
}

function fail(message: string, data?: unknown, how: Partial<Omit<ToolError, 'message'>> = {}): Content {
  const error: ToolError = { code: how.code ?? 'refused', message, recoverable: how.recoverable ?? true, next: how.next ?? [] };
  const next = error.next.length ? `\nNext: ${error.next.join(' ')}` : '';
  return {
    content: [{ type: 'text', text: text(`${message}${next}`, data) }],
    structuredContent: { ok: false, summary: message, error, ...asFields(data) },
    isError: true,
  };
}

/**
 * What each tool does to the world (MCP tool annotations). Every tool is listed; a test checks
 * that none is missing. Writes touch only the site folder unless openWorldHint says otherwise.
 */
const ANNOTATIONS: Record<string, { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint: boolean }> = {
  overview: { readOnlyHint: true, openWorldHint: false },
  read_doc: { readOnlyHint: true, openWorldHint: false },
  whats_new: { readOnlyHint: true, openWorldHint: false },
  list_layers: { readOnlyHint: true, openWorldHint: false },
  describe_layer: { readOnlyHint: true, openWorldHint: false },
  list_building_blocks: { readOnlyHint: true, openWorldHint: false },
  find_capabilities: { readOnlyHint: true, openWorldHint: false },
  describe_capability: { readOnlyHint: true, openWorldHint: false },
  suggest_features: { readOnlyHint: true, openWorldHint: false },
  assess_experience: { readOnlyHint: true, openWorldHint: false },
  find_related_issues: { readOnlyHint: true, openWorldHint: true },
  list_site_files: { readOnlyHint: true, openWorldHint: false },
  import_data: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  add_media: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  export_starter_pack: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  add_sound: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  sdk_reference: { readOnlyHint: true, openWorldHint: false },
  create_layer: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  check_layer: { readOnlyHint: true, openWorldHint: false },
  build_layer: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  preview_layer: { readOnlyHint: true, openWorldHint: false },
  add_service: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  draft_development_request: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  submit_development_request: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  build_experience: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  create_site: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  get_site: { readOnlyHint: true, openWorldHint: false },
  update_site: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  list_versions: { readOnlyHint: true, openWorldHint: false },
  restore_version: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  add_layer: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  set_layer: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  move_layer: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  remove_layer: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  set_steps: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  save_custom_layer: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  validate_site: { readOnlyHint: true, openWorldHint: false },
  preview_site: { readOnlyHint: true, openWorldHint: false },
  check_layer_idea: { readOnlyHint: true, openWorldHint: false },
  draft_module_request: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  submit_module_request: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
};

export const TOOL_NAMES = Object.keys(ANNOTATIONS);

function counts(issues: Issue[]): string {
  const e = issues.filter((i) => i.level === 'error').length;
  const w = issues.filter((i) => i.level === 'warning').length;
  return e ? `${e} error${e > 1 ? 's' : ''}, ${w} warning${w === 1 ? '' : 's'}` : w ? `valid, ${w} warning${w > 1 ? 's' : ''}` : 'valid';
}

/** What `mrstudio import --json` answers. */
interface ImportReport {
  ok?: boolean;
  error?: string;
  summary?: string;
  issues?: { severity: string; message: string; fix?: string }[];
  preview?: unknown;
  [key: string]: unknown;
}

function layerSummary(l: LayerEntry) {
  const m = l.manifest;
  return {
    use: l.use,
    name: m.name,
    description: m.description,
    origin: l.origin,
    category: m.category,
    kernels: m.requires?.kernels ?? [],
    data: m.requires?.data ?? [],
    controls: (m.controls ?? []).map((c) => c.id),
    tools: (m.tools ?? []).map((t) => t.id ?? t.type),
    panels: (m.panels ?? []).map((p) => p.id),
  };
}

export function createServer(options: ServerOptions = {}): { server: McpServer; catalog: Catalog } {
  const project = resolve(options.project ?? process.env.MRSTUDIO_PROJECT ?? process.cwd());
  const catalog = loadCatalog({ ...options, searchFrom: [...(options.searchFrom ?? []), project] });
  const at = (p: string) => (isAbsolute(p) ? p : resolve(project, p));

  const server = new McpServer({ name: 'mrstudio', title: 'MR Studio', version: SERVER_VERSION }, { instructions: serverInstructions(catalog) });

  // Every tool gets its annotations from ANNOTATIONS and the shared result schema (#325).
  // The SDK types each tool's callback from its own input schema; this wrapper serves every tool, so it
  // cannot name one. These are the only loose types left in the server (#543).
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const tool: typeof server.registerTool = (name, config, cb) => {
    const annotations = ANNOTATIONS[name];
    if (!annotations) throw new Error(`Tool '${name}' has no entry in ANNOTATIONS`);
    const run = HINT_AFTER.has(name) ? withHint(cb as any) : cb;
    return server.registerTool(name, { ...config, outputSchema: (config.outputSchema ?? RESULT) as any, annotations: { title: config.title, ...annotations } }, run as typeof cb);
  };

  // ---- Suggestions (#477) ----
  // After a big step, one quiet "you might also like", never the same one twice in a session.
  const HINT_AFTER = new Set(['create_site', 'import_data', 'add_layer', 'update_site', 'build_experience']);
  const hinted = new Set<string>();
  const signalsFor = (dir: string | null) => {
    if (!dir) return null;
    try {
      const m = readSite(dir);
      return readSignals(m, (use) => {
        const l = findLayer(catalog, dir, use, m)?.manifest;
        return { data: l?.requires?.data ?? [], category: l?.category };
      });
    } catch {
      return null;
    }
  };
  const cardsFor = (site?: string) => [...FEATURE_CARDS, ...layerCards(capabilitiesFor(site))];
  function withHint(cb: (args: any, extra: any) => Promise<Content>) {
    return async (args: any, extra: any): Promise<Content> => {
      const out = await cb(args, extra);
      const sc = out.structuredContent as Record<string, unknown> | undefined;
      const site: string | undefined = args?.site ?? args?.dir;
      if (!sc?.ok || !site) return out;
      const signals = signalsFor(at(site));
      if (!signals) return out;
      const pick = suggest(cardsFor(site), String(args?.goal ?? ''), signals, site, 12).suggestions.find((x) => !hinted.has(x.id));
      if (!pick) return out;
      hinted.add(pick.id);
      sc.you_might_also_like = pick;
      (out.content[0] as { text: string }).text += `\nYou might also like: ${pick.name}. ${pick.reason}. Offer it if it fits their idea; do not switch it on unasked (suggest_features gives more).`;
      return out;
    };
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */


  // ---- Knowledge ----

  tool(
    'overview',
    {
      title: 'MR Studio overview',
      description: 'Start here. What MR Studio is, how a project is structured, what this core offers, and the workflow for building a project with these tools.',
      inputSchema: {},
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

  tool(
    'read_doc',
    {
      title: 'Read an MR Studio doc',
      description: 'Read a core document: "architecture", "roadmap", or a contract such as "contracts/site", "contracts/layer", "contracts/session", "contracts/engine". Call with no name to list them.',
      inputSchema: { name: z.string().optional().describe('Doc name, e.g. "contracts/site"') },
    },
    async ({ name }) => {
      if (!name) return reply('Docs in this core:', Object.keys(catalog.docs));
      const key = name.toLowerCase().replace(/\.md$/, '').replace(/^docs\//, '');
      const text = catalog.docs[key] ?? catalog.docs[`contracts/${key}`];
      return text ? { ...reply(`Doc '${name}'.`, { name, text }), content: [{ type: 'text' as const, text }] } : fail(`No doc '${name}'. Docs: ${Object.keys(catalog.docs).join(', ')}`, undefined, { code: 'unknown_doc' });
    },
  );

  tool(
    'whats_new',
    {
      title: "What's new in MR Studio",
      description: 'What changed in the core, newest first, from CHANGELOG.md: new layers, settings and fixes per version, and the notes merged since the last version. Use it when someone asks for something that may have been built recently, or to tell a team what an update brings.',
      inputSchema: {
        since: z.string().optional().describe('Only versions newer than this one, e.g. "0.3.0"'),
        limit: z.number().int().positive().optional().describe('How many versions (default 5)'),
      },
    },
    async ({ since, limit }) => {
      const newer = (v: string) => {
        if (!since) return true;
        const a = v.split(/[.-]/).map(Number);
        const b = since.replace(/^v/, '').split(/[.-]/).map(Number);
        for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
        return false;
      };
      const versions = changelogVersions(catalog.changelog ?? '').filter((v) => newer(v.version)).slice(0, limit ?? 5);
      const pending = catalog.pending ?? [];
      if (!versions.length && !pending.length) return reply(`Nothing newer${since ? ` than ${since}` : ''} is recorded in this core (${catalog.version}).`);
      return reply(
        `Core ${catalog.version}. ${versions.length} version${versions.length === 1 ? '' : 's'}${pending.length ? `, and ${pending.length} change${pending.length === 1 ? '' : 's'} merged but not yet released` : ''}.`,
        { versions, unreleased: pending },
      );
    },
  );

  tool(
    'list_layers',
    {
      title: 'List layers',
      description: 'Layers that can go into a scene: the core layers of this MR Studio version (plus a site\'s own, if a site is given), and the planned layers on the roadmap with what each reuses.',
      inputSchema: {
        site: z.string().optional().describe('Site folder, to include its own layers'),
        include_roadmap: z.boolean().optional().describe('Include planned roadmap layers (default true)'),
      },
    },
    async ({ site, include_roadmap }) => {
      const layers = availableLayers(catalog, site ? at(site) : null).map(layerSummary);
      const roadmap = include_roadmap === false ? undefined : catalog.roadmap.filter((r) => !r.built).map((r) => ({ section: r.section, layer: r.layer, kernel: r.kernel, blocks: r.blocks }));
      return reply(`${layers.length} layer${layers.length === 1 ? '' : 's'} available now${roadmap ? `, ${roadmap.length} planned` : ''}. Use describe_layer for controls before setting params.`, { available: layers, planned: roadmap });
    },
  );

  tool(
    'describe_layer',
    {
      title: 'Describe a layer',
      description: 'The full manifest of a layer: controls (with types, ranges, options and defaults), tools, required kernels and data, TV panels. Use it before choosing params.',
      inputSchema: {
        layer: z.string().describe('Core layer id, or ./layers/<name> for a site layer'),
        site: z.string().optional().describe('Site folder, needed for site layers'),
      },
    },
    async ({ layer, site }) => {
      const found = findLayer(catalog, site ? at(site) : null, layer);
      if (!found) return fail(`No layer '${layer}'. Core layers: ${catalog.layers.map((l) => l.id).join(', ')}`, undefined, { code: 'unknown_layer', next: ['Pick one of the core layers, or find_capabilities and assess_experience for something new.'] });
      return reply(`${found.manifest.name} (${found.origin} layer). Params are the control ids; set them in the site's layer entry.`, found.manifest);
    },
  );

  tool(
    'list_building_blocks',
    {
      title: 'List building blocks',
      description: 'The shared primitives layers are composed from (visuals, data sources, interactions, TV panels), whether each is built or planned in this core, and the kernels. Superseded by find_capabilities with kind "block" or "kernel", which gives the same with evidence; this name works for this release only.',
      inputSchema: { group: z.enum(['visual', 'data', 'interaction', 'tv']).optional() },
    },
    async ({ group }) => {
      const blocks = catalog.blocks.filter((b) => !group || b.group === group).map(({ detect: _d, ...b }) => b);
      return reply('Building blocks. A planned block is a module request, not something to write in a site.', {
        blocks,
        kernels: { built: catalog.kernels, planned: catalog.plannedKernels },
      });
    },
  );

  // ---- Capabilities (#326) ----

  const siteFacts = (dir: string | null) => {
    if (!dir) return null;
    try {
      const m = readSite(dir);
      return {
        data: new Set<string>([...Object.keys(m.data ?? {}), ...(['buildings', 'trees', 'terrain', 'mesh'] as const).filter((k) => m.scene?.[k])]),
        services: new Set<string>((Array.isArray(m.services) ? m.services : []).map((x) => x?.id).filter(Boolean)),
      };
    } catch {
      return null;
    }
  };
  const capabilitiesFor = (site?: string) => {
    const dir = site ? at(site) : null;
    const extra = dir ? availableLayers(catalog, dir).filter((l) => l.origin !== 'core') : [];
    const facts = siteFacts(dir);
    return buildCapabilities(catalog, extra).map((c) => withSite(c, facts));
  };
  const brief = (c: Capability) => ({
    id: c.id,
    name: c.name,
    status: c.status,
    ...(c.use ? { use: c.use } : {}),
    purpose: c.purpose ?? c.summary,
    ...(c.questions.length ? { questions: c.questions } : {}),
    surfaces: c.surfaces,
    ...(c.interactions.length ? { interactions: c.interactions } : {}),
    ...(c.requires.length ? { requires: c.requires } : {}),
    ...(c.pairs_with.length ? { pairs_with: c.pairs_with } : {}),
    ...(c.limitations.length ? { limitations: c.limitations } : {}),
    evidence: c.evidence,
  });
  const KINDS = ['layer', 'block', 'kernel', 'site', 'constraint'] as const;
  const STATUSES = ['available', 'needs_setup', 'planned', 'unsupported'] as const;

  tool(
    'find_capabilities',
    {
      title: 'Find what MR Studio can do for a goal',
      description:
        'Search everything MR Studio can do (layers, building blocks, kernels, site features) and what it cannot (planned items, constraints) for a goal, question or idea in plain words, e.g. "help residents see how a new development changes sun and wind". Returns ranked capabilities, each with why it matched, its status from the code (available, needs_setup, planned, unsupported), what it needs (data, keys, services), what the table, controller and phones do, what it pairs with, and the files that prove it. Use it before proposing an experience; a planned or unsupported capability is a development request, never something to configure. With site, requirements say whether that site meets them.',
      inputSchema: {
        goal: z.string().optional().describe('What the people at the table should see, understand or do, in plain words'),
        kind: z.enum(KINDS).optional().describe('Only this kind'),
        surface: z.enum(['table', 'controller', 'phone']).optional().describe('Only capabilities that use this surface'),
        status: z.enum(STATUSES).optional().describe('Only this status'),
        site: z.string().optional().describe('Site folder: check requirements against its data and services'),
        limit: z.number().int().positive().max(50).optional().describe('How many (default 12; all when no goal)'),
      },
    },
    async ({ goal, kind, surface, status, site, limit }) => {
      let caps = capabilitiesFor(site);
      if (kind) caps = caps.filter((c) => c.kind === kind);
      if (surface) caps = caps.filter((c) => Boolean(c.surfaces[surface]));
      if (status) caps = caps.filter((c) => c.status === status);
      if (!goal) {
        const list = caps.slice(0, limit ?? caps.length).map(brief);
        return reply(`${list.length} capabilit${list.length === 1 ? 'y' : 'ies'}${kind ? ` of kind ${kind}` : ''}.`, { matches: list });
      }
      const ranked = rank(caps, goal).slice(0, limit ?? 12);
      if (!ranked.length) {
        return reply('Nothing in MR Studio matches those words. If it is truly missing, it is a development request: find_related_issues, then draft_development_request.', { matches: [] });
      }
      const matches = ranked.map((m) => ({ ...brief(m.capability), matched: m.why }));
      const counts = STATUSES.map((st) => [st, matches.filter((x) => x.status === st).length] as const).filter(([, n]) => n);
      return reply(`${matches.length} matches (${counts.map(([st, n]) => `${n} ${st}`).join(', ')}). Read purpose and questions to judge fit; a match on words is not a match on intent.`, {
        matches,
        patterns: 'mrstudio://patterns lists experience shapes (compare today and the proposal, map it together…) that combine these',
      });
    },
  );

  tool(
    'describe_capability',
    {
      title: 'Describe one capability',
      description: 'Everything known about one capability by id (from find_capabilities): purpose, questions it answers, status and why, requirements, surfaces, interactions, what it uses and pairs with, limits, example sites that use it, evidence files and related issues. For a layer, also its controls (the params a site sets).',
      inputSchema: {
        id: z.string().describe('e.g. "layer:sunlight", "block:phone-tools", "kernel:thermal", "site:ribbons", "constraint:table-3d"'),
        site: z.string().optional().describe('Site folder, to check requirements and include its own layers'),
      },
    },
    async ({ id, site }) => {
      const caps = capabilitiesFor(site);
      const key = id.includes(':') ? id : `layer:${id}`;
      const c = caps.find((x) => x.id === key || (x.use !== undefined && x.use === id));
      if (!c) {
        const near = closestIds(caps, id);
        return fail(`No capability '${id}'.`, { similar: near }, { code: 'unknown_capability', next: ['Use one of the similar ids, or find_capabilities with a goal.'] });
      }
      const layer = c.kind === 'layer' && c.use ? findLayer(catalog, site ? at(site) : null, c.use) : undefined;
      const controls = layer ? (layer.manifest.controls ?? []).map((control) => {
        // Whichever kind of control it is: the fields some kinds have.
        const x = control as Control & { default?: unknown; options?: { value: string }[]; min?: number; max?: number };
        return { id: x.id, type: x.type, label: x.label, default: x.default, ...(x.phone ? { phone: true } : {}), ...(x.options ? { options: x.options.map((o) => o?.value ?? o) } : {}), ...(x.min !== undefined ? { min: x.min, max: x.max } : {}) };
      }) : undefined;
      const examples = (catalog.examples ?? []).filter((e) => c.examples.includes(e.path));
      return reply(`${c.name} (${c.id}): ${c.status}.`, { ...c, ...(controls ? { controls } : {}), example_sites: examples });
    },
  );

  tool(
    'suggest_features',
    {
      title: 'Suggest features that fit an idea',
      description:
        "Suggest 3 to 5 existing features that would help this idea and this table, including ones people would never search for (life on the map at rest, strips in the projector's margin, a second layer over the first, a guided tour with notes, a starter pack for designers). Give the person's goal in their words and the site: the table's shape, data, layers, languages and tour are read from site.json, and features already on are left out. Each suggestion has a one-line reason tied to the idea or the table, what it needs, and enable: the exact tool call that switches it on (or how, when nothing needs setting). Planned features that would fit come back as coming, with their issue. Offer suggestions to the person in a sentence each; never apply one they have not agreed to.",
      inputSchema: {
        goal: z.string().optional().describe('The idea in the person\'s words, e.g. "an exhibition about the new tram line for residents"'),
        site: z.string().optional().describe('Site folder: read what the table already has'),
        limit: z.number().int().min(1).max(8).optional().describe('How many (default 5)'),
      },
    },
    async ({ goal, site, limit }) => {
      if (!goal?.trim() && !site) return fail('Give a goal, a site, or both.', undefined, { code: 'nothing_to_go_on', next: ['Call again with the person\'s idea in their words, the site folder, or both.'] });
      const signals = site ? signalsFor(at(site)) : null;
      if (site && !signals) return fail(`No site at ${at(site)}.`, undefined, { code: 'no_site', next: ['Check the folder, or call with only a goal.'] });
      const { suggestions, coming } = suggest(cardsFor(site), goal ?? '', signals, site ?? null, limit ?? 5);
      if (!suggestions.length) return reply('Nothing else stands out for this idea and table. find_capabilities searches everything.', { suggestions, coming });
      for (const x of suggestions) hinted.add(x.id);
      const lines = suggestions.map((x, i) => `${i + 1}. ${x.name}: ${x.reason}.`);
      return reply(`${suggestions.length} feature${suggestions.length === 1 ? '' : 's'} that could help:\n${lines.join('\n')}${coming.length ? `\nComing: ${coming.map((c) => `${c.name} (#${c.issue})`).join(', ')}.` : ''}\nOffer these; switch one on only when the person says yes, with its enable call.`, { suggestions, coming });
    },
  );

  // ---- Experiences (#327) ----

  const STEP = z.object({
    title: z.string().describe('Short, in the person\'s words; becomes the step title on the controller'),
    want: z.string().optional().describe('What the table shows and people do in this step, in plain words'),
    use: z.string().optional().describe('The layer, if chosen with find_capabilities: "sunlight", "layer:sunlight", "custom:zones"'),
    params: z.record(z.string(), z.unknown()).optional().describe('Settings for this step by control id (describe_layer)'),
    with: z.array(z.string()).optional().describe('Layers shown inside this one while it is open, e.g. ["transit"]'),
    controller: z.string().optional().describe('What the controller says for this step'),
    phone: z.string().optional().describe('What phones do in this step'),
    notes: z.string().optional().describe('The guide\'s words, shown only on the guide\'s phone'),
  });
  const PLAN = {
    title: z.string(),
    goal: z.string().describe('What people should leave understanding, having seen or having said'),
    audience: z.string().optional(),
    steps: z.array(STEP).min(1),
    at_rest: z.array(z.string()).optional().describe('Layers playing when nobody touches the controller, e.g. ["cars", "trees"]'),
    needs: z.array(z.string()).optional().describe('Other things the experience needs that are not a step, e.g. "people vote on each other\'s ideas"'),
    guided: z.boolean().optional().describe('Make a guided sequence of the steps (default: yes for two or more steps)'),
  };
  const assessFor = (plan: ExperiencePlan, site?: string) => {
    const dir = site ? at(site) : null;
    return assessExperience(plan, capabilitiesFor(site), availableLayers(catalog, dir), Boolean(dir));
  };

  tool(
    'assess_experience',
    {
      title: 'Check an experience plan',
      description:
        'Check a whole experience against what MR Studio can do, before building it. A plan is a title, a goal, the audience, and steps: each step is what the table shows and people do (want, or a layer chosen with find_capabilities as use), its settings, layers inside it (with), what the controller says, what phones do, and notes for the guide. Add layers at rest and other needs. Returns, per step and need, the layer that serves it and why, alternatives, setup still needed (data, services), param problems, a constraint it runs into, and gaps with the kind of development request they need; and a verdict: buildable, buildable_with_setup, partly_buildable or needs_development. Writes nothing. Read mrstudio://concepts and mrstudio://patterns first.',
      inputSchema: { ...PLAN, site: z.string().optional().describe('Site folder: check data and services against it') },
    },
    async ({ site, ...plan }) => {
      const a = assessFor(plan as ExperiencePlan, site);
      return reply(`${a.summary}\nNext: ${a.next.join(' ')}`, a);
    },
  );

  tool(
    'build_experience',
    {
      title: 'Build an experience plan',
      description:
        'Build the parts of an experience plan that exist, in one validated change to the site: a layer for each buildable step (an existing instance is reused), the layers inside them, the layers at rest, and, for two or more steps, a guided sequence (a slideshow named after the plan) with each step\'s settings, title, controller text and notes. Steps that need development or run into a constraint are skipped and listed with their gaps; nothing that does not exist is written. Call assess_experience first and show the person the result.',
      inputSchema: { site: z.string(), ...PLAN },
    },
    async ({ site, ...plan }) => {
      const a = assessFor(plan as ExperiencePlan, site);
      let result: BuildResult | undefined;
      const out = editScene(site, (m) => {
        result = buildExperience(m, plan as ExperiencePlan, a, availableLayers(catalog, at(site)));
        if (!result.built.length && !m.layers?.length) return 'Nothing in this plan can be built yet; see assess_experience for the gaps.';
        return { message: result.message, issues: result.issues };
      });
      const sc = out.structuredContent as Record<string, unknown> | undefined;
      if (sc && result) {
        Object.assign(sc, { verdict: a.verdict, built: result.built, skipped: result.skipped, gaps: a.gaps, setup: a.setup });
        if (sc.ok && a.gaps.length) {
          sc.next = [`Show the person the ${a.gaps.length} gap${a.gaps.length === 1 ? '' : 's'}; with their yes, look for an existing issue with find_related_issues, then draft a request for each with draft_development_request.`];
          (out.content[0] as { text: string }).text += `\nGaps: ${a.gaps.map((g) => `${g.for} (${g.kind})`).join('; ')}`;
        }
      }
      return out;
    },
  );

  // ---- Sites ----

  tool(
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
        if (!result.files.length) return fail('The site was not created.', { issues: result.issues }, { code: 'invalid_site', next: ['Fix the values listed and call create_site again.'] });
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

  tool(
    'get_site',
    {
      title: 'Read a site',
      description: "Read a site's site.json, its scene (layers bottom to top with effective params) and its current problems.",
      inputSchema: { site: z.string().describe('Site folder') },
    },
    async ({ site }) => {
      const dir = at(site);
      const { manifest, issues } = validateSiteDir(dir, catalog);
      if (!manifest) return fail(issues[0]!.message, undefined, { code: 'no_site', next: ['Check the folder, or create the site with create_site.'] });
      const describe = (ref: SceneEntry) => {
        const layer = findLayer(catalog, dir, ref.use, manifest);
        const defaults = Object.fromEntries((layer?.manifest.controls ?? []).filter((c) => c.type !== 'action').map((c) => [c.id, c.default]));
        return { id: ref.id, use: ref.use, name: layer?.manifest.name ?? '(unknown layer)', active: ref.active !== false && (ref.active === true || ref.items === undefined), params: { ...defaults, ...(ref.params ?? {}) }, overrides: ref.params ?? {} };
      };
      const scene = (manifest.layers ?? []).map((ref, index) => ({
        index,
        ...describe(ref),
        active: Boolean(ref.active),
        ...(ref.items?.length ? { items: ref.items.map((item) => ({ ...describe(item), active: item.active !== false })) } : {}),
        ...(ref.steps ? { steps: ref.steps } : {}),
      }));
      return reply(`${manifest.name}: ${scene.length} layer${scene.length === 1 ? '' : 's'}, ${counts(issues)}.`, { scene, issues, manifest });
    },
  );

  const editable = (catalog.siteSchema?.['']?.fields ?? ['name', 'origin', 'extent', 'timezone', 'table', 'scene', 'basemap', 'branding', 'tv']).filter(
    (k) => !['format', 'id', 'layers', 'custom'].includes(k),
  );

  tool(
    'update_site',
    {
      title: 'Update site settings',
      description:
        `Change site settings other than the scene. Settable in this core: ${editable.join(', ')}. Among them: table (size, tile_cm, front, ribbons, glow: the ambient glow around the model, intro: build (the default), fade or zoom, how the table opens), scene sources (buildings, terrain, trees, cell_m), basemap (style, black and white, brightness), branding (title, logo, welcome line, languages, translations), palette, display (quality, sounds: the interface sounds' volume 0 to 1) and tv. Objects are merged one level deep; null removes a key. The change is refused if it makes the site invalid. Use the layer tools for the scene.`,
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
          return fail(`'${key}' is not a site.json setting in format ${SITE_FORMAT}. Settable: ${editable.join(', ')}.`, undefined, { code: 'unknown_setting', next: ['If the site really needs it, it is a core change: find_related_issues, then draft_development_request (kind "site-setting").'] });
        }
        // Any top-level setting by name, checked as a whole by validateManifest below.
        const bag = next as unknown as Record<string, unknown>;
        const isPlain = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
        const old = bag[key];
        if (value === null) delete bag[key];
        else if (isPlain(value) && isPlain(old)) {
          const merged: Record<string, unknown> = { ...old };
          for (const [k, v] of Object.entries(value)) {
            if (v === null && key !== 'basemap') delete merged[k];
            else merged[k] = v;
          }
          bag[key] = merged;
        } else bag[key] = value;
      }
      const issues = validateManifest(next, dir, catalog);
      const before = new Set(validateManifest(manifest, dir, catalog).filter((i) => i.level === 'error').map((i) => `${i.path}|${i.message}`));
      const added = issues.filter((i) => i.level === 'error' && !before.has(`${i.path}|${i.message}`));
      if (added.length) return fail('Not saved: the change would make the site invalid.', { issues: added }, { code: 'would_invalidate', next: ['Fix the values listed and call update_site again; nothing was written.'] });
      writeSite(dir, next, `Changed ${Object.keys(set).join(', ')}`);
      return reply(`Saved (${counts(issues)}).`, { issues, changed: Object.keys(set) });
    },
  );

  tool(
    'list_versions',
    {
      title: 'List saved versions of a table',
      description: 'The versions of site.json the MR Studio app keeps on this computer (its Version history, the last 200 changes), newest first: who made each (editor, controller, mcp, import, outside, history) and what it changed. Empty for a table the app has not opened on this computer.',
      inputSchema: { site: z.string().describe('Site folder'), limit: z.number().int().positive().optional().describe('How many (default 20)') },
    },
    async ({ site, limit }) => {
      const versions = listVersions(at(site)).slice(0, limit ?? 20);
      if (!versions.length) return reply('No versions are kept for this table on this computer. The app keeps them once it has opened the table.', { versions });
      return reply(`${versions.length} version${versions.length === 1 ? '' : 's'}, newest first.`, { versions: versions.map((v) => ({ ...v, when: new Date(v.at * 1000).toISOString() })) });
    },
  );

  tool(
    'restore_version',
    {
      title: 'Go back to a saved version',
      description: 'Puts back a version from list_versions. The app records it as a new version on top ("Went back to: …"), so nothing is lost and Undo in the editor takes it back. Ask the person first: it replaces the current layers and settings.',
      inputSchema: { site: z.string().describe('Site folder'), revision: z.number().int().positive().describe('The rev from list_versions') },
    },
    async ({ site, revision }) => {
      try {
        const back = restoreVersion(at(site), revision);
        return reply(`Went back to version ${revision}: ${back.summary}.`, { revision, summary: back.summary });
      } catch (error) {
        return fail((error as Error).message, undefined, { code: 'unknown_version', next: ['Call list_versions to see the versions kept.'] });
      }
    },
  );

  const target = {
    id: z.string().optional().describe('Instance id of a layer or item (from get_site); the surest way to name one'),
    index: z.number().int().optional().describe('Position in the scene (0 is the bottom)'),
    use: z.string().optional().describe('Layer id, if it appears once in the scene'),
  };
  /** Where an entry is: the list that holds it (the scene, or a layer's items), its index there, and its layer for an item. */
  type Place = { list: SceneEntry[]; i: number; parent?: LayerRef };
  function locate(manifest: SiteManifest, id?: string, index?: number, use?: string): Place | string {
    const layers: SceneEntry[] = (manifest.layers ??= []);
    if (id !== undefined) {
      for (const [i, layer] of layers.entries()) {
        if (layer?.id === id) return { list: layers, i };
        const j = Array.isArray(layer?.items) ? layer.items.findIndex((item) => item?.id === id) : -1;
        if (j >= 0) return { list: layer.items!, i: j, parent: layer };
      }
      return `No layer or item '${id}'. Ids: ${instanceIds(manifest).join(', ') || 'none'}.`;
    }
    if (index !== undefined) return index >= 0 && index < layers.length ? { list: layers, i: index } : `No layer at index ${index}; the scene has ${layers.length}.`;
    if (!use) return 'Give id, index or use.';
    const hits = layers.map((l, i) => (l.use === use ? i : -1)).filter((i) => i >= 0);
    if (hits.length === 1) return { list: layers, i: hits[0]! };
    return hits.length ? `'${use}' appears ${hits.length} times; give its id (${hits.map((i) => layers[i]!.id).join(', ')}).` : `'${use}' is not in the scene (${layers.map((l) => l.use).join(', ') || 'empty'}).`;
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
      return fail(`This site is in the older site format ${manifest.format}.`, undefined, { code: 'old_site_format', next: [`Run \`mrstudio migrate <site folder>\` (or open it once in the MR Studio app) to bring it to format ${SITE_FORMAT}, then try again.`] });
    }
    manifest.layers = Array.isArray(manifest.layers) ? manifest.layers : [];
    const result = edit(manifest);
    if (typeof result === 'string') return fail(result, undefined, { code: 'not_found', next: ['Call get_site to see the scene and its ids.'] });
    // A refusal never repeats the success line it would have had (#321): say what was refused and why.
    const next = ['Fix the issues listed and call the tool again; nothing was written.'];
    if (result.issues?.some((i) => i.level === 'error')) return fail('Not saved: the values given are not valid.', { attempted: result.message, issues: result.issues }, { code: 'invalid_params', next });
    const issues = validateManifest(manifest, dir, catalog);
    const errors = issues.filter((i) => i.level === 'error' && /^(layers|custom)/.test(i.path));
    if (errors.length) return fail('Not saved: the change would leave the scene invalid.', { attempted: result.message, issues: errors }, { code: 'would_invalidate', next });
    writeSite(dir, manifest, result.message.replace(/\.$/, ''));
    const scene = manifest.layers.map(
      (l, i) => `${i}: ${l.id} (${l.use})${l.active ? ' active' : ''}${l.items?.length ? `, items ${l.items.map((item) => item.id).join(', ')}` : ''}${l.steps?.sequence?.length ? `, ${l.steps.sequence.length} steps` : ''}`,
    );
    return reply(`${result.message} Site is ${counts(issues)}.`, { scene_bottom_to_top: scene, issues: [...(result.issues ?? []), ...issues.filter((i) => i.level !== 'note')] });
  }

  tool(
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
        stack: z.union([z.literal(1), z.literal(2)]).optional().describe('Inside an X-ray glass (lens) or a Reveal line (swipe): 1 the surface, shown around the glass or on the far side of the line; 2 (default) underneath, shown through it (#606)'),
      },
    },
    async ({ site, use, id, parent, active, params, position, stack }) =>
      editScene(site, (m) => {
        const layer = findLayer(catalog, at(site), use, m);
        if (!layer) return `No layer '${use}'. Core layers: ${catalog.layers.map((l) => l.id).join(', ')}. For something new, use find_capabilities and assess_experience.`;
        const checked = params ? checkParams(layer, params, 'params') : { issues: [], cleaned: undefined };
        const name = id ?? freeId(m, use);
        if (instanceIds(m).includes(name)) return `'${name}' is already the id of a layer or item; give another id.`;
        const entry: SceneEntry = { use, id: name };
        if (active !== undefined && !(parent && active)) entry.active = active;
        if (checked.cleaned && Object.keys(checked.cleaned).length) entry.params = checked.cleaned;
        if (stack === 1) {
          if (!parent) return 'Only an item inside a layer has a stack: give parent too.';
          entry.stack = 1;
        }
        let list: SceneEntry[] = (m.layers ??= []);
        if (parent) {
          const owner = list.find((l) => l.id === parent);
          if (!owner) return `No layer '${parent}' in the scene to hold it (items cannot hold items).`;
          owner.items = Array.isArray(owner.items) ? owner.items : [];
          list = owner.items;
        }
        const pos = position === undefined ? list.length : Math.max(0, Math.min(list.length, position));
        list.splice(pos, 0, entry);
        return { message: `Added ${layer.manifest.name} as '${name}'${parent ? ` inside '${parent}'` : ''} at index ${pos}.`, issues: checked.issues };
      }),
  );

  tool(
    'set_layer',
    {
      title: 'Change a layer in the scene',
      description:
        "Set params, the start state and the controller button of a layer or item already in the scene. Params merge into the existing overrides (null removes one) unless replace_params is true. The button's fields (name, description, icon, side, group, order, credit: a credit line under its name, legend: auto, full, compact or off) merge the same way; items have no button.",
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
        const entry = place.list[place.i]!;
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
            if (!['name', 'description', 'icon', 'side', 'group', 'order', 'credit', 'legend'].includes(k)) return `A button has no '${k}' (name, description, icon, side, group, order, credit, legend).`;
            if (k === 'legend' && v !== null && !['auto', 'full', 'compact', 'off'].includes(String(v))) return `button.legend is 'auto', 'full', 'compact' or 'off'.`;
            if (v === null) delete next[k];
            else next[k] = v;
          }
          if (Object.keys(next).length) entry.button = next;
          else delete entry.button;
        }
        return { message: `Updated ${layer.manifest.name} ('${entry.id}').`, issues };
      }),
  );

  tool(
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
        const entry = place.list[place.i]!;
        let list: SceneEntry[] = place.list;
        if (parent === null) list = m.layers ??= [];
        else if (parent !== undefined) {
          const owner = (m.layers ?? []).find((l) => l.id === parent);
          if (!owner || owner === entry) return `No other layer '${parent}' in the scene to hold it.`;
          if (entry.items?.length || entry.steps || entry.button) return `'${entry.id}' has items, steps or a button, so it cannot become an item.`;
          owner.items = Array.isArray(owner.items) ? owner.items : [];
          list = owner.items;
        }
        place.list.splice(place.i, 1);
        if (place.parent && !place.parent.items?.length) delete place.parent.items;
        const dest = Math.max(0, Math.min(list.length, to));
        list.splice(dest, 0, entry);
        return { message: `Moved '${entry.id}' to ${dest}${parent ? ` inside '${parent}'` : parent === null ? ' in the scene' : ''}.` };
      }),
  );

  tool(
    'remove_layer',
    {
      title: 'Remove a layer from the scene',
      description: "Remove one layer (with its items) or one item. Sequence steps that showed it are removed too.",
      inputSchema: { site: z.string(), ...target },
    },
    async ({ site, id, index, use }) =>
      editScene(site, (m) => {
        const place = locate(m, id, index, use);
        if (typeof place === 'string') return place;
        const entry = place.list.splice(place.i, 1)[0]!;
        if (place.parent && !place.parent.items?.length) delete place.parent.items;
        const gone = new Set([entry.id, ...(entry.items ?? []).map((item) => item.id)]);
        let dropped = 0;
        for (const layer of m.layers ?? []) {
          const steps = layer.steps;
          if (!steps || !Array.isArray(steps.sequence)) continue;
          const before = steps.sequence.length;
          steps.sequence = steps.sequence.filter((step) => !gone.has(step?.layer));
          dropped += before - steps.sequence.length;
        }
        return { message: `Removed '${entry.id}' (${entry.use})${dropped ? ` and ${dropped} step${dropped === 1 ? '' : 's'} that showed it` : ''}.` };
      }),
  );

  tool(
    'set_steps',
    {
      title: 'Set how Next moves through a layer',
      description:
        'Set or clear a layer\'s steps: mode (manual or timed), loop, reveal (what Next does after a step\'s sub-steps: stop or then-next), the sequence\'s default transition and transition_s and, for a sequence such as the slideshow, the sequence of steps. Each step shows another layer of the scene or one of the sequence\'s own items, by id, with optional params for that step only, duration_s, transition (cut, fade or dip: through the empty map) and transition_s, next, title, description, source and notes. notes are the presenter\'s words for that step: they show on the guide\'s phone (/guide) and in the editor, never on the table or the controller. Replaces the whole steps object; null clears it.',
      inputSchema: {
        site: z.string(),
        ...target,
        steps: z.record(z.string(), z.unknown()).nullable().describe('e.g. { "mode": "manual", "loop": true, "sequence": [{ "layer": "sunlight", "params": { "hour": 9 }, "title": "Morning", "notes": "Ask who walks here before work." }] }'),
      },
    },
    async ({ site, id, index, use, steps }) =>
      editScene(site, (m) => {
        const place = locate(m, id, index, use);
        if (typeof place === 'string') return place;
        if (place.parent) return `'${place.list[place.i]!.id}' is an item; items have no steps.`;
        const entry = place.list[place.i]!;
        if (steps === null) delete entry.steps;
        else entry.steps = steps;
        return { message: steps === null ? `Cleared the steps of '${entry.id}'.` : `Set the steps of '${entry.id}'.` };
      }),
  );

  tool(
    'save_custom_layer',
    {
      title: 'Save a custom layer',
      description:
        'Save (or with recipe null, remove) a custom layer in the site: a recipe of blocks the runtime draws without code. A recipe has name, description, icon, category, data (each { id, and one of dataset | path | wms { url, layers, styles, format, source } | tiles }), look, motion and interaction (each a list of { id, block, data?, on?, props }), enter (cut or fade), controls (as in layer.json, with bind: "look.<block id>.<prop>", or "filter.<look id>.<column>" to show only matching features), interaction tap-info (props label, name, facts: the features become pickable, their facts on the controller), timeline motion series (columns in time order, coloured in turn, with time_play/time_at controls), legend and attract. Leave legend out and it is worked out from the looks and their data, as the editor does. The table is 2D only. Then add it to the scene with add_layer use "custom:<id>". The block names are in docs/blocks.md.',
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
          const users = (m.layers ?? []).flatMap((l): SceneEntry[] => [l, ...(l.items ?? [])]).filter((e) => e?.use === use).map((e) => e.id);
          if (users.length) return `The custom layer '${id}' is used by ${users.join(', ')}; remove those first.`;
          if (!m.custom?.[id]) return `There is no custom layer '${id}'.`;
          delete m.custom[id];
          if (!Object.keys(m.custom).length) delete m.custom;
          return { message: `Removed the custom layer '${id}'.` };
        }
        // As the caller gave it; editScene checks the whole site before it is written.
        const saved = { ...recipe } as unknown as CustomLayer;
        let legendNote = '';
        if (saved.legend === undefined) {
          const legend = legendFor(saved, at(site), m.data ?? {}, m.palette);
          if (legend?.length) {
            saved.legend = legend;
            legendNote = ` The controller's legend has ${legend.length} row${legend.length === 1 ? '' : 's'}, worked out from the looks and their data.`;
          } else if ((saved.look ?? []).some((block) => block?.block === 'raster')) legendNote = ' The table works out the legend from the looks while it shows the layer.';
          else if ((saved.look ?? []).length) legendNote = ' No legend yet: the looks\' data could not be read; save again once the data is in the site, or give legend yourself.';
        }
        m.custom = { ...(m.custom ?? {}), [id]: saved };
        return { message: `Saved the custom layer '${id}'. Add it with add_layer use "${use}".${legendNote}` };
      }),
  );

  // ---- Data in (#320): the editor's own import code, through the mrstudio command line ----

  const noCli = () =>
    fail('The mrstudio command line is not on this computer, so data cannot be brought in from here.', undefined, {
      code: 'no_cli',
      next: ['Install or update the MR Studio app (it ships the command line inside it), then in the app use Displays and settings, Command line, Install command line tool so terminals find mrstudio; or set MRSTUDIO_CLI to an mrstudio program.', "Or add the data in the editor's Your place or Add data, then call list_site_files."],
    });
  const TARGETS = 'buildings, trees, water, context (buildings around the table, felt only by the wind), walkways, trips, terrain, or data:<name> for any other dataset (data:roads, data:zones)';

  tool(
    'import_data',
    {
      title: 'Bring data into a site',
      description: `Bring a dataset into the site exactly as the editor's Add data does, with the same checks: from a file (GeoJSON, CSV with lon and lat, a zipped shapefile or a GeoPackage as agencies like SGU and Lantmäteriet hand them out (one layer at a time: the report lists the layers, pass layer to choose), GeoTIFF for terrain or for a raster of values such as data:soil-depth), from OpenStreetMap for the table's area (source osm: buildings, trees, walkways, data:roads), or free elevation for the ground (source elevation, target terrain). The coordinate system is detected and reprojected, and what lies off the table is reported. Without write it only checks and reports (count, how many are on the table, issues, blockers); with write it saves the file into data/ and points site.json at it (scene.* or data.<name>). Targets: ${TARGETS}. Needs the MR Studio app or the mrstudio command line.`,
      inputSchema: {
        site: z.string(),
        target: z.string().describe(TARGETS),
        file: z.string().optional().describe('Path of the file on this computer'),
        source: z.enum(['file', 'osm', 'elevation']).optional().describe("Default file; osm or elevation fetch for the table's area"),
        write: z.boolean().optional().describe('Save it (default false: check and report only)'),
        crop: z.boolean().optional().describe('Leave out what lies well outside the table'),
        swap: z.boolean().optional().describe('The file has latitude first'),
        crs: z.string().optional().describe('For a terrain GeoTIFF that does not say: "EPSG:3006"'),
        layer: z.string().optional().describe('For a zip of shapefiles or a GeoPackage with several layers: the layer name the report lists'),
      },
    },
    async ({ site, target, file, source, write, crop, swap, crs, layer }) => {
      const cli = findCli(catalog);
      if (!cli) return noCli();
      const from = source ?? 'file';
      if (from === 'file' && !file) return fail('Give file, or source "osm" or "elevation".', undefined, { code: 'invalid_params', next: [] });
      const args = ['data', 'add', at(site), '--target', target];
      if (from === 'file') args.push('--file', at(file!));
      else args.push(`--${from}`);
      if (write) args.push('--write');
      if (crop) args.push('--crop');
      if (swap) args.push('--swap');
      if (crs) args.push('--crs', crs);
      if (layer) args.push('--layer', layer);
      const run = await runCliJson<ImportReport>(cli, args);
      const report = run.json;
      if (!report || report.error) return fail(report?.error ?? `The command line failed: ${run.output.slice(-400)}`, undefined, { code: 'import_failed', next: [] });
      const { preview: _preview, ...rest } = report;
      const blockers = (report.issues ?? []).filter((i) => i.severity === 'blocker');
      if (!report.ok) {
        return fail(`Not brought in: ${report.summary}`, { report: rest }, { code: 'import_refused', next: blockers.map((b) => (b.fix ? `${b.message} Try again with ${b.fix}: true.` : b.message)).concat(['Nothing was written.']) });
      }
      return reply(write ? `Brought in ${target}: ${report.summary}. site.json now points at it.` : `Checked ${target}: ${report.summary}. Nothing written; call again with write true to save it.`, { written: Boolean(write), report: rest });
    },
  );

  const keepFile = (kind: 'media' | 'sound') => async ({ site, file }: { site: string; file: string }) => {
    const cli = findCli(catalog);
    if (!cli) return noCli();
    const run = await runCliJson<{ path?: string; error?: string }>(cli, ['data', kind, at(site), at(file)]);
    if (run.json?.path) {
      const use = kind === 'media' ? `Use it as the file of a media layer or slide step (params.file: "${run.json.path}").` : `Name it in a points dataset column used by a sound motion ("${run.json.path}").`;
      return reply(`Saved ${run.json.path}. ${use}`, { path: run.json.path });
    }
    return fail(run.json?.error ?? `The command line failed: ${run.output.slice(-400)}`, undefined, { code: 'import_refused', next: ['Nothing was written.'] });
  };

  tool(
    'add_media',
    {
      title: 'Add a picture or video to a site',
      description: "Copy a picture (PNG, JPEG, WebP, GIF) or video (MP4, WebM) into the site's data/media/, with the same checks as the editor, and return the path to use in a media layer or slide step. Needs the MR Studio app or the mrstudio command line.",
      inputSchema: { site: z.string(), file: z.string().describe('Path of the file on this computer') },
    },
    keepFile('media'),
  );

  tool(
    'add_sound',
    {
      title: 'Add a sound to a site',
      description: "Copy a sound (WAV, MP3, OGG, M4A) into the site's data/sounds/, with the same checks as the editor, and return the path a points dataset names for a sound motion. Needs the MR Studio app or the mrstudio command line.",
      inputSchema: { site: z.string(), file: z.string().describe('Path of the file on this computer') },
    },
    keepFile('sound'),
  );

  tool(
    'export_starter_pack',
    {
      title: 'Export a starter pack for outside tools',
      description:
        "Make a starter pack (#450): the table's outline, tile grid, building footprints, street network, projection area and at-a-glance boxes as files to draw on in other programs, in one zip with a README of steps per program and how to bring the result back. QGIS gets GeoJSON (WGS84) and a picture placed by a world file; Illustrator a layered SVG at the table's real size (its \"MR Studio guides\" group is dropped when the drawing comes back as a Masterplan); Photoshop one transparent PNG per feature; PowerPoint a one-slide .pptx the table's shape. The table canvas is exactly the table's frame, so a picture (Picture or video layer, fit stretch), a drawing (Masterplan) or data made on it comes back in place; the projection canvas adds the projector's margins. Use it when a team wants to make a layer's art or data outside MR Studio. Same as the editor's File, Export starter pack. Needs the MR Studio app or the mrstudio command line.",
      inputSchema: {
        site: z.string(),
        out: z.string().describe('The zip to write, for example "Lindholmen starter pack.zip"'),
        features: z.array(z.enum(['table', 'tiles', 'buildings', 'streets', 'projection', 'glance'])).optional().describe('Default table, tiles, buildings, streets'),
        apps: z.array(z.enum(['qgis', 'illustrator', 'photoshop', 'powerpoint'])).optional().describe('Default all four'),
        canvas: z.enum(['table', 'projection']).optional().describe('table (default): comes back in place; projection: with the margins'),
        px_per_cm: z.number().min(2).max(100).optional().describe('Picture detail, default 20'),
      },
    },
    async ({ site, out, features, apps, canvas, px_per_cm }) => {
      const cli = findCli(catalog);
      if (!cli) return noCli();
      const args = ['starter-pack', at(site), '--out', at(out), '--json'];
      if (features?.length) args.push('--features', features.join(','));
      if (apps?.length) args.push('--apps', apps.join(','));
      if (canvas) args.push('--canvas', canvas);
      if (px_per_cm) args.push('--px-per-cm', String(px_per_cm));
      const run = await runCliJson<{ ok?: boolean; error?: string; path: string; written: { files: string[]; picture: [number, number]; notes: string[] } }>(cli, args);
      const result = run.json;
      if (!result?.ok) return fail(result?.error ?? `The command line failed: ${run.output.slice(-400)}`, undefined, { code: 'starter_pack_failed', next: ['Check that the site loads (validate_site) and that at least one chosen feature exists.'] });
      const w = result.written;
      return reply(`Wrote ${result.path}: ${w.files.length} files for ${(apps ?? ['qgis', 'illustrator', 'photoshop', 'powerpoint']).join(', ')}, pictures ${w.picture[0]} x ${w.picture[1]} px. Open README.md inside first.${w.notes.length ? ` Notes: ${w.notes.join(' ')}` : ''}`, { path: result.path, ...w });
    },
  );

  tool(
    'list_site_files',
    {
      title: 'List the files in a site',
      description:
        'What is in the site\'s data/ folder: datasets (GeoJSON, CSV) with feature counts, geometry types, columns (numbers with their range, text with its values when there are few) and bounds; pictures, video and sounds; 3D models. Each file says which site.json keys use it, so unused files and the right column for a custom layer\'s "by" are plain. Use the paths as they are in params, scene, data and recipes.',
      inputSchema: {
        site: z.string(),
        kind: z.enum(['geojson', 'csv', 'picture', 'video', 'sound', 'model', 'raster', 'other']).optional().describe('Only this kind'),
      },
    },
    async ({ site, kind }) => {
      const dir = at(site);
      let manifest: SiteManifest;
      try {
        manifest = readSite(dir);
      } catch (error) {
        return fail((error as Error).message, undefined, { code: 'no_site', next: ['Give the site folder, or create one with create_site.'] });
      }
      const files = listSiteFiles(dir, manifest, kind);
      const unused = files.filter((f) => !f.used_by.length).length;
      const counts = Object.entries(files.reduce((a: Record<string, number>, f) => ((a[f.kind] = (a[f.kind] ?? 0) + 1), a), {})).map(([k, n]) => `${n} ${k}`);
      return reply(`${files.length} file${files.length === 1 ? '' : 's'} in data/${counts.length ? ` (${counts.join(', ')})` : ''}${unused ? `; ${unused} not used by site.json` : ''}.`, { files });
    },
  );

  tool(
    'validate_site',
    {
      title: 'Validate a site',
      description: 'Check a site against the site and layer contracts: keys, geometry, data paths, layer ids, params. Also runs `mrstudio validate` (the app\'s own check, which bakes the scene) when the CLI is installed.',
      inputSchema: { site: z.string(), run_cli: z.boolean().optional().describe('Run the mrstudio CLI too (default true when found)') },
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
      const summary = `${manifest?.name ?? site}: ${counts(issues)}${cli.ran ? `; mrstudio validate ${cli.ok ? 'passed' : 'failed'}` : ''}.`;
      if (!ok) return fail(summary, { valid: false, issues, cli }, { code: 'site_invalid', next: ['Fix each error with the site tools, then validate again.'] });
      return reply(summary, { valid: true, issues, cli });
    },
  );

  tool(
    'preview_site',
    {
      title: 'How to preview a site',
      description:
        'How to see a site running on this computer (Windows or macOS): with the installed MR Studio app (the usual way), or with the mrstudio CLI on a free port so it does not clash with the running app. Returns the command or steps and the URLs of the editor, table, controller, guide\'s phone, phone and dev views. Starts nothing.',
      inputSchema: { site: z.string(), lan: z.boolean().optional().describe('Let phones on the local network join') },
    },
    async ({ site, lan }) => {
      const plan = await previewPlan(at(site), catalog, { lan: lan === true });
      return reply(plan.summary, plan);
    },
  );

  // ---- For layer developers (#284): site code layers (#277) and services (#278) ----

  const layerDir = (site: string, id: string) => join(at(site), 'layers', id);
  const sceneUses = (manifest: SiteManifest | null, id: string) =>
    (Array.isArray(manifest?.layers) ? manifest.layers : []).some((l) => l?.use === `./layers/${id}` || (Array.isArray(l?.items) && l.items.some((i) => i?.use === `./layers/${id}`)));
  const checkFor = (site: string, id: string) => {
    let manifest: SiteManifest | null = null;
    try {
      manifest = readSite(at(site));
    } catch {
      manifest = null;
    }
    return { site: manifest, ...checkLayerPackage(layerDir(site, id), { manifest, kernels: catalog.kernels }) };
  };

  tool(
    'sdk_reference',
    {
      title: 'Look up the layer SDK',
      description:
        "What @mrstudio/sdk really exports, read from its source: functions, classes, constants, interfaces and types, each with its doc comment and declaration (an interface with its members, such as TableContext with ctx.publish, ctx.pointer, ctx.service). Search in words or by name (\"rings that pulse\", \"service jobs\", \"ctx.sendTool\", \"defineLayer\"). Write layer code only against what this returns; anything missing is a development request (kind sdk-runtime), never a copy of core code. Use find_capabilities first: most ideas need no code at all.",
      inputSchema: {
        query: z.string().optional().describe('Words or a name. Leave out for the list of SDK files and what each exports'),
        name: z.string().optional().describe('One export by its exact name, in full'),
        limit: z.number().int().min(1).max(40).optional(),
      },
    },
    async ({ query, name, limit }) => {
      const sdk = catalog.sdk ?? [];
      if (!sdk.length) return fail('This build of the server has no SDK reference.', undefined, { code: 'no_sdk', next: ['Run the server from a core checkout (--core), or update it.'] });
      if (name) {
        const hit = sdk.find((e) => e.name === name) ?? sdk.find((e) => e.name.toLowerCase() === name.toLowerCase());
        if (!hit) return fail(`@mrstudio/sdk exports nothing called ${name}.`, { closest: searchSdk(sdk, name, 5).map((e) => e.name) }, { code: 'not_found', next: ['Search with query instead.'] });
        return reply(`${hit.kind} ${hit.name} (packages/sdk/src/${hit.file})`, { export: hit });
      }
      if (!query) {
        const files: Record<string, string[]> = {};
        for (const e of sdk) (files[e.file] ??= []).push(e.name);
        return reply(`@mrstudio/sdk exports ${sdk.length} names from ${Object.keys(files).length} files. Search with query, or ask for one by name.`, { files, start_with: ['defineLayer', 'LayerModule', 'TableContext', 'PanelContext', 'ContextBase'] });
      }
      const found = searchSdk(sdk, query, limit ?? 12).map(({ score: _score, ...e }) => ({ ...e, signature: e.signature.split('\n').slice(0, 30).join('\n') }));
      return reply(found.length ? `${found.length} exports match "${query}": ${found.slice(0, 6).map((e) => e.name).join(', ')}.` : `Nothing in @mrstudio/sdk matches "${query}". If a layer needs it, that is a development request (kind sdk-runtime).`, { exports: found });
    },
  );

  tool(
    'create_layer',
    {
      title: 'Start a site code layer',
      description:
        "Create a layer with its own code inside a site, for what recipes and existing layers cannot do (check find_capabilities and save_custom_layer first). Runs `mrstudio layer new`: <site>/layers/<id>/ with layer.json, src/index.ts (table(), a primary action, a stat panel bound to ctx.publish and a custom panel), locales/sv.json, build.mjs and a README. It runs in the installed app without changing the core. Then edit the files, check_layer, build_layer, add_layer with use './layers/<id>', and preview_layer. Needs the mrstudio command line.",
      inputSchema: {
        site: z.string(),
        id: z.string().describe('Lowercase letters, digits and dashes: energy-flows'),
        name: z.string().optional().describe('Its name on buttons and in the palette'),
      },
    },
    async ({ site, id, name }) => {
      const cli = findCli(catalog);
      if (!cli) return noCli();
      const run = await runCli(cli, ['layer', 'new', id, '--site', at(site), ...(name ? ['--name', name] : [])]);
      if (!run.ok) return fail(run.output.split('\n').pop() || 'mrstudio layer new failed.', undefined, { code: 'create_failed', next: [] });
      const dir = layerDir(site, id);
      const files = ['layer.json', 'src/index.ts', 'locales/sv.json', 'build.mjs', 'README.md'].filter((f) => existsSync(join(dir, f)));
      return reply(`Made layers/${id}. Edit src/index.ts and layer.json, then check_layer and build_layer; add it to the scene with use "./layers/${id}".`, {
        path: relative(project, dir).replace(/\\/g, '/'),
        files,
        use: `./layers/${id}`,
        next: ['sdk_reference for the API', `check_layer { id: "${id}" }`, `build_layer { id: "${id}" }`, `add_layer { use: "./layers/${id}" }`, `preview_layer { id: "${id}" }`],
      });
    },
  );

  tool(
    'check_layer',
    {
      title: 'Check a site code layer against the rules',
      description:
        "Checks a site layer before it goes on a table: layer.json (api, id, controls, TV panels and a stage made of panels within the density budget or a map stage with at most 4 chip or tile panels, control and map panels naming real controls and tools, team widgets declared, text lengths), every word people see in locales/sv.json, the code (no longitudes and latitudes of a place, no talking to surfaces or the host behind ctx's back, only '@mrstudio/sdk' from the core), what it needs of the site (datasets, services, kernels), and whether dist/index.js is newer than its source. A layer whose stage is a map or panels may be layer.json alone, with no code to build. Writes nothing.",
      inputSchema: { site: z.string(), id: z.string() },
    },
    async ({ site, id }) => {
      if (!existsSync(join(layerDir(site, id), 'layer.json'))) return fail(`No layer package layers/${id} in this site.`, undefined, { code: 'not_found', next: ['create_layer makes one.'] });
      const { site: m, issues } = checkFor(site, id);
      const errors = issues.filter((i) => i.level === 'error').length;
      const used = sceneUses(m, id);
      const summary = errors ? `layers/${id} breaks ${errors} rule${errors === 1 ? '' : 's'}; fix ${errors === 1 ? 'it' : 'them'} before building.` : `layers/${id} follows the layer rules${issues.length ? ` (${issues.length} warning${issues.length === 1 ? '' : 's'})` : ''}.${used ? '' : ` The scene does not use it yet: add_layer with use "./layers/${id}".`}`;
      return reply(summary, { ok_to_build: errors === 0, used_by_scene: used, issues });
    },
  );

  tool(
    'build_layer',
    {
      title: 'Build a site code layer',
      description:
        "Bundles a site layer's src/ into dist/index.js with `mrstudio layer build` (esbuild; npm install on the first build), which is what the app loads; commit dist/ so the table's computer needs no Node. Returns the build's errors when it fails, and the layer's checks when it builds. Needs the mrstudio command line and Node 20+ on this computer.",
      inputSchema: { site: z.string(), id: z.string() },
    },
    async ({ site, id }) => {
      const cli = findCli(catalog);
      if (!cli) return noCli();
      const run = await runCli(cli, ['layer', 'build', id, '--site', at(site)], 600_000);
      if (!run.ok) {
        const errors = run.output.split('\n').filter((l) => /error|ERROR|✘|not found|Node/.test(l)).slice(0, 20);
        return fail(`layers/${id} did not build.`, { errors: errors.length ? errors : run.output.split('\n').slice(-20) }, { code: 'build_failed', next: ['Fix the errors in src/ and build again.', 'Node 20 or newer must be on PATH for building (not for running).'] });
      }
      const { issues } = checkFor(site, id);
      const rest = issues.filter((i) => i.rule !== 'build');
      return reply(`Built layers/${id}/dist/index.js.${rest.some((i) => i.level === 'error') ? ' It still breaks layer rules; see issues.' : ''} preview_layer shows it.`, { output: run.output.split('\n').slice(-8), issues: rest });
    },
  );

  tool(
    'preview_layer',
    {
      title: 'How to see a site layer running',
      description:
        "How to see a site layer on this computer: the dev view (/dev) opens the live table with the Developer workbench beside it (every widget at every size with its cost in reads, live shared values and params with bindings to copy, the controller as the 46-inch screen shows it, an action log, and problems such as refused panels or unpublished bindings); the composer (/compose) and editor show it too. Says first whether the layer is built and in the scene. Starts nothing.",
      inputSchema: { site: z.string(), id: z.string(), lan: z.boolean().optional() },
    },
    async ({ site, id, lan }) => {
      if (!existsSync(join(layerDir(site, id), 'layer.json'))) return fail(`No layer package layers/${id} in this site.`, undefined, { code: 'not_found', next: ['create_layer makes one.'] });
      const { site: m, issues } = checkFor(site, id);
      const plan = await previewPlan(at(site), catalog, { lan: lan === true });
      const built = !issues.some((i) => i.rule === 'build' && /missing/.test(i.message));
      const used = sceneUses(m, id);
      const before = [...(built ? [] : [`build_layer { id: "${id}" } (unbuilt layers draw nothing)`]), ...(used ? [] : [`add_layer { use: "./layers/${id}", active: true } (only layers in the scene run)`])];
      const dev = plan.urls?.dev;
      return reply(`${before.length ? `First: ${before.join('; ')}. Then: ` : ''}${plan.summary}${dev ? ` Open ${dev} to see the layer with its controls and panels.` : ''}`, { ...plan, built, used_by_scene: used, before });
    },
  );

  tool(
    'add_service',
    {
      title: 'Add an outside compute service to a site',
      description:
        "Declare a model or API a site's code layers reach through the host (site.json \"services\"): a program the host starts with the table and keeps running (run: cwd, command with {port} and {python}, optional venv and requirements, env, health path) or a service elsewhere (url). Layers name it in requires.services and call ctx.service(id).get / post / job; the host caches the last answers, so the table still plays them when the service is down. Replaces a service with the same id. Keys go in the app's Sources and keys, never here. See samples/service-example.",
      inputSchema: {
        site: z.string(),
        id: z.string().describe('What layers call it by: ecom'),
        name: z.string().optional(),
        url: z.string().optional().describe('A service that runs elsewhere: https://ecom.example.org'),
        cwd: z.string().optional().describe('Its folder, relative to the site: services/ecom'),
        command: z.array(z.string()).optional().describe('["{python}", "-m", "uvicorn", "app.main:app", "--port", "{port}"]'),
        venv: z.string().optional().describe('.venv, made on the first start'),
        requirements: z.string().optional().describe('requirements.txt, installed into the venv'),
        env: z.record(z.string(), z.string()).optional(),
        health: z.string().optional().describe('The path that answers 200 when ready; default /'),
        start_s: z.number().positive().optional(),
      },
    },
    async ({ site, id, name, url, cwd, command, venv, requirements, env, health, start_s }) => {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return fail(`'${id}' must be lowercase letters, digits and dashes.`, undefined, { code: 'invalid_params', next: [] });
      if (Boolean(url) === Boolean(cwd || command)) return fail('Give either url (a service elsewhere) or cwd and command (a program the host starts), not both or neither.', undefined, { code: 'invalid_params', next: [] });
      if (!url && (!cwd || !command?.length)) return fail('A program the host starts needs both cwd and command.', undefined, { code: 'invalid_params', next: [] });
      if (url && !/^https?:\/\//.test(url)) return fail('url must start with http:// or https://.', undefined, { code: 'invalid_params', next: [] });
      const issues: Issue[] = [];
      if (cwd && !existsSync(join(at(site), cwd))) issues.push({ level: 'warning', path: `services.${id}.run.cwd`, message: `${cwd} does not exist in the site yet; put the service's code there` });
      if (command && !command.some((a) => a.includes('{port}')) && !Object.values(env ?? {}).some((v) => v.includes('{port}'))) issues.push({ level: 'warning', path: `services.${id}.run.command`, message: 'nothing says {port}; the host picks the port and the service must listen on it' });
      return editScene(site, (m) => {
        // Without url, cwd and command were checked above.
        const entry: Service = { id, ...(name ? { name } : {}), ...(url ? { url } : { run: { cwd: cwd!, command: command!, ...(venv ? { venv } : {}), ...(requirements ? { requirements } : {}), ...(env && Object.keys(env).length ? { env } : {}), ...(start_s ? { start_s } : {}) } }), ...(health ? { health } : {}) };
        const list: Service[] = Array.isArray(m.services) ? m.services : [];
        const at_ = list.findIndex((s) => s?.id === id);
        if (at_ >= 0) list[at_] = entry;
        else list.push(entry);
        m.services = list;
        return { message: `${at_ >= 0 ? 'Replaced' : 'Added'} service '${id}'${url ? ` at ${url}` : `, started from ${cwd}`}. Layers reach it with requires.services ["${id}"] and ctx.service("${id}").`, issues };
      });
    },
  );

  // ---- Development requests (#328) ----

  tool(
    'find_related_issues',
    {
      title: 'Find issues that already ask for this',
      description:
        `Before drafting a development request, look for what already exists: issues on ${CORE_REPO} (open and closed) that may ask for the same thing, ranked by how much of the title they share, and capabilities or planned roadmap items that cover it. An issue with similarity 0.6 or more is a likely duplicate: show it to the person and comment there instead of filing a new one. Reads GitHub's public search; signs in with GITHUB_TOKEN, GH_TOKEN or the gh CLI when available.`,
      inputSchema: {
        title: z.string().describe('What is missing, as an issue title would say it: "Voting on sketch marks from phones"'),
        context: z.string().optional().describe('A sentence or two more, used when the title is short'),
      },
    },
    async ({ title, context }) => {
      const found = await searchIssues(title, context ?? '');
      const caps = rank(capabilitiesFor(), `${title} ${context ?? ''}`).slice(0, 5).map((m) => ({ id: m.capability.id, name: m.capability.name, status: m.capability.status, matched: m.why }));
      const likely = found.issues.filter((i) => i.similarity >= DUPLICATE_AT);
      const summary = found.error
        ? `Could not search GitHub (${found.error.code}); check ${CORE_REPO} issues by hand before filing. ${caps.length} capabilities match.`
        : likely.length
          ? `#${likely[0]!.number} "${likely[0]!.title}" (${likely[0]!.state}) likely already asks for this.`
          : `${found.issues.length} related issue${found.issues.length === 1 ? '' : 's'}, none a likely duplicate.`;
      return reply(summary, { issues: found.issues, likely_duplicates: likely.map((i) => i.number), capabilities: caps, ...(found.error ? { github_error: found.error } : {}) });
    },
  );

  tool(
    'draft_development_request',
    {
      title: 'Draft a development request',
      description: `Write an actionable issue for the MR Studio core when an experience needs something it cannot do (a gap from assess_experience, or a planned or missing capability). Searches existing issues first and returns them: if one is a likely duplicate, do not file, comment there. Saves a markdown draft in <site>/requests/ and returns a prefilled issue link; nothing is sent. Kinds: ${Object.entries(DEV_KINDS).map(([k, v]) => `${k} (${v})`).join('; ')}. The issue gets the labels development-request, its kind and needs-triage.`,
      inputSchema: {
        kind: z.string().describe(`One of ${Object.keys(DEV_KINDS).join(', ')} (the older kinds and assess_experience's gap kinds are accepted)`),
        title: z.string().describe('Specific and short: "Voting on sketch marks from phones"'),
        context: z.string().describe('The site, the people at the table, and what they are trying to do'),
        user_story: z.string().describe('"As a <who>, I want <what>, so that <why>"'),
        proposal: z.string().describe('What should exist, in plain words'),
        experience: z.object({ table: z.string().optional(), controller: z.string().optional(), phone: z.string().optional() }).optional().describe('What each surface does with it'),
        technical: z.string().optional().describe('Blocks it could reuse, kernels, data, risks'),
        acceptance: z.array(z.string()).min(1).describe('Checks that say it is done'),
        dependencies: z.array(z.string()).optional(),
        limitations: z.string().optional().describe('What MR Studio does today and why that falls short'),
        references: z.array(z.string()).optional(),
        related_capabilities: z.array(z.string()).optional().describe('Capability ids it reuses or extends'),
        related_issues: z.array(z.object({ number: z.number().int(), why: z.string() })).optional().describe('Related issues this is not a duplicate of, and how it differs'),
        example: z.unknown().optional().describe('The layer.json or site.json fragment a team would write once it exists'),
        site: z.string().optional().describe('Site folder; the draft is saved in its requests/ folder'),
      },
    },
    async (args) => {
      const kind = (args.kind in DEV_KINDS ? args.kind : KIND_ALIASES[args.kind]) as DevKind | undefined;
      if (!kind) return fail(`'${args.kind}' is not a request kind.`, { kinds: Object.keys(DEV_KINDS) }, { code: 'invalid_params', next: [`Use one of ${Object.keys(DEV_KINDS).join(', ')}.`] });
      const dir = args.site ? at(args.site) : null;
      let siteName: string | undefined;
      if (dir) {
        try {
          siteName = readSite(dir).name;
        } catch {
          siteName = undefined;
        }
      }
      const found = await searchIssues(args.title, args.context);
      const draft = writeDevDraft({ ...args, kind, site: siteName ?? args.site } as DevRequest, catalog.version, dir);
      const likely = found.issues.filter((i) => i.similarity >= DUPLICATE_AT && !(args.related_issues ?? []).some((r) => r.number === i.number));
      const warn = likely.length ? ` Careful: #${likely[0]!.number} "${likely[0]!.title}" may already ask for this; show it to the person before filing.` : found.error ? ` GitHub could not be searched (${found.error.code}); check for duplicates by hand.` : '';
      return reply(
        `Drafted "${draft.title}" (${kind}).${draft.path ? ` Saved to ${draft.path}.` : ''}${warn} Show the person the draft; send it with submit_development_request only after they say yes (one yes may cover several drafts).`,
        { path: draft.path, issue_link: draft.url, labels: draft.labels, body: draft.body, related_issues: found.issues, likely_duplicates: likely.map((i) => i.number), ...(found.error ? { github_error: found.error } : {}) },
      );
    },
  );

  tool(
    'submit_development_request',
    {
      title: 'Send development requests',
      description: `Open drafted development requests as GitHub issues on ${CORE_REPO}. Only after the person has read the drafts and said yes; one yes may cover the batch. Each draft is checked against existing issues again first and refused as possible_duplicate unless its number is in not_duplicate_of. Signs in with GITHUB_TOKEN, GH_TOKEN or the gh CLI; without one, or when GitHub refuses, nothing is sent and the prefilled link is returned. An issue number and link are reported only when GitHub returned them.`,
      inputSchema: {
        paths: z.array(z.string()).min(1).describe('Draft paths in <site>/requests/'),
        not_duplicate_of: z.array(z.number().int()).optional().describe('Issue numbers the person agreed these are not duplicates of'),
      },
    },
    async ({ paths, not_duplicate_of }) => {
      const results: SubmitOutcome[] = [];
      for (const p of paths) results.push(await submitDevDraft(at(p), not_duplicate_of ?? []));
      const sent = results.filter((r): r is Extract<SubmitOutcome, { submitted: true }> => r.submitted);
      const held = results.filter((r): r is Extract<SubmitOutcome, { submitted: false }> => !r.submitted);
      const summary = `${sent.length ? `Sent ${sent.map((r) => `#${r.number}`).join(', ')}.` : 'Nothing was sent.'}${held.length ? ` Not sent: ${held.map((r) => `${r.path.split(/[\\/]/).pop()} (${r.error.code})`).join(', ')}.` : ''}`;
      if (!sent.length) {
        const first = held[0]!;
        return fail(summary, { submitted: [], results }, { code: first.error.code, recoverable: first.error.recoverable, next: first.error.next });
      }
      return reply(summary, { submitted: sent.map(({ number, url, title }) => ({ number, url, title })), results });
    },
  );

  // ---- Ideas and requests ----

  tool(
    'check_layer_idea',
    {
      title: 'Check a layer idea',
      description:
        'Superseded by assess_experience (a one-step plan gives the same answer); this name works for this release only. Check a sketched layer against the core: which existing layers already cover it, which kernels and building blocks exist or are planned, and whether it should be configured from an existing layer, requested as a new core layer from existing blocks, or needs new blocks or kernels first.',
      inputSchema: {
        title: z.string(),
        description: z.string().describe('What it shows and what people do with it'),
        kernels: z.array(z.string()).optional().describe('Kernel ids it needs, e.g. ["sunlight"]'),
        blocks: z.array(z.string()).optional().describe('Block ids or names from list_building_blocks, e.g. ["field-overlay", "animated-paths"]'),
        data: z.array(z.string()).optional().describe('Site data it reads'),
        tools: z.array(z.enum(['point', 'line', 'polygon'])).optional(),
        site: z.string().optional(),
      },
    },
    async (args) => {
      const extra = args.site ? availableLayers(catalog, at(args.site)).filter((l) => l.origin === 'site') : [];
      const report = checkIdea(args, catalog, extra);
      // The same idea as a one-step experience plan, so callers can move to assess_experience (#327).
      const assessment = assessFor({ title: args.title, goal: args.description, steps: [{ title: args.title, want: args.description }] }, args.site);
      return reply(`${report.verdict}: ${report.summary}\nNext: ${report.next_step}`, { ...report, assessment: { verdict: assessment.verdict, step: assessment.steps[0], gaps: assessment.gaps } });
    },
  );

  tool(
    'draft_module_request',
    {
      title: 'Draft a module request',
      description: `Superseded by draft_development_request, which also searches existing issues; this name works for this release only. Write a request for the MR Studio core team when a project needs something the core lacks, instead of writing custom code. Saves a markdown draft in <site>/requests/ and returns a prefilled GitHub issue link for ${process.env.MRSTUDIO_REPO ?? 'snjsomnath/mr-studio'}. Nothing is sent. Kinds: ${Object.entries(REQUEST_KINDS).map(([k, v]) => `${k} (${v})`).join('; ')}.`,
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

  tool(
    'submit_module_request',
    {
      title: 'Submit a module request',
      description: 'Superseded by submit_development_request, which checks for duplicates and sends a batch; this name works for this release only. Open a drafted module request as a GitHub issue on the core repository. Only call this after the person has read the draft and agreed: it posts publicly. Uses GITHUB_TOKEN or GH_TOKEN, else a signed-in gh CLI, else returns the link to file by hand.',
      inputSchema: { path: z.string().describe('Path of the draft in <site>/requests/') },
    },
    async ({ path }) => {
      try {
        const result = await submitDraft(at(path));
        if (result.submitted) {
          const number = Number(/\/issues\/(\d+)/.exec(result.url)?.[1]) || null;
          return reply(`Opened ${number ? `#${number}` : 'the issue'}: ${result.url} (${result.how}).`, { submitted: true, number, url: result.url, how: result.how });
        }
        return fail(`Not sent: ${result.how}.`, { submitted: false, issue_link: result.url }, { code: 'not_submitted', next: ['Give the person the issue_link to file it by hand, or sign in (GITHUB_TOKEN, GH_TOKEN or gh auth login) and try again. Never say it was filed.'] });
      } catch (error) {
        return fail((error as Error).message, undefined, { code: 'no_draft', next: ['Draft it first with draft_module_request and pass the path it returns.'] });
      }
    },
  );

  // ---- Prompts ----

  server.registerPrompt(
    'design_experience',
    {
      title: 'Design an experience',
      description: 'From a goal in plain words to an experience across the table, controller and phones: capabilities, a plan, its assessment, then build what exists and request what does not.',
      argsSchema: { goal: z.string().optional(), place: z.string().optional(), audience: z.string().optional() },
    },
    ({ goal, place, audience }) => ({ messages: [{ role: 'user', content: { type: 'text', text: designExperiencePrompt(goal, place, audience) } }] }),
  );

  server.registerPrompt(
    'plan_workshop',
    {
      title: 'Plan a workshop',
      description: 'A timed workshop at the table: the place today, questions answered step by step, a moment where people contribute from their phones, and a close.',
      argsSchema: { topic: z.string().optional(), minutes: z.string().optional(), participants: z.string().optional() },
    },
    ({ topic, minutes, participants }) => ({ messages: [{ role: 'user', content: { type: 'text', text: planWorkshopPrompt(topic, minutes, participants) } }] }),
  );

  server.registerPrompt(
    'compare_scenarios',
    {
      title: 'Compare scenarios',
      description: 'Show today and a proposal on a table that shows one layer at a time: reveal line, magnifier, phased plan or a repeated question.',
      argsSchema: { today: z.string().optional(), proposal: z.string().optional() },
    },
    ({ today, proposal }) => ({ messages: [{ role: 'user', content: { type: 'text', text: compareScenariosPrompt(today, proposal) } }] }),
  );

  server.registerPrompt(
    'build_from_data',
    {
      title: 'Build from data',
      description: 'Turn a dataset into a custom layer and a step of an experience, without code.',
      argsSchema: { data: z.string().optional() },
    },
    ({ data }) => ({ messages: [{ role: 'user', content: { type: 'text', text: buildFromDataPrompt(data) } }] }),
  );

  server.registerPrompt(
    'build_code_layer',
    {
      title: 'Build a layer with its own code',
      description: 'A site code layer like ECOM: check no-code options first, plan the surfaces, add a service for a model, then scaffold, check, build and preview.',
      argsSchema: { idea: z.string().optional() },
    },
    ({ idea }) => ({ messages: [{ role: 'user', content: { type: 'text', text: buildCodeLayerPrompt(idea) } }] }),
  );

  server.registerPrompt(
    'build_controller_app',
    {
      title: 'Build a controller map app',
      description: "Something people do on the controller's screen that changes the table: existing tools and stages first, code last.",
      argsSchema: { idea: z.string().optional() },
    },
    ({ idea }) => ({ messages: [{ role: 'user', content: { type: 'text', text: buildControllerAppPrompt(idea) } }] }),
  );

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

  const patterns = () => parsePatterns(catalog.docs['experience-design'] ?? '');

  server.registerResource(
    'concepts',
    'mrstudio://concepts',
    { title: 'Designing an MR Studio experience', description: 'Read first: the three surfaces (table, controller, phones), what goes where, the words, the constraints, and the experience patterns', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: catalog.docs['experience-design'] ?? 'docs/experience-design.md is missing from this core.' }] }),
  );

  server.registerResource(
    'patterns',
    new ResourceTemplate('mrstudio://patterns/{id}', {
      list: async () => ({ resources: patterns().map((p) => ({ uri: `mrstudio://patterns/${p.id}`, name: p.name, mimeType: 'text/markdown', description: `Uses ${p.capabilities.join(', ')}` })) }),
    }),
    { title: 'Experience patterns', description: 'Shapes of experience that work at a table, each with the table, controller and phone roles and the capabilities it uses', mimeType: 'text/markdown' },
    async (uri, { id }) => {
      const p = patterns().find((x) => x.id === String(id));
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: p ? p.text : `No pattern ${id}. Patterns: ${patterns().map((x) => x.id).join(', ')}` }] };
    },
  );

  server.registerResource(
    'data-formats',
    'mrstudio://data-formats',
    { title: 'Data formats', description: 'What a good file looks like for each kind of data a table takes (buildings, ground, trees, streets, walking paths, trips): the words the editor shows on each "?"', mimeType: 'text/markdown' },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: DATA_FORMATS.map((f) => `## ${f.name} (\`${f.dataset}\`, ${f.files})\n\n${f.example}`).join('\n\n') }],
    }),
  );

  server.registerResource(
    'capabilities',
    'mrstudio://capabilities',
    { title: 'Capability catalogue', description: 'Every capability with its status from the code: id, name, kind, status, one line', mimeType: 'application/json' },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(capabilitiesFor().map((c) => ({ id: c.id, kind: c.kind, name: c.name, status: c.status, summary: c.purpose ?? c.summary })), null, 2) }],
    }),
  );

  server.registerResource(
    'capability',
    new ResourceTemplate('mrstudio://capabilities/{id}', {
      list: async () => ({ resources: capabilitiesFor().map((c) => ({ uri: `mrstudio://capabilities/${c.id}`, name: c.name, mimeType: 'application/json' })) }),
    }),
    { title: 'One capability', description: 'A capability record in full', mimeType: 'application/json' },
    async (uri, { id }) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(capabilitiesFor().find((c) => c.id === decodeURIComponent(String(id))) ?? null, null, 2) }] }),
  );

  server.registerResource(
    'schema',
    new ResourceTemplate('mrstudio://schema/{name}', {
      list: async () => ({
        resources: [
          { uri: 'mrstudio://schema/site', name: 'site.json keys', mimeType: 'application/json' },
          { uri: 'mrstudio://schema/recipe', name: 'Custom layer recipe vocabulary', mimeType: 'application/json' },
        ],
      }),
    }),
    { title: 'Schemas', description: 'The keys site.json accepts at each level (from manifest.rs), and the blocks, props, colours, ramps and icons a custom layer recipe may use (from the SDK)', mimeType: 'application/json' },
    async (uri, { name }) => {
      const body = String(name) === 'site' ? (catalog.siteSchema ?? null) : String(name) === 'recipe' ? RECIPE_VOCABULARY : null;
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(body, null, 2) }] };
    },
  );

  server.registerResource(
    'examples',
    new ResourceTemplate('mrstudio://examples/{id}', {
      list: async () => ({ resources: (catalog.examples ?? []).map((e) => ({ uri: `mrstudio://examples/${e.id}`, name: e.name, mimeType: 'application/json', description: e.about.slice(0, 160) })) }),
    }),
    { title: 'Example sites', description: 'Real sites and samples in the core repository: their layers, steps and custom layers', mimeType: 'application/json' },
    async (uri, { id }) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify((catalog.examples ?? []).find((e) => e.id === String(id)) ?? null, null, 2) }] }),
  );


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

