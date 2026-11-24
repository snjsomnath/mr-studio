// Finds the MR Studio core the server describes: its layers, kernels, building blocks and docs.
//
// Order: an explicit core folder (--core or MRSTUDIO_CORE), a core checkout above the working
// folder or above this script, and finally the snapshot embedded in the built server. The
// snapshot is taken from the same commit the server is built from, so an installed server
// always describes the core it shipped with.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BLOCKS, type BlockDef } from './blocks.ts';

export interface LayerEntry {
  id: string;
  /** "core" for a layer shipped in the app, "site" for a site-only package, "custom" for a custom layer saved in site.json. */
  origin: 'core' | 'site' | 'custom';
  /** The value to put in site.json `use`: "sunlight", "./layers/artwork" or "custom:heat-walk". */
  use: string;
  manifest: Record<string, any>;
}

export interface RoadmapRow {
  section: string;
  layer: string;
  kernel: string;
  blocks: string;
  built: boolean;
  /** The layer package, for rows of the Built table. */
  package?: string;
}

export interface Block extends BlockDef {
  status: 'built' | 'planned';
  /** The source file its pattern was found in, when built. */
  evidence?: string;
}

/** A real site or sample in the core repository. */
export interface Example {
  id: string;
  path: string;
  name: string;
  /** The layer uses in its scene, items included. */
  layers: string[];
  steps: number;
  custom: string[];
  about: string;
}

/** Keys allowed at each path of site.json, read from mrs-site's manifest structs. "layers[]" is a layer entry. */
export type SiteSchema = Record<string, { fields: string[]; required: string[] }>;

export interface Catalog {
  version: string;
  source: 'live' | 'snapshot';
  root: string | null;
  layers: LayerEntry[];
  kernels: string[];
  plannedKernels: string[];
  blocks: Block[];
  roadmap: RoadmapRow[];
  docs: Record<string, string>;
  siteSchema: SiteSchema | null;
  /** CHANGELOG.md: one section per released version, newest first. */
  changelog?: string;
  /** Release notes merged since the last version, waiting in changes/ (live checkouts only). */
  pending?: string[];
  /** Sites and samples in the core repository. */
  examples?: Example[];
}

/** The released versions in CHANGELOG.md, newest first, each with its text. */
export function changelogVersions(changelog: string): { version: string; date: string; text: string }[] {
  const out: { version: string; date: string; text: string }[] = [];
  const parts = changelog.split(/^## /m).slice(1);
  for (const part of parts) {
    const head = /^(\d+\.\d+\.\d+\S*)(?:\s*\(([^)]*)\))?/.exec(part);
    if (head) out.push({ version: head[1]!, date: head[2] ?? '', text: `## ${part}`.trim() });
  }
  return out;
}

/**
 * Reads the serde structs in crates/mrs-site/src/manifest.rs into the keys each level of
 * site.json accepts, so the server follows the core's format without a copy of it.
 */
export function parseSiteSchema(rust: string): SiteSchema | null {
  const structs = new Map<string, { name: string; type: string; required: boolean }[]>();
  let current: { name: string; type: string; required: boolean }[] | null = null;
  let hasDefault = false;
  for (const raw of rust.split(/\r?\n/)) {
    const line = raw.trim();
    const start = /^pub struct (\w+)\s*\{/.exec(line);
    if (start) {
      current = [];
      structs.set(start[1]!, current);
      hasDefault = false;
      continue;
    }
    if (!current) continue;
    if (raw.startsWith('}')) {
      current = null;
      continue;
    }
    if (/^#\[serde\(.*\bdefault\b/.test(line)) hasDefault = true;
    const field = /^pub (?:r#)?(\w+):\s*(.+?),?$/.exec(line);
    if (field) {
      const type = field[2]!;
      current.push({ name: field[1]!, type, required: !hasDefault && !type.startsWith('Option<') });
      hasDefault = false;
    }
  }
  if (!structs.has('SiteManifest')) return null;
  const schema: SiteSchema = {};
  const visit = (struct: string, path: string, depth: number) => {
    const fields = structs.get(struct);
    if (!fields || depth > 6) return;
    schema[path] = { fields: fields.map((f) => f.name), required: fields.filter((f) => f.required).map((f) => f.name) };
    for (const f of fields) {
      const vec = /^(?:Option<)?Vec<(\w+)>/.exec(f.type);
      const inner = /^(?:Option<)?(\w+)/.exec(f.type)?.[1];
      const sub = path ? `${path}.${f.name}` : f.name;
      if (vec && structs.has(vec[1]!)) visit(vec[1]!, `${sub}[]`, depth + 1);
      else if (inner && structs.has(inner)) visit(inner, sub, depth + 1);
    }
  };
  visit('SiteManifest', '', 0);
  return schema;
}

declare const __MRSTUDIO_CATALOG__: string | undefined;

export function isCoreRoot(dir: string): boolean {
  return existsSync(join(dir, 'packages', 'layers')) && existsSync(join(dir, 'docs', 'contracts'));
}

function findUp(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (isCoreRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function rel(root: string, path: string): string {
  return relative(root, path).replace(/\\/g, '/');
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function subdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => statSync(join(dir, name)).isDirectory()).sort();
}

function walkFiles(dir: string, ext: RegExp, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walkFiles(path, ext, out);
    else if (ext.test(name)) out.push(path);
  }
  return out;
}

/** Reads the layer packages in a folder (core packages/layers or a site's layers/). */
export function readLayerDir(dir: string, origin: 'core' | 'site'): LayerEntry[] {
  const out: LayerEntry[] = [];
  for (const name of subdirs(dir)) {
    const path = join(dir, name, 'layer.json');
    if (!existsSync(path)) continue;
    try {
      const manifest = readJson(path);
      out.push({ id: String(manifest.id ?? name), origin, use: origin === 'core' ? String(manifest.id ?? name) : `./layers/${name}`, manifest });
    } catch {
      // A broken manifest is reported by validate_site, not here.
    }
  }
  return out;
}

/**
 * Splits the markdown tables in ROADMAP.md into rows. Columns are found by their header
 * names, not their position: the planned tables are `Layer | Kernel | Blocks`, the Built
 * table is `Layer | Package | Kernel | Notes` (#319).
 */
export function parseRoadmap(text: string): RoadmapRow[] {
  const rows: RoadmapRow[] = [];
  let section = '';
  let header: string[] | null = null;
  for (const line of text.split(/\r?\n/)) {
    const heading = /^##\s+(.*)$/.exec(line);
    if (heading) {
      section = heading[1]!.trim();
      header = null;
      continue;
    }
    if (!line.startsWith('|')) {
      header = null;
      continue;
    }
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.every((c) => /^-+$/.test(c))) continue;
    if (!header) {
      header = cells.map((c) => c.toLowerCase());
      continue;
    }
    if (header[0] !== 'layer') continue;
    const col = (name: string) => {
      const i = header!.indexOf(name);
      return i >= 0 ? (cells[i] ?? '') : '';
    };
    const kernel = col('kernel');
    const pkg = col('package').replace(/`/g, '');
    const built = /^built$/i.test(section) || /\(built\b/.test(kernel);
    rows.push({ section, layer: cells[0] ?? '', kernel, blocks: col('blocks') || col('notes'), built, ...(pkg ? { package: pkg } : {}) });
  }
  return rows;
}

/**
 * Kernels the roadmap names that the engine does not have yet. Only the kernel column counts,
 * and a name that is a core layer's id or a built row's package is never a kernel.
 */
export function plannedKernelsFrom(roadmap: RoadmapRow[], built: string[], layerIds: string[] = []): string[] {
  const names = new Set<string>();
  const not = new Set([...built, ...layerIds, ...roadmap.map((r) => r.package ?? '').filter(Boolean)]);
  for (const row of roadmap) for (const m of row.kernel.matchAll(/`([a-z0-9_-]+)`/g)) names.add(m[1]!);
  return [...names].filter((k) => !not.has(k)).sort();
}

/** Builds the catalog from a core checkout. */
export function loadLive(root: string): Catalog {
  const pkg = existsSync(join(root, 'package.json')) ? readJson(join(root, 'package.json')) : {};
  const layers = readLayerDir(join(root, 'packages', 'layers'), 'core');

  const docs: Record<string, string> = {};
  for (const path of walkFiles(join(root, 'docs'), /\.md$/)) {
    const key = path.slice(join(root, 'docs').length + 1).replace(/\\/g, '/').replace(/\.md$/, '').toLowerCase();
    docs[key] = readFileSync(path, 'utf8');
  }

  const kernels = subdirs(join(root, 'crates', 'mrs-engine', 'src', 'kernels'));

  const sourceFiles = ['sdk', 'runtime', 'dashboard']
    .flatMap((p) => walkFiles(join(root, 'packages', p, 'src'), /\.ts$/))
    .map((p) => ({ path: rel(root, p), text: readFileSync(p, 'utf8') }));
  // A block is built when its pattern is in the source; the first file it is found in is the evidence.
  const blocks: Block[] = BLOCKS.map((b) => {
    const re = new RegExp(b.detect);
    const hit = sourceFiles.find((f) => re.test(f.text));
    return { ...b, status: hit ? 'built' : 'planned', ...(hit ? { evidence: hit.path } : {}) };
  });

  // Real sites and samples, as examples of what a layer looks like in use.
  const examples: Example[] = [];
  for (const base of ['sites', 'samples']) {
    for (const name of subdirs(join(root, base))) {
      const path = join(root, base, name, 'site.json');
      if (!existsSync(path)) continue;
      try {
        const m = readJson(path);
        const uses = (Array.isArray(m.layers) ? m.layers : []).flatMap((l: any) => [l?.use, ...(Array.isArray(l?.items) ? l.items.map((i: any) => i?.use) : [])]).filter((u: unknown): u is string => typeof u === 'string');
        const readme = join(root, base, name, 'README.md');
        examples.push({
          id: name,
          path: `${base}/${name}`,
          name: String(m.name ?? name),
          layers: [...new Set<string>(uses)],
          steps: (Array.isArray(m.layers) ? m.layers : []).filter((l: any) => Array.isArray(l?.steps?.sequence)).reduce((n: number, l: any) => n + l.steps.sequence.length, 0),
          custom: Object.keys(m.custom ?? {}),
          about: existsSync(readme) ? readFileSync(readme, 'utf8').split(/\r?\n\r?\n/).find((p) => p.trim() && !p.startsWith('#'))?.trim().slice(0, 400) ?? '' : '',
        });
      } catch {
        // A broken sample is not an example.
      }
    }
  }

  const roadmap = parseRoadmap(docs['roadmap'] ?? '');
  const layerNames = new Set(layers.map((l) => String(l.manifest.name ?? '').toLowerCase()));
  for (const row of roadmap) if (layerNames.has(row.layer.toLowerCase())) row.built = true;

  const changelogPath = join(root, 'CHANGELOG.md');
  const changelog = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : '';
  if (changelog) docs['changelog'] = changelog;
  const pending = walkFiles(join(root, 'changes'), /\.md$/)
    .filter((p) => !/readme\.md$/i.test(p))
    .map((p) => readFileSync(p, 'utf8').replace(/^---[\s\S]*?---\s*/, '').trim());

  const manifestRs = join(root, 'crates', 'mrs-site', 'src', 'manifest.rs');
  const siteSchema = existsSync(manifestRs) ? parseSiteSchema(readFileSync(manifestRs, 'utf8')) : null;

  return {
    version: String(pkg.version ?? '0.0.0'),
    source: 'live',
    root,
    layers,
    kernels,
    plannedKernels: plannedKernelsFrom(roadmap, kernels, layers.map((l) => l.id)),
    blocks,
    roadmap,
    docs,
    siteSchema,
    changelog,
    pending,
    examples,
  };
}

export interface CoreOptions {
  core?: string;
  /** Folders to search upwards from, first match wins. */
  searchFrom?: string[];
}

export function loadCatalog(options: CoreOptions = {}): Catalog {
  const explicit = options.core ?? process.env.MRSTUDIO_CORE;
  if (explicit) {
    const root = resolve(explicit);
    if (!isCoreRoot(root)) throw new Error(`${root} is not an MR Studio core folder (no packages/layers and docs/contracts)`);
    return loadLive(root);
  }
  const here = (() => {
    try {
      return dirname(fileURLToPath(import.meta.url));
    } catch {
      return null;
    }
  })();
  for (const start of [...(options.searchFrom ?? []), process.cwd(), ...(here ? [here] : [])]) {
    const root = findUp(start);
    if (root) return loadLive(root);
  }
  if (typeof __MRSTUDIO_CATALOG__ === 'string') {
    return { ...(JSON.parse(__MRSTUDIO_CATALOG__) as Catalog), source: 'snapshot', root: null };
  }
  throw new Error('No MR Studio core found. Pass --core <path to an mr-studio checkout> or set MRSTUDIO_CORE.');
}
