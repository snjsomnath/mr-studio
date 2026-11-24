import assert from 'node:assert/strict';
import { test } from 'node:test';

import { serviceClient } from '../src/service.ts';

/** A fake host: answers by method and path, and keeps what `kept` is given. */
function host(routes: Record<string, (body?: unknown) => { status?: number; body: unknown; cached?: number }>) {
  const kept = new Map<string, string>();
  const calls: string[] = [];
  const fetch = async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace(/^\/api\/services\/[^/]+/, '');
    calls.push(`${method} ${path}`);
    if (path.startsWith('/kept')) {
      const key = new URL(`http://x${path}`).searchParams.get('key')!;
      if (method === 'PUT') {
        kept.set(key, String(init.body));
        return new Response(null, { status: 204 });
      }
      return kept.has(key) ? new Response(kept.get(key)) : new Response('{}', { status: 404 });
    }
    const route = routes[`${method} ${path}`];
    if (!route) return new Response(JSON.stringify({ error: 'down' }), { status: 503 });
    const answer = route(init.body ? JSON.parse(String(init.body)) : undefined);
    const headers: Record<string, string> = answer.cached ? { 'x-mrs-cached': String(answer.cached) } : {};
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers });
  };
  return { fetch, calls, kept };
}

test('get and post go through the host and say when the answer is a kept one', async () => {
  const fake = host({
    'POST /call/api/mr/layer': (body) => ({ body: { echoed: body } }),
    'GET /call/api/scenarios?x=1': () => ({ body: ['campus'], cached: 1700000000 }),
  });
  const ecom = serviceClient('ecom', { fetch: fake.fetch });
  assert.deepEqual((await ecom.post('/api/mr/layer', { pv: 0.4 })).value, { echoed: { pv: 0.4 } });
  const listed = await ecom.get('api/scenarios?x=1');
  assert.deepEqual(listed.value, ['campus']);
  assert.equal(listed.cached, 1700000000 * 1000);
  await assert.rejects(ecom.get('nothing'), /service 'ecom': down/);
});

test('a job is polled to its end, reports progress, and its result stands in when the service is gone', async () => {
  let polls = 0;
  const fake = host({
    'POST /call/api/optimize': () => ({ body: { job_id: 'j1' } }),
    'GET /call/api/optimize/j1': () => {
      polls += 1;
      return { body: polls < 3 ? { status: 'running', progress: polls * 30, message: 'solving' } : { status: 'completed', result: { saving: 12 } } };
    },
  });
  const ecom = serviceClient('ecom', { fetch: fake.fetch });
  const seen: (number | undefined)[] = [];
  const job = ecom.job<{ saving: number }>('/api/optimize', { days: 2 }, { every_s: 0.2, onProgress: (p) => seen.push(p.progress) });
  assert.deepEqual((await job.result).value, { saving: 12 });
  assert.deepEqual(seen, [0.3, 0.6, undefined]);

  // The service is gone now: the same job gives its last result, marked as kept.
  const gone = serviceClient('ecom', {
    fetch: async (url, init) => (String(url).includes('/kept') ? fake.fetch(url, init) : new Response('{"error":"down"}', { status: 503 })),
  });
  const again = await gone.job<{ saving: number }>('/api/optimize', { days: 2 }).result;
  assert.deepEqual(again.value, { saving: 12 });
  assert.ok(again.cached);
  await assert.rejects(gone.job('/api/optimize', { days: 3 }).result, /down/);
});

test('a failed job says why', async () => {
  const fake = host({
    'POST /call/run': () => ({ body: { job: 'k' } }),
    'GET /call/run/k': () => ({ body: { state: 'failed', error: 'infeasible' } }),
  });
  await assert.rejects(serviceClient('m', { fetch: fake.fetch }).job('run', {}, { every_s: 0.2 }).result, /infeasible/);
});
