// CoolPaths' routing off the page's thread (#492): the shortest and coolest walks, and picking the
// example walk, search the whole walking network, which takes seconds on a city. The page sends the
// network once and every edge's sun and PET when they change; the answers are small.
import { unpackWalkNetwork } from '@mrstudio/sdk/src/walk-network.ts';
import type { PackedWalkNetwork } from '@mrstudio/sdk/src/walk-network.ts';

import { exampleWalk, route } from './network.ts';
import type { Network } from './network.ts';

export type RouteJob =
  | { kind: 'network'; packed: PackedWalkNetwork }
  | { kind: 'heat'; exposure: Float64Array; pet: Float64Array }
  | { kind: 'route'; id: number; from: number; to: number; detour: number }
  | { kind: 'example'; id: number; seed: number; min: number; max: number; detour: number; allowed: Uint8Array };

let network: Network | null = null;

const scope = self as unknown as { onmessage: ((event: MessageEvent<RouteJob>) => void) | null; postMessage(message: unknown): void };
scope.onmessage = ({ data: job }) => {
  if (job.kind === 'network') {
    network = unpackWalkNetwork(job.packed, () => ({ exposure: 0, pet: 0 }));
    return;
  }
  if (job.kind === 'heat') {
    network?.edges.forEach((edge, i) => {
      edge.exposure = job.exposure[i] ?? 0;
      edge.pet = job.pet[i] ?? 0;
    });
    return;
  }
  try {
    if (!network) throw new Error('no network yet');
    if (job.kind === 'route') scope.postMessage({ id: job.id, result: route(network, job.from, job.to, job.detour) });
    else scope.postMessage({ id: job.id, result: exampleWalk(network, job.seed, job.min, job.max, job.detour, (node) => job.allowed[node] === 1) });
  } catch (error) {
    scope.postMessage({ id: job.id, error: (error as Error).message || String(error) });
  }
};
