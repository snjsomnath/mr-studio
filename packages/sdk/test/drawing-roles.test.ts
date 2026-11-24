import assert from 'node:assert/strict';
import { test } from 'node:test';

import { phaseNumber, phaseTitle, roleFrame, roleMoves, roleOfName } from '../src/drawing-roles.ts';

test('parts of a drawing are given roles by their names, in English and Swedish', () => {
  // The Chalmers demo's Campus Vision names.
  assert.equal(roleOfName('01_PROJECT BOUNDARY'), 'boundary');
  assert.equal(roleOfName('projektgräns'), 'boundary');
  assert.equal(roleOfName('01_Primary Path'), 'route');
  assert.equal(roleOfName('03_Tertiary Path'), 'route');
  assert.equal(roleOfName('Arrow'), 'arrow');
  assert.equal(roleOfName('04_Points'), 'point');
  assert.equal(roleOfName('Marker'), 'point');
  assert.equal(roleOfName('04_Asterix'), 'node');
  assert.equal(roleOfName('Blob'), 'area');
  assert.equal(roleOfName('Gröna-mötesplatser'), 'area');
  assert.equal(roleOfName('Main axis'), 'axis');
  assert.equal(roleOfName('route'), 'route');
  // Names that say nothing about a role, and words inside other words.
  assert.equal(roleOfName('LEVANDE-CAMPUS'), null);
  assert.equal(roleOfName('Viewpoint 2'), null);
  assert.equal(roleOfName('Artwork 3'), null);
  assert.equal(roleOfName(null), null);
});

test('numbered phase names give their order and a readable title', () => {
  assert.equal(phaseNumber('01_PROJECT BOUNDARY'), 1);
  assert.equal(phaseNumber('04_GREEN MEETING SPACES'), 4);
  assert.equal(phaseNumber('Green spaces'), null);
  assert.equal(phaseTitle('01_PROJECT BOUNDARY'), 'Project boundary');
  assert.equal(phaseTitle('03_HÄLSOFRÄMJANDE-CAMPUS:'), 'Hälsofrämjande campus');
  assert.equal(phaseTitle('Green spaces'), 'Green spaces');
});

test('each role comes in over its phase and has settled when the phase is in', () => {
  for (const role of ['boundary', 'axis', 'route', 'arrow', 'point', 'node', 'area', 'label', 'shape'] as const) {
    const start = roleFrame(role, 0, 0, 0, 3);
    const end = roleFrame(role, 1, 0, 2, 3);
    assert.ok(start.alpha * start.draw * start.scale < 0.05, `${role} starts hidden`);
    assert.ok(end.draw >= 0.999 && end.alpha > 0.8 && end.scale > 0.9, `${role} is in at the end`);
  }
  // Routes come one after another; arrows wait for them.
  assert.ok(roleFrame('route', 0.3, 0, 0, 4).draw > roleFrame('route', 0.3, 0, 3, 4).draw);
  assert.equal(roleFrame('arrow', 0.5, 0).alpha, 0);
  // The boundary marches once drawn; an axis grows from its middle.
  assert.equal(roleFrame('boundary', 0.5, 3).march, null);
  assert.equal(roleFrame('boundary', 1, 3).march, 3);
  assert.equal(roleFrame('axis', 0.5, 0).from, 'middle');
  assert.ok(roleMoves('point') && !roleMoves('label'));
});
