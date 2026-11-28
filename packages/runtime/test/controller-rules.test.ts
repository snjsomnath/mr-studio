// The controller's rules that need no browser (#742): which buttons go on which rail, typed
// values, what phones may do, and two layers at once.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isAmbient, isAtRest, parseValue, phoneControl, phoneMaySwitch, railButtons, visibleControls } from '../src/controls.ts';
import type { Store } from '../src/store.ts';
import { canJoin, chosenLayers } from '../src/two-layers.ts';

type Layer = { layer: string; active?: boolean; parent?: string; shown_by?: string; rest?: boolean; button?: { side?: 'left' | 'right'; order?: number; group?: string; hidden?: boolean } };
type Manifest = { id: string; category?: string; alongside?: boolean; combine?: boolean; phone_switch?: boolean };

/** Just enough of a Store: a scene, its layers and their manifests. */
function store(layers: Record<string, Layer>, manifests: Manifest[], tv: Record<string, unknown> = {}): Store {
  const listeners: ((id: string, state: Layer, previous?: Layer) => void)[] = [];
  return {
    state: { scene: Object.keys(layers), layers, site: { tv } },
    manifest: (id: string) => manifests.find((m) => m.id === id),
    onLayer: (listener: (id: string, state: Layer, previous?: Layer) => void) => {
      listeners.push(listener);
      return () => {};
    },
  } as unknown as Store;
}

const analysis = (id: string, extra: Partial<Manifest> = {}): Manifest => ({ id, category: 'analysis', ...extra });

test('base and ambient layers are at rest; a layer marked rest is too, unless it is an item', () => {
  assert.equal(isAmbient({ category: 'base' } as never), true);
  assert.equal(isAmbient({ category: 'analysis' } as never), false);
  assert.equal(isAtRest({ category: 'ambient' } as never, undefined), true);
  assert.equal(isAtRest({ category: 'analysis' } as never, { rest: true } as never), true);
  assert.equal(isAtRest({ category: 'analysis' } as never, { rest: true, parent: 'tour' } as never), false);
});

test('rail buttons: the map at rest and items get none, the rest share both sides', () => {
  const s = store(
    {
      map: { layer: 'basemap' },
      sun: { layer: 'sunlight' },
      wind: { layer: 'wind' },
      rain: { layer: 'stormwater' },
      flood: { layer: 'stormwater', parent: 'rain' },
      paths: { layer: 'coolpaths' },
    },
    [{ id: 'basemap', category: 'base' }, analysis('sunlight'), analysis('wind'), analysis('stormwater'), analysis('coolpaths')],
  );
  const buttons = railButtons(s);
  assert.deepEqual(buttons.map((b) => b.id), ['paths', 'rain', 'wind', 'sun'], 'top of the scene first');
  assert.deepEqual(buttons.map((b) => b.side), ['left', 'left', 'right', 'right'], 'half on each side');
});

test('rail buttons: a placed side stays, groups keep together, order wins, hidden ones go', () => {
  const s = store(
    {
      a: { layer: 'x', button: { group: 'Sim' } },
      b: { layer: 'x', button: { order: 1 } },
      c: { layer: 'x', button: { group: 'Sim' } },
      d: { layer: 'x', button: { side: 'right' } },
      e: { layer: 'x', button: { hidden: true } },
    },
    [analysis('x')],
  );
  const buttons = railButtons(s);
  assert.equal(buttons[0]!.id, 'b', 'order 1 comes first');
  const ids = buttons.map((b) => b.id);
  assert.equal(Math.abs(ids.indexOf('a') - ids.indexOf('c')), 1, 'a group sits together');
  assert.equal(buttons.find((b) => b.id === 'd')!.side, 'right');
  assert.ok(!ids.includes('e'));
  assert.ok(railButtons(s, true).some((b) => b.id === 'e'), 'the editor still lists a hidden one');
});

test('rail buttons: tv.rail puts every unplaced button on one side', () => {
  const s = store({ a: { layer: 'x' }, b: { layer: 'x' }, c: { layer: 'x', button: { side: 'left' } } }, [analysis('x')], { rail: 'right' });
  assert.deepEqual(Object.fromEntries(railButtons(s).map((b) => [b.id, b.side])), { a: 'right', b: 'right', c: 'left' });
});

test('a typed value is read in its unit, as a time of day for hours, inside the range and on its steps', () => {
  const speed = { type: 'range', id: 's', min: 0, max: 20, step: 0.5, unit: 'm/s' } as never;
  assert.equal(parseValue('5.5 m/s', speed), 5.5);
  assert.equal(parseValue('5,5', speed), 5.5);
  assert.equal(parseValue('5.7', speed), 5.5);
  assert.equal(parseValue('99', speed), 20);
  assert.equal(parseValue('windy', speed), null);
  const hour = { type: 'range', id: 'h', min: 0, max: 24, step: 0.25, unit: 'h' } as never;
  assert.equal(parseValue('13:30', hour), 13.5);
  assert.equal(parseValue('9', hour), 9);
});

test('people see all controls but state ones; phones get primary ones unless the layer says', () => {
  const controls = [{ id: 'a', tier: 'primary' }, { id: 'b', tier: 'state' }, { id: 'c' }] as never;
  assert.deepEqual(visibleControls(controls).map((c) => c.id), ['a', 'c']);
  assert.deepEqual(visibleControls(undefined), []);
  assert.equal(phoneControl({ tier: 'primary' }), true);
  assert.equal(phoneControl({ tier: 'secondary' }), false);
  assert.equal(phoneControl({ tier: 'primary', phone: false }), false);
  assert.equal(phoneControl({ phone: true }), true);
});

test('phones may switch layers unless the table, the layer or a running slideshow says no', () => {
  const sun = analysis('sunlight');
  assert.equal(phoneMaySwitch(store({ sun: { layer: 'sunlight' } }, [sun]), sun as never), true);
  assert.equal(phoneMaySwitch(store({ sun: { layer: 'sunlight' } }, [sun], { phone_switch: false }), sun as never), false);
  assert.equal(phoneMaySwitch(store({ sun: { layer: 'sunlight' } }, [sun]), { ...sun, phone_switch: false } as never), false);
  assert.equal(phoneMaySwitch(store({ sun: { layer: 'sunlight', shown_by: 'tour' } }, [sun]), sun as never), false);
});

test('two layers at once: a second joins the open one, not with a layer that fills the table', () => {
  const manifests = [{ id: 'basemap', category: 'base' }, analysis('sunlight'), analysis('wind'), analysis('video', { combine: false }), analysis('ruler', { alongside: true })];
  const layers: Record<string, Layer> = {
    map: { layer: 'basemap', active: true },
    sun: { layer: 'sunlight', active: true },
    wind: { layer: 'wind' },
    film: { layer: 'video' },
    ruler: { layer: 'ruler', active: true },
  };
  const s = store(layers, manifests);
  assert.deepEqual(chosenLayers(s), ['sun'], 'not the map at rest, not a tool kept alongside');
  assert.equal(canJoin(s, 'wind'), true);
  assert.equal(canJoin(s, 'film'), false, 'a layer that will not share the table opens alone');
  assert.equal(canJoin(s, 'sun'), false, 'already open');
  assert.equal(canJoin(store(layers, manifests, { two_layers: false }), 'wind'), false, 'the table allows one');
  assert.equal(canJoin(store({ ...layers, sun: { layer: 'sunlight' } }, manifests), 'wind'), false, 'nothing open to join');
});
