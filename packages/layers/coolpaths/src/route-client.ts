// The page's side of CoolPaths' route worker (#492). Without workers (tests, a page that forbids
// them) the same searches run here, as before.
import type { PackedWalkNetwork } from '@mrstudio/sdk';

import { exampleWalk, route } from './network.ts';
import type { Network, RoutePair } from './network.ts';
import type { RouteJob } from './route-worker.ts';

export interface Router {
  /** Sends every edge's sun and PET after they change. */
  heat(): void;
  route(from: number, to: number, detour: number): Promise<RoutePair | null>;
  example(seed: number, min: number, max: number, detour: number, allowed: (node: number) => boolean): Promise<[number, number] | null>;
  stop(): void;
}

export function startRouter(network: Network, packed: PackedWalkNetwork | null): Router {
  let worker: Worker | null = null;
  if (packed && typeof Worker !== 'undefined') {
    try {
      worker = new Worker(new URL('./route-worker.ts', import.meta.url), { type: 'module' });
    } catch {
      worker = null;
    }
  }
  const waiting = new Map<number, { done: (value: any) => void; fail: (error: Error) => void }>();
  let next = 1;
  if (worker && packed) {
    worker.onmessage = ({ data }: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
      const job = waiting.get(data.id);
      waiting.delete(data.id);
      if (data.error) job?.fail(new Error(data.error));
      else job?.done(data.result ?? null);
    };
    worker.onerror = (event) => {
      event.preventDefault?.();
      worker = null;
      for (const job of waiting.values()) job.fail(new Error('the route worker stopped'));
      waiting.clear();
    };
    // A copy: the kept network stays whole for the next start.
    const copy = Object.fromEntries(Object.entries(packed).map(([k, v]) => [k, (v as Float64Array | Uint32Array).slice()])) as unknown as PackedWalkNetwork;
    const send: RouteJob = { kind: 'network', packed: copy };
    worker.postMessage(send, Object.values(copy).map((a) => (a as Float64Array).buffer));
  }
  const ask = <T>(job: RouteJob & { id: number }, here: () => T): Promise<T> => {
    if (!worker) return Promise.resolve(here());
    return new Promise<T>((done, fail) => {
      waiting.set(job.id, { done, fail });
      worker!.postMessage(job);
    }).catch(() => here());
  };
  return {
    heat() {
      if (!worker) return;
      const exposure = new Float64Array(network.edges.length);
      const pet = new Float64Array(network.edges.length);
      network.edges.forEach((edge, i) => {
        exposure[i] = edge.exposure;
        pet[i] = edge.pet;
      });
      const job: RouteJob = { kind: 'heat', exposure, pet };
      worker.postMessage(job, [exposure.buffer, pet.buffer]);
    },
    route: (from, to, detour) => ask({ kind: 'route', id: next++, from, to, detour }, () => route(network, from, to, detour)),
    example(seed, min, max, detour, allowed) {
      const marks = new Uint8Array(network.nodes.length);
      for (let i = 0; i < marks.length; i++) marks[i] = allowed(i) ? 1 : 0;
      return ask({ kind: 'example', id: next++, seed, min, max, detour, allowed: marks }, () => exampleWalk(network, seed, min, max, detour, allowed));
    },
    stop() {
      worker?.terminate();
      worker = null;
    },
  };
}
