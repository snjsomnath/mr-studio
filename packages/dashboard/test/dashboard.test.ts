import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import type { PanelSpec } from '@mrstudio/sdk';

import { clip, formatValue, resolveProps } from '../src/bind.ts';
import { pack } from '../src/pack.ts';
import { GRID, SCREEN, SIZES } from '../src/rules.ts';
import { contrast, STYLE_TOKENS, themeVariables, validateTheme } from '../src/theme.ts';
import { panelReads, validateLayerPanels, validatePage, validatePanel, validateRibbon } from '../src/validate.ts';
import { defineWidget } from '../src/registry.ts';
import { coreWidgets } from '../src/widgets/index.ts';

const json = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const registry = coreWidgets();
const rules = (spec: PanelSpec) => validatePanel(spec, registry).map((issue) => issue.rule);
const stat = (extra: Partial<PanelSpec> = {}, props: Record<string, unknown> = {}): PanelSpec => ({ id: 'a', widget: 'stat', size: 'tile', title: 'Solar now', props: { value: 1, ...props }, ...extra });

test('the shipped examples follow the rules', () => {
  assert.deepEqual(validateLayerPanels(json('../../layers/sunlight/layer.json').panels, registry), []);
  assert.deepEqual(validatePage(json('../examples/energy-page.json'), registry), []);
  assert.deepEqual(validateTheme(json('../examples/light-theme.json')), []);
  assert.deepEqual(validateTheme({}), [], 'the default theme passes its own rules');
});

test('every size fits the grid and no single panel can use up the screen', () => {
  for (const [name, size] of Object.entries(SIZES)) {
    assert.ok(size.cols <= GRID.columns && size.rows <= GRID.rows, name);
    assert.ok(size.reads < SCREEN.reads / 2, name);
  }
  for (const widget of registry.list()) assert.ok(widget.sizes.length > 0, widget.type);
});

test('a panel cannot ask for more than its size holds', () => {
  assert.deepEqual(rules(stat()), []);
  assert.deepEqual(rules(stat({}, { caption: 'so far today', delta: 2 })), []);
  // A chip holds one read: the number. Context needs a tile.
  assert.deepEqual(rules(stat({ size: 'chip' }, { caption: 'so far today' })), ['budget']);
  assert.deepEqual(rules(stat({ size: 'hero' })), ['size'], 'a stat does not come in hero');
  const bars = (count: number, size: PanelSpec['size']): PanelSpec => ({
    id: 'b', widget: 'bars', size, title: 'Bars', props: { items: Array.from({ length: count }, (_, i) => ({ label: `Bar ${i}`, value: i })) },
  });
  assert.deepEqual(rules(bars(6, 'block')), []);
  assert.deepEqual(rules(bars(7, 'block')), ['budget']);
  assert.deepEqual(rules(bars(5, 'wide')), ['budget'], 'a wide panel shows four bars');
  // A list bound to live data is charged in full, whatever arrives.
  assert.equal(panelReads({ id: 'b', widget: 'bars', size: 'tall', title: 'Bars', props: { items: { bind: 'shared.rows' } } }, registry.get('bars')!), 6);
  assert.deepEqual(rules({ id: 'c', widget: 'custom', size: 'tile', title: 'Mine', props: { reads: 4 } }), ['budget']);
});

test('text is held to a length a visitor can take in', () => {
  assert.deepEqual(rules(stat({ title: 'A title that goes on for far longer than a glance allows' })), ['text']);
  assert.deepEqual(rules(stat({ title: undefined })), ['text'], 'every panel needs a title');
  assert.deepEqual(rules(stat({}, { unit: 'kilowatt' })), ['text']);
  assert.deepEqual(rules(stat({}, { value: 'a long value' })), ['text']);
});

test('props follow the widget schema and bindings are checked', () => {
  assert.deepEqual(rules(stat({}, { colour: 'red' })), ['schema']);
  assert.deepEqual(rules(stat({}, { value: undefined })), ['schema']);
  assert.deepEqual(rules(stat({}, { value: { bind: 'shared.solar' } })), []);
  assert.deepEqual(rules(stat({}, { value: { bind: 'window.location' } })), ['binding']);
  assert.deepEqual(rules(stat({}, { unit: { bind: 'shared.unit' } })), ['binding'], 'a unit is not bindable');
  assert.deepEqual(rules({ id: 'x', widget: 'table', size: 'tile', title: 'T' }), ['schema'], 'there is no table widget');
  assert.deepEqual(validateLayerPanels([stat({ at: { col: 1, row: 1 } })], registry).map((i) => i.rule), ['grid'], 'layers do not place panels');
});

test('a hand-made page must fit the grid and the screen', () => {
  const page = (panels: PanelSpec[]) => validatePage({ id: 'p', panels }, registry).map((issue) => issue.rule);
  const at = (id: string, col: number, row: number, extra: Partial<PanelSpec> = {}) => stat({ id, at: { col, row }, ...extra });
  assert.deepEqual(page([at('a', 1, 1), at('b', 4, 1)]), []);
  assert.deepEqual(page([at('a', 1, 1), at('b', 3, 2)]), ['grid'], 'overlap');
  assert.deepEqual(page([at('a', 11, 1)]), ['grid'], 'off the right edge');
  assert.deepEqual(page([stat()]), ['grid'], 'no position');
  // Twelve tiles fit the cells, but not the screen: nine panels is one too many.
  const tiles = Array.from({ length: 9 }, (_, i) => at(`t${i}`, 1 + (i % 4) * 3, 1 + Math.floor(i / 4) * 2));
  assert.deepEqual(page(tiles), ['screen']);
  // Eight panels that each use their whole budget ask for more than a screen holds.
  const heavy = Array.from({ length: 8 }, (_, i) => at(`h${i}`, 1 + (i % 4) * 3, 1 + Math.floor(i / 4) * 2, { props: { value: 1, caption: 'c', delta: 1 } }));
  assert.deepEqual(page(heavy), []);
  const blocks: PanelSpec[] = [1, 7].map((col) => ({ id: `b${col}`, widget: 'custom', size: 'block', title: 'B', at: { col, row: 1 }, props: { reads: 8 } }));
  const strip: PanelSpec = { id: 's', widget: 'custom', size: 'strip', title: 'S', at: { col: 1, row: 5 }, props: { reads: 6 } };
  assert.deepEqual(page([...blocks, strip]), [], '22 reads');
  assert.deepEqual(page([...blocks, { ...strip, size: 'hero', props: { reads: 10 }, at: { col: 1, row: 5 } }]).includes('grid'), true);
});

test('the automatic layout pages instead of squeezing', () => {
  const item = (id: string, size: PanelSpec['size'], reads = 2, priority = 0) => ({ item: id, size, reads, priority });
  const one = pack([item('a', 'tile'), item('b', 'tile'), item('clock', 'band')]);
  assert.equal(one.length, 1);
  assert.deepEqual(one[0]!.panels.map((p) => [p.item, p.col, p.row]), [['a', 1, 1], ['b', 4, 1], ['clock', 1, 6]], 'bands dock at the bottom');

  // Three blocks do not fit 12 by 6; the third goes to a second page at full size.
  const two = pack([item('a', 'block'), item('b', 'block'), item('c', 'block')]);
  assert.deepEqual(two.map((p) => p.panels.map((x) => x.item)), [['a', 'b'], ['c']]);
  assert.deepEqual([two[1]!.panels[0]!.cols, two[1]!.panels[0]!.rows], [6, 4]);

  // The screen's budget makes a page even when cells are free.
  const heavy = pack(Array.from({ length: 10 }, (_, i) => item(`t${i}`, 'tile', 3)));
  assert.deepEqual(heavy.map((p) => p.panels.length), [8, 2]);
  assert.ok(heavy.every((p) => p.reads <= SCREEN.reads && p.panels.length <= SCREEN.panels));

  // Priority decides who gets the first page.
  const ranked = pack([item('low', 'hero'), item('high', 'hero', 2, 5)]);
  assert.equal(ranked[0]!.panels[0]!.item, 'high');
  // Fixed places are kept.
  const fixed = pack([{ item: 'f', size: 'tile' as const, reads: 1, at: { col: 10, row: 5 }, page: 1 }, item('a', 'tile')]);
  assert.deepEqual(fixed.map((p) => p.panels.map((x) => [x.item, x.col, x.row])), [[['a', 1, 1]], [['f', 10, 5]]]);
});

test('a short canvas gets fewer rows, not shorter ones', () => {
  const item = (id: string, size: PanelSpec['size'], reads = 2, priority = 0) => ({ item: id, size, reads, priority });
  // Three rows: two tiles and the colour key still share one page, the key at the bottom.
  const three = pack([item('a', 'tile'), item('b', 'tile'), item('key', 'band')], 3);
  assert.deepEqual(three.map((p) => p.panels.map((x) => [x.item, x.row])), [[['a', 1], ['b', 1], ['key', 3]]]);
  // Two rows: the band waits for the next page.
  assert.deepEqual(pack([item('a', 'tile'), item('key', 'band')], 2).map((p) => p.panels.map((x) => x.item)), [['a'], ['key']]);
  // A panel taller than the canvas is left out rather than squeezed.
  assert.deepEqual(pack([item('chart', 'block'), item('a', 'tile')], 3).map((p) => p.panels.map((x) => x.item)), [['a']]);
  // A site's hand-made pages keep the full grid.
  assert.equal(pack([{ item: 'f', size: 'tile' as const, reads: 1, at: { col: 1, row: 5 }, page: 0 }], 2)[0]!.panels[0]!.row, 5);
});

test('live values are held to the same limits as literals', () => {
  const source = {
    params: { hour: 8.5 },
    shared: { caption: 'x'.repeat(100), rows: Array.from({ length: 20 }, (_, i) => ({ label: `Row ${i}`, value: i })), curve: Array.from({ length: 500 }, (_, i) => i) },
    site: { name: 'Sample' },
  };
  const s = resolveProps(registry.get('stat')!, { value: { bind: 'params.hour' }, caption: { bind: 'shared.caption' } }, 'tile', source);
  assert.equal(s.value, 8.5);
  assert.equal([...s.caption].length, 40);
  assert.ok(s.caption.endsWith('…'));
  assert.equal(resolveProps(registry.get('bars')!, { items: { bind: 'shared.rows' } }, 'tall', source).items.length, 6);
  assert.equal(resolveProps(registry.get('bars')!, { items: { bind: 'shared.rows' } }, 'wide', source).items.length, 4);
  const lines = resolveProps(registry.get('series')!, { series: [{ label: 'A', values: { bind: 'shared.curve' } }] }, 'block', source).series;
  assert.equal(lines[0].values.length, 96);
  assert.equal(resolveProps(registry.get('stat')!, { value: { bind: 'shared.missing' } }, 'tile', source).value, undefined);
  assert.equal(clip('abcdef', 4), 'abc…');
});

test('numbers are short enough to read at a glance', () => {
  assert.equal(formatValue(13.75, { format: 'hour' }), '13:45');
  assert.equal(formatValue(0.456, { format: 'percent' }), '46%');
  assert.equal(formatValue(41.23), '41.2');
  assert.equal(formatValue(7), '7');
  assert.equal(formatValue(1234.56, { decimals: 2 }), '1,235');
  assert.equal(formatValue(123.456, { decimals: 2 }), '123.5');
  assert.equal(formatValue(1234567), '1.2M');
  assert.equal(formatValue(undefined), '–');
  for (const value of [0.001, 9.999, 99.99, 999.9, 9999.4, 12345, 987654321, -4321.5]) {
    assert.ok(formatValue(value, { decimals: 2 }).length <= 6, `${value} -> ${formatValue(value, { decimals: 2 })}`);
  }
});

test('a site can restyle but not break the rules', () => {
  const rulesOf = (theme: Record<string, unknown>) => validateTheme(theme).map((issue) => `${issue.path}:${issue.rule}`);
  assert.deepEqual(rulesOf({ 'color.accent': '#ff5a36', 'font.text': 'Georgia, serif', 'shape.radius': 'none', 'panel.style': 'outlined' }), []);
  // Sizes and the grid are not tokens.
  assert.deepEqual(rulesOf({ 'type.label': '10px' }), ['theme.type.label:schema']);
  assert.deepEqual(rulesOf({ 'grid.columns': '24' }), ['theme.grid.columns:schema']);
  // Grey text on a dark panel is refused.
  assert.deepEqual(rulesOf({ 'color.text': '#4a5060' }), ['theme.color.text:text', 'theme.color.text:text']);
  assert.deepEqual(rulesOf({ 'font.text': 'url(https://example.com/f.woff)' }), ['theme.font.text:schema']);
  assert.ok(contrast('#000000', '#ffffff') > 20.9);

  // A refused colour drops the whole colour set to the default; a good font still applies.
  const { variables } = themeVariables({ 'color.background': '#ffffff', 'font.text': 'Georgia, serif' });
  assert.equal(variables['--mrs-bg'], STYLE_TOKENS['color.background']!.default);
  assert.equal(variables['--mrs-font'], 'Georgia, serif');
  assert.equal(themeVariables(json('../examples/light-theme.json')).variables['--mrs-bg'], '#f3efe6');
});

test('the registry is plain data an editor can read', () => {
  const described = registry.describe();
  assert.deepEqual(described.map((w) => w.type), ['stat', 'bars', 'compare', 'balance', 'series', 'ramp', 'timeline', 'text', 'custom']);
  assert.deepEqual(JSON.parse(JSON.stringify(described)), described);
  for (const widget of described) for (const prop of Object.values(widget.props)) assert.ok(prop.label, `${widget.type} props need labels`);
});

test('a ribbon holds a few small panels (#78)', () => {
  const ribbon = (id: string, size: PanelSpec['size'] = 'tile') => stat({ id, size, ribbon: true });
  assert.deepEqual(validateRibbon([ribbon('a'), ribbon('b', 'chip'), ribbon('c', 'wide')], registry), []);
  assert.deepEqual(validatePanel(ribbon('a'), registry), [], 'ribbon is a panel field');
  assert.deepEqual(validateRibbon([{ ...ribbon('a'), widget: 'series', size: 'strip', props: { values: [] } }], registry).map((i) => i.rule), ['size']);
  assert.deepEqual(validateRibbon(['a', 'b', 'c', 'd', 'e'].map((id) => ribbon(id, 'chip')), registry).map((i) => i.rule), ['budget']);
  const busy = (id: string) => stat({ id, ribbon: true }, { caption: 'Now', delta: 1 });
  assert.deepEqual(validateRibbon(['a', 'b', 'c', 'd'].map(busy), registry).map((i) => i.rule), ['budget'], '12 reads is more than a ribbon holds');
  assert.ok(validateLayerPanels([ribbon('a', 'block')], registry).some((i) => i.path === 'panels.a.size'));
});

test('compare and balance panels fit their sizes, in a ribbon too, and are counted (#281)', async () => {
  const { scenarioChange, selfSufficiency } = await import('../src/widgets/index.ts');
  const scenarios = [
    { label: 'As today', value: { bind: 'shared.today' }, state: 'done' },
    { label: 'Each alone', value: { bind: 'shared.alone' }, state: { bind: 'shared.alone_state' } },
    { label: 'Community', value: { bind: 'shared.community' }, state: { bind: 'shared.community_state' } },
  ];
  const compare = (size: PanelSpec['size'], list = scenarios): PanelSpec => ({ id: 'c', widget: 'compare', size, title: 'Yearly cost', props: { scenarios: list, unit: 'kkr' } });
  assert.deepEqual(rules(compare('wide')), []);
  assert.deepEqual(rules(compare('chip')), []);
  assert.deepEqual(rules(compare('tall')), ['size']);
  assert.equal(panelReads(compare('wide'), registry.get('compare')!), 4);
  assert.equal(panelReads(compare('chip'), registry.get('compare')!), 1);
  assert.deepEqual(rules({ ...compare('wide'), props: { scenarios: [{ label: 'X', state: 'later' }] } }), ['schema']);
  const parts = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `P${i}`, value: i + 1 }));
  const balance = (size: PanelSpec['size'], n = 3): PanelSpec => ({ id: 'b', widget: 'balance', size, title: 'Energy today', props: { sources: parts(n), uses: parts(n), unit: 'kWh' } });
  assert.deepEqual(rules(balance('wide')), []);
  assert.equal(panelReads(balance('wide'), registry.get('balance')!), 3);
  assert.deepEqual(rules(balance('block')), []);
  assert.equal(panelReads(balance('block'), registry.get('balance')!), 7);
  assert.equal(panelReads(balance('chip'), registry.get('balance')!), 1);
  // A ribbon takes the chip and wide forms.
  assert.deepEqual(validateRibbon([{ ...compare('chip'), ribbon: true }, { ...balance('wide'), id: 'b2', ribbon: true }] as PanelSpec[], registry), []);
  // Bindings: a scenario not worked out yet keeps its state; values are numbers or nothing.
  const props = resolveProps(registry.get('compare')!, compare('wide').props, 'wide', { params: {}, shared: { today: 120, alone: 100, alone_state: 'done', community: 'n/a', community_state: 'running' }, site: {} });
  assert.deepEqual(props.scenarios, [
    { label: 'As today', value: 120, state: 'done' },
    { label: 'Each alone', value: 100, state: 'done' },
    { label: 'Community', state: 'running' },
  ]);
  assert.equal(scenarioChange(120, 90), -0.25);
  assert.equal(scenarioChange(undefined, 90), null);
  assert.equal(selfSufficiency([{ label: 'Solar', value: 60 }, { label: 'Grid', value: 40 }], 'Grid'), 0.6);
  assert.equal(selfSufficiency([], 'Grid'), null);
});

test('a layer package brings its own widgets, held to the core contract (#353)', () => {
  const registry = coreWidgets();
  const meter = defineWidget({
    type: 'meter', name: 'Meter', description: 'A level.', sizes: ['chip', 'tile'],
    props: { value: { kind: 'value', label: 'Value', required: true, bindable: true } },
    reads: () => 1,
    mount: () => ({ update() {} }),
  });
  const broken = { type: 'Bad Name', name: '', sizes: ['huge'], props: { x: { kind: 'number' } }, mount: () => ({ update() {} }) };
  const problems = registry.registerTeam('energy', [meter, broken]);
  for (const words of [/lower-case/, /needs a name/, /sizes is a list/, /needs reads/, /prop 'x' needs a label/]) assert.match(problems.join(' | '), words);
  assert.equal(registry.get('energy/meter')?.owner, 'energy');
  assert.equal(registry.get('meter'), undefined);
  // The layer's own panels may name it short; core widgets keep their names.
  assert.equal(registry.find('meter', 'energy')?.type, 'energy/meter');
  assert.equal(registry.find('stat', 'energy')?.type, 'stat');
  assert.equal(registry.find('meter', 'other'), undefined);
  // It counts in the density budget and validates like a core widget.
  assert.deepEqual(validateLayerPanels([{ id: 'm', widget: 'energy/meter', size: 'tile', title: 'Level', props: { value: 3 } }], registry), []);
  assert.ok(validateLayerPanels([{ id: 'm', widget: 'energy/meter', size: 'block', title: 'Level', props: { value: 3 } }], registry).length > 0);
  // A rebuilt layer replaces its widget, and the editor sees who owns it.
  registry.registerTeam('energy', [{ ...meter, name: 'Meter 2' }]);
  assert.equal(registry.get('energy/meter')?.name, 'Meter 2');
  assert.equal(registry.describe().find((w) => w.type === 'energy/meter')?.owner, 'energy');
  assert.deepEqual(registry.registerTeam('energy', undefined), []);
});
