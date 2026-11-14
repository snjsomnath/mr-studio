// Reading, checking and editing a site package (docs/contracts/site.md).
// The checks mirror mrs-site and the host's control validation so an LLM gets every problem
// at once, in words, before the app sees the file. `mrstudio validate` stays the authority
// and is run as well when the CLI can be found.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path';

import { readLayerDir, type Catalog, type LayerEntry, type SiteSchema } from './core.ts';

export const SITE_FORMAT = 2;

export interface Issue {
  level: 'error' | 'warning' | 'note';
  path: string;
  message: string;
}

export type SiteManifest = Record<string, any>;

// The keys mrs-site accepts. Unknown keys are an error there. The catalog normally carries the
// schema read from the core's own manifest.rs; this copy of format 2 is the fallback.
const FALLBACK_SCHEMA: SiteSchema = {
  '': { fields: ['format', 'id', 'name', 'origin', 'extent', 'timezone', 'table', 'scene', 'basemap', 'layers', 'tv', 'branding'], required: ['format', 'id', 'name', 'origin', 'extent', 'scene'] },
  origin: { fields: ['lon', 'lat'], required: ['lon', 'lat'] },
  extent: { fields: ['width_m', 'height_m', 'rotation_deg'], required: ['width_m', 'height_m'] },
  table: { fields: ['width_cm', 'height_cm', 'tile_cm'], required: ['width_cm', 'height_cm'] },
  scene: { fields: ['cell_m', 'buildings', 'terrain', 'trees'], required: ['cell_m'] },
  'scene.buildings': { fields: ['path', 'height_property', 'default_height_m'], required: ['path'] },
  'scene.terrain': { fields: ['path', 'width', 'height'], required: ['path', 'width', 'height'] },
  'scene.trees': { fields: ['path', 'height_property', 'default_height_m', 'crown_radius_m'], required: ['path'] },
  basemap: { fields: ['background', 'style'], required: [] },
  branding: { fields: ['title', 'logo'], required: [] },
  'layers[]': { fields: ['use', 'id', 'params', 'active', 'button'], required: ['use'] },
};

export function sitePath(dir: string): string {
  return join(dir, 'site.json');
}

export function readSite(dir: string): SiteManifest {
  const path = sitePath(dir);
  if (!existsSync(path)) throw new Error(`No site.json in ${dir}`);
  const text = readFileSync(path, 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`site.json is not valid JSON: ${(error as Error).message}`);
  }
}

export function writeSite(dir: string, manifest: SiteManifest): void {
  writeFileSync(sitePath(dir), JSON.stringify(manifest, null, 2) + '\n');
}

/** True when `path` stays inside `dir`. */
export function inside(dir: string, path: string): boolean {
  const rel = relative(resolve(dir), resolve(dir, path));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** The layers a site can use: the core's and its own `layers/` packages. */
export function availableLayers(catalog: Catalog, dir: string | null): LayerEntry[] {
  const site = dir ? readLayerDir(join(dir, 'layers'), 'site') : [];
  return [...catalog.layers, ...site];
}

export function findLayer(catalog: Catalog, dir: string | null, use: string): LayerEntry | undefined {
  if (use.startsWith('.')) {
    if (!dir) return undefined;
    const path = join(dir, use, 'layer.json');
    if (!inside(dir, use) || !existsSync(path)) return undefined;
    try {
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      return { id: String(manifest.id), origin: 'site', use, manifest };
    } catch {
      return undefined;
    }
  }
  return catalog.layers.find((l) => l.id === use);
}

// ---- Controls: the same rules as the host (crates/mrs-host/src/layers.rs) ----

export interface ValueCheck {
  ok: boolean;
  value?: unknown;
  message?: string;
}

export function checkControlValue(control: Record<string, any>, value: unknown): ValueCheck {
  switch (control.type) {
    case 'range': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, message: 'must be a number' };
      const { min, max } = control;
      const step = Number(control.step ?? 0);
      let v = Math.min(max, Math.max(min, value));
      if (step > 0) v = Math.min(max, Math.max(min, min + Math.round((v - min) / step) * step));
      v = Math.round(v * 1e9) / 1e9;
      return v === value ? { ok: true, value: v } : { ok: true, value: v, message: `will be stored as ${v} (range ${min} to ${max}, step ${step || 'any'})` };
    }
    case 'select': {
      const options = (control.options ?? []).map((o: any) => (o && typeof o === 'object' && 'value' in o ? o.value : o));
      return options.some((o: unknown) => o === value)
        ? { ok: true, value }
        : { ok: false, message: `is not one of the options: ${options.map((o: unknown) => JSON.stringify(o)).join(', ')}` };
    }
    case 'toggle':
      return typeof value === 'boolean' ? { ok: true, value } : { ok: false, message: 'must be true or false' };
    case 'date': {
      const m = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
      const month = m ? Number(m[2]) : 0;
      const day = m ? Number(m[3]) : 0;
      return m && month >= 1 && month <= 12 && day >= 1 && day <= 31 ? { ok: true, value } : { ok: false, message: 'must be a YYYY-MM-DD date' };
    }
    case 'color':
      return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? { ok: true, value } : { ok: false, message: 'must be a #rrggbb colour' };
    case 'text':
      return typeof value === 'string' && [...value].length <= 500 ? { ok: true, value } : { ok: false, message: 'must be text of at most 500 characters' };
    case 'action':
      return { ok: false, message: 'is an action button, it has no value' };
    default:
      return { ok: false, message: `has unknown control type ${JSON.stringify(control.type)}` };
  }
}

/** Checks params against a layer's controls. Returns issues and the cleaned params. */
export function checkParams(layer: LayerEntry, params: Record<string, unknown>, path: string): { issues: Issue[]; cleaned: Record<string, unknown> } {
  const issues: Issue[] = [];
  const cleaned: Record<string, unknown> = {};
  const controls: any[] = layer.manifest.controls ?? [];
  for (const [key, value] of Object.entries(params)) {
    const control = controls.find((c) => c.id === key);
    if (!control) {
      const ids = controls.filter((c) => c.type !== 'action').map((c) => c.id);
      issues.push({ level: 'error', path: `${path}.${key}`, message: `layer '${layer.id}' has no control '${key}'. Its controls are: ${ids.join(', ') || 'none'}` });
      continue;
    }
    const check = checkControlValue(control, value);
    if (!check.ok) issues.push({ level: 'error', path: `${path}.${key}`, message: `${key} ${check.message}` });
    else {
      cleaned[key] = check.value;
      if (check.message) issues.push({ level: 'warning', path: `${path}.${key}`, message: `${key} ${check.message}` });
    }
  }
  return { issues, cleaned };
}

// ---- Whole-site validation ----

/** Unknown and missing keys at every level the schema knows, as mrs-site would refuse them. */
function checkKeys(obj: unknown, at: string, shown: string, schema: SiteSchema, issues: Issue[]): void {
  if (Array.isArray(obj) && schema[`${at}[]`]) {
    obj.forEach((item, i) => checkKeys(item, `${at}[]`, `${shown}[${i}]`, schema, issues));
    return;
  }
  const level = schema[at];
  if (!level || !obj || typeof obj !== 'object' || Array.isArray(obj)) return;
  for (const key of level.required) {
    if (!(key in obj)) issues.push({ level: 'error', path: shown ? `${shown}.${key}` : key, message: `'${key}' is required` });
  }
  for (const key of Object.keys(obj)) {
    const path = shown ? `${shown}.${key}` : key;
    if (!level.fields.includes(key)) {
      issues.push({
        level: 'error',
        path,
        message: `'${key}' is not allowed here in site format ${SITE_FORMAT} (allowed: ${level.fields.join(', ')}). If the site needs it, it is a core change: draft a module request.`,
      });
    } else checkKeys((obj as any)[key], at ? `${at}.${key}` : key, path, schema, issues);
  }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function validateManifest(manifest: SiteManifest, dir: string | null, catalog: Catalog): Issue[] {
  const issues: Issue[] = [];
  const err = (path: string, message: string) => issues.push({ level: 'error', path, message });
  const warn = (path: string, message: string) => issues.push({ level: 'warning', path, message });
  const note = (path: string, message: string) => issues.push({ level: 'note', path, message });

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    err('', 'site.json must be an object');
    return issues;
  }
  checkKeys(manifest, '', '', catalog.siteSchema ?? FALLBACK_SCHEMA, issues);

  if (typeof manifest.format === 'number' && manifest.format < SITE_FORMAT) err('format', `this site is in the older site format ${manifest.format}; run \`mrstudio migrate <site folder>\` (or open it once in the MR Studio app) to bring it to format ${SITE_FORMAT}, then try again`);
  else if (manifest.format !== SITE_FORMAT) err('format', `must be ${SITE_FORMAT}; this core reads site format ${SITE_FORMAT}`);
  if (typeof manifest.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(manifest.id)) err('id', 'must be lower-case letters, digits and dashes');
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) err('name', 'is required');

  const o = manifest.origin;
  if (!o || !isNum(o.lon) || !isNum(o.lat) || Math.abs(o.lon) > 180 || Math.abs(o.lat) > 85) err('origin', 'needs lon (-180..180) and lat (-85..85) in WGS84, the centre of the table area');

  const e = manifest.extent;
  if (!e || !isNum(e.width_m) || !isNum(e.height_m) || e.width_m <= 0 || e.height_m <= 0) err('extent', 'needs positive width_m and height_m');
  else {
    if (e.rotation_deg !== undefined && !isNum(e.rotation_deg)) err('extent.rotation_deg', 'must be a number of degrees clockwise from north');
    if (Math.max(e.width_m, e.height_m) > 10000) warn('extent', 'is larger than 10 km; the local metric frame is accurate to a few kilometres');
  }

  if (manifest.timezone !== undefined && manifest.timezone !== null) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: manifest.timezone });
    } catch {
      err('timezone', `'${manifest.timezone}' is not an IANA time zone such as Europe/Stockholm`);
    }
  } else warn('timezone', 'is missing; times will be read as UTC');

  const t = manifest.table;
  if (t !== undefined && t !== null) {
    if (!isNum(t.width_cm) || !isNum(t.height_cm) || t.width_cm <= 0 || t.height_cm <= 0) err('table', 'needs positive width_cm and height_cm');
    else if (e && isNum(e.width_m) && isNum(e.height_m) && e.height_m > 0) {
      const a = e.width_m / e.height_m;
      const b = t.width_cm / t.height_cm;
      if (Math.abs(a - b) / b > 0.03) warn('table', `aspect ${b.toFixed(3)} does not match the extent's ${a.toFixed(3)}; the map will be letterboxed or cropped`);
    }
  }

  const s = manifest.scene;
  if (!s || typeof s !== 'object') err('scene', "is required, at least { \"cell_m\": 1 }");
  else {
    if (!isNum(s.cell_m) || s.cell_m <= 0) err('scene.cell_m', 'must be a positive number of metres');
    else if (e && isNum(e.width_m) && isNum(e.height_m)) {
      const cells = Math.round(e.width_m / s.cell_m) * Math.round(e.height_m / s.cell_m);
      if (cells > 4_000_000) warn('scene.cell_m', `gives ${cells.toLocaleString('en')} cells; above about 4 million, kernels slow down. Use a larger cell`);
    }
    for (const key of ['buildings', 'terrain', 'trees'] as const) {
      const src = s[key];
      if (!src) continue;
      if (typeof src.path !== 'string') err(`scene.${key}.path`, 'is required');
      else if (dir) {
        if (!inside(dir, src.path)) err(`scene.${key}.path`, 'must stay inside the site folder');
        else if (!existsSync(join(dir, src.path))) err(`scene.${key}.path`, `${src.path} does not exist yet`);
      }
    }
    if (!s.buildings) note('scene.buildings', 'no buildings yet: kernels such as sunlight and wind will see a flat, empty site. Add GeoJSON footprints with a height property.');
  }

  const bg = manifest.basemap?.background;
  if (bg !== undefined && !(typeof bg === 'string' && /^#[0-9a-fA-F]{6}$/.test(bg))) err('basemap.background', 'must be a #rrggbb colour');

  const logo = manifest.branding?.logo;
  if (typeof logo === 'string' && dir) {
    if (!inside(dir, logo)) err('branding.logo', 'must be a path inside the site folder');
    else if (!existsSync(join(dir, logo))) err('branding.logo', `${logo} does not exist`);
  }

  // Layers: the scene, bottom to top.
  const layers = manifest.layers;
  if (layers !== undefined && !Array.isArray(layers)) err('layers', 'must be a list');
  const seen = new Map<string, number>();
  (Array.isArray(layers) ? layers : []).forEach((ref: any, i: number) => {
    const at = `layers[${i}]`;
    if (!ref || typeof ref.use !== 'string') return err(at, "needs 'use': a core layer id or ./layers/<name>");
    if (seen.has(ref.use)) warn(at, `uses '${ref.use}' again (also layers[${seen.get(ref.use)}]); layer state is keyed by id, so both entries share one state until per-entry ids land in the core`);
    seen.set(ref.use, i);
    const layer = findLayer(catalog, dir, ref.use);
    if (!layer) {
      const ids = catalog.layers.map((l) => l.id).join(', ');
      return err(`${at}.use`, ref.use.startsWith('.') ? `no layer.json at ${ref.use} inside the site` : `'${ref.use}' is not a core layer in MR Studio ${catalog.version}. Core layers: ${ids}`);
    }
    if (ref.active !== undefined && typeof ref.active !== 'boolean') err(`${at}.active`, 'must be true or false');
    if (ref.params !== undefined) {
      if (!ref.params || typeof ref.params !== 'object' || Array.isArray(ref.params)) err(`${at}.params`, 'must be an object');
      else issues.push(...checkParams(layer, ref.params, `${at}.params`).issues);
    }
    const req = layer.manifest.requires ?? {};
    for (const k of req.kernels ?? []) if (!catalog.kernels.includes(k)) err(at, `layer '${layer.id}' needs kernel '${k}', which this core does not have`);
    for (const d of req.data ?? []) note(at, `layer '${layer.id}' reads site data '${d}'; check the layer's docs for the file it expects`);
    for (const svc of req.services ?? []) note(at, `layer '${layer.id}' needs service '${svc}'`);
    if (layer.origin === 'site') {
      warn(at, `'${ref.use}' is a site-only layer. The runtime only bundles core layer code today, so it will not draw. If the scene needs it, propose it to the core with draft_module_request.`);
    }
  });
  if (Array.isArray(layers) && layers.length === 0) note('layers', 'the scene is empty; add a layer');
  if (Array.isArray(layers) && !layers.some((l: any) => l?.active)) note('layers', 'no layer starts active; the table will show only the base map until someone turns one on');

  return issues;
}

export function validateSiteDir(dir: string, catalog: Catalog): { manifest: SiteManifest | null; issues: Issue[] } {
  try {
    const manifest = readSite(dir);
    return { manifest, issues: validateManifest(manifest, dir, catalog) };
  } catch (error) {
    return { manifest: null, issues: [{ level: 'error', path: 'site.json', message: (error as Error).message }] };
  }
}

// ---- The mrstudio CLI ----

export function findCli(catalog: Catalog): string | null {
  const exe = process.platform === 'win32' ? 'mrstudio.exe' : 'mrstudio';
  const candidates: string[] = [];
  if (process.env.MRSTUDIO_CLI) candidates.push(process.env.MRSTUDIO_CLI);
  for (const p of (process.env.PATH ?? '').split(delimiter)) if (p) candidates.push(join(p, exe));
  if (catalog.root) for (const profile of ['release', 'debug']) candidates.push(join(catalog.root, 'target', profile, exe));
  return candidates.find((c) => existsSync(c)) ?? null;
}

export function runCli(cli: string, args: string[], timeoutMs = 120_000): Promise<{ ok: boolean; output: string }> {
  return new Promise((done) => {
    execFile(cli, args, { timeout: timeoutMs, windowsHide: true, env: { ...process.env, NO_COLOR: '1', RUST_LOG: 'warn' } }, (error, stdout, stderr) => {
      const output = `${stdout}${stderr}`.replace(/\x1b\[[0-9;]*m/g, '').trim();
      done({ ok: !error, output: output || (error ? error.message : '') });
    });
  });
}

// ---- Creating a site ----

export interface NewSite {
  dir: string;
  id?: string;
  name: string;
  lon: number;
  lat: number;
  width_m: number;
  height_m: number;
  rotation_deg?: number;
  timezone: string;
  table_width_cm?: number;
  cell_m?: number;
  title?: string;
  background?: string;
  layers?: { use: string; active?: boolean; params?: Record<string, unknown> }[];
}

export function slug(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'site';
}

export function newSiteManifest(spec: NewSite): SiteManifest {
  const tableW = spec.table_width_cm ?? 100;
  const tableH = Math.round((tableW * spec.height_m) / spec.width_m * 100) / 100;
  // One metre cells up to about two million cells, coarser for larger areas.
  const area = spec.width_m * spec.height_m;
  const cell = spec.cell_m ?? (area > 2_000_000 ? Math.ceil(Math.sqrt(area / 2_000_000)) : 1);
  return {
    format: SITE_FORMAT,
    id: spec.id ?? slug(spec.name),
    name: spec.name,
    origin: { lon: spec.lon, lat: spec.lat },
    extent: { width_m: spec.width_m, height_m: spec.height_m, rotation_deg: spec.rotation_deg ?? 0 },
    timezone: spec.timezone,
    table: { width_cm: tableW, height_cm: tableH },
    scene: { cell_m: cell },
    basemap: { background: spec.background ?? '#0b0e14', style: null },
    layers: spec.layers ?? [{ use: 'basemap', active: true }, { use: 'sunlight', active: true }],
    branding: { title: spec.title ?? spec.name },
  };
}

const SITE_GITIGNORE = `# Generated by mrstudio prepare
scene/
.DS_Store
`;

function siteReadme(m: SiteManifest, version: string): string {
  return `# ${m.name}

An MR Studio site package. It holds only what is this team's own: \`site.json\`, data, and
dashboards. The engine, layers and screens come from the MR Studio app (built against core ${version}).

\`\`\`
site.json      the site: where it is, how big the table is, which layers make up the scene
data/          building footprints, terrain and trees (GeoJSON in WGS84, raw f32 terrain)
requests/      drafts of feature requests for the MR Studio core
\`\`\`

Check it with \`mrstudio validate .\` and preview it with \`mrstudio dev --site .\`, then open http://localhost:4170/dev.

Need something the core does not have yet? Do not fork or copy core code. Describe it in a
module request (the MR Studio MCP server drafts one into \`requests/\`) and open it as an issue on
https://github.com/snjsomnath/mr-studio so it can be built once for every team.
`;
}

export function createSite(spec: NewSite, catalog: Catalog): { manifest: SiteManifest; issues: Issue[]; files: string[] } {
  const dir = resolve(spec.dir);
  if (existsSync(sitePath(dir))) throw new Error(`${dir} already has a site.json; use the editing tools instead`);
  const manifest = newSiteManifest(spec);
  const issues = validateManifest(manifest, null, catalog).filter((i) => i.level === 'error');
  if (issues.length) return { manifest, issues, files: [] };
  mkdirSync(join(dir, 'data'), { recursive: true });
  mkdirSync(join(dir, 'requests'), { recursive: true });
  writeSite(dir, manifest);
  const files = ['site.json', 'data/'];
  if (!existsSync(join(dir, 'README.md'))) {
    writeFileSync(join(dir, 'README.md'), siteReadme(manifest, catalog.version));
    files.push('README.md');
  }
  if (!existsSync(join(dir, '.gitignore'))) {
    writeFileSync(join(dir, '.gitignore'), SITE_GITIGNORE);
    files.push('.gitignore');
  }
  writeFileSync(join(dir, 'requests', '.gitkeep'), '');
  files.push('requests/');
  return { manifest, issues: validateManifest(manifest, dir, catalog), files };
}
