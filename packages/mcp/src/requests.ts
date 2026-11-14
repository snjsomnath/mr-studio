// Module requests: when a site needs something the core lacks, the server writes a request for
// the core repository instead of letting a team grow its own copy of core code. Drafts are
// files the team can read and edit; submitting one opens a GitHub issue.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { slug } from './site.ts';

export const CORE_REPO = process.env.MRSTUDIO_REPO ?? 'snjsomnath/mr-studio';

export const REQUEST_KINDS = {
  'layer-change': 'A new control, tool, panel or option on an existing core layer',
  layer: 'A new core layer composed of building blocks that already exist',
  block: 'A new shared building block (visual, data source or interaction) in the SDK or runtime',
  kernel: 'A new compute kernel in the engine',
  contract: 'A change to a contract: site.json keys, TV dashboard, protocol, CLI',
  promote: 'Move a layer a team built into the core so every team gets it',
} as const;

export type RequestKind = keyof typeof REQUEST_KINDS;

export interface ModuleRequest {
  kind: RequestKind;
  title: string;
  /** What the team wants to show or let people do, in plain words. */
  goal: string;
  /** Who it is for and why existing layers are not enough. */
  why: string;
  /** How it could be built from the core's pieces. */
  proposal: string;
  /** Existing layers, blocks and kernels it would reuse. */
  reuses?: string[];
  /** Blocks, kernels or contract fields that do not exist yet. */
  missing?: string[];
  /** Draft manifest (layer.json) or site.json fragment showing the wanted configuration. */
  example?: unknown;
  /** Roadmap items it relates to. */
  roadmap?: string[];
  /** The site that needs it, for context. */
  site?: string;
}

export interface Draft {
  title: string;
  labels: string[];
  body: string;
  path: string | null;
  url: string;
}

function list(items: string[] | undefined, empty: string): string {
  return items?.length ? items.map((i) => `- ${i}`).join('\n') : empty;
}

export function renderRequest(req: ModuleRequest, coreVersion: string): { title: string; labels: string[]; body: string } {
  const title = `[${req.kind}] ${req.title}`.slice(0, 120);
  const labels = ['module-request', req.kind];
  const example = req.example === undefined ? '' : `\n## Example configuration\n\n\`\`\`json\n${typeof req.example === 'string' ? req.example : JSON.stringify(req.example, null, 2)}\n\`\`\`\n`;
  const body = `## What we want

${req.goal.trim()}

## Why the core does not cover it yet

${req.why.trim()}

## Proposal

${req.proposal.trim()}

## Reuses

${list(req.reuses, '_Nothing named._')}

## Missing in the core

${list(req.missing, '_Nothing; this composes existing pieces._')}
${example}
## Context

- Kind: \`${req.kind}\` (${REQUEST_KINDS[req.kind]})
- Core version: ${coreVersion}${req.site ? `\n- Site: ${req.site}` : ''}${req.roadmap?.length ? `\n- Roadmap: ${req.roadmap.join(', ')}` : ''}

_Drafted with the MR Studio MCP server._
`;
  return { title, labels, body };
}

export function issueUrl(title: string, body: string, labels: string[]): string {
  // Browsers and GitHub cope with about 8 KB of URL; longer bodies are cut with a pointer to the file.
  let text = body;
  const base = `https://github.com/${CORE_REPO}/issues/new`;
  const make = (b: string) => `${base}?${new URLSearchParams({ title, body: b, labels: labels.join(',') }).toString()}`;
  let url = make(text);
  while (url.length > 7500 && text.length > 200) {
    text = text.slice(0, Math.floor(text.length * 0.8)) + '\n\n_(cut; paste the rest from the draft file)_';
    url = make(text);
  }
  return url;
}

export function writeDraft(req: ModuleRequest, coreVersion: string, siteDir: string | null): Draft {
  const { title, labels, body } = renderRequest(req, coreVersion);
  let path: string | null = null;
  if (siteDir) {
    const dir = join(siteDir, 'requests');
    mkdirSync(dir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    path = join(dir, `${date}-${slug(req.title)}.md`);
    const front = `---\ntitle: ${JSON.stringify(title)}\nlabels: ${JSON.stringify(labels)}\nrepo: ${CORE_REPO}\nstatus: draft\n---\n\n`;
    writeFileSync(path, front + body);
  }
  return { title, labels, body, path, url: issueUrl(title, body, labels) };
}

export function readDraft(path: string): { title: string; labels: string[]; body: string; status: string } {
  if (!existsSync(path)) throw new Error(`No draft at ${path}`);
  const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error('The draft has no front matter (title, labels)');
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const parse = (v: string | undefined, fallback: any) => {
    try {
      return v ? JSON.parse(v) : fallback;
    } catch {
      return v ?? fallback;
    }
  };
  return { title: String(parse(meta.title, '')), labels: parse(meta.labels, ['module-request']), body: m[2]!, status: meta.status ?? 'draft' };
}

function markSubmitted(path: string, url: string): void {
  const text = readFileSync(path, 'utf8');
  writeFileSync(path, text.replace(/^status: .*$/m, `status: submitted\nissue: ${url}`));
}

function gh(args: string[], input?: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((done) => {
    const child = execFile(process.platform === 'win32' ? 'gh.exe' : 'gh', args, { timeout: 60_000, windowsHide: true }, (error, stdout, stderr) =>
      done({ ok: !error, out: (stdout || stderr || error?.message || '').trim() }),
    );
    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });
}

/** Opens the draft as an issue: with GITHUB_TOKEN or GH_TOKEN, else with the gh CLI. */
export async function submitDraft(path: string): Promise<{ submitted: boolean; url: string; how: string }> {
  const draft = readDraft(path);
  if (draft.status === 'submitted') throw new Error('This draft was already submitted; see the issue line in its front matter');
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token) {
    const res = await fetch(`https://api.github.com/repos/${CORE_REPO}/issues`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'mrstudio-mcp' },
      body: JSON.stringify({ title: draft.title, body: draft.body, labels: draft.labels }),
    });
    if (!res.ok) throw new Error(`GitHub refused the issue (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const issue = (await res.json()) as { html_url: string };
    markSubmitted(path, issue.html_url);
    return { submitted: true, url: issue.html_url, how: 'GitHub API with GITHUB_TOKEN' };
  }
  const result = await gh(['issue', 'create', '--repo', CORE_REPO, '--title', draft.title, '--body-file', '-', ...draft.labels.flatMap((l) => ['--label', l])], draft.body);
  if (result.ok && /https:\/\/github\.com\//.test(result.out)) {
    const url = result.out.split(/\s+/).find((s) => s.startsWith('https://github.com/'))!;
    markSubmitted(path, url);
    return { submitted: true, url, how: 'gh CLI' };
  }
  // Labels that do not exist make gh fail; try once without them.
  if (result.ok === false && /label/i.test(result.out)) {
    const retry = await gh(['issue', 'create', '--repo', CORE_REPO, '--title', draft.title, '--body-file', '-'], draft.body);
    if (retry.ok && /https:\/\/github\.com\//.test(retry.out)) {
      const url = retry.out.split(/\s+/).find((s) => s.startsWith('https://github.com/'))!;
      markSubmitted(path, url);
      return { submitted: true, url, how: 'gh CLI, without labels' };
    }
  }
  return { submitted: false, url: issueUrl(draft.title, draft.body, draft.labels), how: 'no GITHUB_TOKEN and no signed-in gh CLI: open the link to file it by hand' };
}
