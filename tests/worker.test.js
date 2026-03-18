import { test } from 'node:test';
import assert from 'node:assert/strict';

const WORKER_URL    = process.env.WORKER_URL    || 'http://100.107.68.112:8473';
const WORKER_SECRET = process.env.WORKER_SECRET || '';

const SAMPLE_KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document><name>T</name>
    <Folder><name>Points</name>
      <Placemark id="p1"><name>A</name>
        <Point><coordinates>-98.5,39.8,0</coordinates></Point>
      </Placemark>
    </Folder>
  </Document>
</kml>`;

test('GET /health returns ok and cpu count', async () => {
  const res = await fetch(`${WORKER_URL}/health`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.ok(data.cpus > 0, `Expected cpus > 0, got ${data.cpus}`);
});

test('POST /parse rejects missing secret', async () => {
  const form = new FormData();
  form.append('file', new Blob([SAMPLE_KML]), 'test.kml');
  const res = await fetch(`${WORKER_URL}/parse`, { method: 'POST', body: form });
  assert.equal(res.status, 401);
});

test('POST /parse returns rows and fields for KML', async () => {
  const form = new FormData();
  form.append('file', new Blob([SAMPLE_KML]), 'test.kml');
  const res = await fetch(`${WORKER_URL}/parse`, {
    method: 'POST',
    headers: { 'X-Worker-Secret': WORKER_SECRET },
    body: form
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.rows));
  assert.equal(data.rows.length, 1);
  assert.ok(Array.isArray(data.fields));
  assert.ok(data.fields.some(f => f.key === 'lat'));
});

test('POST /filter returns filtered rows', async () => {
  const rows = [
    { lat: 37.96, lon: -84.51, source: 't', geometry_type: 'Point', placemark_uid: 't\x00\x001' },
    { lat: 40.00, lon: -99.00, source: 't', geometry_type: 'Point', placemark_uid: 't\x00\x002' }
  ];
  const filter = { type: 'rectangle', bounds: [[37.9, -84.6], [38.0, -84.4]] };
  const res = await fetch(`${WORKER_URL}/filter`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Worker-Secret': WORKER_SECRET },
    body: JSON.stringify({ rows, filter, keepCrossingLines: false })
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.rows.length, 1);
  assert.equal(data.rows[0].lat, 37.96);
});

test('POST /filter rejects missing secret', async () => {
  const res = await fetch(`${WORKER_URL}/filter`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows: [], filter: { type: 'rectangle', bounds: [[0,0],[1,1]] } })
  });
  assert.equal(res.status, 401);
});
