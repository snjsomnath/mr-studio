import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildNetwork, distancesFrom, exampleWalk, pointAlongRoute, route, setExposure, snap } from '../src/network.ts';
import type { LonLat } from '../src/network.ts';

// Tests use plain metres as coordinates.
const distance = (a: readonly number[], b: readonly number[]) => Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!);
const line = (...coordinates: number[][]) => ({ geometry: { type: 'LineString', coordinates } });

/**
 * A 100 m square with a middle street:
 *
 *   (0,100) ---- (100,100) ---- (200,100)
 *      |             |              |
 *   (0,0) ------ (100,0) ------ (200,0)
 *
 * The bottom street is one line through (100,0), so it must be split there.
 */
function town() {
  return buildNetwork(
    {
      features: [
        line([0, 0], [100, 0], [200, 0]),
        line([0, 100], [100, 100]),
        line([100, 100], [200, 100]),
        line([0, 0], [0, 100]),
        line([100, 0], [100, 100]),
        line([200, 0], [200, 100]),
      ],
    },
    distance,
  );
}

const at = (network: ReturnType<typeof town>, x: number, y: number) => snap(network, [x, y], distance, 1);

test('lines are split where they share a vertex', () => {
  const network = town();
  assert.equal(network.nodes.length, 6);
  assert.equal(network.edges.length, 7);
  assert.equal(network.adjacency[at(network, 100, 0)]!.length, 3);
  assert.ok(network.edges.every((edge) => edge.length === 100));
});

test('unusable geometry is ignored', () => {
  const network = buildNetwork({ features: [{ geometry: null }, { geometry: { type: 'Point', coordinates: [0, 0] } }, line([0, 0]), line([5, 5], [5, 5])] }, distance);
  assert.equal(network.edges.length, 0);
  assert.equal(snap(network, [0, 0], distance), -1);
  assert.equal(exampleWalk(network, 0, 0, 100, 0.5), null);
});

test('exposure is the sunlit share of each edge', () => {
  const network = town();
  // Sun everywhere east of x = 50.
  setExposure(network, (p) => (p[0] > 50 ? 1 : 0), 5, distance);
  const bottomLeft = network.edges.find((e) => e.coordinates[0]![0] === 0 && e.coordinates[1]![0] === 100 && e.coordinates[0]![1] === 0)!;
  assert.equal(bottomLeft.exposure, 0.5);
  const west = network.edges.find((e) => e.coordinates.every((p) => p[0] === 0))!;
  assert.equal(west.exposure, 0);
});

test('the coolest route detours around the sun, within the limit', () => {
  const network = town();
  // The bottom street is in full sun; everything else is shaded.
  setExposure(network, (p) => (p[1] < 1 ? 1 : 0), 5, distance);
  const [from, to] = [at(network, 0, 0), at(network, 200, 0)];

  const pair = route(network, from, to, 1)!;
  assert.equal(pair.shortest.length, 200);
  assert.equal(pair.shortest.sun, 200);
  assert.equal(pair.coolest.length, 400);
  assert.equal(pair.coolest.sun, 0);
  assert.deepEqual(pair.coolest.coordinates, [[0, 0], [0, 100], [100, 100], [200, 100], [200, 0]]);

  // A 50% limit allows 300 m, and the only cooler route is 400 m.
  const limited = route(network, from, to, 0.5)!;
  assert.equal(limited.coolest, limited.shortest);
  assert.equal(route(network, from, to, 0)!.coolest.length, 200);
});

test('with no sun the shortest route is kept', () => {
  const network = town();
  setExposure(network, () => 0, 5, distance);
  const pair = route(network, at(network, 0, 0), at(network, 200, 100), 1)!;
  assert.equal(pair.coolest, pair.shortest);
  assert.equal(pair.shortest.length, 300);
});

test('unconnected points have no route', () => {
  const network = buildNetwork({ features: [line([0, 0], [10, 0]), line([50, 0], [60, 0])] }, distance);
  assert.equal(route(network, 0, 2, 0.5), null);
  assert.equal(route(network, 0, 0, 0.5), null);
  assert.equal(distancesFrom(network, 0).distance[2], Infinity);
});

test('snapping respects the distance limit', () => {
  const network = town();
  assert.equal(snap(network, [3, 4], distance, 80), at(network, 0, 0));
  assert.equal(snap(network, [500, 500], distance, 80), -1);
});

test('example walks are repeatable and connected', () => {
  const network = town();
  setExposure(network, (p) => (p[1] < 1 ? 1 : 0), 5, distance);
  const first = exampleWalk(network, 3, 150, 400, 1)!;
  assert.deepEqual(exampleWalk(network, 3, 150, 400, 1), first);
  assert.ok(route(network, first[0], first[1], 1));
});

test('a point along a route is interpolated and clamped', () => {
  const path: LonLat[] = [[0, 0], [100, 0], [100, 100]];
  assert.deepEqual(pointAlongRoute(path, 50, distance), [50, 0]);
  assert.deepEqual(pointAlongRoute(path, 150, distance), [100, 50]);
  assert.deepEqual(pointAlongRoute(path, 999, distance), [100, 100]);
  assert.deepEqual(pointAlongRoute(path, -5, distance), [0, 0]);
});
