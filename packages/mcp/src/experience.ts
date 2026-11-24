// Experience plans (#327): a group's story at the table, written as steps, checked against the
// capability catalogue, then built as far as the code allows. A plan says what people should
// see and do; assess says, step by step, what exists, what needs setup and what needs
// development; build writes only the parts that exist, in one validated change.

import { closestIds, rank, tokens, type Capability } from './capabilities.ts';
import { checkParams, freeId, instanceIds, type Issue, type SiteManifest } from './site.ts';
import type { LayerEntry } from './core.ts';

export interface PlanStep {
  title: string;
  /** What the table shows and people do, in plain words. Used to find a layer when `use` is not given. */
  want?: string;
  /** A layer (`sunlight`, `custom:zones`, `./layers/x`) or capability id (`layer:sunlight`) chosen with find_capabilities. */
  use?: string;
  /** Settings for this step, by control id. */
  params?: Record<string, unknown>;
  /** Layers shown inside this one while it is open (public transport inside a sun study). */
  with?: string[];
  /** What the controller says for this step (its description). */
  controller?: string;
  /** What phones do in this step. */
  phone?: string;
  /** The guide's words for this step, shown only on the guide's phone. */
  notes?: string;
}

export interface ExperiencePlan {
  title: string;
  /** What people should leave understanding, having seen or having said. */
  goal: string;
  audience?: string;
  steps: PlanStep[];
  /** Layers playing at rest, when nobody touches the controller (cars, trees, street life). */
  at_rest?: string[];
  /** Anything else the experience needs that is not a step: "people vote on each other's ideas". */
  needs?: string[];
  /** Make a guided sequence of the steps (default: true when there are two or more). */
  guided?: boolean;
}

export type StepStatus = 'buildable' | 'needs_setup' | 'needs_development' | 'unsupported';
/** The development request kinds (devrequests.ts) a gap can need. */
export type GapKind = 'layer-enhancement' | 'new-layer' | 'block' | 'kernel' | 'site-setting' | 'interaction' | 'data-integration';

export interface Gap {
  /** The step title or need it comes from. */
  for: string;
  kind: GapKind;
  summary: string;
  /** Capabilities a request would reuse or extend. */
  related: string[];
}

export interface StepReport {
  index: number;
  title: string;
  status: StepStatus;
  /** The layer that serves it, when one does. */
  layer?: { use: string; name: string; capability: string; why: string[] };
  alternatives: { id: string; name: string; status: string }[];
  with: { use: string; ok: boolean; why?: string }[];
  setup: { what: string; how: string }[];
  issues: Issue[];
  gap?: Gap;
  /** A constraint the wording runs into ("3D", "text on the table"). */
  constraint?: { id: string; name: string; instead: string };
}

export interface NeedReport {
  need: string;
  status: StepStatus;
  covered_by?: { id: string; name: string };
  gap?: Gap;
}

export type Verdict = 'buildable' | 'buildable_with_setup' | 'partly_buildable' | 'needs_development';

export interface Assessment {
  verdict: Verdict;
  summary: string;
  steps: StepReport[];
  at_rest: { use: string; ok: boolean; why?: string }[];
  needs: NeedReport[];
  gaps: Gap[];
  setup: { what: string; how: string }[];
  next: string[];
}

/** A word's stem, enough to see that "voting" and "vote", or "comments" and "commenting", are the same. */
function stem(word: string): string {
  return word.replace(/(ing|ed|es|s|e)$/, '');
}
const stems = (text: string) => new Set(tokens(text).map(stem).filter((w) => w.length >= 3));

const MIN_SCORE = 3;

/** The layer capability a step names, by layer id, use or capability id. */
function named(caps: Capability[], use: string): Capability | undefined {
  const id = use.includes(':') && !use.startsWith('custom:') ? use : `layer:${use}`;
  return caps.find((c) => c.id === id || (c.kind === 'layer' && c.use === use));
}

/** Words of `asked` that a capability's limits name and its purpose does not: the thing it cannot do. */
function limitHit(cap: Capability, asked: string): string | null {
  const want = stems(asked);
  const has = stems(`${cap.purpose ?? ''} ${cap.questions.join(' ')} ${cap.summary}`);
  for (const limit of cap.limitations) {
    const hit = [...stems(limit)].filter((w) => want.has(w) && !has.has(w) && w.length >= 3);
    if (hit.length) return limit;
  }
  return null;
}

function constraintFor(caps: Capability[], text: string): Capability | undefined {
  const hit = rank(caps.filter((c) => c.kind === 'constraint'), text)[0];
  return hit && hit.score >= MIN_SCORE ? hit.capability : undefined;
}

/** What a request for something missing would be, from what the catalogue does have. */
function gapFor(caps: Capability[], forWhat: string, text: string): Gap {
  const ranked = rank(caps, text);
  const planned = ranked.find((m) => m.capability.status === 'planned' && m.score >= MIN_SCORE);
  if (planned) {
    const kind: GapKind = planned.capability.kind === 'kernel' ? 'kernel' : planned.capability.kind === 'block' ? 'block' : 'new-layer';
    return { for: forWhat, kind, summary: `On the roadmap but not built: ${planned.capability.name}.`, related: [planned.capability.id] };
  }
  const asked = new Set(tokens(text));
  const covers = (m: { why: string[] }) => new Set(m.why.map((w) => w.split('→')[0]!)).size / Math.max(1, asked.size);
  const parts = ranked.filter((m) => (m.capability.kind === 'block' || m.capability.kind === 'kernel') && m.capability.status !== 'planned' && m.score >= MIN_SCORE / 2);
  const together = new Set(parts.flatMap((m) => m.why.map((w) => w.split('→')[0]!)));
  if (parts.length && (together.size / Math.max(1, asked.size) >= 0.5 || parts.some((m) => covers(m) >= 0.5)))
    return { for: forWhat, kind: 'new-layer', summary: 'No layer does this, but the pieces exist; a new core layer could compose them.', related: parts.slice(0, 4).map((m) => m.capability.id) };
  return { for: forWhat, kind: 'block', summary: 'Nothing in the core does this yet; it needs a new building block or kernel.', related: [] };
}

function setupOf(cap: Capability, siteKnown: boolean): { what: string; how: string }[] {
  return cap.requires
    .filter((r) => r.kind !== 'kernel' && r.kind !== 'key' && (siteKnown ? r.met === false || (r.met === undefined && r.kind !== 'data') : true))
    .map((r) => ({ what: `${cap.name}: ${r.kind} ${r.what}`, how: r.how }));
}

/** Checks a plan against the catalogue. `layers` resolves `use` values to layer.json for params. */
export function assessExperience(plan: ExperiencePlan, caps: Capability[], layers: LayerEntry[], siteKnown: boolean): Assessment {
  const layerCaps = caps.filter((c) => c.kind === 'layer');
  const layerOf = (use: string) => layers.find((l) => (l.origin === 'core' ? l.id : l.use) === use || l.use === use);
  const resolveUse = (use: string) => {
    const cap = named(caps, use);
    return cap?.kind === 'layer' ? cap : undefined;
  };

  const steps: StepReport[] = plan.steps.map((step, index) => {
    const text = [step.title, step.want, step.controller, step.phone].filter(Boolean).join('. ');
    const report: StepReport = { index, title: step.title, status: 'buildable', alternatives: [], with: [], setup: [], issues: [] };
    const constraint = constraintFor(caps, text);
    if (constraint) report.constraint = { id: constraint.id, name: constraint.name, instead: constraint.limitations[0] ?? '' };

    let cap: Capability | undefined;
    let why: string[] = [];
    if (step.use) {
      cap = resolveUse(step.use);
      if (!cap) {
        const other = named(caps, step.use);
        if (other && other.kind !== 'layer') {
          report.alternatives = rank(layerCaps, `${other.name} ${other.summary}`).slice(0, 3).map((m) => ({ id: m.capability.id, name: m.capability.name, status: m.capability.status }));
        } else {
          report.alternatives = closestIds(layerCaps, step.use, 3).map((id) => ({ id, name: layerCaps.find((c) => c.id === id)!.name, status: layerCaps.find((c) => c.id === id)!.status }));
        }
        report.issues.push({ level: 'error', path: `steps[${index}].use`, message: other && other.kind !== 'layer' ? `'${step.use}' is a ${other.kind}, not a layer; a step shows a layer. Closest layers: ${report.alternatives.map((a) => a.id).join(', ')}` : `No layer '${step.use}'.` });
      } else why = ['named in the plan'];
    } else {
      const ranked = rank(layerCaps, text);
      if (ranked[0] && ranked[0].score >= MIN_SCORE) {
        cap = ranked[0].capability;
        why = ranked[0].why;
      }
      report.alternatives = ranked.slice(cap ? 1 : 0, cap ? 4 : 3).map((m) => ({ id: m.capability.id, name: m.capability.name, status: m.capability.status }));
    }

    // Wording that runs into a constraint ("in 3D") is not served by whichever layer shares a word with it.
    if (constraint && !step.use) {
      report.status = 'unsupported';
      report.alternatives = [];
      return report;
    }
    if (!cap) {
      report.status = constraint ? 'unsupported' : 'needs_development';
      if (!constraint) report.gap = gapFor(caps, step.title, text);
      return report;
    }
    report.layer = { use: cap.use ?? cap.id.slice(6), name: cap.name, capability: cap.id, why };
    const limit = limitHit(cap, text);
    if (limit) report.gap = { for: step.title, kind: 'layer-enhancement', summary: `${cap.name} cannot do this yet: ${limit}`, related: [cap.id] };

    const layer = layerOf(report.layer.use);
    if (layer && step.params) report.issues.push(...checkParams(layer, step.params, `steps[${index}].params`).issues);
    report.setup = setupOf(cap, siteKnown);
    for (const use of step.with ?? []) {
      const inner = resolveUse(use);
      report.with.push(inner ? { use: inner.use ?? use, ok: true } : { use, ok: false, why: `No layer '${use}'` });
    }

    if (report.issues.some((i) => i.level === 'error') || report.with.some((w) => !w.ok)) report.status = 'needs_development';
    if (report.issues.some((i) => i.level === 'error')) report.gap ??= { for: step.title, kind: 'layer-enhancement', summary: `Fix the step first: ${report.issues.filter((i) => i.level === 'error').map((i) => i.message).join('; ')}`, related: [cap.id] };
    else if (report.gap) report.status = 'buildable';
    else if (report.setup.length) report.status = 'needs_setup';
    return report;
  });

  const restSetup: { what: string; how: string }[] = [];
  const at_rest = (plan.at_rest ?? []).map((use) => {
    const cap = resolveUse(use);
    if (cap) restSetup.push(...setupOf(cap, siteKnown));
    return cap ? { use: cap.use ?? use, ok: true } : { use, ok: false, why: `No layer '${use}'; closest ${closestIds(layerCaps, use, 3).join(', ')}` };
  });

  const usable = caps.filter((c) => c.kind !== 'constraint' && c.status !== 'planned');
  const needs: NeedReport[] = (plan.needs ?? []).map((need) => {
    const hit = rank(usable, need)[0];
    // A need is covered only when most of its words are: "export the ideas" is not Sketch because of "ideas".
    const asked = new Set(tokens(need));
    const covered = new Set(hit?.why.map((w) => w.split('→')[0]!) ?? []);
    if (hit && hit.score >= MIN_SCORE && covered.size / Math.max(1, asked.size) >= 0.5) {
      const limit = limitHit(hit.capability, need);
      if (!limit) return { need, status: hit.capability.status === 'needs_setup' ? 'needs_setup' : 'buildable', covered_by: { id: hit.capability.id, name: hit.capability.name } };
      return { need, status: 'needs_development', gap: { for: need, kind: 'layer-enhancement', summary: `${hit.capability.name} cannot do this yet: ${limit}`, related: [hit.capability.id] } };
    }
    const constraint = constraintFor(caps, need);
    if (constraint) return { need, status: 'unsupported', covered_by: { id: constraint.id, name: constraint.name } };
    return { need, status: 'needs_development', gap: gapFor(caps, need, need) };
  });

  const gaps = [...steps.flatMap((s) => (s.gap ? [s.gap] : [])), ...needs.flatMap((n) => (n.gap ? [n.gap] : []))];
  const setup = dedupe([...steps.flatMap((s) => s.setup), ...restSetup]);
  const built = steps.filter((s) => s.layer && s.status !== 'needs_development').length;
  const verdict: Verdict = gaps.length || steps.some((s) => s.status === 'unsupported') || at_rest.some((r) => !r.ok)
    ? (built ? 'partly_buildable' : 'needs_development')
    : setup.length ? 'buildable_with_setup' : 'buildable';

  const next: string[] = [];
  if (built) next.push(`build_experience writes the ${built} step${built === 1 ? '' : 's'} that exist${built === 1 ? 's' : ''}${plan.steps.length > 1 && plan.guided !== false ? ' and a guided sequence of them' : ''}; gaps are never written into site.json.`);
  if (setup.length) next.push('Bring in what setup lists (data files into the site, keys in the app\'s Sources and keys) before the session.');
  if (steps.some((s) => s.constraint)) next.push('A step runs into a constraint; rephrase it with the alternative given.');
  if (gaps.length) next.push(`Show the person the ${gaps.length} gap${gaps.length === 1 ? '' : 's'}; with their yes, look for an existing issue (find_related_issues), then draft a development request for each (draft_development_request with the kind given).`);
  const summary = `${plan.title}: ${verdict.replace(/_/g, ' ')}. ${built} of ${plan.steps.length} steps exist${setup.length ? `, ${setup.length} setup item${setup.length === 1 ? '' : 's'}` : ''}${gaps.length ? `, ${gaps.length} gap${gaps.length === 1 ? '' : 's'}` : ''}.`;
  return { verdict, summary, steps, at_rest, needs, gaps, setup, next };
}

function dedupe<T extends { what: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(i.what) ? false : (seen.add(i.what), true)));
}

export interface BuildResult {
  message: string;
  built: string[];
  skipped: { step: string; why: string }[];
  issues: Issue[];
}

/**
 * Writes the buildable part of an assessed plan into a manifest: one instance per layer used
 * (reused when the scene already has one), items, layers at rest, and a guided sequence of
 * the steps with titles, controller text and notes. Steps that need development are skipped.
 */
export function buildExperience(m: SiteManifest, plan: ExperiencePlan, assessment: Assessment, layers: LayerEntry[]): BuildResult {
  const built: string[] = [];
  const skipped: { step: string; why: string }[] = [];
  const issues: Issue[] = [];
  const layerOf = (use: string) => layers.find((l) => (l.origin === 'core' ? l.id : l.use) === use || l.use === use);
  const instanceOf = (use: string) => m.layers.find((l: any) => l.use === use);
  const add = (use: string, extra: Record<string, unknown> = {}) => {
    const existing = instanceOf(use);
    if (existing) return existing;
    const entry = { use, id: freeId(m, use), ...extra };
    m.layers.push(entry);
    built.push(`${entry.id} (${use})`);
    return entry;
  };

  for (const rest of assessment.at_rest) {
    if (!rest.ok) {
      skipped.push({ step: `at rest: ${rest.use}`, why: rest.why ?? 'unknown layer' });
      continue;
    }
    const entry = add(rest.use, { active: true });
    entry.active = true;
  }

  const sequence: Record<string, unknown>[] = [];
  assessment.steps.forEach((report, i) => {
    const step = plan.steps[i]!;
    if (!report.layer || report.status === 'needs_development' || report.status === 'unsupported') {
      skipped.push({ step: step.title, why: report.gap?.summary ?? report.constraint?.instead ?? 'no layer serves it' });
      return;
    }
    const layer = layerOf(report.layer.use);
    const entry = add(report.layer.use);
    const checked = layer && step.params ? checkParams(layer, step.params, `${step.title}.params`) : { issues: [], cleaned: step.params ?? {} };
    issues.push(...checked.issues);
    for (const inner of report.with.filter((w) => w.ok)) {
      entry.items = Array.isArray(entry.items) ? entry.items : [];
      if (!entry.items.some((it: any) => it.use === inner.use) && !instanceIds(m).includes(`${entry.id}-${inner.use}`)) {
        entry.items.push({ use: inner.use, id: `${entry.id}-${inner.use.replace(/[^a-z0-9-]/g, '')}` });
        built.push(`${entry.id}-${inner.use} inside ${entry.id}`);
      }
    }
    sequence.push({
      layer: entry.id,
      ...(Object.keys(checked.cleaned).length ? { params: checked.cleaned } : {}),
      title: step.title,
      ...(step.controller ? { description: step.controller } : {}),
      ...(step.notes ? { notes: step.notes } : {}),
    });
    // A single-step plan, or one that is not guided, puts the step's settings on the layer itself.
    if ((plan.guided === false || plan.steps.length < 2) && Object.keys(checked.cleaned).length) entry.params = { ...(entry.params ?? {}), ...checked.cleaned };
    if (plan.guided === false || plan.steps.length < 2) entry.button = { ...(entry.button ?? {}), name: step.title };
  });

  const guided = plan.guided ?? plan.steps.length >= 2;
  if (guided && sequence.length) {
    const story = m.layers.find((l: any) => l.use === 'slideshow' && l.button?.name === plan.title) ?? add('slideshow');
    story.button = { ...(story.button ?? {}), name: plan.title };
    story.steps = { mode: 'manual', ...(story.steps ?? {}), sequence };
  }
  const message = `Built ${plan.title}: ${built.length ? built.join(', ') : 'nothing new'}${guided && sequence.length ? `, a guided sequence of ${sequence.length} steps` : ''}${skipped.length ? `; skipped ${skipped.map((s) => s.step).join(', ')}` : ''}.`;
  return { message, built, skipped, issues };
}
