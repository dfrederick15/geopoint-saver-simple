/*
  lib-parse.js — Server-side KML/KMZ parsing
  Uses fast-xml-parser for high-performance XML parsing.
*/

import { XMLParser } from 'fast-xml-parser';
import { inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';

const inflateRawAsync = promisify(inflateRaw);

const INTERNAL_FIELDS = new Set(['placemark_uid']);
const MAX_XML_BYTES   = 50 * 1024 * 1024; // 50 MB raw XML
const MAX_ROWS        = 500_000;

// Geometry elements that directly contain <coordinates>
const DIRECT_GEOM_TAGS = ['Point', 'LineString', 'LinearRing', 'Track', 'MultiTrack'];

function makeParser() {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    removeNSPrefix: true,
    isArray: (tagName) => [
      'Document', 'Folder', 'Placemark', 'SimpleData',
      'coordinates',
      'Point', 'LineString', 'LinearRing', 'Polygon',
      'MultiGeometry', 'outerBoundaryIs', 'innerBoundaryIs',
    ].includes(tagName),
    parseTagValue: false,
    trimValues: true,
    parseAttributeValue: false,
  });
}

// ── Public entry points ──────────────────────────────────────────────────────

// Accepts a filename string and a Node Buffer. Returns { rows, fields }.
export async function parseKmlBuffer(filename, buffer) {
  const kmls = await readKmlOrKmzToKmls(filename, buffer);
  const multiKml = kmls.length > 1;
  const allRows = [];

  for (const { name: kmlName, text } of kmls) {
    if (text.length > MAX_XML_BYTES) {
      throw new Error(`KML file "${kmlName}" exceeds the 50 MB size limit.`);
    }
    const kmlFileLabel = multiKml ? stripExt(kmlName.split('/').pop()) : '';
    const rows = parseRowsFromKml(text, filename, kmlFileLabel);
    allRows.push(...rows);
    if (allRows.length > MAX_ROWS) {
      throw new Error(`File "${filename}" exceeds the ${MAX_ROWS.toLocaleString()} row limit.`);
    }
  }

  const fields = inferFields(allRows);
  return { rows: allRows, fields };
}

// Accepts a filename string and a Node Buffer.
// Returns { coords: [[lat, lng], ...] } for the first polygon found, or null.
export async function parsePolygonFromKmlBuffer(filename, buffer) {
  const kmls = await readKmlOrKmzToKmls(filename, buffer);
  for (const { text } of kmls) {
    const result = parseFirstPolygonFromKml(text);
    if (result) return result;
  }
  return null;
}

// ── KMZ extraction ───────────────────────────────────────────────────────────

async function readKmlOrKmzToKmls(filename, buffer) {
  const lower = (filename || '').toLowerCase();
  const isKmz = lower.endsWith('.kmz') || looksLikeZip(buffer);

  if (isKmz) {
    if (!looksLikeZip(buffer)) {
      throw new Error(`"${filename}" has a .kmz extension but is not a valid ZIP archive.`);
    }
    const kmls = await extractAllKmlsFromKmz(buffer);
    return kmls.map(({ name, bytes }) => ({ name, text: decodeUtf8(bytes) }));
  }

  return [{ name: filename, text: decodeBestEffort(buffer) }];
}

function looksLikeZip(buffer) {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4B;
}

async function extractAllKmlsFromKmz(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let p = 0;
  const kmls = [];

  const cdOffsets = buildCentralDirectoryOffsets(u8);

  while (p + 30 <= u8.length) {
    const sig = readU32LE(u8, p);
    if (sig !== 0x04034b50) break;

    const flags     = readU16LE(u8, p + 6);
    const method    = readU16LE(u8, p + 8);
    const nameLen   = readU16LE(u8, p + 26);
    const extraLen  = readU16LE(u8, p + 28);

    const nameStart = p + 30;
    const nameEnd   = nameStart + nameLen;
    if (nameEnd > u8.length) throw new Error('KMZ parse error (name out of range).');

    const entryName = decodeUtf8(u8.slice(nameStart, nameEnd)).replace(/\\/g, '/');
    const dataStart = nameEnd + extraLen;

    const cdEntry    = cdOffsets.get(entryName);
    const compSize   = cdEntry ? cdEntry.compSize   : readU32LE(u8, p + 18);
    const uncompSize = cdEntry ? cdEntry.uncompSize : readU32LE(u8, p + 22);

    if ((flags & 0x8) && !cdEntry) break;

    const dataEnd = dataStart + compSize;
    if (dataEnd > u8.length) throw new Error('KMZ parse error (data out of range).');

    if (entryName.toLowerCase().endsWith('.kml')) {
      const fileData = u8.slice(dataStart, dataEnd);
      let bytes;
      if (method === 0) {
        bytes = fileData;
      } else if (method === 8) {
        bytes = new Uint8Array(await inflateRawAsync(Buffer.from(fileData)));
        if (bytes.length !== uncompSize) throw new Error('KMZ decompress size mismatch.');
      } else {
        throw new Error(`Unsupported KMZ compression method: ${method}`);
      }
      kmls.push({ name: entryName, bytes });
    }

    p = dataEnd;
  }

  if (kmls.length === 0) throw new Error('No .kml found inside KMZ.');
  return kmls;
}

// ── KML parsing (fast-xml-parser) ────────────────────────────────────────────

function parseRowsFromKml(kmlText, sourceName, kmlFileLabel = '') {
  let result;
  try {
    result = makeParser().parse(kmlText);
  } catch (e) {
    throw new Error(`Invalid KML/XML: ${e.message}`);
  }

  if (!result.kml) {
    throw new Error(`"${sourceName}" is not a valid KML file (root element must be <kml>).`);
  }

  const rows = [];
  let pmIndex = 0;

  walkContainer(result.kml, []);

  return rows;

  function walkContainer(obj, layerStack) {
    if (!obj || typeof obj !== 'object') return;

    for (const doc of toArr(obj.Document)) {
      const n = getText(doc.name);
      walkContainer(doc, n ? [...layerStack, n] : layerStack);
    }
    for (const folder of toArr(obj.Folder)) {
      const n = getText(folder.name);
      walkContainer(folder, n ? [...layerStack, n] : layerStack);
    }
    for (const pm of toArr(obj.Placemark)) {
      const placemark_id  = pm['@_id'] || '';
      const name          = getText(pm.name);
      const layer         = buildLayer(layerStack, kmlFileLabel);
      const placemark_uid = `${sourceName}\x00${kmlFileLabel}\x00${++pmIndex}`;
      const ext           = extractExtData(pm.ExtendedData);
      const base = { source: sourceName, placemark_id, name, layer, placemark_uid, ...ext };

      // Direct geometry elements (Point, LineString, LinearRing, Track)
      for (const tag of DIRECT_GEOM_TAGS) {
        for (const geom of toArr(pm[tag])) {
          for (const c of toArr(geom.coordinates)) {
            pushCoordRows(getText(c), tag, base, rows);
          }
        }
      }

      // Polygon: outerBoundaryIs/innerBoundaryIs > LinearRing > coordinates
      for (const poly of toArr(pm.Polygon)) {
        for (const bKey of ['outerBoundaryIs', 'innerBoundaryIs']) {
          for (const boundary of toArr(poly[bKey])) {
            for (const ring of toArr(boundary.LinearRing)) {
              for (const c of toArr(ring.coordinates)) {
                pushCoordRows(getText(c), 'LinearRing', base, rows);
              }
            }
          }
        }
      }

      // MultiGeometry: recurse into nested geometry elements
      for (const mg of toArr(pm.MultiGeometry)) {
        for (const tag of DIRECT_GEOM_TAGS) {
          for (const geom of toArr(mg[tag])) {
            for (const c of toArr(geom.coordinates)) {
              pushCoordRows(getText(c), tag, base, rows);
            }
          }
        }
        for (const poly of toArr(mg.Polygon)) {
          for (const bKey of ['outerBoundaryIs', 'innerBoundaryIs']) {
            for (const boundary of toArr(poly[bKey])) {
              for (const ring of toArr(boundary.LinearRing)) {
                for (const c of toArr(ring.coordinates)) {
                  pushCoordRows(getText(c), 'LinearRing', base, rows);
                }
              }
            }
          }
        }
      }
    }
  }
}

function parseFirstPolygonFromKml(kmlText) {
  let result;
  try {
    result = makeParser().parse(kmlText);
  } catch (e) {
    throw new Error(`Invalid KML/XML: ${e.message}`);
  }
  return findFirstPolygon(result);
}

function findFirstPolygon(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const r = findFirstPolygon(item);
      if (r) return r;
    }
    return null;
  }

  for (const poly of toArr(obj.Polygon)) {
    let rawCoords = null;
    for (const outer of toArr(poly.outerBoundaryIs)) {
      for (const ring of toArr(outer.LinearRing)) {
        const c = toArr(ring.coordinates)[0];
        if (c !== undefined) { rawCoords = getText(c); break; }
      }
      if (rawCoords) break;
    }
    if (!rawCoords) {
      for (const ring of toArr(poly.LinearRing)) {
        const c = toArr(ring.coordinates)[0];
        if (c !== undefined) { rawCoords = getText(c); break; }
      }
    }
    if (rawCoords) {
      const coords = parsePolygonCoordinates(rawCoords);
      if (coords.length >= 3) return { coords };
    }
  }

  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object') {
      const r = findFirstPolygon(val);
      if (r) return r;
    }
  }
  return null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractExtData(extDataVal) {
  const ext = {};
  if (!extDataVal) return ext;
  const ed = Array.isArray(extDataVal) ? extDataVal[0] : extDataVal;
  if (!ed || !ed.SchemaData) return ext;
  const sd = Array.isArray(ed.SchemaData) ? ed.SchemaData[0] : ed.SchemaData;
  if (!sd) return ext;
  for (const item of toArr(sd.SimpleData)) {
    const key = item['@_name'];
    if (key) ext[key] = getText(item);
  }
  return ext;
}

function pushCoordRows(rawStr, geometry_type, base, rows) {
  if (!rawStr) return;
  for (const t of rawStr.split(/\s+/).filter(Boolean)) {
    const parts = t.split(',').map(s => s.trim());
    if (parts.length < 2) continue;
    const lon = Number(parts[0]);
    const lat = Number(parts[1]);
    const alt = parts.length >= 3 ? Number(parts[2]) : null;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    rows.push({
      ...base,
      geometry_type,
      lat,
      lon,
      alt: (alt != null && Number.isFinite(alt)) ? alt : null,
    });
  }
}

function buildLayer(layerStack, kmlFileLabel) {
  const parts = kmlFileLabel ? [kmlFileLabel, ...layerStack] : [...layerStack];
  return parts.filter(Boolean).join(' / ') || '(Ungrouped)';
}

function parsePolygonCoordinates(raw) {
  const coords = [];
  for (const t of raw.trim().split(/\s+/).filter(Boolean)) {
    const parts = t.split(',').map(s => s.trim());
    if (parts.length < 2) continue;
    const lon = Number(parts[0]);
    const lat = Number(parts[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    const prev = coords[coords.length - 1];
    if (!prev || prev[0] !== lat || prev[1] !== lon) coords.push([lat, lon]);
  }
  return coords;
}

function inferFields(rows) {
  const map = new Map();
  for (const r of rows) {
    for (const [k, v] of Object.entries(r)) {
      if (INTERNAL_FIELDS.has(k)) continue;
      if (!map.has(k)) map.set(k, typeof v === 'number' ? 'number' : 'text');
    }
  }
  return Array.from(map.entries()).map(([key, type]) => ({ key, type }));
}

function toArr(val) {
  if (val === undefined || val === null) return [];
  return Array.isArray(val) ? val : [val];
}

function getText(val) {
  if (val === undefined || val === null) return '';
  if (typeof val === 'string') return val.trim();
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (typeof val === 'object') {
    const t = val['#text'];
    return t !== undefined ? String(t).trim() : '';
  }
  return '';
}

function decodeUtf8(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes.toString('utf8');
  return new TextDecoder('utf-8').decode(bytes);
}

function decodeBestEffort(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('latin1').decode(buffer);
  }
}

function buildCentralDirectoryOffsets(u8) {
  const map = new Map();
  const minEocd = 22;
  if (u8.length < minEocd) return map;

  let eocdPos = -1;
  for (let i = u8.length - minEocd; i >= 0; i--) {
    if (readU32LE(u8, i) === 0x06054b50) { eocdPos = i; break; }
  }
  if (eocdPos === -1) return map;

  const cdSize   = readU32LE(u8, eocdPos + 12);
  const cdOffset = readU32LE(u8, eocdPos + 16);
  let p = cdOffset;
  const cdEnd = cdOffset + cdSize;

  while (p + 46 <= cdEnd && p + 46 <= u8.length) {
    if (readU32LE(u8, p) !== 0x02014b50) break;
    const compSize   = readU32LE(u8, p + 20);
    const uncompSize = readU32LE(u8, p + 24);
    const nameLen    = readU16LE(u8, p + 28);
    const extraLen   = readU16LE(u8, p + 30);
    const commentLen = readU16LE(u8, p + 32);
    const nameStart  = p + 46;
    const nameEnd    = nameStart + nameLen;
    if (nameEnd > u8.length) break;
    const name = decodeUtf8(u8.slice(nameStart, nameEnd)).replace(/\\/g, '/');
    map.set(name, { compSize, uncompSize });
    p = nameEnd + extraLen + commentLen;
  }
  return map;
}

function readU16LE(u8, off) {
  return (u8[off] | (u8[off + 1] << 8)) >>> 0;
}
function readU32LE(u8, off) {
  return (u8[off] | (u8[off+1] << 8) | (u8[off+2] << 16) | (u8[off+3] << 24)) >>> 0;
}
function stripExt(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}
