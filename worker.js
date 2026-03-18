/*
  GeoPoints → CSV (Native) - Worker
  Copyright © 2026 Devin Frederick
*/

// Worker does CSV building only. No DOMParser / XML parsing here.

self.onmessage = async (e) => {
  const msg = e.data;
  const id = msg.id;

  try {
    if (msg.type === "rowsToCsv") {
      const { rows, fieldKeys, delimiter, includeHeader, precision } = msg;
      const csvBytes = rowsToCsv(rows, fieldKeys, delimiter, includeHeader, precision);
      postMessage({ id, ok: true, csvBytes }, [csvBytes.buffer]);
      return;
    }

    if (msg.type === "combineCsv") {
      const { items, delimiter, includeHeader, fieldKeys } = msg;
      const combined = combineCsv(items, delimiter, includeHeader, fieldKeys);
      postMessage({ id, ok: true, csvBytes: combined }, [combined.buffer]);
      return;
    }

    postMessage({ id, ok: false, error: `Unknown message type: ${msg.type}` });
  } catch (err) {
    postMessage({ id, ok: false, error: err?.message || String(err) });
  }
};

function rowsToCsv(rows, fieldKeys, delimiter, includeHeader, precision) {
  const fmt = (n) => n.toFixed(precision);

  const lines = [];
  if (includeHeader) {
    lines.push(fieldKeys.map(k => escapeCell(k, delimiter)).join(delimiter));
  }

  for (const r of rows) {
    const cols = fieldKeys.map((k) => {
      const v = r[k];
      if (typeof v === "number") return fmt(v);
      if (v == null) return "";
      return escapeCell(String(v), delimiter);
    });
    lines.push(cols.join(delimiter));
  }

  return new TextEncoder().encode(lines.join("\n") + "\n");
}

function combineCsv(items, delimiter, includeHeader, fieldKeys) {
  const lines = [];
  if (includeHeader) {
    lines.push(fieldKeys.map(k => escapeCell(k, delimiter)).join(delimiter));
  }

  for (const it of items) {
    const csvText = decodeUtf8(it.bytes);
    const rows = csvText.split(/\r?\n/).filter(Boolean);
    for (let i = 0; i < rows.length; i++) {
      if (includeHeader && i === 0) continue;
      lines.push(rows[i]);
    }
  }

  return new TextEncoder().encode(lines.join("\n") + "\n");
}

function decodeUtf8(bytes) {
  if (bytes instanceof ArrayBuffer) return new TextDecoder("utf-8").decode(bytes);
  if (bytes instanceof Uint8Array) return new TextDecoder("utf-8").decode(bytes);
  return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
}

function escapeCell(s, delimiter) {
  s = String(s ?? "");
  const needs = s.includes('"') || s.includes("\n") || s.includes("\r") || s.includes(delimiter);
  if (!needs) return s;
  return `"${s.replace(/"/g, '""')}"`;
}
