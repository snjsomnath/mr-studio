// For layer developers (#284): the SDK's real API read from its source, and the checks a site
// code layer must pass before it goes on a table. Contract in docs/contracts/layer.md.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** One thing `@mrstudio/sdk` exports, as its source declares it. */
export interface SdkExport {
  name: string;
  kind: 'function' | 'const' | 'class' | 'interface' | 'type' | 'enum';
  /** The source file, relative to packages/sdk/src. */
  file: string;
  /** The doc comment above it, without the stars. */
  doc: string;
  /** The declaration: a function's parameters and result, an interface's members (cut at 120 lines). */
  signature: string;
}

const DECL = /^export\s+(?:declare\s+)?(?:async\s+)?(function\*?|const|let|class|interface|type|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/;

/** Reads every `export` of the SDK's source files, with its doc comment and declaration. */
export function parseSdk(files: { path: string; text: string }[]): SdkExport[] {
  const out: SdkExport[] = [];
  for (const { path, text } of files) {
    const lines = text.split(/\r?\n/);
    // An unexported interface that an exported one extends is part of the API too (ContextBase).
    const extended = new Set([...text.matchAll(/^export\s+interface\s+\w+(?:<[^>]*>)?\s+extends\s+([^{]+)\{/gm)].flatMap((m) => m[1]!.split(',').map((n) => n.trim().replace(/<.*$/, ''))));
    for (let i = 0; i < lines.length; i++) {
      const inner = /^interface\s+([A-Za-z_$][\w$]*)/.exec(lines[i]!);
      const m = DECL.exec(lines[i]!) ?? (inner && extended.has(inner[1]!) ? ([lines[i]!, 'interface', inner[1]!] as unknown as RegExpExecArray) : null);
      if (!m) continue;
      const raw = m[1]!.replace('abstract ', '').replace('*', '');
      const kind = (raw === 'let' ? 'const' : raw) as SdkExport['kind'];
      // The doc comment ends on the line above.
      let doc = '';
      if (/\*\/\s*$/.test(lines[i - 1] ?? '')) {
        let j = i - 1;
        while (j > 0 && !/^\s*\/\*\*/.test(lines[j]!)) j--;
        doc = lines
          .slice(j, i)
          .map((l) => l.replace(/^\s*\/\*\*\s?/, '').replace(/\s*\*\/\s*$/, '').replace(/^\s*\*\s?/, ''))
          .join('\n')
          .trim();
      }
      out.push({ name: m[2]!, kind, file: path, doc, signature: declaration(lines, i, kind) });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The declaration from its first line: up to the body for a function, the whole body for a type. */
function declaration(lines: string[], start: number, kind: SdkExport['kind']): string {
  const take: string[] = [];
  let depth = 0;
  for (let i = start; i < lines.length && take.length < (kind === 'interface' ? 120 : 40); i++) {
    const line = lines[i]!;
    if (kind === 'function' || kind === 'class' || kind === 'const') {
      // A function's signature can span lines; stop at the body's opening brace or the end.
      take.push(line);
      const opened = kind === 'function' ? /\)\s*(:\s*[^{=]+)?\{\s*$/.test(line) || /\{\s*$/.test(line) : /[{=;]/.test(line);
      if (opened || /;\s*$/.test(line)) break;
      continue;
    }
    take.push(line);
    for (const ch of line) depth += ch === '{' ? 1 : ch === '}' ? -1 : 0;
    if (depth <= 0 && (/[;}]\s*$/.test(line) || (kind === 'type' && !/[=|&,(<]\s*$/.test(line)))) break;
  }
  let text = take.join('\n').replace(/^export\s+/, '');
  if (kind === 'function') text = text.replace(/\s*\{\s*$/, '');
  if (kind === 'const') text = text.replace(/\s*=\s*[\s\S]*$/, '').replace(/\s*\{\s*$/, '');
  if (kind === 'class') text = text.replace(/\s*\{\s*$/, '');
  return text.trim();
}

const WORD = /[a-z0-9]+/g;
const splitName = (name: string) => name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

/** The exports that best match a query in words or a name ("pulse rings", "service", "ctx.publish"). */
export function searchSdk(sdk: SdkExport[], query: string, limit = 12): (SdkExport & { score: number })[] {
  const q = query.trim().toLowerCase();
  const words = (q.replace(/^ctx\./, '').match(WORD) ?? []).filter((w) => w.length > 1);
  const scored = sdk.map((e) => {
    const name = e.name.toLowerCase();
    const nameWords = splitName(e.name);
    const doc = e.doc.toLowerCase();
    const sig = e.signature.toLowerCase();
    let score = 0;
    if (name === q || name === q.replace(/^ctx\./, '')) score += 10;
    for (const w of words) {
      if (name.includes(w)) score += 3;
      else if (nameWords.includes(w)) score += 3;
      if (doc.includes(w)) score += 1;
      // A member of an interface by that name (ctx.publish lives in ContextBase).
      if (new RegExp(`^\\s*(readonly\\s+)?${w}\\??\\s*[(:<]`, 'm').test(sig)) score += 3;
      else if (sig.includes(w)) score += 0.5;
      if (e.file.toLowerCase().includes(w)) score += 1;
    }
    return { ...e, score };
  });
  return scored.filter((e) => e.score > 0).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
}

// ---- Checking a site layer ----

export interface LayerIssue {
  level: 'error' | 'warning';
  rule: string;
  message: string;
  file?: string;
  line?: number;
}

/** The dashboard's panel sizes and their density budget (packages/dashboard/src/rules.ts). */
const PANEL_READS: Record<string, number> = { chip: 1, tile: 3, wide: 5, tall: 6, block: 8, hero: 10, band: 3, strip: 6 };
const TEXT = { title: 28, label: 20 };
/** The layer API this server's core speaks (packages/sdk/src/types.ts LAYER_API). */
export const LAYER_API = 1;

function walk(dir: string, re: RegExp): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p, re));
    else if (re.test(entry.name)) out.push(p);
  }
  return out;
}

/**
 * The layer rules for a site code layer: its manifest, its words in Swedish, its code (no site
 * coordinates, no talking to surfaces behind the host's back, only the SDK from the core), what it
 * requires of the site, and whether its build is current.
 */
export function checkLayerPackage(dir: string, site: { manifest: any; kernels: string[]; api?: number }): { manifest: any | null; issues: LayerIssue[] } {
  const issues: LayerIssue[] = [];
  const add = (level: LayerIssue['level'], rule: string, message: string, file?: string, line?: number) => issues.push({ level, rule, message, ...(file ? { file } : {}), ...(line ? { line } : {}) });
  const id = dir.split(/[\\/]/).pop()!;
  let manifest: any = null;
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'layer.json'), 'utf8'));
  } catch (error) {
    add('error', 'manifest', `layer.json is missing or not JSON: ${(error as Error).message}`, 'layer.json');
    return { manifest, issues };
  }

  // The manifest.
  const api = site.api ?? LAYER_API;
  if (manifest.api !== api) add('error', 'api', `layer.json says api ${manifest.api}; this core runs layer api ${api}, so the app would refuse it`, 'layer.json');
  if (manifest.id !== id) add('error', 'id', `layer.json id is '${manifest.id}' but the folder is '${id}'; they must match`, 'layer.json');
  if (!manifest.name) add('error', 'name', 'layer.json has no name', 'layer.json');
  const controls: any[] = Array.isArray(manifest.controls) ? manifest.controls : [];
  const tools: any[] = Array.isArray(manifest.tools) ? manifest.tools : [];
  const panels: any[] = Array.isArray(manifest.panels) ? manifest.panels : [];
  const seen = new Set<string>();
  for (const c of controls) {
    if (!c?.id) add('error', 'controls', 'a control has no id', 'layer.json');
    else if (seen.has(c.id)) add('error', 'controls', `two controls are called '${c.id}'`, 'layer.json');
    seen.add(c?.id);
    if (c?.label && String(c.label).length > TEXT.label) add('warning', 'text', `control '${c.id}' label "${c.label}" is longer than ${TEXT.label} characters; the controller cuts it`, 'layer.json');
  }
  // Panels within the dashboard's density budget.
  for (const p of panels) {
    const budget = PANEL_READS[p?.size];
    if (budget === undefined) {
      add('error', 'panels', `panel '${p?.id}' has size '${p?.size}'; use one of ${Object.keys(PANEL_READS).join(', ')}`, 'layer.json');
      continue;
    }
    const reads = Number(p?.props?.reads ?? (p?.widget === 'custom' ? NaN : 0));
    if (p?.widget === 'custom' && !Number.isFinite(reads)) add('error', 'density', `custom panel '${p.id}' must say how many things it asks people to read (props.reads, at most ${budget} for a ${p.size})`, 'layer.json');
    else if (reads > budget) add('error', 'density', `panel '${p.id}' asks for ${reads} reads; a ${p.size} holds ${budget}. Use a bigger size or show less`, 'layer.json');
    if (p?.title && String(p.title).length > TEXT.title) add('warning', 'text', `panel '${p.id}' title is longer than ${TEXT.title} characters`, 'layer.json');
  }
  if (panels.length > 8) add('warning', 'density', `${panels.length} panels; one TV screen holds 8, the rest rotate onto another page`, 'layer.json');

  // Every word people see, in Swedish.
  const words = [manifest.name, ...controls.map((c) => c?.label), ...controls.flatMap((c) => (Array.isArray(c?.options) ? c.options.map((o: any) => o?.label) : [])), ...tools.map((t) => t?.label), ...panels.map((p) => p?.title)].filter((w): w is string => typeof w === 'string' && w.trim() !== '');
  let sv: Record<string, string> = {};
  try {
    sv = JSON.parse(readFileSync(join(dir, 'locales', 'sv.json'), 'utf8'));
  } catch {
    add('error', 'translations', 'locales/sv.json is missing or not JSON; visitors can switch the table to Swedish', 'locales/sv.json');
  }
  const missing = [...new Set(words)].filter((w) => !(w in sv));
  if (missing.length && Object.keys(sv).length) add('error', 'translations', `not in locales/sv.json: ${missing.map((w) => `"${w}"`).join(', ')}`, 'locales/sv.json');

  // The code.
  const src = walk(join(dir, 'src'), /\.(ts|tsx|js|mjs)$/);
  if (!src.length) add('error', 'code', 'no src/index.ts', 'src/index.ts');
  const COORD = /(?<![\w.])(-?\d{1,3}\.\d{4,})\s*,\s*(-?\d{1,3}\.\d{4,})(?![\w.])/;
  const SURFACE = /\bnew\s+(WebSocket|BroadcastChannel|EventSource)\s*\(|\.postMessage\s*\(|['"`]\/(ws|api\/(session|layers|site))\b/;
  for (const file of src) {
    const name = relative(dir, file).replace(/\\/g, '/');
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((text, i) => {
      if (/^\s*(\/\/|\*)/.test(text)) return;
      const coord = COORD.exec(text);
      if (coord) {
        const [a, b] = [Math.abs(Number(coord[1])), Math.abs(Number(coord[2]))];
        if (a <= 180 && b <= 90 || a <= 90 && b <= 180) add('error', 'no-site-coordinates', `a longitude and latitude in code (${coord[1]}, ${coord[2]}); places belong in the site's data or params, so the layer works on any table`, name, i + 1);
      }
      const surface = SURFACE.exec(text);
      if (surface) add('error', 'no-direct-messaging', `talks to surfaces or the host directly (${surface[0].trim()}); use ctx.publish, ctx.sendTool, ctx.service or ctx.data so every view agrees`, name, i + 1);
      const from = /\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/.exec(text);
      const spec = from?.[1] ?? from?.[2];
      if (spec && !spec.startsWith('.') && spec !== '@mrstudio/sdk' && !/^(node:)?(path|fs|url)$/.test(spec)) {
        if (/packages\/|@mrstudio\/(runtime|dashboard|layers)/.test(spec)) add('error', 'sdk-only', `imports '${spec}'; a site layer may use only '@mrstudio/sdk' from the core`, name, i + 1);
        else add('warning', 'dependencies', `imports '${spec}', which is bundled into dist/index.js; keep the layer small`, name, i + 1);
      }
      if (spec && /\.\.\/\.\.\/\.\./.test(spec)) add('error', 'sdk-only', `imports '${spec}' from outside the layer's folder`, name, i + 1);
    });
  }

  // What it needs of the site.
  const req = manifest.requires ?? {};
  const data = new Set(Object.keys(site.manifest?.data ?? {}));
  for (const d of req.data ?? []) if (!data.has(d)) add('error', 'requires', `needs dataset '${d}', which site.json "data" does not have; bring it in with import_data (target data:${d})`, 'layer.json');
  const services = new Set((Array.isArray(site.manifest?.services) ? site.manifest.services : []).map((s: any) => s?.id));
  for (const s of req.services ?? []) if (!services.has(s)) add('error', 'requires', `calls service '${s}', which site.json "services" does not declare; add it with add_service`, 'layer.json');
  for (const k of req.kernels ?? []) if (!site.kernels.includes(k)) add('error', 'requires', `needs kernel '${k}', which this core does not have (${site.kernels.join(', ')})`, 'layer.json');

  // The build.
  const dist = join(dir, 'dist', 'index.js');
  if (!existsSync(dist)) add('warning', 'build', 'not built yet: dist/index.js is missing, so the table lists the layer but draws nothing; run build_layer', 'dist/index.js');
  else {
    const built = statSync(dist).mtimeMs;
    const newer = [...src, join(dir, 'layer.json')].filter((f) => statSync(f).mtimeMs > built + 1000);
    if (newer.length) add('warning', 'build', `dist/index.js is older than ${newer.map((f) => relative(dir, f).replace(/\\/g, '/')).join(', ')}; run build_layer`, 'dist/index.js');
  }

  return { manifest, issues };
}
