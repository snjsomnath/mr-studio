import assert from 'node:assert/strict';
import { test } from 'node:test';
import { geojsonLines, geojsonPoints, geojsonPolygons, packGeojson, tableSpace, unpackGeometry } from '../src/index.ts';
import type { SiteInfo } from '../src/index.ts';

const site = {
  extent: { width_m: 400, height_m: 200, rotation_deg: 0 },
  corners: [[11.96, 57.69], [11.967, 57.69], [11.967, 57.688], [11.96, 57.688]],
} as unknown as SiteInfo;

const doc = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { name: 'hall' }, geometry: { type: 'Polygon', coordinates: [[[11.961, 57.689], [11.962, 57.689], [11.962, 57.6895], [11.961, 57.689]], [[11.9612, 57.6892], [11.9615, 57.6892], [11.9615, 57.6893], [11.9612, 57.6892]]] } },
    { type: 'Feature', properties: { name: 'two' }, geometry: { type: 'MultiPolygon', coordinates: [[[[11.963, 57.689], [11.964, 57.689], [11.964, 57.6895], [11.963, 57.689]]], [[[11.965, 57.689], [11.966, 57.689], [11.966, 57.6895], [11.965, 57.689]]]] } },
    { type: 'Feature', properties: { kind: 'road' }, geometry: { type: 'MultiLineString', coordinates: [[[11.96, 57.689], [11.967, 57.689]], [[11.961, 57.688]], [[11.962, 57.69], [11.962, 57.688], [11.963, 57.688]]] } },
    { type: 'Feature', properties: { kind: 'tree' }, geometry: { type: 'MultiPoint', coordinates: [[11.9605, 57.6885], [11.9606, 57.6886]] } },
    { type: 'Feature', properties: { kind: 'none' }, geometry: null },
  ],
};

test('packed GeoJSON unpacks to what the geojson helpers give (#263)', () => {
  const space = tableSpace(site);
  const shapes = unpackGeometry(packGeojson(JSON.stringify(doc), site));
  const near = (a: unknown, b: unknown) => assert.deepEqual(JSON.parse(JSON.stringify(a, (_, v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v))), JSON.parse(JSON.stringify(b, (_, v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v))));
  near(shapes.polygons, geojsonPolygons(doc, space));
  near(shapes.lines, geojsonLines(doc, space));
  near(shapes.points, geojsonPoints(doc, space));
  assert.equal(shapes.polygons.length, 3);
  assert.equal(shapes.polygons[0]!.geometry.length, 2, 'the hole stays a second ring');
  assert.equal(shapes.lines.length, 2, 'a line of one corner is left out');
});

test('bytes, text and a parsed document pack the same', () => {
  const bytes = new TextEncoder().encode(JSON.stringify(doc)).buffer as ArrayBuffer;
  assert.deepEqual(unpackGeometry(packGeojson(bytes, site)), unpackGeometry(packGeojson(doc, site)));
  assert.deepEqual(unpackGeometry(packGeojson(null, site)), { polygons: [], lines: [], points: [] });
});
