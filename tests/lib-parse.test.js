import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseKmlBuffer } from '../lib-parse.js';

const SAMPLE_KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Test</name>
    <Folder>
      <name>Points Layer</name>
      <Placemark id="p1">
        <name>Alpha</name>
        <ExtendedData>
          <SchemaData>
            <SimpleData name="Code">A1</SimpleData>
          </SchemaData>
        </ExtendedData>
        <Point><coordinates>-98.5,39.8,100</coordinates></Point>
      </Placemark>
    </Folder>
    <Folder>
      <name>Roads Layer</name>
      <Placemark id="l1">
        <name>Main St</name>
        <LineString><coordinates>-98.5,39.8 -98.6,39.9</coordinates></LineString>
      </Placemark>
    </Folder>
  </Document>
</kml>`;

test('parseKmlBuffer: returns correct row count', async () => {
  const buf = Buffer.from(SAMPLE_KML);
  const { rows } = await parseKmlBuffer('test.kml', buf);
  // Point = 1 row, LineString = 2 coordinate tuples = 2 rows
  assert.equal(rows.length, 3);
});

test('parseKmlBuffer: point row has correct fields', async () => {
  const buf = Buffer.from(SAMPLE_KML);
  const { rows } = await parseKmlBuffer('test.kml', buf);
  const point = rows.find(r => r.name === 'Alpha');
  assert.ok(point);
  assert.equal(point.lat, 39.8);
  assert.equal(point.lon, -98.5);
  assert.equal(point.alt, 100);
  assert.equal(point.geometry_type, 'Point');
  assert.equal(point.layer, 'Test / Points Layer');
  assert.equal(point.Code, 'A1');
});

test('parseKmlBuffer: line row has correct geometry_type', async () => {
  const buf = Buffer.from(SAMPLE_KML);
  const { rows } = await parseKmlBuffer('test.kml', buf);
  const line = rows.find(r => r.name === 'Main St');
  assert.ok(line);
  assert.equal(line.geometry_type, 'LineString');
  assert.equal(line.layer, 'Test / Roads Layer');
});

test('parseKmlBuffer: fields inferred correctly', async () => {
  const buf = Buffer.from(SAMPLE_KML);
  const { fields } = await parseKmlBuffer('test.kml', buf);
  const keys = fields.map(f => f.key);
  assert.ok(keys.includes('lat'));
  assert.ok(keys.includes('lon'));
  assert.ok(keys.includes('Code'));
});
