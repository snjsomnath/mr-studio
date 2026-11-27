// What is in a site's data folder (#320): datasets with feature counts, geometry, columns and
// bounds, pictures, video and sounds, and which site.json keys use each file. Read-only, so a
// model picks a custom layer's `by` column or a media file by name instead of guessing.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';

import type { SiteManifest } from './site.ts';

export interface Column {
  name: string;
  type: 'number' | 'text' | 'mixed';
  /** Distinct values, when there are few (a category). */
  values?: string[];
  /** Smallest and largest, for numbers. */
  range?: [number, number];
}

export interface SiteFile {
  path: string;
  kind: 'geojson' | 'csv' | 'picture' | 'video' | 'sound' | 'model' | 'raster' | 'other';
  bytes: number;
  features?: number;
  geometry?: string[];
  columns?: Column[];
  /** [west, south, east, north] in WGS84. */
  bounds?: [number, number, number, number];
  /** Whether the CSV has longitude and latitude columns (points) or not (a table). */
  points?: boolean;
  used_by: string[];
  problem?: string;
}

const KINDS: Record<string, SiteFile['kind']> = {
  '.geojson': 'geojson', '.json': 'geojson', '.csv': 'csv',
  '.png': 'picture', '.jpg': 'picture', '.jpeg': 'picture', '.webp': 'picture', '.gif': 'picture',
  '.mp4': 'video', '.webm': 'video', '.wav': 'sound', '.mp3': 'sound', '.ogg': 'sound', '.m4a': 'sound',
  '.glb': 'model', '.gltf': 'model', '.obj': 'model', '.3dm': 'model', '.tif': 'raster', '.tiff': 'raster',
};

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name.startsWith('.') || name.endsWith('.part')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function columns(rows: Record<string, unknown>[]): Column[] {
  const keys = [...new Set(rows.slice(0, 2000).flatMap((r) => Object.keys(r ?? {})))];
  return keys.map((name) => {
    const vals = rows.map((r) => r?.[name]).filter((v) => v !== null && v !== undefined && v !== '');
    const nums = vals.map((v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : NaN));
    const allNum = vals.length > 0 && nums.every((n) => Number.isFinite(n));
    const distinct = [...new Set(vals.map(String))];
    const col: Column = { name, type: allNum ? 'number' : nums.some(Number.isFinite) ? 'mixed' : 'text' };
    if (allNum) col.range = [Math.min(...nums), Math.max(...nums)];
    if (!allNum && distinct.length <= 12) col.values = distinct.sort();
    return col;
  });
}

function extend(b: [number, number, number, number] | undefined, x: number, y: number): [number, number, number, number] {
  return b ? [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)] : [x, y, x, y];
}

function coords(c: unknown, visit: (x: number, y: number) => void): void {
  if (!Array.isArray(c)) return;
  if (typeof c[0] === 'number' && typeof c[1] === 'number') visit(c[0], c[1]);
  else for (const part of c) coords(part, visit);
}

/** Splits one CSV line, honouring quotes. */
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') (cur += '"'), i++;
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) out.push(cur), (cur = '');
    else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

/** The site.json keys that name each path: scene.buildings, data.zones, a layer's params, a custom layer's data. */
function uses(manifest: Partial<SiteManifest> | null): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const add = (path: unknown, where: string) => {
    if (typeof path !== 'string') return;
    const p = path.replace(/^\.\//, '');
    found.set(p, [...(found.get(p) ?? []), where]);
  };
  const pathOf = (v: unknown) => (typeof v === 'object' && v ? ((v as { path?: unknown; file?: unknown }).path ?? (v as { file?: unknown }).file) : v);
  for (const [k, v] of Object.entries(manifest?.scene ?? {})) add(pathOf(v), `scene.${k}`);
  for (const [k, v] of Object.entries(manifest?.data ?? {})) add(pathOf(v), `data.${k}`);
  const params = (entry: { params?: Record<string, unknown> }, where: string) => {
    for (const [k, v] of Object.entries(entry?.params ?? {})) add(v, `${where}.params.${k}`);
  };
  for (const l of manifest?.layers ?? []) {
    params(l, l.id);
    for (const item of l.items ?? []) params(item, `${l.id}.${item.id}`);
    for (const [i, step] of (l.steps?.sequence ?? []).entries()) params(step, `${l.id}.steps[${i}]`);
  }
  for (const [id, recipe] of Object.entries(manifest?.custom ?? {})) for (const d of recipe?.data ?? []) add(d?.path, `custom.${id}.data.${d.id}`);
  if (manifest?.branding?.logo) add(manifest.branding.logo, 'branding.logo');
  return found;
}

export function listSiteFiles(dir: string, manifest: Partial<SiteManifest> | null, only?: SiteFile['kind']): SiteFile[] {
  const used = uses(manifest);
  const files: SiteFile[] = [];
  for (const full of walk(join(dir, 'data'))) {
    const path = relative(dir, full).split(sep).join('/');
    const kind = KINDS[extname(full).toLowerCase()] ?? 'other';
    if (only && kind !== only) continue;
    const file: SiteFile = { path, kind, bytes: statSync(full).size, used_by: used.get(path) ?? [] };
    try {
      if (kind === 'geojson' && file.bytes < 200 * 1024 * 1024) {
        const json = JSON.parse(readFileSync(full, 'utf8')) as { type?: string; features?: { geometry?: { type?: string; coordinates?: unknown } | null; properties?: Record<string, unknown> | null }[] };
        if (json?.type !== 'FeatureCollection' || !Array.isArray(json.features)) {
          file.kind = 'other';
        } else {
          file.features = json.features.length;
          file.geometry = [...new Set(json.features.map((f) => f?.geometry?.type).filter((t): t is string => Boolean(t)))];
          file.columns = columns(json.features.map((f) => f?.properties ?? {}));
          let b: [number, number, number, number] | undefined;
          for (const f of json.features) coords(f?.geometry?.coordinates, (x, y) => (b = extend(b, x, y)));
          if (b) file.bounds = b.map((v) => Math.round(v * 1e6) / 1e6) as [number, number, number, number];
          if (b && (Math.abs(b[0]) > 180 || Math.abs(b[1]) > 90)) file.problem = 'Coordinates are not longitude and latitude (WGS84); the editor\'s Add data reprojects files.';
        }
      } else if (kind === 'csv') {
        const lines = readFileSync(full, 'utf8').split(/\r?\n/).filter((l) => l.trim());
        const head = cells(lines[0] ?? '');
        const rows = lines.slice(1).map((l) => Object.fromEntries(cells(l).map((v, i) => [head[i] ?? `col${i}`, v])));
        file.features = rows.length;
        file.columns = columns(rows);
        const lon = head.find((k) => ['lon', 'lng', 'long', 'longitude', 'x'].includes(k.toLowerCase()));
        const lat = head.find((k) => ['lat', 'latitude', 'y'].includes(k.toLowerCase()));
        file.points = Boolean(lon && lat);
        if (lon && lat) {
          let b: [number, number, number, number] | undefined;
          for (const r of rows) if (Number.isFinite(Number(r[lon])) && Number.isFinite(Number(r[lat]))) b = extend(b, Number(r[lon]), Number(r[lat]));
          if (b) file.bounds = b;
        }
      }
    } catch (error) {
      file.problem = `Could not be read: ${(error as Error).message.slice(0, 120)}`;
    }
    files.push(file);
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
