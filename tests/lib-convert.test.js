import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowsToCsv, rowsToKml, layerHasLines, applySpatialFilter } from '../lib-convert.js';

const POINT_ROWS = [
  { source: 'f.kml', placemark_id: 'p1', name: 'Alpha', layer: 'L', geometry_type: 'Point',
    placemark_uid: 'f\x00\x001', lat: 39.8, lon: -98.5, alt: null },
  { source: 'f.kml', placemark_id: 'p2', name: 'Beta',  layer: 'L', geometry_type: 'Point',
    placemark_uid: 'f\x00\x002', lat: 40.0, lon: -99.0, alt: null },
];

const LINE_ROWS = [
  { source: 'f.kml', placemark_id: 'l1', name: 'Road', layer: 'R', geometry_type: 'LineString',
    placemark_uid: 'f\x00\x001', lat: 39.8, lon: -98.5, alt: null },
  { source: 'f.kml', placemark_id: 'l1', name: 'Road', layer: 'R', geometry_type: 'LineString',
    placemark_uid: 'f\x00\x001', lat: 39.9, lon: -98.6, alt: null },
];

test('rowsToCsv: produces header and rows', () => {
  const bytes = rowsToCsv(POINT_ROWS, ['name', 'lat', 'lon'], ',', true, 6);
  const text = new TextDecoder().decode(bytes);
  const lines = text.trim().split('\n');
  assert.equal(lines[0], 'name,lat,lon');
  assert.equal(lines[1], 'Alpha,39.800000,-98.500000');
  assert.equal(lines[2], 'Beta,40.000000,-99.000000');
});

test('rowsToCsv: no header when includeHeader=false', () => {
  const bytes = rowsToCsv(POINT_ROWS, ['name'], ',', false, 2);
  const text = new TextDecoder().decode(bytes);
  assert.ok(!text.startsWith('name'));
  assert.ok(text.startsWith('Alpha'));
});

test('layerHasLines: true for LineString rows', () => {
  assert.equal(layerHasLines(LINE_ROWS), true);
});

test('layerHasLines: false for Point rows', () => {
  assert.equal(layerHasLines(POINT_ROWS), false);
});

test('rowsToKml: produces valid KML with LineString', () => {
  const bytes = rowsToKml(LINE_ROWS, 'Roads');
  const text = new TextDecoder().decode(bytes);
  assert.ok(text.includes('<kml '));
  assert.ok(text.includes('<LineString>'));
  assert.ok(text.includes('-98.5,39.8'));
});

test('applySpatialFilter: null filter returns all rows', () => {
  const result = applySpatialFilter(POINT_ROWS, null, false);
  assert.equal(result.length, 2);
});

test('applySpatialFilter: rectangle filter excludes outside points', () => {
  const filter = { type: 'rectangle', bounds: [[39.75, -98.6], [39.85, -98.4]] };
  const result = applySpatialFilter(POINT_ROWS, filter, false);
  // Alpha (39.8, -98.5) is inside; Beta (40.0, -99.0) is outside
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Alpha');
});

test('applySpatialFilter: polygon filter works', () => {
  // Triangle enclosing Alpha
  const filter = {
    type: 'polygon',
    coords: [[39.7, -98.6], [39.9, -98.6], [39.9, -98.4], [39.7, -98.4], [39.7, -98.6]]
  };
  const result = applySpatialFilter(POINT_ROWS, filter, false);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Alpha');
});
