import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import type { EntityFeature, PanelSpec, Position } from '@mrstudio/sdk';

import { clip, formatValue, mainProp, panelIsEmpty, resolveProps } from '../src/bind.ts';
import { pack } from '../src/pack.ts';
import { GRID, SCREEN, SIZES, TEXT } from '../src/rules.ts';
import { contrast, STYLE_TOKENS, themeVariables, validateTheme } from '../src/theme.ts';
import { controlProblems, panelReads, validateLayerPanels, validatePage, validatePanel, validateRibbon, worstCasePanel } from '../src/validate.ts';
import { defineWidget } from '../src/registry.ts';
import { colourFeatures, rampColour, valueOf } from '../src/widgets/map.ts';
import { coreWidgets, donutParts, entityAt, gaugeArc, gaugeShare, mediaUrl } from '../src/widgets/index.ts';
import { parseTemplate, writeValue } from '../src/widgets/text.ts';

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
  assert.deepEqual(described.map((w) => w.type), ['stat', 'gauge', 'bars', 'list', 'donut', 'compare', 'balance', 'control', 'map', 'media', 'legend', 'series', 'ramp', 'timeline', 'text', 'custom']);
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

test('a control panel names one of its layer\'s controls and costs what it shows (#354)', () => {
  const registry = coreWidgets();
  const widget = registry.get('control')!;
  assert.deepEqual(widget.sizes, ['chip', 'tile', 'wide']);
  assert.equal(widget.reads({ control: 'share' }, 'chip'), 1);
  assert.equal(widget.reads({ control: 'share' }, 'wide'), 2);
  assert.deepEqual(validateLayerPanels([{ id: 'c', widget: 'control', size: 'wide', title: 'Share', props: { control: 'share' } }], registry), []);
  assert.ok(validateLayerPanels([{ id: 'c', widget: 'control', size: 'wide', title: 'Share', props: {} }], registry).length > 0);
  assert.deepEqual(controlProblems([{ id: 'c', widget: 'control', size: 'tile', props: { control: 'go' } }, { id: 'd', widget: 'control', size: 'tile', props: { control: 'nope' } }, { id: 's', widget: 'stat', size: 'tile', props: {} }], ['go']), ["panel 'd' names control 'nope', which the layer does not have"]);
});

test('a map panel picks the entity under a tap: an area that holds it, else the nearest point (#355)', () => {
  const square = (id: string, x: number): EntityFeature => ({ id, label: id, geometry: { type: 'Polygon', coordinates: [[[x, 0], [x + 1, 0], [x + 1, 1], [x, 1], [x, 0]]] } });
  const stop: EntityFeature = { id: 'stop', label: 'Stop', geometry: { type: 'Point', coordinates: [10, 10] } };
  const features = [square('a', 0), square('b', 2), stop];
  const project = ([x, y]: Position): [number, number] => [x * 10, y * 10];
  assert.equal(entityAt(features, [2.5, 0.5], project)?.id, 'b');
  assert.equal(entityAt(features, [10.5, 10.5], project)?.id, 'stop');
  assert.equal(entityAt(features, [6, 6], project), undefined);
  const widget = coreWidgets().get('map')!;
  assert.equal(widget.reads({ data: [{ name: 'roads' }, { name: 'buildings' }], hint: 'Tap a building' }, 'block'), 4);
  assert.deepEqual(validateLayerPanels([{ id: 'm', widget: 'map', size: 'block', title: 'Pick a building', props: { data: [{ name: 'roads', slot: 2 }], entities: 'buildings', shapes: { bind: 'shared.route' } } }], coreWidgets()), []);
  assert.ok(validateLayerPanels([{ id: 'm', widget: 'map', size: 'block', title: 'Bad', props: { shapes: 3 } }], coreWidgets()).length > 0);
});

test('gauge, list, donut, picture and legend widgets hold to the budget (#356)', () => {
  const registry = coreWidgets();
  assert.equal(gaugeShare(50, 0, 200), 0.25);
  assert.equal(gaugeShare(500, 0, 200), 1);
  assert.equal(gaugeShare('x', 0, 1), null);
  // The fill is never the large arc, or past half the range it leaves the track (#491).
  for (const share of [0.1, 0.5, 0.62, 0.99, 1]) assert.match(gaugeArc(0, share), / A 40 40 0 0 1 /);
  assert.deepEqual(donutParts([1, 3, -2, undefined]), [{ from: 0, to: 0.25 }, { from: 0.25, to: 1 }, { from: 1, to: 1 }, { from: 1, to: 1 }]);
  assert.equal(mediaUrl('media/plan view.png'), '/site/media/plan%20view.png');
  assert.equal(mediaUrl('../secret.txt'), null);
  assert.equal(mediaUrl('https://example.com/a.png'), null);
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `Row ${i}`, value: i }));
  // A tile list shows three rows; asking for more is over its size.
  assert.deepEqual(validateLayerPanels([{ id: 'l', widget: 'list', size: 'tile', title: 'Busiest', props: { items: rows(3) } }], registry), []);
  assert.ok(validateLayerPanels([{ id: 'l', widget: 'list', size: 'tile', title: 'Busiest', props: { items: rows(5) } }], registry).length > 0);
  assert.deepEqual(validateLayerPanels([{ id: 'g', widget: 'gauge', size: 'chip', title: 'Battery', props: { value: { bind: 'shared.soc' }, max: 1, format: 'percent' } }], registry), []);
  assert.deepEqual(validateLayerPanels([{ id: 'd', widget: 'donut', size: 'wide', title: 'Sources', props: { items: rows(4), headline: 0.4, format: 'percent' } }], registry), []);
  assert.deepEqual(validateLayerPanels([{ id: 'm', widget: 'media', size: 'wide', title: 'The plan', props: { path: 'media/plan.png' } }], registry), []);
  // A legend with no rows of its own reads the layer's.
  assert.deepEqual(validateLayerPanels([{ id: 'k', widget: 'legend', size: 'tall', title: 'Key', props: {} }], registry), []);
});

test('every core widget has an example that passes the rules at every size it takes (#358)', async () => {
  const { coreWidgets } = await import('../src/widgets/index.ts');
  const { examplePanel } = await import('../src/validate.ts');
  const registry = coreWidgets();
  for (const widget of registry.list()) {
    assert.ok(widget.example, `${widget.type} has an example`);
    for (const size of widget.sizes) {
      const issues = validatePanel(examplePanel(widget, size), registry, `${widget.type}.${size}`);
      assert.deepEqual(issues, [], `${widget.type} at ${size}`);
    }
  }
});

test('a map colours its features by data (#374)', () => {
  const slot = (n: number) => `slot${n}`;
  // Numbers follow the ramp from the smallest to the largest value.
  const ramp = colourFeatures({ property: 'h', ramp: ['#000000', '#ffffff'] }, [0, 5, 10, undefined], slot);
  assert.deepEqual(ramp, ['rgb(0 0 0)', 'rgb(128 128 128)', 'rgb(255 255 255)', undefined]);
  assert.equal(rampColour(['#000000', '#ffffff'], 2), 'rgb(255 255 255)', 'clamped');
  assert.match(rampColour('viridis', 0.5), /^rgb\(/);
  // Categories: a slot number or a CSS colour; values not listed get none.
  assert.deepEqual(colourFeatures({ entity: 'use', categories: { a: 2, b: 'red' } }, ['a', 'b', 'c'], slot), ['slot2', 'red', undefined]);
  // Without categories each new value takes the next slot.
  assert.deepEqual(colourFeatures({ property: 'kind' }, ['x', 'y', 'x', true], slot), ['slot1', 'slot2', 'slot1', 'slot3']);
  // Where the value comes from.
  const f = { id: 'b1', props: { kind: 'shop' }, geometry: { type: 'Point', coordinates: [0, 0] } };
  const set = { id: 'buildings', dataset: 'buildings', key: 'id', controls: [{ id: 'use', type: 'select', label: 'Use', default: 'home', options: [] }] } as never;
  assert.equal(valueOf({ property: 'kind' }, f, undefined, undefined, undefined), 'shop');
  assert.equal(valueOf({ entity: 'use' }, f, set, { entities: { buildings: { b1: { use: 'office' } } } }, undefined), 'office');
  assert.equal(valueOf({ entity: 'use' }, { ...f, id: 'b2' }, set, {}, undefined), 'home');
  assert.equal(valueOf({ shared: 'load' }, f, undefined, undefined, { load: { b1: 0.4 } }), 0.4);
});

test('a colour rule names one source (#374)', () => {
  const map = (by: unknown) => rules({ id: 'm', widget: 'map', size: 'block', title: 'Map', props: { fill_by: by } } as PanelSpec);
  assert.deepEqual(map({ entity: 'use' }), []);
  assert.ok(map({ entity: 'use', property: 'kind' }).length > 0);
  assert.ok(map({ property: 'h', ramp: ['#000'] }).length > 0);
});

test('a whole list binds, its items checked as they arrive; bound yes/no and numbers arrive as text (#373)', () => {
  const series = { id: 'day', widget: 'series', size: 'wide', title: 'Today', props: { series: { bind: 'shared.day' }, unit: 'kW' } } as PanelSpec;
  assert.deepEqual(validatePanel(series, registry), []);
  const source = { params: {}, shared: { day: [{ label: 'Solar', values: [1, 2, 3] }, { label: 'Demand' }, { label: 'Third', values: [3] }, { label: 'Fourth', values: [4] }] }, site: {} };
  const lines = resolveProps(registry.get('series')!, series.props, 'wide', source).series as { label: string; values?: number[] }[];
  assert.equal(lines.length, 2, 'held to the list limit: a wide panel draws two lines');
  assert.deepEqual(lines[0], { label: 'Solar', values: [1, 2, 3] });
  assert.equal(lines[1]!.values, undefined, 'an item missing a part leaves it out');
  // A yes/no and a number a layer published as text.
  const flags = defineWidget({
    type: 'flagged', name: 'Flagged', description: 'A test widget', sizes: ['tile'], reads: () => 1, mount: () => ({ update() {} }),
    props: { on: { kind: 'boolean', label: 'On', bindable: true }, n: { kind: 'number', label: 'N', bindable: true } },
  });
  const read = (on: unknown, n: unknown) => resolveProps(flags, { on: { bind: 'shared.on' }, n: { bind: 'shared.n' } }, 'tile', { params: {}, shared: { on, n }, site: {} });
  assert.deepEqual(read('true', '12.5'), { on: true, n: 12.5 });
  assert.deepEqual(read('false', 3), { on: false, n: 3 });
  assert.deepEqual(read('maybe', 'many'), {});
});

test('the worst case of every core widget is still a panel the rules allow (#681)', () => {
  const registry = coreWidgets();
  for (const widget of registry.list()) {
    for (const size of widget.sizes) {
      const spec = worstCasePanel(widget, size);
      assert.deepEqual(validatePanel(spec, registry, `${widget.type}/${size}`), [], `${widget.type}/${size}`);
      assert.ok([...spec.title!].length > TEXT.title - 8, `${widget.type}/${size}: a long title`);
    }
  }
});

test('a bindable prop may be worked out by an expression (#669)', () => {
  const registry = coreWidgets();
  const stat = registry.get('stat')!;
  const spec: PanelSpec = { id: 'per-m2', widget: 'stat', size: 'tile', title: 'Use per m²', props: { value: { expr: ['round', ['/', ['bind', 'shared.kwh'], ['bind', 'site.area']], 1] }, unit: 'kWh/m²' } };
  assert.deepEqual(validatePanel(spec, registry), []);
  const props = resolveProps(stat, spec.props, 'tile', { params: {}, shared: { kwh: 1000 }, site: { area: 300 } });
  assert.equal(props.value, 3.3);
  // Not where a prop cannot be bound, and not a faulty one.
  const bad = validatePanel({ ...spec, props: { value: { expr: ['nope'] }, unit: { expr: 'kWh' } } }, registry);
  assert.ok(bad.some((i) => i.path.endsWith('.value') && i.message.includes('not an operator')));
  assert.ok(bad.some((i) => i.path.endsWith('.unit') && i.message.includes('only props that can be bound')));
  // A faulty expression shows nothing rather than breaking the panel.
  assert.equal(resolveProps(stat, { value: { expr: ['/', 1, 0] } }, 'tile', { params: {}, shared: {}, site: {} }).value, undefined);
});

test('a panel may read a table dataset and reduce it (#670)', () => {
  const registry = coreWidgets();
  const rows = [
    { building: 'Library', year: 2030, kwh: 200 },
    { building: 'School', year: 2030, kwh: 120 },
    { building: 'School', year: 2020, kwh: 90 },
  ];
  let asked = 0;
  const source = { params: { year: 2030 }, shared: {}, site: {}, rows: (name: string) => (asked++, name === 'energy' ? rows : undefined) };
  const total: PanelSpec = { id: 'total', widget: 'stat', size: 'tile', title: 'Energy', props: { value: { data: 'energy', sum: 'kwh', where: ['==', ['get', 'year'], ['bind', 'params.year']] }, unit: 'kWh' } };
  assert.deepEqual(validatePanel(total, registry), []);
  assert.equal(resolveProps(registry.get('stat')!, total.props, 'tile', source).value, 320);
  // Asked again with nothing changed, the result is kept.
  resolveProps(registry.get('stat')!, total.props, 'tile', source);
  assert.equal(resolveProps(registry.get('stat')!, total.props, 'tile', { ...source, params: { year: 2020 } }).value, 90);

  const bars: PanelSpec = { id: 'by', widget: 'bars', size: 'wide', title: 'By building', props: { items: { data: 'energy', sum: 'kwh', group_by: 'building' }, unit: 'kWh' } };
  assert.deepEqual(validatePanel(bars, registry), []);
  assert.deepEqual(resolveProps(registry.get('bars')!, bars.props, 'wide', source).items, [
    { label: 'School', value: 210 },
    { label: 'Library', value: 200 },
  ]);
  // Counted as full for the budget, like a bound list.
  assert.equal(panelReads(bars, registry.get('bars')!), 4);
  // Nothing while the dataset loads.
  assert.equal(resolveProps(registry.get('stat')!, { value: { data: 'other', sum: 'kwh' } }, 'tile', source).value, undefined);

  const bad = validatePanel({ ...bars, props: { items: { data: 'energy', sum: 'kwh' }, unit: { data: 'energy', count: true } } }, registry);
  assert.ok(bad.some((i) => i.path.endsWith('.items') && i.message.includes('needs group_by')));
  assert.ok(bad.some((i) => i.path.endsWith('.unit') && i.message.includes('only props that can be bound')));
  assert.ok(asked >= 2);
});

test('a panel with hideWhenEmpty is left out while its main value is empty (#752)', () => {
  const registry = coreWidgets();
  const stat = registry.get('stat')!;
  const spec: PanelSpec = { id: 'marks', widget: 'stat', size: 'tile', title: 'Marks', hideWhenEmpty: true, props: { value: { bind: 'shared.count' }, caption: 'From the phones' } };
  assert.deepEqual(validatePanel(spec, registry), []);
  assert.equal(mainProp(stat), 'value');
  const source = (count: unknown) => ({ params: {}, shared: { count }, site: {} });
  assert.equal(panelIsEmpty(stat, spec, source(undefined)), true);
  assert.equal(panelIsEmpty(stat, spec, source(0)), true);
  assert.equal(panelIsEmpty(stat, spec, source(3)), false);
  assert.equal(panelIsEmpty(stat, { ...spec, hideWhenEmpty: false }, source(0)), false);
  const bars = registry.get('bars')!;
  assert.equal(mainProp(bars), 'items');
  assert.equal(panelIsEmpty(bars, { size: 'wide', hideWhenEmpty: true, props: { items: { bind: 'shared.rows' } } }, { params: {}, shared: { rows: [] }, site: {} }), true);
  assert.ok(validatePanel({ ...spec, hideWhenEmpty: 'yes' as unknown as boolean }, registry).some((i) => i.path.endsWith('hideWhenEmpty')));
});

test('a text box writes live values into its words (#671)', () => {
  const registry = coreWidgets();
  const widget = registry.get('text')!;
  assert.deepEqual(parseTemplate('**{{kwh}}** today, {{ delta }} more'), [{ slot: 'kwh', bold: true }, { text: ' today, ' }, { slot: 'delta' }, { text: ' more' }]);
  const spec: PanelSpec = {
    id: 'energy-note',
    widget: 'text',
    size: 'tile',
    title: 'Today',
    props: { body: '{{kwh}} today, {{delta}} more than last year', values: [{ name: 'kwh', value: { bind: 'shared.kwh' }, unit: 'kWh' }, { name: 'delta', value: { bind: 'shared.delta' }, format: 'percent' }] },
  };
  assert.deepEqual(validatePanel(spec, registry), []);
  const props = resolveProps(widget, spec.props, 'tile', { params: {}, shared: { kwh: 1234.4, delta: 0.12 }, site: {} });
  assert.equal(writeValue(props.values[0]), '1,234\u00a0kWh');
  assert.equal(writeValue(props.values[1]), '12\u00a0%');
  assert.equal(writeValue({ name: 'x' }), '–');
  // A slot with no value, a value never used, and three values in a tile are all refused.
  const bad = validatePanel({ ...spec, props: { body: '{{kwh}} and {{oops}}', values: [{ name: 'kwh', value: 1 }, { name: 'spare', value: 2 }, { name: 'third', value: 3 }] } }, registry).map((i) => i.message).join(' | ');
  assert.match(bad, /\{\{oops\}\} is not one of its values/);
  assert.match(bad, /'spare' is not used/);
  // Too many words once the values are in: refused, not shrunk.
  const long = validatePanel({ ...spec, props: { body: `${'word '.repeat(23)}{{kwh}}`, values: [{ name: 'kwh', value: 1 }] } }, registry);
  assert.ok(long.some((i) => /text box holds/.test(i.message)));
  // Two values fit a tile's budget, four need a wide box.
  const four = { body: '{{a}} {{b}} {{c}} {{d}}', values: ['a', 'b', 'c', 'd'].map((name) => ({ name, value: 1 })) };
  assert.ok(validatePanel({ ...spec, props: four }, registry).some((i) => i.rule === 'budget'));
  assert.deepEqual(validatePanel({ ...spec, size: 'wide', props: four }, registry), []);
});
