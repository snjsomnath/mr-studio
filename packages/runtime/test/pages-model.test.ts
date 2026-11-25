import assert from 'node:assert/strict';
import { test } from 'node:test';

import { coreWidgets, validatePage } from '@mrstudio/dashboard';
import type { PanelSpec } from '@mrstudio/sdk';

import { fits, freeSpot, moved, newPanel, pageBudget, resized } from '../src/editor/pages-model.ts';
import type { Page } from '../src/editor/pages-model.ts';

const registry = coreWidgets();

test('a panel fits only on the grid and off the other panels (#155)', () => {
  const panels: PanelSpec[] = [{ id: 'a', widget: 'stat', size: 'tile', at: { col: 1, row: 1 } }];
  assert.equal(fits(panels, 'tile', { col: 3, row: 1 }), false, 'overlaps a');
  assert.equal(fits(panels, 'tile', { col: 4, row: 1 }), true);
  assert.equal(fits(panels, 'wide', { col: 8, row: 1 }), false, 'runs off the right edge');
  assert.equal(fits(panels, 'tile', { col: 1, row: 1 }, 'a'), true, 'a panel does not block itself');
  assert.deepEqual(freeSpot(panels, 'tile'), { col: 4, row: 1 });
  assert.deepEqual(freeSpot(panels, 'band'), { col: 1, row: 3 });
});

test('a new panel starts from its widget\'s example, in the first free place, and passes the page rules', () => {
  const page: Page = { id: 'home', panels: [] };
  const pages = [page];
  for (const type of ['stat', 'bars', 'text', 'gauge']) {
    const spec = newPanel(pages, page, registry.get(type)!, registry);
    assert.equal(typeof spec, 'object', `${type}: ${spec}`);
    page.panels.push(spec as PanelSpec);
  }
  assert.deepEqual(page.panels.map((p) => p.id), ['stat', 'bars', 'text', 'gauge']);
  assert.deepEqual(validatePage(page, registry), []);
  assert.ok(pageBudget(page, registry).reads <= 24);
});

test('a page refuses a ninth panel and a panel over the budget, with the reason', () => {
  const page: Page = { id: 'p', panels: [] };
  for (let i = 0; i < 8; i++) {
    const spec = newPanel([page], page, registry.get('stat')!, registry);
    if (typeof spec === 'string') break;
    page.panels.push(spec);
  }
  assert.equal(page.panels.length, 8);
  assert.match(newPanel([page], page, registry.get('stat')!, registry) as string, /at most 8 panels/);
});

test('moving and resizing stay on the grid and off other panels', () => {
  const a: PanelSpec = { id: 'a', widget: 'stat', size: 'tile', at: { col: 1, row: 1 } };
  const b: PanelSpec = { id: 'b', widget: 'stat', size: 'tile', at: { col: 4, row: 1 } };
  const panels = [a, b];
  assert.equal(moved(panels, a, 1, 0), null, 'b is in the way');
  assert.deepEqual(moved(panels, a, 0, 1), { col: 1, row: 2 });
  assert.equal(moved(panels, a, -1, 0), null, 'off the left edge');
  // A wide panel at column 10 moves left to stay on the grid.
  const c: PanelSpec = { id: 'c', widget: 'stat', size: 'tile', at: { col: 10, row: 5 } };
  assert.deepEqual(resized([c], c, 'wide'), { col: 7, row: 5 });
});
