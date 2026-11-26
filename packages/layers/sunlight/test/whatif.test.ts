import assert from 'node:assert/strict';
import { test } from 'node:test';

import { editFromTool, editShapes } from '../src/whatif.ts';

const ring = [[11.97, 57.7], [11.971, 57.7], [11.971, 57.701], [11.97, 57.7]];

test("a phone's drawings and taps become scene changes", () => {
  assert.deepEqual(editFromTool({ tool: 'addBuilding', geometry: { type: 'Polygon', coordinates: [ring] } as never }, 22), {
    kind: 'building',
    outline: ring,
    height_m: 22,
  });
  assert.deepEqual(editFromTool({ tool: 'plantTree', geometry: { type: 'Point', coordinates: [11.97, 57.7] } as never }, 22), {
    kind: 'tree',
    at: [11.97, 57.7],
    radius_m: 4,
    height_m: 10,
  });
  assert.deepEqual(editFromTool({ tool: 'remove', geometry: { type: 'Point', coordinates: [11.97, 57.7] } as never }, 22), { kind: 'remove', at: [11.97, 57.7] });
  // The spot tool and odd shapes are not changes.
  assert.equal(editFromTool({ tool: 'spot', geometry: { type: 'Point', coordinates: [11.97, 57.7] } as never }, 22), null);
  assert.equal(editFromTool({ tool: 'addBuilding', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] } as never }, 22), null);
});

test('the table draws new buildings and trees filled and removals as a mark', () => {
  const shapes = editShapes([
    { kind: 'building', outline: [[0, 0], [1, 0], [1, 1]], height_m: 10 },
    { kind: 'tree', at: [11.97, 57.7], radius_m: 4, height_m: 10 },
    { kind: 'remove', at: [11.97, 57.7] },
  ]);
  const building = shapes[0]!.geometry as { type: string; coordinates: number[][][] };
  assert.equal(building.type, 'Polygon');
  assert.deepEqual(building.coordinates[0]!.at(-1), [0, 0], 'the outline is closed');
  const crown = (shapes[1]!.geometry as { coordinates: number[][][] }).coordinates[0]!;
  // About 4 m east of the trunk at this latitude.
  assert.ok(Math.abs((crown[0]![0]! - 11.97) * 111_320 * Math.cos((57.7 * Math.PI) / 180) - 4) < 0.05);
  assert.equal(shapes[2]!.geometry.type, 'Point');
  assert.notEqual(shapes[0]!.colour, shapes[2]!.colour);
});
