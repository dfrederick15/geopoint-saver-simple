/*
  sw.js — Session-scoped E2E encryption via Service Worker
  Intercepts all same-origin API requests, performs an ECDH key exchange
  on first use, then wraps every request body in AES-256-GCM and decrypts
  every response. The session key lives only in this SW's memory and is
  never written to any persistent storage.
*/
'use strict';

// Endpoints to protect
const ENCRYPT_PATHS = new Set([
  '/inspect', '/parse-polygon', '/fetch-drive',
  '/email-token', '/staged-files', '/stage-load', '/convert',
]);

let sessionKey  = null;   // AES-256-GCM CryptoKey — in-memory only
let cryptoSid   = null;   // Server-side session handle
let initPromise = null;   // Singleton in-flight key-exchange promise

// ── Lifecycle ─────────────────────────────────────────────────────────────────

self.addEventListener('install',  ()  => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// ── Key Exchange ──────────────────────────────────────────────────────────────

async function initSession() {
  const kp = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  );
  const clientPubJwk = await crypto.subtle.exportKey('jwk', kp.publicKey);

  const resp = await fetch('/crypto-init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKey: clientPubJwk }),
  });
  if (!resp.ok) throw new Error('[SW] Key exchange failed: ' + resp.status);
  const { publicKey: serverPubJwk, sid } = await resp.json();

  const serverPub = await crypto.subtle.importKey(
    'jwk', serverPubJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: serverPub }, kp.privateKey, 256,
  );
  const hkdfKey = await crypto.subtle.importKey(
    'raw', sharedBits, { name: 'HKDF' }, false, ['deriveKey'],
  );
  sessionKey = await crypto.subtle.deriveKey(
    {
      name: 'HKDF', hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: new TextEncoder().encode('geopoint-saver-v1'),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false, ['encrypt', 'decrypt'],
  );
  cryptoSid = sid;
}

function ensureSession() {
  if (sessionKey) return Promise.resolve();
  if (!initPromise) {
    initPromise = initSession().catch(err => { initPromise = null; throw err; });
  }
  return initPromise;
}

// ── AES-256-GCM Helpers ───────────────────────────────────────────────────────

async function aesEncrypt(plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sessionKey, plaintext);
  return { iv: u8b64(iv), ct: u8b64(new Uint8Array(ct)) };
}

async function aesDecrypt(iv64, ct64) {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64u8(iv64) }, sessionKey, b64u8(ct64),
  );
  return new Uint8Array(pt);
}

function u8b64(u8) {
  let s = '';
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s);
}
function b64u8(b64) {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

// ── Request Serialisation ─────────────────────────────────────────────────────

async function serialiseBody(request) {
  const rawCt = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();

  if (rawCt === 'multipart/form-data' || rawCt.startsWith('multipart/')) {
    const fd = await request.formData();
    const parts = [];
    for (const [name, value] of fd.entries()) {
      if (value instanceof File) {
        const bytes = await value.arrayBuffer();
        parts.push({ name, filename: value.name, mimeType: value.type, data: u8b64(new Uint8Array(bytes)) });
      } else {
        parts.push({ name, value: String(value) });
      }
    }
    return { contentType: 'multipart/form-data', data: { _type: 'formdata', parts } };
  }

  if (rawCt === 'application/json') {
    return { contentType: 'application/json', data: JSON.parse(await request.text()) };
  }

  return { contentType: rawCt || '', data: null };
}

// ── Fetch Interceptor ─────────────────────────────────────────────────────────

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (!ENCRYPT_PATHS.has(url.pathname)) return;
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  await ensureSession();

  const headers = new Headers(request.headers);
  headers.set('X-Crypto-Sid', cryptoSid);

  let encBody;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const { contentType, data } = await serialiseBody(request);
    const inner = new TextEncoder().encode(JSON.stringify({ contentType, data }));
    const { iv, ct } = await aesEncrypt(inner);
    headers.set('Content-Type', 'application/json');
    encBody = JSON.stringify({ _enc: true, sid: cryptoSid, iv, ct });
  }

  const response = await fetch(new Request(request.url, {
    method:      request.method,
    headers,
    body:        encBody,
    redirect:    request.redirect,
    credentials: request.credentials,
  }));

  return decryptResponse(response);
}

async function decryptResponse(response) {
  let body;
  try { body = await response.json(); }
  catch { return response; }

  if (!body || !body._enc) {
    return new Response(JSON.stringify(body), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const pt    = await aesDecrypt(body.iv, body.ct);
  const inner = JSON.parse(new TextDecoder().decode(pt));

  if (inner._binary) {
    const bytes = b64u8(inner.data);
    return new Response(bytes.buffer, {
      status: response.status,
      headers: {
        'Content-Type':        inner.contentType,
        'Content-Disposition': inner.contentDisposition,
      },
    });
  }

  return new Response(JSON.stringify(inner), {
    status: response.status,
    headers: { 'Content-Type': 'application/json' },
  });
}
