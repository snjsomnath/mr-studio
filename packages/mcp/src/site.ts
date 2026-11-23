// Reading, checking and editing a site package (docs/contracts/site.md).
// The checks mirror mrs-site and the host's control validation so an LLM gets every problem
// at once, in words, before the app sees the file. `mrstudio validate` stays the authority
// and is run as well when the CLI can be found.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path';

import { readLayerDir, type Catalog, type LayerEntry, type SiteSchema } from './core.ts';

export const SITE_FORMAT = 3;

export interface Issue {
  level: 'error' | 'warning' | 'note';
  path: string;
  message: string;
}

export type SiteManifest = Record<string, any>;

// The keys mrs-site accepts. Unknown keys are an error there. The catalog normally carries the
// schema read from the core's own manifest.rs; this copy of format 3 is the fallback.
const FALLBACK_SCHEMA: SiteSchema = {
  '': { fields: ['format', 'id', 'name', 'origin', 'extent', 'timezone', 'table', 'scene', 'data', 'basemap', 'layers', 'custom', 'tv', 'branding'], required: ['format', 'id', 'name', 'origin', 'extent', 'scene'] },
  origin: { fields: ['lon', 'lat'], required: ['lon', 'lat'] },
  extent: { fields: ['width_m', 'height_m', 'rotation_deg'], required: ['width_m', 'height_m'] },
  table: { fields: ['width_cm', 'height_cm', 'tile_cm', 'front', 'ribbons'], required: ['width_cm', 'height_cm'] },
  'table.ribbons': { fields: ['top', 'bottom', 'left', 'right'], required: [] },
  scene: { fields: ['cell_m', 'buildings', 'terrain', 'trees'], required: ['cell_m'] },
  'scene.buildings': { fields: ['path', 'height_property', 'default_height_m'], required: ['path'] },
  'scene.terrain': { fields: ['path', 'width', 'height'], required: ['path', 'width', 'height'] },
  'scene.trees': { fields: ['path', 'height_property', 'default_height_m', 'crown_radius_m'], required: ['path'] },
  basemap: { fields: ['background', 'style'], required: [] },
  branding: { fields: ['title', 'logo'], required: [] },
  'layers[]': { fields: ['use', 'id', 'active', 'params', 'button', 'hide', 'items', 'steps'], required: ['use', 'id'] },
  'layers[].button': { fields: ['name', 'description', 'icon', 'side', 'group', 'order'], required: [] },
  'layers[].items[]': { fields: ['use', 'id', 'active', 'params', 'hide'], required: ['use', 'id'] },
  'layers[].steps': { fields: ['mode', 'loop', 'reveal', 'transition', 'transition_s', 'sequence'], required: [] },
  'layers[].steps.sequence[]': { fields: ['layer', 'params', 'duration_s', 'transition', 'transition_s', 'next', 'title', 'description', 'source'], required: ['layer'] },
};

/** What `use` starts with for a custom layer saved in the site. */
export const CUSTOM_PREFIX = 'custom:';

/** A site's custom layers as layer entries, so they are offered and checked like any layer. */
export function customLayers(manifest: SiteManifest | null | undefined): LayerEntry[] {
  const custom = manifest?.custom;
  if (!custom || typeof custom !== 'object') return [];
  return Object.entries(custom).map(([id, recipe]: [string, any]) => ({
    id,
    origin: 'custom' as const,
    use: `${CUSTOM_PREFIX}${id}`,
    manifest: { api: 1, id, name: recipe?.name ?? id, description: recipe?.description ?? '', icon: recipe?.icon, category: recipe?.category ?? 'analysis', controls: recipe?.controls ?? [], custom: recipe },
  }));
}

function siteOrNull(dir: string | null): SiteManifest | null {
  if (!dir) return null;
  try {
    return readSite(dir);
  } catch {
    return null;
  }
}

/** The id an entry gets when none is given: the layer's own, then `-2`, `-3`… past ids already used. */
export function freeId(manifest: SiteManifest, use: string): string {
  const base = (use.startsWith(CUSTOM_PREFIX) ? use.slice(CUSTOM_PREFIX.length) : use).replace(/\/+$/, '').split('/').pop() || 'layer';
  const used = new Set(instanceIds(manifest));
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** Every instance id in the scene, layers and their items. */
export function instanceIds(manifest: SiteManifest): string[] {
  const layers: any[] = Array.isArray(manifest.layers) ? manifest.layers : [];
  return layers.flatMap((l) => [l?.id, ...(Array.isArray(l?.items) ? l.items.map((i: any) => i?.id) : [])]).filter((id): id is string => typeof id === 'string');
}

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
  return [...catalog.layers, ...site, ...customLayers(siteOrNull(dir))];
}

/** The layer a `use` names. A custom layer is read from `manifest` when given, else from the site's file. */
export function findLayer(catalog: Catalog, dir: string | null, use: string, manifest?: SiteManifest): LayerEntry | undefined {
  if (use.startsWith(CUSTOM_PREFIX)) return customLayers(manifest ?? siteOrNull(dir)).find((l) => l.use === use);
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
    if (t.front !== undefined && !['top', 'bottom', 'left', 'right'].includes(t.front)) err('table.front', "is the edge where visitors stand: 'bottom', 'top', 'left' or 'right'");
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

  // Layers: the scene, bottom to top. Each may hold items, and a sequence holds steps.
  const layers = manifest.layers;
  if (layers !== undefined && !Array.isArray(layers)) err('layers', 'must be a list');
  const list: any[] = Array.isArray(layers) ? layers : [];
  const seen = new Map<string, string>();
  const checkInstance = (ref: any, at: string, item: boolean): LayerEntry | undefined => {
    if (!ref || typeof ref.use !== 'string') {
      err(at, "needs 'use': a core layer id, ./layers/<name> or custom:<id>");
      return undefined;
    }
    if (typeof ref.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(ref.id)) err(`${at}.id`, 'every layer and item needs an id: lowercase letters, digits and dashes');
    else if (seen.has(ref.id)) err(`${at}.id`, `'${ref.id}' is also ${seen.get(ref.id)}; every layer and item needs its own id`);
    else seen.set(ref.id, at);
    const layer = findLayer(catalog, dir, ref.use, manifest);
    if (!layer) {
      const ids = catalog.layers.map((l) => l.id).join(', ');
      const why = ref.use.startsWith(CUSTOM_PREFIX)
        ? `there is no custom layer '${ref.use.slice(CUSTOM_PREFIX.length)}' under "custom"`
        : ref.use.startsWith('.')
          ? `no layer.json at ${ref.use} inside the site`
          : `'${ref.use}' is not a core layer in MR Studio ${catalog.version}. Core layers: ${ids}`;
      err(`${at}.use`, why);
      return undefined;
    }
    if (ref.active !== undefined && typeof ref.active !== 'boolean') err(`${at}.active`, 'must be true or false');
    if (item && ref.active === false) note(at, `item '${ref.id}' is set not to come on with its layer`);
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
    if (layer.origin === 'custom') note(at, `'${ref.use}' is a custom layer; the runtime draws custom layers once the layer editor (#38) lands`);
    return layer;
  };
  const found = list.map((ref, i) => {
    const layer = checkInstance(ref, `layers[${i}]`, false);
    if (ref?.items !== undefined && !Array.isArray(ref.items)) err(`layers[${i}].items`, 'must be a list');
    (Array.isArray(ref?.items) ? ref.items : []).forEach((child: any, j: number) => checkInstance(child, `layers[${i}].items[${j}]`, true));
    return layer;
  });
  const TRANSITIONS = ['cut', 'fade', 'dip'];
  const sequences = new Set(list.filter((l) => Array.isArray(l?.steps?.sequence) && l.steps.sequence.length).map((l) => l.id));
  list.forEach((ref, i) => {
    const steps = ref?.steps;
    if (steps === undefined) return;
    const at = `layers[${i}].steps`;
    if (!steps || typeof steps !== 'object' || Array.isArray(steps)) return err(at, 'must be an object');
    if (steps.mode !== undefined && !['manual', 'timed'].includes(steps.mode)) err(`${at}.mode`, "is 'manual' or 'timed'");
    if (steps.reveal !== undefined && !['stop', 'then-next'].includes(steps.reveal)) err(`${at}.reveal`, "is 'stop' or 'then-next'");
    if (steps.transition !== undefined && !TRANSITIONS.includes(steps.transition)) err(`${at}.transition`, "is 'cut', 'fade' or 'dip'");
    if (steps.transition_s !== undefined && !(isNum(steps.transition_s) && steps.transition_s >= 0 && steps.transition_s <= 10)) err(`${at}.transition_s`, 'must be 0 to 10 seconds');
    if (steps.sequence === undefined) return;
    if (!Array.isArray(steps.sequence)) return err(`${at}.sequence`, 'must be a list of steps');
    if (steps.sequence.length && found[i] && found[i]!.manifest.sequence !== true) err(`${at}.sequence`, `only a sequence layer, such as the slideshow, shows other layers; '${ref.use}' is not one`);
    steps.sequence.forEach((step: any, n: number) => {
      const here = `${at}.sequence[${n}]`;
      const own = Array.isArray(ref.items) && ref.items.some((item: any) => item?.id === step?.layer);
      const top = list.find((l) => l?.id === step?.layer);
      if (typeof step?.layer !== 'string') return err(here, "needs 'layer': the id of the layer the step shows");
      if (step.layer === ref.id) return err(here, 'a sequence cannot show itself');
      if (sequences.has(step.layer)) return err(here, `'${step.layer}' is a sequence too; a step shows one layer`);
      if (!own && !top) return err(here, `shows '${step.layer}', which is neither a layer of the scene nor an item of this one`);
      if (step.duration_s !== undefined && !(isNum(step.duration_s) && step.duration_s > 0)) err(`${here}.duration_s`, 'must be a positive number of seconds');
      if (step.transition !== undefined && !TRANSITIONS.includes(step.transition)) err(`${here}.transition`, "is 'cut', 'fade' or 'dip'");
      if (step.transition_s !== undefined && !(isNum(step.transition_s) && step.transition_s >= 0 && step.transition_s <= 10)) err(`${here}.transition_s`, 'must be 0 to 10 seconds');
      const shown = own ? ref.items.find((item: any) => item?.id === step.layer) : top;
      const layer = shown && findLayer(catalog, dir, shown.use, manifest);
      if (layer && step.params !== undefined) issues.push(...checkParams(layer, step.params, `${here}.params`).issues);
    });
  });

  // Custom layers: recipes the layer editor saves.
  const datasets = new Set([...Object.keys(manifest.data ?? {}), ...['buildings', 'trees', 'terrain'].filter((k) => manifest.scene?.[k])]);
  for (const [id, recipe] of Object.entries((manifest.custom ?? {}) as Record<string, any>)) {
    const at = `custom.${id}`;
    if (!/^[a-z0-9-]{1,40}$/.test(id)) err(at, 'a custom layer id is lowercase letters, digits and dashes');
    if (catalog.layers.some((l) => l.id === id)) err(at, `'${id}' is a core layer's id; give the custom layer another`);
    if (!recipe || typeof recipe !== 'object') {
      err(at, 'must be an object with at least a name');
      continue;
    }
    if (typeof recipe.name !== 'string' || !recipe.name.trim() || recipe.name.length > 40) err(`${at}.name`, 'is 1 to 40 characters');
    const sources = new Set<string>();
    (Array.isArray(recipe.data) ? recipe.data : []).forEach((d: any, n: number) => {
      const here = `${at}.data[${n}]`;
      if (typeof d?.id !== 'string') return err(here, "needs an 'id'");
      sources.add(d.id);
      const kinds = ['dataset', 'path', 'wms', 'tiles'].filter((k) => d[k] !== undefined);
      if (kinds.length !== 1) err(here, 'give exactly one of dataset, path, wms and tiles');
      if (typeof d.dataset === 'string' && !datasets.has(d.dataset)) err(`${here}.dataset`, `the site has no dataset '${d.dataset}'`);
      if (typeof d.path === 'string' && dir) {
        if (!inside(dir, d.path)) err(`${here}.path`, 'must stay inside the site folder');
        else if (!existsSync(join(dir, d.path))) err(`${here}.path`, `${d.path} does not exist`);
      }
      if (d.wms !== undefined && !(typeof d.wms?.url === 'string' && /^https?:\/\//.test(d.wms.url) && typeof d.wms?.layers === 'string')) err(`${here}.wms`, 'needs an http(s) url and the names of its layers');
    });
    const look = new Set((Array.isArray(recipe.look) ? recipe.look : []).map((b: any) => b?.id));
    for (const stage of ['look', 'motion', 'interaction']) {
      (Array.isArray(recipe[stage]) ? recipe[stage] : []).forEach((block: any, n: number) => {
        const here = `${at}.${stage}[${n}]`;
        if (typeof block?.id !== 'string' || typeof block?.block !== 'string') return err(here, "needs an 'id' and a 'block' name");
        if (block.data !== undefined && !sources.has(block.data)) err(`${here}.data`, `the layer has no data '${block.data}'`);
        if (block.on !== undefined && !look.has(block.on)) err(`${here}.on`, `'${block.on}' is not one of its look blocks`);
      });
    }
  }
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
  const manifest: SiteManifest = {
    format: SITE_FORMAT,
    id: spec.id ?? slug(spec.name),
    name: spec.name,
    origin: { lon: spec.lon, lat: spec.lat },
    extent: { width_m: spec.width_m, height_m: spec.height_m, rotation_deg: spec.rotation_deg ?? 0 },
    timezone: spec.timezone,
    table: { width_cm: tableW, height_cm: tableH },
    scene: { cell_m: cell },
    basemap: { background: spec.background ?? '#0b0e14', style: null },
    layers: [] as any[],
    branding: { title: spec.title ?? spec.name },
  };
  // Every entry gets its id, as the host writes them.
  for (const layer of spec.layers ?? [{ use: 'basemap', active: true }, { use: 'sunlight', active: true }]) {
    const { use, ...rest } = layer;
    manifest.layers.push({ use, id: freeId(manifest, use), ...rest });
  }
  return manifest;
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
