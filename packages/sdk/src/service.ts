// A site's outside compute (#278), reached through the host: `ctx.service('ecom')`.
// The host starts the service, forwards to it from this computer only, and keeps each good
// answer, so a table whose service is down still shows the last answer to the same request.
// Contract in docs/contracts/site.md, "Services".

/** What a service call gave back. */
export interface ServiceAnswer<T = unknown> {
  value: T;
  /** Set when the service could not answer and this is the answer it gave before: when, in ms since 1970. */
  cached?: number;
}

/** A long run (an optimiser): its progress, its result, and a way to stop waiting. */
export interface ServiceJob<T = unknown> {
  readonly result: Promise<ServiceAnswer<T>>;
  cancel(): void;
}

export interface JobProgress {
  /** 0..1 when the service says, else undefined. */
  progress?: number;
  /** What the service says it is doing. */
  message?: string;
  state: string;
}

export interface JobOptions {
  /** Called on every poll. */
  onProgress?(progress: JobProgress): void;
  /** Seconds between polls. Default 1. */
  every_s?: number;
}

export interface ServiceClient {
  readonly id: string;
  get<T = unknown>(path: string): Promise<ServiceAnswer<T>>;
  post<T = unknown>(path: string, body: unknown): Promise<ServiceAnswer<T>>;
  /**
   * Starts a job: POSTs `body` to `path`, which answers `{ "job": "<id>" }` (or `job_id`), then
   * polls `GET <path>/<id>` until it says `state` (or `status`) `done` / `completed` / `failed`,
   * with `progress` (0..1) and `message` on the way and `result` at the end. ECOM's
   * `/api/optimize` works this way. The finished result is kept by the host, so when the service
   * cannot be reached the same job's last result is given instead.
   */
  job<T = unknown>(path: string, body: unknown, options?: JobOptions): ServiceJob<T>;
  /** Whether the service is up, starting, installing, down or remote, and why. */
  status(): Promise<{ state: string; message?: string } | undefined>;
}

export class ServiceError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const DONE = new Set(['done', 'completed', 'complete', 'finished', 'succeeded', 'success']);
const FAILED = new Set(['failed', 'error', 'cancelled', 'canceled']);

/** The client for one of the site's services. `base` is the host's address (empty on the host's own pages). */
export function serviceClient(id: string, options: { base?: string; fetch?: Fetch } = {}): ServiceClient {
  const base = `${options.base ?? ''}/api/services/${encodeURIComponent(id)}`;
  const go: Fetch = options.fetch ?? ((url, init) => fetch(url, init));
  const tidy = (path: string) => path.replace(/^\/+/, '');

  async function call<T>(method: string, path: string, body?: unknown): Promise<ServiceAnswer<T>> {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { 'Content-Type': 'application/json' };
    }
    const answer = await go(`${base}/call/${tidy(path)}`, init);
    const text = await answer.text();
    let value: unknown = text;
    try {
      value = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON: the text as it is.
    }
    if (!answer.ok) {
      const why = (value as { error?: string; detail?: string } | null)?.error ?? (value as { detail?: string } | null)?.detail ?? `${answer.status}`;
      throw new ServiceError(`service '${id}': ${why}`, answer.status);
    }
    const cached = answer.headers.get('x-mrs-cached');
    return cached ? { value: value as T, cached: Number(cached) * 1000 } : { value: value as T };
  }

  async function kept<T>(key: string): Promise<T | undefined> {
    const answer = await go(`${base}/kept?key=${encodeURIComponent(key)}`).catch(() => undefined);
    return answer?.ok ? ((await answer.json()) as T) : undefined;
  }

  async function keep(key: string, value: unknown): Promise<void> {
    await go(`${base}/kept?key=${encodeURIComponent(key)}`, { method: 'PUT', body: JSON.stringify(value) }).catch(() => undefined);
  }

  return {
    id,
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body),
    job<T>(path: string, body: unknown, opts: JobOptions = {}): ServiceJob<T> {
      let cancelled = false;
      let jobId: string | undefined;
      const key = `job ${tidy(path)} ${JSON.stringify(body)}`;
      const result = (async (): Promise<ServiceAnswer<T>> => {
        let started: ServiceAnswer<Record<string, unknown>>;
        try {
          started = await call<Record<string, unknown>>('POST', path, body);
        } catch (error) {
          const last = await kept<{ value: T; at: number }>(key);
          if (last) return { value: last.value, cached: last.at };
          throw error;
        }
        const given = started.value?.job ?? started.value?.job_id ?? started.value?.id;
        // A service that answers straight away is a job that finished at once.
        if (given === undefined || started.cached) return started as unknown as ServiceAnswer<T>;
        jobId = String(given);
        const every = Math.max(0.2, opts.every_s ?? 1) * 1000;
        for (;;) {
          if (cancelled) throw new ServiceError(`service job ${jobId}: cancelled`, 499);
          await new Promise((resolve) => setTimeout(resolve, every));
          const polled = (await call<Record<string, unknown>>('GET', `${tidy(path)}/${encodeURIComponent(jobId)}`)).value ?? {};
          const state = String(polled.state ?? polled.status ?? 'running').toLowerCase();
          const progress = typeof polled.progress === 'number' ? Math.max(0, Math.min(1, polled.progress > 1 ? polled.progress / 100 : polled.progress)) : undefined;
          opts.onProgress?.({ state, progress, message: typeof polled.message === 'string' ? polled.message : undefined });
          if (FAILED.has(state)) throw new ServiceError(`service job ${jobId}: ${String(polled.error ?? polled.message ?? state)}`, 500);
          if (DONE.has(state)) {
            const value = (polled.result ?? polled) as T;
            await keep(key, { value, at: Date.now() });
            return { value };
          }
        }
      })();
      return {
        result,
        cancel() {
          cancelled = true;
          if (jobId !== undefined) void go(`${base}/call/${tidy(path)}/${encodeURIComponent(jobId)}`, { method: 'DELETE' }).catch(() => undefined);
        },
      };
    },
    async status() {
      const answer = await go(`${options.base ?? ''}/api/services`).catch(() => undefined);
      if (!answer?.ok) return undefined;
      const page = (await answer.json()) as { services: { id: string; state: string; message?: string }[] };
      return page.services.find((s) => s.id === id);
    },
  };
}

/** What a layer publishes as `busy` for the controller to show while a service works. */
export interface BusyState {
  label: string;
  /** 0..1, or absent while the service does not say. */
  progress?: number;
}
