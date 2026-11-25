import assert from 'node:assert/strict';
import { test } from 'node:test';

import { StreetGraph, byHighway, pointsAlong, specOptions } from '../src/street-network.ts';
import { buildWalkNetwork, packWalkNetwork, unpackWalkNetwork } from '../src/walk-network.ts';

const line = (points: [number, number][], highway?: string) => ({ geometry: points, properties: highway ? { highway } : {} }) as never;

test('a graph keeps only the classes asked for and leaves out short loose pieces', () => {
  const lines = [line([[0, 0], [300, 0]], 'residential'), line([[300, 0], [300, 300]], 'footway'), line([[500, 500], [510, 500]], 'residential')];
  const graph = new StreetGraph(lines, { include: byHighway(['residential']), shortestPieceM: 100 });
  assert.equal(graph.edges.length, 2);
  assert.equal(graph.length, 300);
});

test('nothing turns round: a dead end has no next edge', () => {
  const graph = new StreetGraph([line([[0, 0], [300, 0]])], { shortestPieceM: 0 });
  assert.equal(graph.next(0, () => 0.5), null);
});

test('points along a line are evenly spaced', () => {
  const points = pointsAlong([[[0, 0], [100, 0]]], 20);
  assert.equal(points.length, 5);
  assert.deepEqual(points[0], [100 / 6, 0]);
});

test('a route follows the streets the short way round (#283)', () => {
  // A square block with a long detour: from the bottom left to the top right corner.
  const line = (...points: [number, number][]) => ({ geometry: points, properties: {} });
  const graph = new StreetGraph(
    [line([0, 0], [100, 0], [100, 100]), line([0, 0], [0, 300], [100, 300], [100, 100]), line([400, 400], [500, 400])],
    { shortestPieceM: 0 },
  );
  assert.deepEqual(graph.route([2, 3], [99, 98]), [[0, 0], [100, 0], [100, 100]]);
  assert.equal(graph.route([0, 0], [450, 401]), null, 'not connected');
});

test('a graph from a spec crosses a worker as typed arrays and comes back the same (#484)', () => {
  const lines = [line([[0, 0], [300, 0]], 'primary'), line([[300, 0], [300, 300]], 'residential'), line([[300, 300], [0, 300]], 'footway')];
  const graph = new StreetGraph(lines, specOptions({ include: { highway: ['primary', 'residential'] }, major: { highway: ['primary'], unclassed: false }, shortestPieceM: 0 }));
  const back = StreetGraph.fromPacked(graph.toPacked());
  assert.deepEqual(back.nodes, graph.nodes);
  assert.deepEqual(back.edges, graph.edges);
  assert.deepEqual(back.out, graph.out);
  assert.equal(back.length, 600);
  assert.equal(back.start(() => 0.1), graph.start(() => 0.1));
  assert.deepEqual(back.route([0, 0], [300, 300]), graph.route([0, 0], [300, 300]));
});

test('a walking network splits at shared vertices and packs without loss (#484)', () => {
  const feature = (...points: [number, number][]) => ({ geometry: { type: 'LineString', coordinates: points } });
  const distance = (a: readonly number[], b: readonly number[]) => Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!);
  const network = buildWalkNetwork({ features: [feature([0, 0], [1, 0], [2, 0]), feature([1, 0], [1, 1])] }, distance);
  assert.equal(network.edges.length, 3);
  const back = unpackWalkNetwork(packWalkNetwork(network), () => ({ pet: 0 }));
  assert.deepEqual(back.nodes, network.nodes);
  assert.deepEqual(back.adjacency, network.adjacency);
  assert.deepEqual(back.edges.map(({ pet, ...e }) => (assert.equal(pet, 0), e)), network.edges);
});
