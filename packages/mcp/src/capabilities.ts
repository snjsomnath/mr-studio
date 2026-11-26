// The capability catalogue (#326): one record per thing an experience designer can use,
// with an implementation status that comes from the code, never from a roadmap or a doc.
//
// Derived from code: layers (layer.json: requires, controls, tools, panels), building blocks
// (a pattern found in the SDK, runtime or dashboard), kernels (the engine's kernel folders),
// site settings (the serde structs of site.json), and the sites and samples that use them.
// Written by people: a layer's `about` (purpose, questions, pairs_with, limits) and the
// constraints below. Planned items come from docs/ROADMAP.md and are never `available`.

import type { Catalog, LayerEntry, RoadmapRow } from './core.ts';

export type CapabilityKind = 'layer' | 'block' | 'kernel' | 'site' | 'constraint';

/**
 * available: in the code, nothing else needed. needs_setup: in the code, but needs data, a key
 * in Sources and keys, or a service. planned: on the roadmap, not in the code. unsupported: the
 * architecture rules it out. unknown is never stored; find_capabilities says nothing matched.
 */
export type CapabilityStatus = 'available' | 'needs_setup' | 'planned' | 'unsupported';

export interface Requirement {
  kind: 'data' | 'key' | 'service' | 'kernel' | 'file';
  what: string;
  /** How to meet it. */
  how: string;
  /** When a site is given: whether the site meets it. */
  met?: boolean;
}

export interface Capability {
  id: string;
  kind: CapabilityKind;
  name: string;
  summary: string;
  status: CapabilityStatus;
  purpose?: string;
  questions: string[];
  /** What each surface shows or lets people do. */
  surfaces: { table?: string; controller?: string; phone?: string };
  interactions: string[];
  requires: Requirement[];
  /** Other capabilities it is built from. */
  uses: string[];
  pairs_with: string[];
  limitations: string[];
  /** Sites and samples in the core repository that use it. */
  examples: string[];
  /** Files that prove the status. */
  evidence: string[];
  /** Issues named in the roadmap or the changelog for it. */
  issues: number[];
  /** Set when docs and code disagree; the code wins. */
  discrepancy?: string;
  /** For a layer: the value of `use` in site.json. */
  use?: string;
}

/** Things MR Studio deliberately does not do, so a model never promises them (docs/experience-design.md, Constraints). */
const CONSTRAINTS: Omit<Capability, 'questions' | 'interactions' | 'requires' | 'uses' | 'pairs_with' | 'examples' | 'issues' | 'surfaces'>[] = [
  {
    id: 'constraint:table-3d', kind: 'constraint', name: '3D view or extrusion on the table', status: 'unsupported',
    summary: 'The table is drawn in 2D from straight above: no tilted camera, no extruded buildings. Height and value become colour, glow, outline or soft shadow.',
    limitations: ['Use colour, glow or a soft shadow (fill shadow_mm) for height'], evidence: ['docs/visualisation.md', 'docs/experience-design.md'],
  },
  {
    id: 'constraint:table-text', kind: 'constraint', name: 'Paragraphs, buttons or charts on the table', status: 'unsupported',
    summary: 'The table carries almost no text, only a few place labels. Words, controls and charts belong on the controller and phones.',
    limitations: ['Put explanations in step titles, descriptions and notes, or controller panels'], evidence: ['docs/experience-design.md'],
  },
  {
    id: 'constraint:hand-tracking', kind: 'constraint', name: 'Hand or gesture tracking over the table', status: 'unsupported',
    summary: 'MR Studio 2.0 has no hand tracking. People act through the controller, their phones, and the mouse or pointer on the table.',
    limitations: ['Use phone tools or the table pointer instead'], evidence: ['docs/ARCHITECTURE.md'],
  },
];

/** Site features a designer reaches for, each proven by a key in the site.json structs. */
const SITE_FEATURES: { id: string; path: string; name: string; summary: string; surfaces: Capability['surfaces']; interactions?: string[] }[] = [
  { id: 'site:steps-notes', path: 'layers[].steps.sequence[]', name: 'Presenter notes', summary: 'Notes for each step of a sequence, shown on the guide\'s phone and in the editor, never on the table.', surfaces: { phone: "the guide's phone (/guide) shows the notes" } },
  { id: 'site:languages', path: 'branding', name: 'Languages for visitors', summary: 'Visitors switch the controller and phones between languages; the site\'s own words are translated in branding.translations.', surfaces: { controller: 'a language switch', phone: 'the same language' } },
  { id: 'site:ribbons', path: 'table.ribbons', name: 'Table ribbons', summary: 'At-a-glance strips in the blank margins of the projection, on any side of the model, filled by the open layer\'s ribbon panels (Sunlight, Stormwater…).', surfaces: { table: 'strips beside the model', controller: 'a Ribbon button picks whose ribbon shows when more than one open layer has one' } },
  { id: 'site:glow', path: 'table.glow', name: 'Ambient glow', summary: 'The blank margins of the projection glow softly in the model\'s own colours, like the lights behind some televisions. On or off, strength 0 to 1, colours along each edge or one dominant colour; a layer can turn it off or fix its colour with ctx.map.setGlow.', surfaces: { table: 'a soft glow around the model, under the ribbons' } },
  { id: 'site:branding', path: 'branding', name: 'Title, welcome line and logo', summary: 'The table\'s title and welcome line on the controller\'s home screen, and a logo from the table\'s pictures above the title and beside it on phones.', surfaces: { controller: 'title, welcome line and logo on the home screen', phone: 'the logo beside the title' } },
  { id: 'site:two-layers', path: 'layers[].button', name: 'Two layers at once', summary: 'Visitors hold a second layer button until its ring closes (or Shift-click it) to lay it over the open one, such as Wind over Sunlight. At most two; a third replaces the older (#473).', surfaces: { table: 'both layers together', controller: "the newest layer's controls, with a chip to swap to the other" }, interactions: ['hold a second layer button to add it'] },
  { id: 'site:items', path: 'layers[].items[]', name: 'Layers inside a layer', summary: 'A layer shown only while another is open, such as trams inside a sun study.', surfaces: { table: 'both together while the outer layer is open' } },
  { id: 'site:buttons', path: 'layers[].button', name: 'Controller buttons and groups', summary: 'Each layer\'s button: name, icon, side and group (Simulations, Stories…).', surfaces: { controller: 'buttons down the left and right' } },
  { id: 'site:custom-layers', path: 'custom', name: 'Custom layers (recipes)', summary: 'Layers made from data, look and motion blocks without code, saved in the site.', surfaces: { table: 'the recipe\'s looks and motions; tap-info makes features pickable, filter controls show only matching ones', controller: 'its legend, bound controls, a palette theme, and a map of its places where visitors pick a feature to read its facts (the palette theme also colours the TV)' } },
  { id: 'site:services', path: 'services', name: 'Outside compute services', summary: 'A model or API (such as a Python optimiser) the app starts and keeps running beside the table, for site code layers.', surfaces: { controller: 'a progress bar while it works' } },
  { id: 'site:palette', path: 'palette', name: 'Table palette', summary: 'The colour set every layer draws with, tuned for projection.', surfaces: { table: 'colours' } },
];

function words(...parts: (string | string[] | undefined)[]): string {
  return parts.flat().filter(Boolean).join(' ');
}

function issuesIn(text: string): number[] {
  return [...new Set([...text.matchAll(/#(\d{1,5})\b/g)].map((m) => Number(m[1])))];
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function layerCapability(l: LayerEntry, catalog: Catalog, roadmap: RoadmapRow[]): Capability {
  const m = l.manifest;
  const about = (m.about ?? {}) as { purpose?: string; questions?: string[]; pairs_with?: string[]; limits?: string[] };
  const controls: any[] = m.controls ?? [];
  const tools: any[] = m.tools ?? [];
  const panels: any[] = m.panels ?? [];
  const requires: Requirement[] = [];
  for (const d of m.requires?.data ?? []) requires.push({ kind: 'data', what: d, how: `a '${d}' dataset in the site (scene.${d} or data.${d}): bring the file in with import_data (target ${['buildings', 'trees', 'walkways', 'trips', 'terrain'].includes(d) ? d : `data:${d}`}), or the editor's Add data` });
  for (const k of m.requires?.kernels ?? []) if (!catalog.kernels.includes(k)) requires.push({ kind: 'kernel', what: k, how: 'not in this core' });
  for (const s of m.requires?.services ?? []) requires.push({ kind: 'service', what: s, how: `a service '${s}' under "services" in site.json` });
  const keys = new Set<string>();
  for (const c of controls) for (const s of c.sources ?? []) keys.add(s);
  // Every layer starts without a key (free maps, simulated vehicles); a key adds a live or signed-in source.
  for (const k of keys) requires.push({ kind: 'key', what: k, how: `a '${k}' source in the app's Sources and keys, only for the live or signed-in part; the layer works without it` });
  for (const c of controls) if (c.media && c.mediaBy === 'path' && c.default === '' && !c.none) requires.push({ kind: 'file', what: `${c.label} (${(c.media as string[]).join(' or ')})`, how: 'a file added to the site (Insert, or data/media/)' });

  const phone = controls.filter((c) => c.phone).map((c) => c.label);
  const toolWords = tools.map((t) => `${t.type}: ${t.label ?? t.id}`);
  const interactions = [
    ...tools.map((t) => (t.type === 'point' ? `place a point: ${t.label}` : t.type === 'line' ? `draw a route: ${t.label}` : `draw an area: ${t.label}`)),
    ...(controls.some((c) => c.type === 'range' && /hour|time|progress|at\b/i.test(`${c.id} ${c.label}`)) ? ['scrub through time'] : []),
    ...(controls.some((c) => c.type === 'toggle' && /play|animate/i.test(`${c.id} ${c.label}`)) ? ['play an animation'] : []),
    ...(m.sequence ? ['step through a sequence with Next'] : []),
    ...(m.reveals ? ['reveal the layers placed inside it'] : []),
  ];
  const surfaces: Capability['surfaces'] = { table: m.description };
  if (m.category === 'analysis' || m.category === 'media' || !m.category) {
    surfaces.controller = `a button; ${controls.filter((c) => c.tier !== 'more' && c.type !== 'action').length} controls${panels.length ? ` and ${panels.length} panel${panels.length > 1 ? 's' : ''} (${panels.map((p) => p.title ?? p.id).join(', ')})` : ''}`;
  } else surfaces.controller = 'no button: part of the map at rest; settings in the editor';
  // Phones list every layer with a button, each on its own page with its switch, controls and a map to look around (#335).
  if (surfaces.controller !== 'no button: part of the map at rest; settings in the editor' || phone.length || tools.length) {
    surfaces.phone = ['its own page: switch, controls and a map', phone.length ? `controls visitors change: ${phone.join(', ')}` : '', tools.length ? `tools: ${toolWords.join(', ')}` : ''].filter(Boolean).join('; ');
  }

  const built = roadmap.find((r) => r.package === l.id);
  const evidence = l.origin === 'core' ? [`packages/layers/${l.id}/layer.json`, `packages/layers/${l.id}/src/index.ts`] : [`${l.use}/layer.json`];
  const uses = [...(m.requires?.kernels ?? []).map((k: string) => `kernel:${k}`), ...(tools.length ? ['block:phone-tools'] : [])];
  const examples = (catalog.examples ?? []).filter((e) => e.layers.includes(l.use)).map((e) => e.path);
  const missingKernel = requires.some((r) => r.kind === 'kernel');
  const status: CapabilityStatus = missingKernel ? 'planned' : requires.some((r) => r.kind !== 'key') ? 'needs_setup' : 'available';
  return {
    id: `layer:${l.origin === 'core' ? l.id : l.use}`,
    kind: 'layer',
    use: l.use,
    name: String(m.name ?? l.id),
    summary: String(m.description ?? ''),
    status,
    purpose: about.purpose,
    questions: about.questions ?? [],
    surfaces,
    interactions,
    requires,
    uses,
    pairs_with: (about.pairs_with ?? []).map((p) => `layer:${p}`),
    limitations: about.limits ?? [],
    examples,
    evidence,
    issues: built ? issuesIn(built.blocks) : [],
    ...(l.origin !== 'core' ? {} : !about.purpose ? { discrepancy: 'layer.json has no about; purpose unknown' } : {}),
  };
}

/** Builds the catalogue from a core catalog (live or snapshot). Cheap enough to build per call. */
export function buildCapabilities(catalog: Catalog, extraLayers: LayerEntry[] = []): Capability[] {
  const out: Capability[] = [];
  const roadmap = catalog.roadmap;
  for (const l of [...catalog.layers, ...extraLayers]) out.push(layerCapability(l, catalog, roadmap));

  for (const b of catalog.blocks) {
    out.push({
      id: `block:${b.id}`,
      kind: 'block',
      name: b.name,
      summary: b.description,
      status: b.status === 'built' ? 'available' : 'planned',
      purpose: b.usage,
      questions: [],
      surfaces: b.group === 'tv' ? { controller: b.description } : b.group === 'interaction' ? {} : { table: b.description },
      interactions: b.group === 'interaction' ? [b.name.toLowerCase()] : [],
      requires: [],
      uses: [],
      pairs_with: [],
      limitations: b.status === 'built' ? [] : ['Planned: not in the code yet'],
      examples: [],
      evidence: b.evidence ? [b.evidence] : ['packages/mcp/src/blocks.ts'],
      issues: issuesIn(`${b.description} ${b.usage}`),
    });
  }

  for (const k of catalog.kernels) {
    const row = roadmap.find((r) => r.kernel.includes(`\`${k}\``) && !r.package);
    out.push({
      id: `kernel:${k}`, kind: 'kernel', name: `${k} kernel`, summary: row ? `Engine computation for ${row.layer}` : 'Engine computation', status: 'available',
      questions: [], surfaces: {}, interactions: [], requires: [], uses: [], pairs_with: [], limitations: [], examples: [],
      evidence: [`crates/mrs-engine/src/kernels/${k}`], issues: [],
    });
  }
  for (const k of catalog.plannedKernels) {
    const rows = roadmap.filter((r) => r.kernel.includes(`\`${k}\``));
    out.push({
      id: `kernel:${k}`, kind: 'kernel', name: `${k} kernel`, summary: `Planned engine computation for ${rows.map((r) => r.layer).join(', ') || 'roadmap layers'}`, status: 'planned',
      questions: [], surfaces: {}, interactions: [], requires: [], uses: [], pairs_with: [], limitations: ['Planned: not in the engine yet'], examples: [],
      evidence: ['docs/ROADMAP.md'], issues: [],
    });
  }

  // Roadmap layers that no core layer builds yet.
  // A roadmap row is covered when it is marked built, a core layer has its name (Isovist for
  // "Isovist and view sheds"), or every kernel it names is built and a core layer uses one.
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z]/g, '');
  const builtNames = catalog.layers.map((l) => norm(String(l.manifest.name ?? ''))).filter(Boolean);
  const usedKernels = new Set(catalog.layers.flatMap((l) => l.manifest.requires?.kernels ?? []));
  const covered = (r: RoadmapRow) => {
    if (r.built || r.package) return true;
    if (builtNames.some((n) => norm(r.layer) === n || norm(r.layer).startsWith(`${n}and`))) return true;
    const ks = [...r.kernel.matchAll(/`([a-z0-9_-]+)`/g)].map((m) => m[1]!);
    return ks.length > 0 && ks.every((k) => catalog.kernels.includes(k)) && ks.some((k) => usedKernels.has(k)) && !/extended|with a|sampled|reading/i.test(r.kernel);
  };
  const seen = new Set<string>();
  for (const r of roadmap) {
    if (covered(r)) continue;
    const id = `planned:${slug(r.layer)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const kernels = [...r.kernel.matchAll(/`([a-z0-9_-]+)`/g)].map((m) => m[1]!);
    out.push({
      id, kind: 'layer', name: r.layer, summary: `Roadmap (${r.section}): ${r.kernel} · ${r.blocks}`.replace(/\*\*/g, ''), status: 'planned',
      questions: [], surfaces: {}, interactions: [], requires: [], uses: kernels.map((k) => `kernel:${k}`), pairs_with: [],
      limitations: ['Planned: not in the code yet; a development request, not something to configure'], examples: [], evidence: ['docs/ROADMAP.md'], issues: issuesIn(`${r.kernel} ${r.blocks}`),
    });
  }

  const schema = catalog.siteSchema;
  for (const f of SITE_FEATURES) {
    const [parent, key] = f.id === 'site:steps-notes' ? [f.path, 'notes'] : f.id === 'site:languages' ? [f.path, 'languages'] : (() => {
      const at = f.path.lastIndexOf('.');
      return at < 0 ? ['', f.path] : [f.path.slice(0, at), f.path.slice(at + 1)];
    })();
    const known = schema ? Boolean(schema[parent]?.fields.includes(key!.replace(/\[\]$/, ''))) : true;
    out.push({
      id: f.id, kind: 'site', name: f.name, summary: f.summary, status: known ? 'available' : 'planned',
      questions: [], surfaces: f.surfaces, interactions: f.interactions ?? [], requires: f.id === 'site:services' ? [{ kind: 'service', what: 'the service itself', how: 'a folder with the service and its run command, or a URL' }] : [],
      uses: [], pairs_with: [], limitations: [], examples: [], evidence: ['crates/mrs-site/src/manifest.rs', 'docs/contracts/site.md'], issues: [],
      ...(known ? {} : { discrepancy: `site.json has no '${f.path}' in this core` }),
    });
  }

  for (const c of CONSTRAINTS) out.push({ ...c, questions: [], interactions: [], requires: [], uses: [], pairs_with: [], examples: [], issues: [], surfaces: {} });
  return out;
}

/** Marks each requirement met or not for a site's data, services and files. */
export function withSite(cap: Capability, site: { data: Set<string>; services: Set<string> } | null): Capability {
  if (!site) return cap;
  const requires = cap.requires.map((r) => (r.kind === 'data' ? { ...r, met: site.data.has(r.what) } : r.kind === 'service' && cap.kind === 'layer' ? { ...r, met: site.services.has(r.what) } : r));
  const unmet = requires.some((r) => r.met === false);
  return { ...cap, requires, status: cap.status === 'needs_setup' && !unmet && !requires.some((r) => r.kind === 'file') ? 'available' : cap.status };
}

// ---- Search ----

const STOP = new Set('a an and the of to on in for with from by at as is are be it this that or how what when which want we our their people about can could would should help make show let into over under do does them they its you your who where why each other yet also just very much many some'.split(' '));

/** A few words people use for what layers say differently. Kept short: purposes and questions carry most of the matching. */
const SYNONYMS: Record<string, string[]> = {
  shade: ['sun', 'shadow', 'sunlight'], shadow: ['sun', 'sunlight'], overshadowing: ['shadow', 'sun'], daylight: ['sun', 'rule'], boverket: ['sun', 'daylight', 'rule'], bre: ['sun', 'daylight', 'rule'], bbr: ['sun', 'daylight', 'rule'], golden: ['sun', 'evening', 'light'], sunset: ['sun', 'golden', 'evening'], evening: ['sun', 'golden'],
  comfort: ['thermal', 'heat', 'pet', 'cool', 'wind'], pedestrian: ['walk', 'walker', 'walking'], walkability: ['walk'], heat: ['thermal', 'cool', 'pet'],
  see: ['view', 'sight', 'visibility'], seen: ['view', 'visibility'],
  view: ['see', 'sight', 'visibility', 'isovist'], visibility: ['see', 'view', 'isovist'], enclosure: ['view', 'enclosed'],
  participation: ['phone', 'sketch', 'mark'], participate: ['phone', 'sketch'], ideas: ['sketch', 'mark'], contribute: ['sketch', 'mark', 'phone'], comment: ['sketch'],
  compare: ['reveal', 'swipe', 'proposal', 'today'], before: ['reveal', 'history', 'old'], proposal: ['plan', 'masterplan', 'proposed'], development: ['proposal', 'plan'],
  flood: ['rain', 'water', 'stormwater'], rain: ['stormwater', 'water'], water: ['stormwater', 'rain'],
  traffic: ['car', 'cars', 'street'], transport: ['transit', 'tram', 'bus'], tram: ['transit', 'public transport'], bus: ['transit', 'public transport'], train: ['transit', 'public transport'],
  public: ['square', 'street', 'life'], space: ['square', 'street'], green: ['tree', 'trees', 'green'], trees: ['tree', 'green'],
  story: ['sequence', 'slideshow', 'guided'], workshop: ['sequence', 'sketch', 'guided'], tour: ['slideshow', 'guided', 'sequence'],
  history: ['old', 'historic', 'photo', 'before'], then: ['history', 'before', 'swipe'], now: ['today'], hidden: ['under', 'reveal', 'x-ray'], underground: ['under', 'reveal'],
  noise: ['sound', 'soundscape'], sound: ['soundscape', 'sound'], night: ['light', 'lights', 'dark'],
};

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map((w) => (w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

export interface Match {
  capability: Capability;
  score: number;
  /** Words of the query that matched, and where. */
  why: string[];
}

/** Ids closest to a mistyped one, by edit distance on the part after the kind. */
export function closestIds(caps: Capability[], id: string, n = 5): string[] {
  const want = id.replace(/^[a-z]+:/, '').toLowerCase();
  const dist = (a: string, b: string) => {
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const row = [i];
      for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = row;
    }
    return prev[b.length]!;
  };
  return caps
    .map((c) => ({ id: c.id, d: dist(want, c.id.replace(/^[a-z]+:/, '')) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, n)
    .map((x) => x.id);
}

/** Ranks capabilities against free text: purposes and questions count most, then names and summaries. */
export function rank(caps: Capability[], query: string): Match[] {
  const asked = tokens(query);
  const expanded = new Map<string, string>();
  for (const w of asked) {
    expanded.set(w, w);
    for (const s of SYNONYMS[w] ?? SYNONYMS[`${w}s`] ?? []) for (const t of tokens(s)) if (!expanded.has(t)) expanded.set(t, w);
  }
  const out: Match[] = [];
  for (const c of caps) {
    const fields: [string, number][] = [
      [words(c.purpose, c.questions), 3],
      [words(c.name, c.id.split(':')[1]), 3],
      [words(c.summary, c.interactions, Object.values(c.surfaces).filter(Boolean) as string[]), 1],
    ];
    let score = 0;
    const why = new Set<string>();
    for (const [text, weight] of fields) {
      const have = new Set(tokens(text));
      for (const [t, from] of expanded) {
        if (!have.has(t)) continue;
        score += t === from ? weight : weight / 2;
        why.add(t === from ? t : `${from}→${t}`);
      }
    }
    if (score > 0) out.push({ capability: c, score, why: [...why] });
  }
  return out.sort((a, b) => b.score - a.score || statusOrder(a.capability.status) - statusOrder(b.capability.status));
}

function statusOrder(s: CapabilityStatus): number {
  return { available: 0, needs_setup: 1, planned: 2, unsupported: 3 }[s];
}

// ---- Patterns (docs/experience-design.md) ----

export interface Pattern {
  id: string;
  name: string;
  text: string;
  capabilities: string[];
}

/** The experience patterns: `### <id>: <Name>` sections of docs/experience-design.md. */
export function parsePatterns(markdown: string): Pattern[] {
  const out: Pattern[] = [];
  const parts = markdown.split(/^### /m).slice(1);
  for (const part of parts) {
    const head = /^([a-z0-9-]+):\s*(.+)$/m.exec(part);
    if (!head) continue;
    const body = part.split(/^## /m)[0]!;
    const caps = /\*\*Capabilities:\*\*\s*(.+)$/m.exec(body)?.[1] ?? '';
    out.push({ id: head[1]!, name: head[2]!.trim(), text: `### ${body}`.trim(), capabilities: [...caps.matchAll(/`([a-z]+:[a-z0-9-]+)`/g)].map((m) => m[1]!) });
  }
  return out;
}
