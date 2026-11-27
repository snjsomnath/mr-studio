// The rules of the editor's layer list (#58, #382, #606), tested apart from the editor (#540).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { LayerManifest, LayerState } from '@mrstudio/sdk';
import { copyPlace, datasetKind, datasetRows, layerRowWords, listParts, railsOf, restRowWords, stackWords } from '../src/editor/layer-list.ts';

const layer = (id: string, category: string, state: Partial<LayerState> = {}) => ({
  id,
  manifest: { id: category, name: id, category } as unknown as LayerManifest,
  state: { layer: category, active: true, params: {}, ...state } as LayerState,
});
const atRest = (m: LayerManifest) => m.category === 'base' || m.category === 'ambient';

test('the scene is sorted into At rest, the layers and their items', () => {
  const scene = [layer('streets', 'base'), layer('sun', 'analysis'), layer('glow', 'ambient'), layer('label', 'analysis', { parent: 'sun' }), layer('wind', 'analysis'), layer('note', 'analysis', { parent: 'sun' })];
  const parts = listParts(scene, atRest);
  assert.deepEqual(parts.rest.map((l) => l.id), ['streets', 'glow']);
  assert.deepEqual(parts.layers.map((l) => l.id), ['sun', 'wind']);
  assert.deepEqual(parts.itemsOf('sun').map((l) => l.id), ['label', 'note']);
  assert.deepEqual(parts.itemsOf('wind'), []);
});

test('an item of a piece of map life is never shown as map life itself', () => {
  const parts = listParts([layer('glow', 'ambient'), layer('spark', 'ambient', { parent: 'glow' })], atRest);
  assert.deepEqual(parts.rest.map((l) => l.id), ['glow']);
});

test('the rails keep the controller order and leave out buttons that are not listed', () => {
  const seats = [
    { id: 'b', side: 'right' as const },
    { id: 'a', side: 'left' as const },
    { id: 'gone', side: 'left' as const },
    { id: 'c', side: 'left' as const },
  ];
  assert.deepEqual(railsOf(seats, [{ id: 'a' }, { id: 'b' }, { id: 'c' }]), { left: ['a', 'c'], right: ['b'] });
});

test('only an item of a glass or a reveal line says its stack', () => {
  assert.equal(stackWords(false, 1), '');
  assert.equal(stackWords(true, 1), 'Stack 1 · surface');
  assert.equal(stackWords(true, 2), 'Stack 2 · underneath');
  assert.equal(stackWords(true, undefined), 'Stack 2 · underneath');
});

test('a dataset says what it is from its file', () => {
  assert.equal(datasetKind('data/streets.GeoJSON').kind, 'Map data');
  assert.equal(datasetKind('data/a.json').kind, 'Data');
  assert.equal(datasetKind('data/a.csv').kind, 'Table');
  assert.equal(datasetKind('data/height.tif').kind, 'Raster');
  assert.equal(datasetKind('data/height.f32').kind, 'Raster');
  assert.equal(datasetKind('media/walk.mov').kind, 'Video');
  assert.equal(datasetKind('plans/plan.svg').icon, 'plan');
  assert.deepEqual(datasetKind('data/model.glb'), { icon: 'layers', kind: 'File' });
});

test('datasets are listed by name, a file of Your place by what it is', () => {
  const rows = datasetRows({ trees: 'data/trees.csv', buildings: 'data/osm/buildings.geojson' }, (name) => (name === 'buildings' ? { name: 'Buildings', icon: 'building' } : undefined));
  assert.deepEqual(rows, [
    { name: 'buildings', path: 'data/osm/buildings.geojson', label: 'Buildings', detail: 'Map data · buildings.geojson', icon: 'building' },
    { name: 'trees', path: 'data/trees.csv', label: 'trees', detail: 'Table · trees.csv', icon: 'grid' },
  ]);
});

test('a row says where its button is and what its eye does', () => {
  const shown = layerRowWords('Sun', 'left', false);
  assert.match(shown.title, /^Sun: a button on the left of the controller\. /);
  assert.equal(shown.eyeLabel, 'Sun on the controller');
  assert.match(shown.eyeTitle, /^On the controller/);
  const hidden = layerRowWords('Sun', 'right', true);
  assert.match(hidden.title, /on the right of the controller, hidden\./);
  assert.match(hidden.eyeTitle, /^Not on the controller/);
  assert.match(restRowWords('Glow', true).eyeTitle, /^Glow shows on the map/);
  assert.match(restRowWords('Glow', false).eyeTitle, /^Glow is off/);
});

test('a layer’s copy goes just below it with its own button; map life and items go on top', () => {
  const state = { layer: 'sun', active: true, params: {}, button: { order: 2, side: 'right' } } as unknown as LayerState;
  assert.deepEqual(copyPlace(['a', 'sun', 'b'], 'sun', 'Sun', state, false), { index: 1, button: { order: 2.5, side: 'right', name: 'Sun copy' } });
  assert.deepEqual(copyPlace(['a', 'glow'], 'glow', 'Glow', state, true), { index: 2 });
  assert.deepEqual(copyPlace(['x', 'y'], 'x', 'Label', { ...state, parent: 'sun' }, false), { index: 1 });
  const long = copyPlace(['s'], 's', 'A very long button name that is nearly full', { layer: 's', active: true, params: {} } as LayerState, false);
  assert.equal(long.button?.name?.length, 40);
  assert.equal(long.button?.order, undefined);
});
