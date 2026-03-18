/*
  lib-convert.js — Server-side CSV/KML building and spatial filtering
  Ported from worker.js (rowsToCsv) and app.js (rowsToKml, applySpatialFilter).
*/

const INTERNAL_FIELDS = new Set(['placemark_uid']);
const STANDARD_FIELDS = new Set(['source', 'layer', 'geometry_type', 'placemark_id', 'placemark_uid', 'name', 'lat', 'lon', 'alt']);

// ── CSV ──────────────────────────────────────────────────────────────────────

export function rowsToCsv(rows, fieldKeys, delimiter, includeHeader, precision) {
  const fmt = (n) => n.toFixed(precision);
  const lines = [];

  if (includeHeader) {
    lines.push(fieldKeys.map(k => escapeCell(k, delimiter)).join(delimiter));
  }

  for (const r of rows) {
    const cols = fieldKeys.map((k) => {
      const v = r[k];
      if (typeof v === 'number') return fmt(v);
      if (v == null) return '';
      return escapeCell(String(v), delimiter);
    });
    lines.push(cols.join(delimiter));
  }

  return new TextEncoder().encode(lines.join('\n') + '\n');
}

export function combineCsv(items, delimiter, includeHeader, fieldKeys) {
  const lines = [];
  if (includeHeader) {
    lines.push(fieldKeys.map(k => escapeCell(k, delimiter)).join(delimiter));
  }
  for (const it of items) {
    const csvText = new TextDecoder().decode(it.bytes);
    const rows = csvText.split(/\r?\n/).filter(Boolean);
    for (let i = 0; i < rows.length; i++) {
      if (includeHeader && i === 0) continue;
      lines.push(rows[i]);
    }
  }
  return new TextEncoder().encode(lines.join('\n') + '\n');
}

function escapeCell(s, delimiter) {
  s = String(s ?? '');
  const needs = s.includes('"') || s.includes('\n') || s.includes('\r') || s.includes(delimiter);
  if (!needs) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

// ── KML ──────────────────────────────────────────────────────────────────────

export function layerHasLines(rows) {
  return rows.some(r => r.geometry_type === 'LineString' || r.geometry_type === 'LinearRing');
}

export function xmlEscape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c])
  );
}

export function rowsToKml(rows, docName) {
  const pmMap = new Map();
  for (const r of rows) {
    const uid = r.placemark_uid;
    if (!pmMap.has(uid)) {
      const ext = {};
      for (const [k, v] of Object.entries(r)) {
        if (!STANDARD_FIELDS.has(k) && v != null && v !== '') ext[k] = v;
      }
      pmMap.set(uid, { name: r.name, placemark_id: r.placemark_id, ext, geoms: new Map() });
    }
    const pm = pmMap.get(uid);
    const gt = r.geometry_type || 'Point';
    if (!pm.geoms.has(gt)) pm.geoms.set(gt, []);
    pm.geoms.get(gt).push({ lat: r.lat, lon: r.lon, alt: r.alt });
  }

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    '<Document>',
    `  <name>${xmlEscape(docName)}</name>`,
  ];

  for (const [, pm] of pmMap) {
    const idAttr = pm.placemark_id ? ` id="${xmlEscape(pm.placemark_id)}"` : '';
    lines.push(`  <Placemark${idAttr}>`);
    lines.push(`    <name>${xmlEscape(pm.name)}</name>`);

    if (Object.keys(pm.ext).length > 0) {
      lines.push('    <ExtendedData>');
      for (const [k, v] of Object.entries(pm.ext)) {
        lines.push(`      <Data name="${xmlEscape(k)}"><value>${xmlEscape(String(v))}</value></Data>`);
      }
      lines.push('    </ExtendedData>');
    }

    for (const [gt, coords] of pm.geoms) {
      const coordStr = coords.map(c => {
        const alt = c.alt != null ? `,${c.alt}` : '';
        return `${c.lon},${c.lat}${alt}`;
      }).join(' ');

      if (gt === 'Point') {
        lines.push(`    <Point><coordinates>${coordStr}</coordinates></Point>`);
      } else if (gt === 'LineString') {
        lines.push(`    <LineString><coordinates>${coordStr}</coordinates></LineString>`);
      } else if (gt === 'LinearRing') {
        lines.push('    <Polygon><outerBoundaryIs>');
        lines.push(`      <LinearRing><coordinates>${coordStr}</coordinates></LinearRing>`);
        lines.push('    </outerBoundaryIs></Polygon>');
      } else {
        lines.push(`    <LineString><coordinates>${coordStr}</coordinates></LineString>`);
      }
    }

    lines.push('  </Placemark>');
  }

  lines.push('</Document>');
  lines.push('</kml>');
  return new TextEncoder().encode(lines.join('\n'));
}

// ── Spatial filter ────────────────────────────────────────────────────────────

// filter: null | { type: 'rectangle', bounds: [[latSW,lngSW],[latNE,lngNE]] }
//                | { type: 'polygon',   coords: [[lat,lng],...] }
export function applySpatialFilter(rows, filter, keepCrossingLines) {
  if (!filter) return rows;

  if (keepCrossingLines) {
    const insideUids = new Set();
    for (const r of rows) {
      if (r.lat != null && r.lon != null && isPointInFilter(r.lat, r.lon, filter)) {
        insideUids.add(r.placemark_uid);
      }
    }
    return rows.filter(r => {
      if (r.lat == null || r.lon == null) return false;
      if (r.geometry_type && r.geometry_type !== 'Point' && r.geometry_type !== '(Unknown)') {
        return insideUids.has(r.placemark_uid);
      }
      return isPointInFilter(r.lat, r.lon, filter);
    });
  }

  return rows.filter(r => r.lat != null && r.lon != null && isPointInFilter(r.lat, r.lon, filter));
}

function isPointInFilter(lat, lon, filter) {
  if (filter.type === 'rectangle') {
    const [[latSW, lonSW], [latNE, lonNE]] = filter.bounds;
    return lat >= latSW && lat <= latNE && lon >= lonSW && lon <= lonNE;
  }
  if (filter.type === 'polygon') {
    return pointInPolygon(lat, lon, filter.coords);
  }
  return true;
}

function pointInPolygon(lat, lon, coords) {
  // coords: [[lat, lng], ...]  — same winding as Leaflet's latlng array
  let inside = false;
  for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
    const [xi, yi] = coords[i]; // xi=lat, yi=lng
    const [xj, yj] = coords[j];
    const intersect = ((yi > lon) !== (yj > lon)) &&
                      (lat < (xj - xi) * (lon - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}
