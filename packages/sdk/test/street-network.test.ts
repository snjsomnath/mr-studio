import assert from 'node:assert/strict';
import { test } from 'node:test';

import { StreetGraph, byHighway, pointsAlong } from '../src/street-network.ts';

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
