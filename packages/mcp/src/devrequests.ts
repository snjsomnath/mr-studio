// Development requests (#328): when an experience needs something MR Studio cannot do, the
// server writes an actionable issue for the core repository, after checking that no issue
// already asks for it. Drafts are files the person reads; one yes may send a batch; a number
// or link is reported only when GitHub's API returned it.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { tokens } from './capabilities.ts';
import { CORE_REPO, issueUrl } from './requests.ts';
import { slug } from './site.ts';

export const DEV_KINDS = {
  'layer-enhancement': 'A new control, tool, panel or option on an existing layer',
  'new-layer': 'A new core layer, composed of building blocks that exist where possible',
  block: 'A new shared building block (a visual, data source or interaction) in the SDK or runtime',
  kernel: 'A new computation in the engine',
  'data-integration': 'A new data source, format, live feed or service',
  interaction: 'A new way for people to act: controller, phones, the table pointer',
  'site-setting': 'A new key or option in site.json',
  'sdk-runtime': 'A change to the SDK or runtime that layers build on',
  architecture: 'A change to how MR Studio is put together: hosting, protocol, packaging',
  other: 'Anything else',
} as const;
export type DevKind = keyof typeof DEV_KINDS;

/** The older module-request kinds, and the gap kinds assess_experience gives, as development kinds. */
export const KIND_ALIASES: Record<string, DevKind> = {
  'layer-change': 'layer-enhancement',
  layer: 'new-layer',
  contract: 'site-setting',
  promote: 'new-layer',
};

export interface DevRequest {
  kind: DevKind;
  title: string;
  /** The situation: the site, the people, what they are trying to do. */
  context: string;
  /** "As a …, I want …, so that …". */
  user_story: string;
  /** What should exist, in plain words. */
  proposal: string;
  /** What each surface does with it. */
  experience?: { table?: string; controller?: string; phone?: string };
  /** How it could be built: blocks it reuses, kernels, data, risks. */
  technical?: string;
  /** Checks that say it is done. */
  acceptance: string[];
  dependencies?: string[];
  /** What MR Studio does today, and why that falls short. */
  limitations?: string;
  references?: string[];
  /** Capability ids it reuses or extends (from find_capabilities or assess_experience). */
  related_capabilities?: string[];
  /** Issues found by find_related_issues that this one is not a duplicate of, with why. */
  related_issues?: { number: number; why: string }[];
  example?: unknown;
  site?: string;
}

export const DEV_LABELS = (kind: DevKind) => ['development-request', kind, 'needs-triage'];

const list = (items: string[] | undefined, empty = '_None._') => (items?.length ? items.map((i) => `- ${i}`).join('\n') : empty);

export function renderDevRequest(req: DevRequest, coreVersion: string): { title: string; labels: string[]; body: string } {
  const title = req.title.trim().slice(0, 120);
  const exp = req.experience ?? {};
  const surfaces = ['table', 'controller', 'phone'] as const;
  const experience = surfaces.some((s) => exp[s]) ? surfaces.map((s) => `- **${s[0]!.toUpperCase()}${s.slice(1)}:** ${exp[s] ?? '_nothing_'}`).join('\n') : '_Not described._';
  const example = req.example === undefined ? '' : `\n### Example configuration\n\n\`\`\`json\n${typeof req.example === 'string' ? req.example : JSON.stringify(req.example, null, 2)}\n\`\`\`\n`;
  const body = `### Context

${req.context.trim()}

### User story

${req.user_story.trim()}

### Proposed functionality

${req.proposal.trim()}

### Experience across the table, controller and phones

${experience}

### Technical considerations

${req.technical?.trim() || '_None given._'}
${example}
### Acceptance criteria

${req.acceptance.map((a) => `- [ ] ${a}`).join('\n')}

### Dependencies

${list(req.dependencies)}

### Current limitations

${req.limitations?.trim() || '_Not described._'}

### Related

${list([...(req.related_capabilities ?? []).map((c) => `\`${c}\``), ...(req.related_issues ?? []).map((i) => `#${i.number}: ${i.why}`), ...(req.references ?? [])])}

### Kind

\`${req.kind}\`: ${DEV_KINDS[req.kind]}. Core ${coreVersion}${req.site ? `, site ${req.site}` : ''}.

_Drafted with the MR Studio MCP server._
`;
  return { title, labels: DEV_LABELS(req.kind), body };
}

export interface DevDraft {
  title: string;
  labels: string[];
  body: string;
  path: string | null;
  url: string;
}

export function writeDevDraft(req: DevRequest, coreVersion: string, siteDir: string | null): DevDraft {
  const { title, labels, body } = renderDevRequest(req, coreVersion);
  let path: string | null = null;
  if (siteDir) {
    const dir = join(siteDir, 'requests');
    mkdirSync(dir, { recursive: true });
    path = join(dir, `${new Date().toISOString().slice(0, 10)}-${slug(title)}.md`);
    const front = `---\ntitle: ${JSON.stringify(title)}\nlabels: ${JSON.stringify(labels)}\nrepo: ${CORE_REPO}\nkind: ${req.kind}\nstatus: draft\n---\n\n`;
    writeFileSync(path, front + body);
  }
  return { title, labels, body, path, url: issueUrl(title, body, labels) };
}

// ---- GitHub ----

/** The API base, so tests can stand in for GitHub. */
const API = () => (process.env.MRSTUDIO_GITHUB_API ?? 'https://api.github.com').replace(/\/+$/, '');

export interface Issue {
  number: number;
  title: string;
  state: string;
  url: string;
  labels: string[];
  /** 0 to 1: how much of the request's wording the issue shares. */
  similarity: number;
  why: string;
}

export type GitHubError = { code: 'github_not_signed_in' | 'github_forbidden' | 'github_unreachable' | 'github_failed'; message: string };

function ghToken(): Promise<string | null> {
  const env = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (env) return Promise.resolve(env);
  if (process.env.MRSTUDIO_NO_GH) return Promise.resolve(null);
  return new Promise((done) =>
    execFile(process.platform === 'win32' ? 'gh.exe' : 'gh', ['auth', 'token'], { timeout: 10_000, windowsHide: true }, (error, stdout) => done(error ? null : stdout.trim() || null)),
  );
}

/** An issue as GitHub's REST API gives it, the parts read here. */
interface GhIssue {
  number: number;
  title: string;
  body?: string | null;
  state: string;
  html_url: string;
  labels?: (string | { name: string })[];
  pull_request?: unknown;
}

async function github(path: string, init: { method?: string; body?: unknown; token?: string | null } = {}): Promise<{ ok: true; data: unknown } | { ok: false; error: GitHubError }> {
  let res: Response;
  try {
    res = await fetch(`${API()}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'mrstudio-mcp',
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    return { ok: false, error: { code: 'github_unreachable', message: `Could not reach GitHub: ${(error as Error).message}` } };
  }
  if (res.ok) return { ok: true, data: await res.json() };
  const text = (await res.text()).slice(0, 300);
  if (res.status === 401) return { ok: false, error: { code: 'github_not_signed_in', message: `GitHub did not accept the credentials (401): ${text}` } };
  if (res.status === 403 || res.status === 404) return { ok: false, error: { code: 'github_forbidden', message: `GitHub refused (${res.status}); the account may not be allowed to open issues on ${CORE_REPO}: ${text}` } };
  return { ok: false, error: { code: 'github_failed', message: `GitHub answered ${res.status}: ${text}` } };
}

const stem = (w: string) => w.replace(/(ing|ed|es|s|e)$/, '');
const words = (text: string) => new Set(tokens(text).map(stem).filter((w) => w.length >= 3 && !['mr-studio', 'mrstudio', 'studio', 'layer', 'request', 'add', 'new', 'support'].includes(w)));

/** How much of a request's title an issue shares: a word in the issue's title counts 1, in its opening lines 0.5. */
export function similarity(asked: string, title: string, body = ''): { score: number; shared: string[] } {
  const want = words(asked);
  if (!want.size) return { score: 0, shared: [] };
  const inTitle = words(title);
  const inBody = words(body.slice(0, 1500));
  const shared = [...want].filter((w) => inTitle.has(w) || inBody.has(w));
  const score = [...want].reduce((n, w) => n + (inTitle.has(w) ? 1 : inBody.has(w) ? 0.5 : 0), 0) / want.size;
  return { score, shared };
}

/** Issues (open and closed) on the core repository that may already ask for this, ranked by how much of `title` they share. */
export async function searchIssues(title: string, context = '', limit = 8): Promise<{ issues: Issue[]; error?: GitHubError }> {
  let terms = [...words(title)];
  if (terms.length < 2) terms = [...new Set([...terms, ...words(context)])];
  terms = terms.slice(0, 6);
  if (!terms.length) return { issues: [] };
  const token = await ghToken();
  const q = `repo:${CORE_REPO} is:issue ${terms.join(' OR ')}`;
  let res = await github(`/search/issues?per_page=30&q=${encodeURIComponent(q)}`, { token });
  // Search needs no sign-in on a public repository; a stale token should not stop it.
  if (!res.ok && token && res.error.code === 'github_not_signed_in') res = await github(`/search/issues?per_page=30&q=${encodeURIComponent(q)}`, {});
  if (!res.ok) return { issues: [], error: res.error };
  const found = res.data as { items?: GhIssue[] };
  const issues: Issue[] = (found.items ?? [])
    .filter((i) => !i.pull_request)
    .map((i) => {
      const s = similarity(terms.join(' '), String(i.title ?? ''), String(i.body ?? ''));
      return {
        number: i.number,
        title: i.title,
        state: i.state,
        url: i.html_url,
        labels: (i.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)),
        similarity: Math.round(s.score * 100) / 100,
        why: s.shared.length ? `shares ${s.shared.slice(0, 6).join(', ')}` : 'found by GitHub search',
      };
    })
    .filter((i: Issue) => i.similarity >= 0.25)
    .sort((a: Issue, b: Issue) => b.similarity - a.similarity)
    .slice(0, limit);
  return { issues };
}

export const DUPLICATE_AT = 0.6;

export function readDevDraft(path: string): { title: string; labels: string[]; body: string; status: string; kind: string } {
  if (!existsSync(path)) throw new Error(`No draft at ${path}`);
  const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error('The draft has no front matter (title, labels)');
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const parse = <T>(v: string | undefined, fallback: T): T => {
    try {
      return v ? (JSON.parse(v) as T) : fallback;
    } catch {
      return (v as T) ?? fallback;
    }
  };
  return { title: String(parse(meta.title, '')), labels: parse(meta.labels, ['development-request']), body: m[2]!, status: meta.status ?? 'draft', kind: meta.kind ?? 'other' };
}

export type SubmitOutcome =
  | { path: string; submitted: true; number: number; url: string; title: string }
  | { path: string; submitted: false; error: { code: string; message: string; recoverable: boolean; next: string[] }; issue_link?: string; duplicates?: Issue[] };

/** Sends one draft: searches again first, refuses a likely duplicate unless confirmed, reports only what the API returned. */
export async function submitDevDraft(path: string, notDuplicateOf: number[] = []): Promise<SubmitOutcome> {
  let draft: ReturnType<typeof readDevDraft>;
  try {
    draft = readDevDraft(path);
  } catch (error) {
    return { path, submitted: false, error: { code: 'no_draft', message: (error as Error).message, recoverable: true, next: ['Draft it first with draft_development_request.'] } };
  }
  const link = issueUrl(draft.title, draft.body, draft.labels);
  if (draft.status === 'submitted') return { path, submitted: false, error: { code: 'already_submitted', message: 'This draft was already sent; its front matter names the issue.', recoverable: false, next: [] } };

  const found = await searchIssues(draft.title, draft.body.split('### User story')[0]);
  const duplicates = found.issues.filter((i) => i.similarity >= DUPLICATE_AT && !notDuplicateOf.includes(i.number));
  if (duplicates.length) {
    return {
      path,
      submitted: false,
      duplicates,
      issue_link: link,
      error: {
        code: 'possible_duplicate',
        message: `Not sent: #${duplicates[0]!.number} "${duplicates[0]!.title}" (${duplicates[0]!.state}) may already ask for this.`,
        recoverable: true,
        next: ['Show the person the issue. If it covers the need, comment there instead. If not, submit again with not_duplicate_of listing those numbers, after saying in the draft how it differs.'],
      },
    };
  }

  const token = await ghToken();
  if (!token) {
    return {
      path,
      submitted: false,
      issue_link: link,
      error: { code: 'github_not_signed_in', message: 'Not sent: no GitHub sign-in (GITHUB_TOKEN, GH_TOKEN or a signed-in gh CLI).', recoverable: true, next: ['Open issue_link to file it by hand, or sign in with `gh auth login` and submit again.'] },
    };
  }
  const res = await github(`/repos/${CORE_REPO}/issues`, { method: 'POST', token, body: { title: draft.title, body: draft.body, labels: draft.labels } });
  if (!res.ok) {
    return {
      path,
      submitted: false,
      issue_link: link,
      error: { code: res.error.code, message: `Not sent. ${res.error.message}`, recoverable: true, next: ['Open issue_link to file it by hand, or check the account can open issues on the repository.'] },
    };
  }
  const created = res.data as { number?: number; html_url?: string; title?: string } | null;
  const number = Number(created?.number);
  const url = String(created?.html_url ?? '');
  if (!Number.isInteger(number) || !url.startsWith('http')) {
    return { path, submitted: false, issue_link: link, error: { code: 'github_failed', message: 'GitHub answered without an issue number; it may or may not have been created.', recoverable: true, next: [`Search ${CORE_REPO} issues for the title before sending again.`] } };
  }
  writeFileSync(path, readFileSync(path, 'utf8').replace(/^status: .*$/m, `status: submitted\nissue: ${url}`));
  return { path, submitted: true, number, url, title: String(created?.title ?? draft.title) };
}
