// Add media sends each file where it belongs (#306), GIS files included (#620).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kindOf, routeOf } from '../src/media.ts';

test('zipped shapefiles and GeoPackages go through the importer as map data', () => {
  for (const file of ['geology.zip', 'Jordarter.GPKG', 'wells.geojson']) {
    assert.equal(routeOf(file), 'dataset', file);
    assert.equal(kindOf(file), 'map', file);
  }
  assert.equal(routeOf('photo.jpg'), 'media');
  assert.equal(routeOf('notes.txt'), null);
});
