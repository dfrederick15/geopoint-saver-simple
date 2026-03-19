/*
  server.js — GeoPoint Saver Simple Express server
*/

import express from 'express';
import { rateLimit } from 'express-rate-limit';
import multer from 'multer';
import { randomUUID, randomBytes, createHash, createECDH, hkdfSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, rm, readdir } from 'node:fs/promises';
import { appendFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

import { parseKmlBuffer, parsePolygonFromKmlBuffer } from './lib-parse.js';
import { rowsToCsv, rowsToKml, combineCsv, layerHasLines, applySpatialFilter } from './lib-convert.js';
import { ZipWriter } from './lib-zip.js';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || '/opt/geopoint-saver-simple';
const LOG_FILE = join(DATA_DIR, 'logs', 'access.log');

const app  = express();
const PORT = process.env.PORT || 3001;

const ADMIN_PROXY_SECRET = process.env.ADMIN_PROXY_SECRET || '';

app.set('trust proxy', 1);

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(express.json({ limit: '55mb' }));

// ── In-memory log store (replaces Redis access_log) ──────────────────────────

const recentLogs = [];       // last 1000 entries, in-memory
const logStats = { inspects: 0, ok: 0, errors: 0 };
let logSeq = 0;
let conversionCount = 0;

/**
 * Seed the in-memory log ring-buffer from the on-disk access.log at startup,
 * so the admin log viewer shows historical entries immediately after a restart.
 * Reads the last 1000 lines; silently ignores missing or malformed files.
 */
async function loadRecentLogs() {
  try {
    const text = await readFile(LOG_FILE, 'utf8');
    const lines = text.trim().split('\n').filter(Boolean);
    const last = lines.slice(-1000);
    for (const line of last) {
      try {
        const entry = JSON.parse(line);
        recentLogs.push(entry);
        if (entry.status === 'inspect') logStats.inspects++;
        else if (entry.status === 'ok') logStats.ok++;
        else if (entry.status === 'error') logStats.errors++;
        if (entry.id > logSeq) logSeq = entry.id;
      } catch {}
    }
  } catch {}
}
loadRecentLogs().catch(() => {});

// ── Session-scoped E2E crypto ──────────────────────────────────────────────────

// cryptoSessions: sid → { key: Buffer<32>, createdAt: ms }
const cryptoSessions = new Map();
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000; // 2 h TTL
  for (const [sid, s] of cryptoSessions)
    if (s.createdAt < cutoff) cryptoSessions.delete(sid);
}, 60_000);

/** Convert a JWK P-256 public key to an uncompressed 65-byte EC point (0x04 || x || y). */
function jwkToPoint(jwk) {
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  return Buffer.concat([Buffer.from([0x04]), x, y]);
}
/** Convert an uncompressed 65-byte EC point back to a JWK public key object. */
function pointToJwk(pt) {
  return { kty: 'EC', crv: 'P-256', x: pt.subarray(1, 33).toString('base64url'), y: pt.subarray(33, 65).toString('base64url') };
}

/**
 * AES-256-GCM encrypt. Returns { iv, ct } as base64 strings.
 * The 16-byte auth tag is appended to the ciphertext before encoding.
 */
function cryptoEncrypt(key, plaintext) {
  const iv     = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct     = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return { iv: iv.toString('base64'), ct: Buffer.concat([ct, tag]).toString('base64') };
}
/**
 * AES-256-GCM decrypt. Expects the last 16 bytes of ct64 to be the auth tag.
 * Throws if the tag does not verify (tampered ciphertext).
 */
function cryptoDecrypt(key, iv64, ct64) {
  const iv        = Buffer.from(iv64, 'base64');
  const ctWithTag = Buffer.from(ct64, 'base64');
  const tag       = ctWithTag.subarray(ctWithTag.length - 16);
  const ct        = ctWithTag.subarray(0, ctWithTag.length - 16);
  const decipher  = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// POST /crypto-init — ECDH key exchange
app.post('/crypto-init', express.json({ limit: '10kb' }), (req, res) => {
  try {
    const clientPubJwk = req.body?.publicKey;
    if (!clientPubJwk?.x || !clientPubJwk?.y) return res.status(400).json({ error: 'Invalid public key.' });

    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();

    const sharedSecret = ecdh.computeSecret(jwkToPoint(clientPubJwk));
    const aesKey = hkdfSync('sha256', sharedSecret, Buffer.alloc(32), 'geopoint-saver-v1', 32);

    const sid = randomBytes(16).toString('hex');
    cryptoSessions.set(sid, { key: aesKey, createdAt: Date.now() });

    res.json({ publicKey: pointToJwk(ecdh.getPublicKey()), sid });
  } catch { res.status(500).json({ error: 'Key exchange failed.' }); }
});

// Middleware: decrypt incoming bodies + encrypt outgoing responses
app.use((req, res, next) => {
  const sid = req.headers['x-crypto-sid'] || req.body?.sid;
  const session = sid && cryptoSessions.get(sid);
  if (!session) return next();
  req.cryptoSid = sid;

  // Wrap res.end to encrypt all outgoing data
  const _end = res.end.bind(res);
  res.end = function (data, encoding, callback) {
    if (!Buffer.isBuffer(data) || data.length === 0) return _end(data, encoding, callback);
    const ct = (res.getHeader('Content-Type') || '').toString();
    let payload;
    if (ct.startsWith('application/json')) {
      payload = data; // already serialised JSON — encrypt as-is
    } else {
      // Binary (zip/csv/kml) — wrap in an envelope
      payload = Buffer.from(JSON.stringify({
        _binary: true,
        contentType:        ct,
        contentDisposition: (res.getHeader('Content-Disposition') || '').toString(),
        data:               data.toString('base64'),
      }), 'utf8');
      res.setHeader('Content-Type', 'application/json');
      res.removeHeader('Content-Disposition');
    }
    const enc = cryptoEncrypt(session.key, payload);
    return _end(Buffer.from(JSON.stringify({ _enc: true, ...enc })), encoding, callback);
  };

  // Decrypt incoming body if encrypted
  if (req.body?._enc) {
    try {
      const plain = cryptoDecrypt(session.key, req.body.iv, req.body.ct);
      const inner = JSON.parse(plain.toString('utf8'));
      req.originalContentType = inner.contentType;
      req.body = inner.data;
    } catch { return res.status(400).json({ error: 'Decryption failed.' }); }
  }

  next();
});

/**
 * Wrap a multer middleware to also handle pre-decrypted FormData payloads.
 * When a request body carries _type:'formdata' (set by the crypto middleware
 * after decrypting an E2E-encrypted upload), multer is skipped and req.files
 * is reconstructed from the already-decoded base64 parts array.
 */
function smartUpload(multerMw) {
  return (req, res, next) => {
    if (req.body?._type === 'formdata') {
      req.files = (req.body.parts || [])
        .filter(p => p.filename)
        .map(p => ({
          originalname: p.filename,
          mimetype:     p.mimeType,
          buffer:       Buffer.from(p.data, 'base64'),
          size:         Buffer.byteLength(Buffer.from(p.data, 'base64')),
        }));
      req.file = req.files[0] || null;
      req.body = {};
      return next();
    }
    multerMw(req, res, next);
  };
}

// ── Security headers ──────────────────────────────────────────────────────────

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  // Admin pages use inline scripts (localhost-only, so unsafe-inline is acceptable)
  const scriptSrc = req.path.startsWith('/admin') ? "'self' 'unsafe-inline'" : "'self'";
  res.setHeader('Content-Security-Policy',
    `default-src 'self'; script-src ${scriptSrc}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.tile.openstreetmap.org; connect-src 'self'`);
  next();
});

// ── Rate limiting ─────────────────────────────────────────────────────────────

const inspectLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

const convertLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

// ── Server load ───────────────────────────────────────────────────────────────

app.get('/load', (req, res) => {
  const cpus = os.cpus().length || 1;
  const pct  = Math.min(Math.round((os.loadavg()[0] / cpus) * 100), 999);
  res.json({ pct });
});

// ── Admin (localhost + Tailscale only) ─────────────────────────────────────────────────────

function isPrivilegedIp(req) {
  // Allow requests forwarded through the reverse proxy with the admin secret header
  if (ADMIN_PROXY_SECRET && req.headers['x-admin-proxy-secret'] === ADMIN_PROXY_SECRET) return true;
  const raw = req.socket.remoteAddress || '';
  const ip  = raw.replace(/^::ffff:/, '');
  if (ip === '127.0.0.1' || ip === '::1') return true;
  // Tailscale CGNAT range: 100.64.0.0/10
  const parts = ip.split('.');
  if (parts.length === 4) {
    const a = parseInt(parts[0], 10);
    const b = parseInt(parts[1], 10);
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  return false;
}

// ── Logging ───────────────────────────────────────────────────────────────────

const logClients = new Set();

/**
 * Append a structured log entry to the in-memory ring-buffer and the on-disk
 * JSONL access.log, then push it to any connected SSE log-stream clients.
 * Non-fatal: errors are swallowed so a logging failure never breaks a request.
 */
async function writeLog(entry) {
  try {
    logSeq++;
    const doc = { id: logSeq, ts: entry.ts || new Date().toISOString(), ...entry };
    recentLogs.push(doc);
    if (recentLogs.length > 1000) recentLogs.shift();
    if (doc.status === 'inspect') logStats.inspects++;
    else if (doc.status === 'ok') logStats.ok++;
    else if (doc.status === 'error') logStats.errors++;
    await mkdir(join(DATA_DIR, 'logs'), { recursive: true });
    await appendFile(LOG_FILE, JSON.stringify(doc) + '\n');
    // Push to SSE clients
    const msg = `data: ${JSON.stringify(doc)}\n\n`;
    for (const r of logClients) { try { r.write(msg); } catch { logClients.delete(r); } }
  } catch { /* non-fatal */ }
}

app.get('/admin/data', async (req, res) => {
  if (!isPrivilegedIp(req)) return res.status(403).end();
  const now = Date.now();
  const activeSessions = [...sessions.entries()].map(([id, s]) => ({
    id: id.slice(0, 8),
    ip: s.ip || '—',
    userId: s.userId ? s.userId.slice(0, 8) : '—',
    files: s.files || [],
    ageMs: now - s.createdAt,
  }));
  const cpus = os.cpus().length || 1;
  const load = os.loadavg();
  res.json({
    ts: new Date().toISOString(),
    uptime: process.uptime(),
    load: {
      '1m':  (load[0] / cpus * 100).toFixed(1),
      '5m':  (load[1] / cpus * 100).toFixed(1),
      '15m': (load[2] / cpus * 100).toFixed(1),
    },
    activeSessions,
    conversionsThisRun: conversionCount,
    apacheLogs: '',
    submissions: [],
    logStats,
  });
});

app.get('/admin', (req, res) => {
  if (!isPrivilegedIp(req)) return res.status(403).end();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(HOME_HTML);
});

app.get('/admin/stats', (req, res) => {
  if (!isPrivilegedIp(req)) return res.status(403).end();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(ADMIN_HTML);
});

// ── Live log streaming ────────────────────────────────────────────────────────

app.get('/admin/logs/stream', (req, res) => {
  if (!isPrivilegedIp(req)) return res.status(403).end();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  // Send recent history
  const tail = Math.min(parseInt(req.query.tail || '200', 10), 1000);
  const history = recentLogs.slice(-tail);
  for (const row of history) res.write(`data: ${JSON.stringify(row)}\n\n`);
  logClients.add(res);
  req.on('close', () => logClients.delete(res));
});

app.get('/admin/logs', (req, res) => {
  if (!isPrivilegedIp(req)) return res.status(403).end();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(LOGS_HTML);
});

const HOME_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Admin \u2014 GeoPoint</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#050a0f;color:#b8c8d8;font-family:'Courier New',monospace;font-size:13px;line-height:1.5;min-height:100vh}
h1{font-size:16px;letter-spacing:.1em;text-transform:uppercase;color:#00e5ff;padding:16px 20px;border-bottom:1px solid #1a2a3a}
.wrap{max-width:900px;margin:0 auto;padding:40px 20px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px;margin-top:32px}
.card{display:flex;flex-direction:column;background:#0a1520;border:1px solid #1a2a3a;padding:24px;text-decoration:none;color:inherit;transition:border-color .15s}
.card:hover{border-color:#00e5ff}
.card-icon{font-size:28px;margin-bottom:14px}
.card-title{font-size:13px;letter-spacing:.1em;text-transform:uppercase;color:#00e5ff;margin-bottom:8px}
.card-desc{font-size:12px;color:#6a8898;line-height:1.6}
.sub{color:#6a8898;font-size:12px;padding:12px 20px 0}
</style>
</head>
<body>
<h1>GeoPoint \u2014 Admin</h1>
<div class="wrap">
  <div class="grid">
    <a class="card" href="/admin">
      <div class="card-icon">\u{1F4E1}</div>
      <div class="card-title">Live Logs</div>
      <div class="card-desc">Real-time access log stream with filtering and column controls.</div>
    </a>
    <a class="card" href="/admin/stats">
      <div class="card-icon">\u{1F4CA}</div>
      <div class="card-title">Stats &amp; Sessions</div>
      <div class="card-desc">Active sessions, server load, and log stats.</div>
    </a>
  </div>
</div>
</body>
</html>`;

const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>GeoPoint Admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#050a0f;color:#b8c8d8;font-family:'Courier New',monospace;font-size:13px;line-height:1.5}
h1{font-size:16px;letter-spacing:.1em;text-transform:uppercase;color:#00e5ff;padding:16px 20px;border-bottom:1px solid #1a2a3a}
h2{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#8ab8cc;margin-bottom:10px}
.wrap{max-width:1400px;margin:0 auto;padding:20px;display:grid;gap:20px;grid-template-columns:1fr 1fr}
.full{grid-column:1/-1}
.card{background:#0a1520;border:1px solid #1a2a3a;padding:16px}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;color:#8ab8cc;padding:4px 8px;border-bottom:1px solid #1a2a3a;font-weight:normal;letter-spacing:.06em;text-transform:uppercase}
td{padding:4px 8px;border-bottom:1px solid #0f1e2e;vertical-align:top;word-break:break-all}
tr:hover td{background:#0f1e2e}
.stat{display:inline-block;padding:10px 20px;border:1px solid #1a2a3a;margin:0 10px 10px 0}
.stat-val{font-size:28px;color:#00e5ff;display:block}
.stat-lbl{font-size:12px;color:#8ab8cc;letter-spacing:.1em;text-transform:uppercase}
.err .stat-val{color:#ff4060}
#ts{color:#6a8898;font-size:12px;padding:0 20px 8px}
nav{padding:6px 20px 0;display:flex;gap:12px;border-bottom:1px solid #1a2a3a}
nav a{color:#6a8898;font-size:11px;text-decoration:none;letter-spacing:.08em;text-transform:uppercase;padding:6px 0;border-bottom:2px solid transparent}
nav a:hover{color:#b8c8d8}nav a.active{color:#00e5ff;border-bottom-color:#00e5ff}
</style>
</head>
<body>
<h1>GeoPoint Saver Simple \u2014 Admin</h1>
<nav>
  <a href="/">Home</a>
  <a href="/admin">Live Logs</a>
  <a href="/admin/stats" class="active">Stats</a>
</nav>
<div id="ts">Loading\u2026</div>
<div class="wrap">
  <div class="card full" id="statsCard"></div>
  <div class="card full">
    <h2>Active Sessions</h2>
    <table id="sessTable"><thead><tr><th>Session</th><th>IP</th><th>User ID</th><th>Files</th><th>Age</th></tr></thead><tbody id="sessTbody"></tbody></table>
  </div>
  <div class="card full">
    <h2>Tools</h2>
    <a href="/admin" style="display:inline-block;padding:8px 16px;border:1px solid #1a2a3a;color:#00e5ff;text-decoration:none;font-size:12px;letter-spacing:.06em;text-transform:uppercase;margin-right:10px">Live Logs</a>
<a href="/" style="display:inline-block;padding:8px 16px;border:1px solid #1a2a3a;color:#6a8898;text-decoration:none;font-size:12px;letter-spacing:.06em;text-transform:uppercase">\u2190 Home</a>
  </div>
</div>
<script>
function esc(v){
  return String(v==null?'—':v)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}
function fmtAge(ms){const s=Math.floor(ms/1000);if(s<60)return s+'s';if(s<3600)return Math.floor(s/60)+'m '+s%60+'s';return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m';}
function fmtUptime(s){const h=Math.floor(s/3600),m=Math.floor((s%3600)/60);return h+'h '+m+'m';}
function stat(val,lbl,cls){return '<span class="stat'+(cls?' '+cls:'')+'" ><span class="stat-val">'+esc(val)+'</span><span class="stat-lbl">'+esc(lbl)+'</span></span>';}

async function poll(){
  try{
    const d=await fetch('/admin/data').then(r=>r.json());
    document.getElementById('ts').textContent='Updated: '+new Date(d.ts).toLocaleTimeString()
      +' \u2014 Uptime: '+fmtUptime(d.uptime)
      +' \u2014 Load: '+d.load['1m']+'% / '+d.load['5m']+'% / '+d.load['15m']+'% (1m/5m/15m)';

    document.getElementById('statsCard').innerHTML='<h2>Stats</h2><div>'
      +stat(d.activeSessions.length,'Active Sessions')
      +stat(d.logStats.inspects,'Total Inspects')
      +stat(d.logStats.ok,'Total OK')
      +stat(d.conversionsThisRun,'Converts This Run')
      +stat(d.logStats.errors,'Errors','err')
      +'</div>';

    const sess=document.getElementById('sessTbody');
    if(d.activeSessions.length===0){
      sess.textContent='';
      const tr=document.createElement('tr');const td=document.createElement('td');
      td.colSpan=5;td.style.color='#6a8898';td.style.padding='12px 8px';
      td.textContent='No active sessions';tr.appendChild(td);sess.appendChild(tr);
    } else {
      sess.textContent='';
      for(const s of d.activeSessions){
        const tr=document.createElement('tr');
        [s.id+'…',s.ip,s.userId||'—',(s.files||[]).join(', ')||'—',fmtAge(s.ageMs)].forEach(v=>{
          const td=document.createElement('td');td.textContent=v;tr.appendChild(td);
        });
        sess.appendChild(tr);
      }
    }
  } catch(e){
    document.getElementById('ts').textContent='Poll error: '+e.message;
  }
}
poll();setInterval(poll,2000);
</script>
</body>
</html>`;

const LOGS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Live Logs \u2014 GeoPoint</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#050a0f;color:#b8c8d8;font-family:'Courier New',monospace;font-size:12px;line-height:1.5;display:flex;flex-direction:column;height:100vh;overflow:hidden}
header{padding:10px 16px;border-bottom:1px solid #1a2a3a;display:flex;align-items:center;gap:12px;flex-shrink:0}
h1{font-size:14px;letter-spacing:.1em;text-transform:uppercase;color:#00e5ff;flex:1}
#filter{background:#0a1520;border:1px solid #1a2a3a;color:#b8c8d8;padding:4px 8px;font-family:inherit;font-size:12px;width:220px}
#filter::placeholder{color:#6a8898}
button{background:#0a1520;border:1px solid #1a2a3a;color:#b8c8d8;padding:4px 10px;font-family:inherit;font-size:12px;cursor:pointer;letter-spacing:.06em;text-transform:uppercase}
button:hover{border-color:#00e5ff;color:#00e5ff}
button.active{border-color:#00e5ff;color:#00e5ff}
a.back{color:#6a8898;font-size:12px;text-decoration:none;letter-spacing:.06em;text-transform:uppercase}
#colheader{padding:0 16px;display:flex;align-items:stretch;border-bottom:1px solid #1a2a3a;background:#080f1a;flex-shrink:0;user-select:none;min-height:24px}
#log{flex:1;overflow-y:auto;padding:4px 0}
.row{padding:1px 16px;display:flex;align-items:baseline}
.row:hover{background:#0a1520}
.row.hidden{display:none}
.cell{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-right:8px}
.s2{color:#00c853}.s3{color:#00b0ff}.s4{color:#ffab00}.s5{color:#ff4060}.s0{color:#8ab8cc}
.hcell{display:flex;align-items:center;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#6a8898;cursor:grab;position:relative}
.hcell.drag-over{background:#0a1a2a}
.hcell .rh{position:absolute;right:0;top:0;bottom:0;width:5px;cursor:col-resize;background:transparent;z-index:1}
.hcell .rh:hover,.hcell .rh.active{background:#1a3a5a}
.hcell .lbl{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:4px 8px 4px 0}
#statusEl{font-size:12px;color:#6a8898}
#countEl{font-size:12px;color:#6a8898}
</style>
<style id="colStyle"></style>
</head>
<body>
<header>
  <h1>Live Access Log</h1>
  <span id="countEl"></span>
  <input id="filter" type="text" placeholder="filter\u2026" autocomplete="off"/>
  <button id="pauseBtn">Pause</button>
  <button id="clearBtn">Clear</button>
  <a class="back" href="/">\u2190 Home</a>
  <span id="statusEl">Connecting\u2026</span>
</header>
<div id="colheader"></div>
<div id="log"></div>
<script>
var logEl     = document.getElementById('log');
var headerEl  = document.getElementById('colheader');
var statusEl  = document.getElementById('statusEl');
var filterEl  = document.getElementById('filter');
var countEl   = document.getElementById('countEl');
var pauseBtn  = document.getElementById('pauseBtn');
var clearBtn  = document.getElementById('clearBtn');
var colStyleEl = document.getElementById('colStyle');

var paused     = false;
var total      = 0;
var filterText = '';

// Column definitions
var DEFAULT_COLS = [
  { key: 'ts',     label: 'Time',     w: 90,  flex: false },
  { key: 'status', label: 'Action',   w: 100, flex: false },
  { key: 'detail', label: 'Detail',   w: null, flex: true  },
  { key: 'ip',     label: 'IP',       w: 160, flex: false },
  { key: 'isp',    label: 'ISP / AS', w: 220, flex: false },
  { key: 'uid',    label: 'User',     w: 160, flex: false },
];

var COLS_VERSION = 4;
var cols = (function() {
  try {
    var saved = JSON.parse(localStorage.getItem('log_cols'));
    if (Array.isArray(saved) && saved.length &&
        saved[0] && saved[0].__v === COLS_VERSION) return saved;
  } catch(e) {}
  return DEFAULT_COLS.map(function(c) { return Object.assign({ __v: COLS_VERSION }, c); });
})();

function saveCols() {
  try {
    var stamped = cols.map(function(c) { return Object.assign({}, c, { __v: COLS_VERSION }); });
    localStorage.setItem('log_cols', JSON.stringify(stamped));
  } catch(e) {}
}

function applyColStyle() {
  var allKeys    = DEFAULT_COLS.map(function(c) { return c.key; });
  var activeKeys = cols.map(function(c) { return c.key; });
  var rules = [];
  cols.forEach(function(c, i) {
    var w = c.flex ? 'flex:1;min-width:60px' : 'width:' + c.w + 'px;flex-shrink:0';
    rules.push('.cell[data-col="' + c.key + '"]{order:' + i + ';' + w + '}');
    rules.push('.hcell[data-col="' + c.key + '"]{display:flex;order:' + i + ';' + (c.flex ? 'flex:1;min-width:60px' : 'width:' + c.w + 'px;flex-shrink:0') + '}');
  });
  allKeys.forEach(function(k) {
    if (activeKeys.indexOf(k) < 0) {
      rules.push('.cell[data-col="' + k + '"]{display:none}');
      rules.push('.hcell[data-col="' + k + '"]{display:none}');
    }
  });
  colStyleEl.innerHTML = rules.join('');
}

function renderHeader() {
  headerEl.innerHTML = '';
  cols.forEach(function(c) {
    var hc  = document.createElement('div');
    hc.className = 'hcell';
    hc.dataset.col = c.key;
    hc.setAttribute('draggable', 'true');

    var lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = c.label;

    var rh = document.createElement('div');
    rh.className = 'rh';

    hc.appendChild(lbl);
    hc.appendChild(rh);

    // Drag-to-reorder
    hc.addEventListener('dragstart', function(e) {
      e.dataTransfer.setData('text/plain', c.key);
      e.dataTransfer.effectAllowed = 'move';
    });
    hc.addEventListener('dragover', function(e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      document.querySelectorAll('.hcell').forEach(function(el) { el.classList.remove('drag-over'); });
      hc.classList.add('drag-over');
    });
    hc.addEventListener('dragleave', function() { hc.classList.remove('drag-over'); });
    hc.addEventListener('drop', function(e) {
      e.preventDefault();
      hc.classList.remove('drag-over');
      var fromKey = e.dataTransfer.getData('text/plain');
      if (fromKey === c.key) return;
      var fromIdx = cols.findIndex(function(x) { return x.key === fromKey; });
      var toIdx   = cols.findIndex(function(x) { return x.key === c.key; });
      var moved   = cols.splice(fromIdx, 1)[0];
      cols.splice(toIdx, 0, moved);
      applyColStyle();
      renderHeader();
      saveCols();
    });

    // Drag-to-resize
    rh.addEventListener('mousedown', function(e) {
      e.preventDefault();
      e.stopPropagation();
      rh.classList.add('active');
      var startX = e.clientX;
      var startW = c.w || 80;
      function onMove(ev) {
        c.w    = Math.max(40, startW + ev.clientX - startX);
        c.flex = false;
        applyColStyle();
      }
      function onUp() {
        rh.classList.remove('active');
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        saveCols();
      }
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });

    headerEl.appendChild(hc);
  });
}

// ISP lookup via ip-api.com batch endpoint
var ispCache   = {};
var ispPending = {};
var ispTimer   = null;

function ispLookup(ip, cb) {
  if (!ip || ip === '127.0.0.1' || ip === '::1' ||
      /^10\\./.test(ip) || /^192\\.168\\./.test(ip) ||
      /^100\\.(6[4-9]|[7-9]\\d|1([01]\\d|2[0-7]))\\./.test(ip)) {
    cb('private'); return;
  }
  if (ip in ispCache) { cb(ispCache[ip]); return; }
  if (!ispPending[ip]) ispPending[ip] = [];
  ispPending[ip].push(cb);
  if (!ispTimer) ispTimer = setTimeout(flushIsp, 120);
}

function flushIsp() {
  ispTimer = null;
  var ips = Object.keys(ispPending).slice(0, 100);
  if (!ips.length) return;
  var batch = {};
  ips.forEach(function(ip) { batch[ip] = ispPending[ip]; delete ispPending[ip]; });
  if (Object.keys(ispPending).length) ispTimer = setTimeout(flushIsp, 4100);
  fetch('http://ip-api.com/batch?fields=query,as,org', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ips)
  }).then(function(r) { return r.json(); }).then(function(data) {
    data.forEach(function(r) {
      var val = r.as || r.org || '';
      ispCache[r.query] = val;
      (batch[r.query] || []).forEach(function(cb) { try { cb(val); } catch(e) {} });
    });
  }).catch(function() {
    ips.forEach(function(ip) {
      (batch[ip] || []).forEach(function(cb) { try { cb(''); } catch(e) {} });
    });
  });
}

// Parse a JSON log line from access.log
function parseLine(raw) {
  try {
    var e      = JSON.parse(raw);
    var d      = new Date(e.ts);
    var hms    = d.toLocaleTimeString();
    var uid    = e.userLabel || (e.userId || '').slice(0, 8);
    var status = e.status || '???';
    var label  = e.action || status;
    var detail = e.detail || '';
    if (!detail && e.error)   detail = e.error;
    if (!detail && e.outputs) detail = e.outputs.map(function(o){ return o.name; }).join(', ');
    if (!detail && e.files)   detail = e.files.join(', ');
    return { hms: hms, status: status, label: label, detail: detail, ip: e.ip || '', uid: uid };
  } catch(err) {
    return { hms: '', status: '???', label: '???', detail: String(raw), ip: '', uid: '' };
  }
}

function statusCls(s) {
  return ({ ok: 's2', inspect: 's3', error: 's5' })[s] || 's0';
}

function addLine(raw) {
  var p   = parseLine(raw);
  var row = document.createElement('div');
  row.className   = 'row';
  row.dataset.raw = (typeof raw === 'string' ? raw : JSON.stringify(raw)).toLowerCase();
  if (filterText && !row.dataset.raw.includes(filterText)) row.classList.add('hidden');

  var vals   = { ts: p.hms, status: p.label, detail: p.detail, ip: p.ip, isp: '', uid: p.uid };
  var spans  = {};

  DEFAULT_COLS.forEach(function(c) {
    var span = document.createElement('span');
    span.className   = 'cell' + (c.key === 'status' ? ' ' + statusCls(p.status) : '');
    span.dataset.col = c.key;
    span.textContent = vals[c.key] != null ? vals[c.key] : '';
    row.appendChild(span);
    spans[c.key] = span;
  });

  if (p.ip) {
    ispLookup(p.ip, function(val) {
      if (spans.isp) spans.isp.textContent = val;
    });
  }

  logEl.insertBefore(row, logEl.firstChild);
  total++;
  updateCount();
  if (logEl.children.length > 2000) logEl.removeChild(logEl.lastChild);
}

filterEl.addEventListener('input', function() {
  filterText = filterEl.value.toLowerCase();
  for (var i = 0; i < logEl.children.length; i++) {
    var row = logEl.children[i];
    row.classList.toggle('hidden', !!(filterText && !row.dataset.raw.includes(filterText)));
  }
});

pauseBtn.addEventListener('click', function() {
  paused = !paused;
  pauseBtn.classList.toggle('active', paused);
  pauseBtn.textContent = paused ? 'Resume' : 'Pause';
});

clearBtn.addEventListener('click', function() { logEl.textContent = ''; total = 0; updateCount(); });

function updateCount() { countEl.textContent = total + ' lines'; }

var es = new EventSource('/admin/logs/stream?tail=200');
es.onopen    = function() { statusEl.textContent = 'Live'; statusEl.style.color = '#00c853'; };
es.onerror   = function() { statusEl.textContent = 'Disconnected'; statusEl.style.color = '#ff4060'; };
es.onmessage = function(e) {
  if (paused) return;
  try { addLine(JSON.parse(e.data)); } catch(err) {}
};

applyColStyle();
renderHeader();
</script>
</body>
</html>`;

// ── Block sensitive paths ─────────────────────────────────────────────────────

app.use((req, res, next) => {
  const blocked = /^\/(logs|submissions|staged|node_modules)(\/|$)|^\/package(-lock)?\.json$/i;
  if (blocked.test(req.path)) return res.status(403).end();
  next();
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 20 }
});

// ── Session store ─────────────────────────────────────────────────────────────

// rows stay in-memory for fast convert access
const sessions    = new Map(); // sessionId -> { rows, createdAt, ip, userId, files }
const MAX_SESSIONS = 5_000;

const SESSION_TTL_MS = 30 * 60 * 1000;

const sessionCleanupInterval = setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, s] of sessions) {
    if (s.createdAt < cutoff) sessions.delete(id);
  }
}, 5 * 60 * 1000);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Remove the file extension from a filename, leaving the base name. */
function stripExt(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

/** Sanitise a string for use as a filesystem-safe output filename segment. */
function safeName(s) {
  return s.replace(/[^\w\-\. ]+/g, '_').trim().replace(/\s+/g, '_') || 'output';
}

/**
 * Extract the real client IP, preferring Cloudflare's cf-connecting-ip header,
 * then x-forwarded-for (first entry), then the raw socket address.
 */
function getClientIp(req) {
  return req.headers['cf-connecting-ip']
    || req.headers['x-forwarded-for']?.split(',')[0].trim()
    || req.socket.remoteAddress;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read the X-User-Id header (a UUID set by the client in localStorage) for
 * log correlation. Falls back to a fresh UUID if absent or malformed.
 */
function getUserId(req) {
  const id = req.headers['x-user-id'];
  return (id && UUID_RE.test(id)) ? id : randomUUID();
}

const preferredOrder = ['source', 'layer', 'geometry_type', 'placemark_id', 'name', 'lat', 'lon', 'alt'];

/**
 * Sort field descriptors so that known structural fields (source, layer,
 * geometry_type, etc.) appear first in a fixed order, with unknown/custom
 * ExtendedData fields sorted alphabetically after them.
 */
function sortFields(fields) {
  return fields.slice().sort((a, b) => {
    const ia = preferredOrder.indexOf(a.key);
    const ib = preferredOrder.indexOf(b.key);
    const pa = ia === -1 ? 999 : ia;
    const pb = ib === -1 ? 999 : ib;
    if (pa !== pb) return pa - pb;
    return a.key.localeCompare(b.key);
  });
}

// ── Static files ──────────────────────────────────────────────────────────────

const STATIC_ALLOWLIST = new Set([
  '/index.html', '/app.js', '/app.css', '/worker.js', '/zip.js', '/sw.js',
]);
const STATIC_PREFIXES = ['/lib/'];

const API_GET_PATHS = new Set(['/load', '/admin', '/admin/data', '/admin/logs', '/admin/logs/stream']);

app.use((req, res, next) => {
  const p = req.path;
  const allowed = STATIC_ALLOWLIST.has(p) || STATIC_PREFIXES.some(pre => p.startsWith(pre));
  if (req.method === 'GET' && !allowed && p !== '/' && !API_GET_PATHS.has(p) && !p.startsWith('/admin')) return res.status(403).end();
  next();
});

app.get('/', (req, res, next) => { next(); });

app.use(express.static(__dirname));

// ── POST /inspect ─────────────────────────────────────────────────────────────

app.post('/inspect', inspectLimiter, smartUpload(upload.array('files[]')), async (req, res) => {
  const ip     = getClientIp(req);
  const userId = getUserId(req);
  const files  = req.files || [];

  if (files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded.' });
  }

  const badFile = files.find(f => !/\.(kml|kmz)$/i.test(f.originalname));
  if (badFile) {
    return res.status(400).json({ error: `"${badFile.originalname}" is not a KML or KMZ file.` });
  }

  const allRows  = [];
  const fieldMap = new Map();

  try {
    for (const file of files) {
      let rows, fields;
      ({ rows, fields } = await parseKmlBuffer(file.originalname, file.buffer));
      allRows.push(...rows);
      for (const f of fields) {
        if (!fieldMap.has(f.key)) fieldMap.set(f.key, f.type);
      }
    }
  } catch (err) {
    await writeLog({ ts: new Date().toISOString(), ip, userId, files: files.map(f => f.originalname), status: 'error', action: 'upload', detail: err.message, error: err.message });
    return res.status(400).json({ error: err.message });
  }

  const layerCounts = new Map();
  for (const r of allRows) {
    const lk = r.layer ?? '(Ungrouped)';
    layerCounts.set(lk, (layerCounts.get(lk) || 0) + 1);
  }

  if (sessions.size >= MAX_SESSIONS) {
    return res.status(503).json({ error: 'Server busy, please try again shortly.' });
  }

  const sessionId = randomUUID().replace(/-/g, '');
  const now = Date.now();
  sessions.set(sessionId, { rows: allRows, createdAt: now, ip, userId, files: files.map(f => f.originalname) });

  const fields = sortFields(Array.from(fieldMap.entries()).map(([key, type]) => ({ key, type })));
  const layers = Array.from(layerCounts.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => a.key.localeCompare(b.key));

  writeLog({ ts: new Date().toISOString(), ip, userId, files: files.map(f => f.originalname), status: 'inspect', action: 'upload',
    detail: `${files.length} file${files.length > 1 ? 's' : ''} · ${allRows.length.toLocaleString()} rows · ${fieldMap.size} fields · ${layerCounts.size} layer${layerCounts.size !== 1 ? 's' : ''}`,
  }).catch(() => {});

  res.json({ sessionId, rows: allRows, fields, layers });
});

// ── POST /parse-polygon ────────────────────────────────────────────────────────

app.post('/parse-polygon', inspectLimiter, smartUpload(upload.single('file')), async (req, res) => {
  const ip     = getClientIp(req);
  const userId = getUserId(req);
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No file uploaded.' });
  if (!/\.(kml|kmz)$/i.test(file.originalname)) {
    return res.status(400).json({ error: `"${file.originalname}" is not a KML or KMZ file.` });
  }
  try {
    const result = await parsePolygonFromKmlBuffer(file.originalname, file.buffer);
    if (!result) return res.status(400).json({ error: 'No polygon found in the uploaded file.' });
    const pts = Array.isArray(result.coords) ? result.coords.length : 0;
    writeLog({ ts: new Date().toISOString(), ip, userId, files: [file.originalname],
      status: 'inspect', action: 'polygon',
      detail: `${file.originalname} · ${pts} pts`,
    }).catch(() => {});
    res.json(result);
  } catch (err) {
    writeLog({ ts: new Date().toISOString(), ip, userId, files: [file.originalname],
      status: 'error', action: 'polygon', detail: err.message,
    }).catch(() => {});
    res.status(400).json({ error: err.message });
  }
});

// ── POST /convert ─────────────────────────────────────────────────────────────

app.post('/convert', convertLimiter, async (req, res) => {
  const ip     = getClientIp(req);
  const userId = getUserId(req);
  const {
    sessionId, fieldKeys = [], layerKeys = [],
    spatialFilter = null, keepCrossingLines = false,
    delimiter = ',', precision = 6,
    includeHeader = true, combineCsv: doCombine = false, baseName = ''
  } = req.body;

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session expired or not found. Please re-upload your files.' });
  }

  if (fieldKeys.length === 0) {
    return res.status(400).json({ error: 'No fields selected.' });
  }

  if (!Array.isArray(fieldKeys) || fieldKeys.length > 500) {
    return res.status(400).json({ error: 'Invalid field selection.' });
  }

  if (!Array.isArray(layerKeys) || layerKeys.length > 1000) {
    return res.status(400).json({ error: 'Invalid layer selection.' });
  }

  // Input validation
  const safeDelimiter = typeof delimiter === 'string' && delimiter.length === 1 ? delimiter : ',';
  const safePrecision = Math.max(0, Math.min(10, parseInt(precision, 10) || 6));
  if (spatialFilter !== null) {
    if (typeof spatialFilter !== 'object' || !['rectangle', 'polygon'].includes(spatialFilter.type)) {
      return res.status(400).json({ error: 'Invalid spatial filter.' });
    }
    if (spatialFilter.type === 'polygon' && (!Array.isArray(spatialFilter.coords) || spatialFilter.coords.length > 10000)) {
      return res.status(400).json({ error: 'Polygon too complex.' });
    }
  }

  let allRows = session.rows;
  const results = [];

  try {
    const fileSources = [...new Set(allRows.map(r => r.source))];

    for (const source of fileSources) {
      const fileRows = allRows.filter(r => r.source === source);
      const fileBase = stripExt(source.split('/').pop());

      if (layerKeys.length > 0) {
        const fileLayerKeys = new Set(fileRows.map(r => r.layer ?? '(Ungrouped)'));

        for (const layerKey of layerKeys) {
          if (!fileLayerKeys.has(layerKey)) continue;

          const layerRows = fileRows.filter(r => (r.layer ?? '(Ungrouped)') === layerKey);
          const rows      = applySpatialFilter(layerRows, spatialFilter, keepCrossingLines);

          if (rows.length === 0) continue;

          if (layerHasLines(rows)) {
            results.push({ kind: 'kml', name: `${fileBase}_${safeName(layerKey)}.kml`, bytes: rowsToKml(rows, layerKey) });
          } else {
            results.push({ kind: 'csv', name: `${fileBase}_${safeName(layerKey)}.csv`, bytes: rowsToCsv(rows, fieldKeys, safeDelimiter, includeHeader, safePrecision) });
          }
        }
      } else {
        const rows = applySpatialFilter(fileRows, spatialFilter, keepCrossingLines);
        if (rows.length === 0) continue;
        if (layerHasLines(rows)) {
          results.push({ kind: 'kml', name: `${fileBase}.kml`, bytes: rowsToKml(rows, fileBase) });
        } else {
          results.push({ kind: 'csv', name: `${fileBase}.csv`, bytes: rowsToCsv(rows, fieldKeys, safeDelimiter, includeHeader, safePrecision) });
        }
      }
    }

    if (doCombine) {
      const csvItems = results.filter(r => r.kind === 'csv');
      if (csvItems.length > 0) {
        const name = baseName ? `${safeName(baseName)}.csv` : 'combined.csv';
        results.push({ kind: 'csv', name, bytes: combineCsv(csvItems, safeDelimiter, includeHeader, fieldKeys) });
      }
    }

    if (baseName && !doCombine) {
      const csvResults = results.filter(r => r.kind === 'csv');
      if (csvResults.length === 1) csvResults[0].name = `${safeName(baseName)}.csv`;
    }

    const sessionFiles = session.files || [];
    sessions.delete(sessionId);

    const outputs = results.map(r => ({ name: r.name, kind: r.kind }));
    conversionCount++;
    const filterLabel = spatialFilter ? ` · ${spatialFilter.type} filter` : '';
    const convertDetail = `${sessionFiles.join(', ')} → ${outputs.map(o => o.name).join(', ')}${filterLabel} · ${fieldKeys.length} fields`;

    writeLog({ ts: new Date().toISOString(), ip, userId, sessionId, outputs, status: 'ok', action: 'convert', detail: convertDetail }).catch(() => {});

    if (results.length === 1) {
      const r    = results[0];
      const mime = r.kind === 'kml' ? 'application/vnd.google-earth.kml+xml' : 'text/csv';
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', `attachment; filename="${r.name}"`);
      return res.end(Buffer.from(r.bytes));
    }

    const zip = new ZipWriter();
    for (const r of results) zip.addFile(r.name, r.bytes);
    const zipBytes = zip.finish();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="converted.zip"');
    res.end(Buffer.from(zipBytes));

  } catch (err) {
    writeLog({ ts: new Date().toISOString(), ip, userId, sessionId, status: 'error', action: 'convert', detail: err.message, error: err.message }).catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

export { sessions, MAX_SESSIONS };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`GeoPoint Saver Simple listening on http://127.0.0.1:${PORT}`);
  });
}
