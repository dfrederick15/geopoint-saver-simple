import { test, before, after } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');

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

let serverProcess;
let baseUrl;
const TEST_PORT = 19871;
const TEST_DATA_DIR = '/tmp/geopoint-saver-simple-test';

before(async () => {
  await mkdir(join(TEST_DATA_DIR, 'logs'), { recursive: true });

  serverProcess = spawn(process.execPath, [join(PROJECT_DIR, 'server.js')], {
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      DATA_DIR: TEST_DATA_DIR,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server start timeout')), 8000);
    serverProcess.stdout.on('data', (d) => {
      if (d.toString().includes('listening')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    serverProcess.stderr.on('data', () => {});
    serverProcess.on('error', (err) => { clearTimeout(timeout); reject(err); });
    serverProcess.on('exit', (code) => {
      if (code !== null) { clearTimeout(timeout); reject(new Error(`Server exited with code ${code}`)); }
    });
  });
});

after(() => {
  serverProcess?.kill('SIGTERM');
});

test('GET / returns HTML', async () => {
  const res = await fetch(`${baseUrl}/`);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.toLowerCase().includes('<!doctype html>'));
});

test('POST /inspect returns sessionId, rows, fields, layers', async () => {
  const form = new FormData();
  form.append('files[]', new Blob([SAMPLE_KML], { type: 'application/xml' }), 'test.kml');
  const res = await fetch(`${baseUrl}/inspect`, { method: 'POST', body: form });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.sessionId);
  assert.ok(Array.isArray(data.rows));
  assert.equal(data.rows.length, 1);
  assert.ok(Array.isArray(data.fields));
  assert.ok(Array.isArray(data.layers));
  assert.equal(data.layers[0].key, 'T / Points');
});

test('POST /convert returns a file', async () => {
  const form = new FormData();
  form.append('files[]', new Blob([SAMPLE_KML], { type: 'application/xml' }), 'test.kml');
  const inspectRes = await fetch(`${baseUrl}/inspect`, { method: 'POST', body: form });
  const { sessionId, fields } = await inspectRes.json();

  const convertRes = await fetch(`${baseUrl}/convert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      fieldKeys: fields.map(f => f.key).filter(k => k !== 'placemark_uid'),
      layerKeys: ['T / Points'],
      spatialFilter: null,
      keepCrossingLines: false,
      delimiter: ',',
      precision: 6,
      includeHeader: true,
      combineCsv: false,
      baseName: ''
    })
  });
  assert.equal(convertRes.status, 200);
  const cd = convertRes.headers.get('content-disposition');
  assert.ok(cd && cd.includes('attachment'));
});

test('POST /convert with unknown sessionId returns 404', async () => {
  const res = await fetch(`${baseUrl}/convert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: 'doesnotexist',
      fieldKeys: ['name'], layerKeys: [], spatialFilter: null,
      keepCrossingLines: false, delimiter: ',', precision: 6,
      includeHeader: true, combineCsv: false, baseName: ''
    })
  });
  assert.equal(res.status, 404);
});

test('GET /load returns pct', async () => {
  const res = await fetch(`${baseUrl}/load`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(typeof data.pct === 'number');
});

test('POST /inspect rejects non-KML files', async () => {
  const form = new FormData();
  form.append('files[]', new Blob(['not a kml'], { type: 'text/plain' }), 'test.csv');
  const res = await fetch(`${baseUrl}/inspect`, { method: 'POST', body: form });
  assert.equal(res.status, 400);
});

test('POST /inspect with no files returns 400', async () => {
  const form = new FormData();
  const res = await fetch(`${baseUrl}/inspect`, { method: 'POST', body: form });
  assert.equal(res.status, 400);
});
