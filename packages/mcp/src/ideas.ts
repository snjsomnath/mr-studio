// Checks a layer idea against what the core has, so brainstorming ends in one of three
// places: configure a layer that exists, ask the core for a layer made of blocks that exist,
// or ask the core for the missing blocks or kernels first.

import type { Block, Catalog, LayerEntry, RoadmapRow } from './core.ts';

export interface LayerIdea {
  title: string;
  description: string;
  kernels?: string[];
  blocks?: string[];
  data?: string[];
  tools?: ('point' | 'line' | 'polygon')[];
}

export type Verdict = 'use-existing' | 'compose-from-blocks' | 'needs-new-module';

export interface IdeaReport {
  verdict: Verdict;
  summary: string;
  existing_layers: { id: string; name: string; why: string }[];
  roadmap: RoadmapRow[];
  kernels: { id: string; status: 'built' | 'planned' | 'unknown' }[];
  blocks: { asked: string; id: string | null; status: 'built' | 'planned' | 'unknown'; usage?: string }[];
  missing: string[];
  next_step: string;
}

const STOP = new Set('a an and the of to on in for with from by at as is are be it this that or show shows showing layer table map where how what when which see people their our its into over under'.split(' '));

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
      .map((w) => w.replace(/(ies)$/, 'y').replace(/(s)$/, '')),
  );
}

function overlap(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((w) => b.has(w));
}

export function findBlock(blocks: Block[], asked: string): Block | undefined {
  const key = asked.toLowerCase().trim();
  const dashed = key.replace(/[^a-z0-9]+/g, '-');
  return (
    blocks.find((b) => b.id === dashed || b.name.toLowerCase() === key) ??
    blocks.find((b) => b.id.includes(dashed) || dashed.includes(b.id) || b.name.toLowerCase().includes(key))
  );
}

export function checkIdea(idea: LayerIdea, catalog: Catalog, extraLayers: LayerEntry[] = []): IdeaReport {
  const words = tokens(`${idea.title} ${idea.description}`);

  const existing = [...catalog.layers, ...extraLayers]
    .map((l) => {
      const m = l.manifest;
      const text = `${m.name ?? ''} ${m.description ?? ''} ${(m.controls ?? []).map((c: any) => c.label).join(' ')}`;
      const shared = overlap(words, tokens(text));
      const kernelHit = (m.requires?.kernels ?? []).filter((k: string) => idea.kernels?.includes(k));
      return { l, shared, kernelHit, score: shared.length + 2 * kernelHit.length };
    })
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score)
    .map(({ l, shared, kernelHit }) => ({
      id: l.origin === 'core' ? l.id : l.use,
      name: String(l.manifest.name ?? l.id),
      why: [kernelHit.length ? `uses kernel ${kernelHit.join(', ')}` : '', shared.length ? `matches ${shared.slice(0, 6).join(', ')}` : ''].filter(Boolean).join('; '),
    }));

  const withBlocks = new Set([...words, ...tokens((idea.blocks ?? []).join(' '))]);
  const roadmap = catalog.roadmap
    .map((row) => ({ row, n: overlap(withBlocks, tokens(`${row.layer} ${row.blocks}`)).length + (idea.kernels ?? []).filter((k) => row.kernel.includes(`\`${k}\``)).length * 2 }))
    .filter((x) => x.n >= 2)
    .sort((a, b) => b.n - a.n)
    .slice(0, 5)
    .map((x) => x.row);

  // A "kernel" that is really a layer id (transit, isovist) names that layer, not a missing kernel (#319).
  const allLayers = [...catalog.layers, ...extraLayers];
  const layerKernels = (idea.kernels ?? []).filter((id) => !catalog.kernels.includes(id) && allLayers.some((l) => l.id === id));
  for (const id of layerKernels) {
    const l = allLayers.find((x) => x.id === id)!;
    const at = existing.findIndex((e) => e.id === (l.origin === 'core' ? l.id : l.use));
    if (at >= 0) existing.splice(at, 1);
    existing.unshift({ id: l.origin === 'core' ? l.id : l.use, name: String(l.manifest.name ?? l.id), why: `'${id}' is a layer, not a kernel; it already exists` });
  }
  const kernels = (idea.kernels ?? [])
    .filter((id) => !layerKernels.includes(id))
    .map((id) => ({
      id,
      status: catalog.kernels.includes(id) ? ('built' as const) : catalog.plannedKernels.includes(id) ? ('planned' as const) : ('unknown' as const),
    }));

  const blocks = (idea.blocks ?? []).map((asked) => {
    const b = findBlock(catalog.blocks, asked);
    return b ? { asked, id: b.id, status: b.status, usage: b.usage } : { asked, id: null, status: 'unknown' as const };
  });

  if (idea.tools?.length && !catalog.blocks.find((b) => b.id === 'phone-tools' && b.status === 'built')) {
    blocks.push({ asked: 'phone tools', id: 'phone-tools', status: 'planned', usage: 'planned' });
  }

  const missing = [
    ...kernels.filter((k) => k.status !== 'built').map((k) => `kernel '${k.id}' (${k.status === 'planned' ? 'on the roadmap' : 'new'})`),
    ...blocks.filter((b) => b.status !== 'built').map((b) => `block '${b.id ?? b.asked}' (${b.status === 'planned' ? 'planned' : 'new'})`),
  ];

  const strongMatch = existing.length > 0 && missing.length === 0 && (existing[0]!.why.includes('kernel') || layerKernels.length > 0);
  let verdict: Verdict;
  let summary: string;
  let next: string;
  if (missing.length) {
    verdict = 'needs-new-module';
    summary = `The core is missing ${missing.length} piece${missing.length > 1 ? 's' : ''} for this idea: ${missing.join('; ')}.`;
    next = 'Draft a module request with draft_module_request (kind "block" or "kernel"), listing the missing pieces and the layer they unlock. Meanwhile, use the closest existing layers in the scene.';
  } else if (strongMatch || (existing.length && !idea.kernels?.length && !idea.blocks?.length)) {
    verdict = 'use-existing';
    summary = `An existing layer likely covers this: ${existing[0]!.name}. Configure it with params rather than asking for new code.`;
    next = `Call describe_layer on '${existing[0]!.id}', then add_layer with params that tell the story. If a control is missing, request it with draft_module_request (kind "layer-change").`;
  } else {
    verdict = 'compose-from-blocks';
    summary = 'Every kernel and block this idea needs exists, but no layer composes them yet. That is a short layer package in the core, not custom code in the site.';
    next = 'Draft a module request with draft_module_request (kind "layer"), including the layer.json you would want (controls, tools, requires) and which blocks it uses.';
  }
  if (roadmap.length) next += ` Related roadmap item${roadmap.length > 1 ? 's' : ''}: ${roadmap.map((r) => r.layer).join(', ')}; mention ${roadmap.length > 1 ? 'them' : 'it'} in the request.`;

  return { verdict, summary, existing_layers: existing.slice(0, 5), roadmap, kernels, blocks, missing, next_step: next };
}
