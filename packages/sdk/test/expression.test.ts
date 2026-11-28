import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compileExpression, evaluateExpression, EXPRESSION_LIMITS, EXPRESSION_OPERATORS, isExpressionValue } from '../src/expression.ts';

const item = { kwh: 1200, area: 400, use: 'school', name: 'Kårhuset', ecom: { kwh: 9 }, empty: '' };
const vars = { params: { year: 2030 }, shared: { import_kw: 12.5 }, site: { name: 'Chalmers' } };
const ev = (expr: unknown) => evaluateExpression(expr, { item, vars });

test('reads properties and live values (#669)', () => {
  assert.equal(ev(['get', 'kwh']), 1200);
  assert.equal(ev(['get', 'ecom.kwh']), 9);
  assert.equal(ev(['get', 'missing']), null);
  assert.equal(ev(['bind', 'shared.import_kw']), 12.5);
  assert.equal(ev(['bind', 'params.year']), 2030);
  assert.equal(ev(['has', 'empty']), false);
  assert.equal(ev(['has', 'kwh']), true);
});

test('arithmetic, and null instead of nonsense', () => {
  assert.equal(ev(['/', ['get', 'kwh'], ['get', 'area']]), 3);
  assert.equal(ev(['/', 1, 0]), null);
  assert.equal(ev(['+', 1, ['get', 'name']]), null);
  assert.equal(ev(['+', 1, '2']), 3);
  assert.equal(ev(['-', 5]), -5);
  assert.equal(ev(['round', 3.14159, 2]), 3.14);
  assert.equal(ev(['clamp', 7, 0, 5]), 5);
  assert.equal(ev(['max', 1, 9, 4]), 9);
});

test('tests, choices and text', () => {
  assert.equal(ev(['>', ['bind', 'params.year'], 2020]), true);
  assert.equal(ev(['==', ['get', 'use'], 'school']), true);
  assert.equal(ev(['==', ['get', 'kwh'], '1200']), true);
  assert.equal(ev(['case', ['>', ['get', 'kwh'], 2000], 'high', ['>', ['get', 'kwh'], 1000], 'mid', 'low']), 'mid');
  assert.equal(ev(['match', ['get', 'use'], ['office', 'shop'], '@cat1', 'school', '@cat2', '@neutral']), '@cat2');
  assert.equal(ev(['match', ['get', 'use'], 'office', 1, 0]), 0);
  assert.equal(ev(['coalesce', ['get', 'missing'], ['get', 'empty'], 'fallback']), 'fallback');
  assert.equal(ev(['concat', ['get', 'name'], ': ', ['get', 'kwh'], ' kWh']), 'Kårhuset: 1200 kWh');
  assert.equal(ev(['in', ['get', 'use'], ['literal', ['school', 'office']]]), true);
  assert.equal(ev(['all', true, ['!', false]]), true);
  assert.equal(ev(['any', false, 0, '']), false);
});

test('interpolate numbers and #rrggbb colours, and steps', () => {
  assert.equal(ev(['interpolate', ['linear'], ['get', 'area'], 0, 0, 800, 10]), 5);
  assert.equal(ev(['interpolate', ['linear'], 400, 0, '#000000', 800, '#ffffff']), '#808080');
  assert.equal(ev(['interpolate', ['linear'], -5, 0, 1, 10, 2]), 1);
  assert.equal(ev(['interpolate', ['linear'], 50, 0, 1, 10, 2]), 2);
  assert.equal(ev(['step', ['get', 'kwh'], 'a', 1000, 'b', 2000, 'c']), 'b');
  assert.equal(ev(['step', 5, 'a', 1000, 'b']), 'a');
});

test('mistakes are reported and evaluate to null, never throw', () => {
  for (const [bad, words] of [
    [['nope', 1], 'not an operator'],
    [['+'], 'takes at least 1'],
    [['get', 1, 2], 'takes 1'],
    [['bind', 'kwh'], 'params.<name>'],
    [['case', true, 1, 2, 3], 'pairs'],
    [['interpolate', ['linear'], 1, 10, 'a', 5, 'b'], 'lowest first'],
    [[1, 2, 3], 'literal'],
    [{ a: 1 }, 'an expression is'],
  ] as [unknown, string][]) {
    const compiled = compileExpression(bad);
    assert.ok(compiled.problems.some((p) => p.includes(words)), `${JSON.stringify(bad)}: ${compiled.problems.join('; ')}`);
    assert.equal(compiled.evaluate({ item, vars }), null);
  }
  // Prototype names are not operators.
  assert.ok(compileExpression(['constructor', 1]).problems.length > 0);
  assert.ok(compileExpression(['__proto__']).problems.length > 0);
});

test('expressions stay small', () => {
  let deep: unknown = 1;
  for (let i = 0; i < EXPRESSION_LIMITS.depth + 2; i++) deep = ['abs', deep];
  assert.ok(compileExpression(deep).problems.some((p) => p.includes('nested')));
  const wide = ['+', ...Array.from({ length: EXPRESSION_LIMITS.nodes + 5 }, () => 1)];
  assert.ok(compileExpression(wide).problems.some((p) => p.includes('parts')));
});

test('what an expression reads, the operators listed, and {expr} values', () => {
  const c = compileExpression(['/', ['get', 'kwh'], ['coalesce', ['get', 'area'], ['bind', 'shared.area']]]);
  assert.deepEqual(c.reads, { properties: ['kwh', 'area'], values: ['shared.area'] });
  assert.ok(Object.keys(EXPRESSION_OPERATORS).length > 30);
  assert.ok(isExpressionValue({ expr: ['get', 'a'] }));
  assert.ok(!isExpressionValue({ expr: 1, other: 2 }));
  assert.ok(!isExpressionValue({ bind: 'shared.a' }));
});

test("a look's own columns and where rule (#669)", async () => {
  const { applyLookExpressions, lookExpressionProblems } = await import('../src/recipe.ts');
  const spot = (properties: Record<string, unknown>) => ({ id: 0, point: { x: 0, y: 0 }, properties }) as never;
  const shapes = { areas: [], paths: [], spots: [spot({ kwh: 1200, area: 400, year: 1990 }), spot({ kwh: 300, area: 300, year: 2015 }), spot({ kwh: 50, area: 0, year: 2020 })] };
  const props = { columns: { per_m2: ['/', ['get', 'kwh'], ['get', 'area']], high: ['>', ['get', 'per_m2'], 2] }, where: ['>=', ['get', 'year'], ['bind', 'params.from']] };
  const out = applyLookExpressions(shapes, props, { params: { from: 2000 } });
  assert.deepEqual(out.spots.map((s: { properties: Record<string, unknown> }) => [s.properties.per_m2, s.properties.high]), [[1, false], [null, false]]);
  assert.equal(applyLookExpressions(shapes, {}), shapes);
  assert.deepEqual(lookExpressionProblems({ id: 'b', block: 'points', props }), []);
  const bad = lookExpressionProblems({ id: 'b', block: 'points', props: { columns: { 'per m2': 1, ok: ['nope'] }, where: ['+'] } });
  assert.equal(bad.length, 3);
});

test('every operator is in docs/contracts/expressions.md', async () => {
  const { readFileSync } = await import('node:fs');
  const doc = readFileSync(new URL('../../../docs/contracts/expressions.md', import.meta.url), 'utf8');
  for (const name of Object.keys(EXPRESSION_OPERATORS)) assert.ok(doc.includes(`| \`${name}\` |`), `docs/contracts/expressions.md lists ${name}`);
});
