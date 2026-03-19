/*
  GeoPoints → CSV (Native) - ZIP writer
  Copyright © 2026 Devin Frederick
*/

/**
 * Minimal in-memory ZIP writer using the STORE method (no compression).
 *
 * Usage:
 *   const zip = new ZipWriter();
 *   zip.addFile('data.csv', csvBytes);
 *   zip.addFile('other.kml', kmlBytes);
 *   const zipBytes = zip.finish(); // Uint8Array
 */
export class ZipWriter {
  constructor() {
    this.files = [];   // metadata + bytes for each added entry
    this.chunks = [];  // accumulated byte chunks for the archive body
    this.offset = 0;   // running byte offset (used to record local header positions)
  }

  /**
   * Add a file entry to the archive.
   * @param {string}     name  - File path inside the ZIP (slashes normalised, no traversal).
   * @param {Uint8Array} bytes - Raw file content (not compressed).
   */
  addFile(name, bytes) {
    if (!(bytes instanceof Uint8Array)) {
      throw new Error("bytes must be Uint8Array");
    }
    name = normalizeName(name);

    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(bytes);

    const localHeader = buildLocalFileHeader(nameBytes, crc, bytes.length);
    const localOffset = this.offset;

    this._push(localHeader);
    this._push(nameBytes);
    this._push(bytes);

    this.files.push({
      name,
      nameBytes,
      bytes,
      crc32: crc,
      size: bytes.length,
      localOffset
    });
  }

  /**
   * Write the central directory and end-of-central-directory record, then
   * concatenate all chunks into a single Uint8Array ZIP archive.
   * @returns {Uint8Array}
   */
  finish() {
    const centralDirStart = this.offset;

    for (const f of this.files) {
      const cdr = buildCentralDirectoryRecord(
        f.nameBytes,
        f.crc32,
        f.size,
        f.localOffset
      );
      this._push(cdr);
      this._push(f.nameBytes);
    }

    const centralDirSize = this.offset - centralDirStart;

    const eocd = buildEndOfCentralDirectory(
      this.files.length,
      centralDirSize,
      centralDirStart
    );
    this._push(eocd);

    const out = new Uint8Array(this.offset);
    let p = 0;
    for (const c of this.chunks) {
      out.set(c, p);
      p += c.length;
    }
    return out;
  }

  _push(u8) {
    this.chunks.push(u8);
    this.offset += u8.length;
  }
}

/** Sanitise a filename for use inside a ZIP: forward slashes only, no path traversal, never empty. */
function normalizeName(name) {
  name = name.replace(/\\/g, "/");
  name = name.replace(/^(\.\.\/)+/g, "");
  name = name.replace(/^\//g, "");
  if (!name) name = "file.bin";
  return name;
}

function u16(n) {
  const b = new Uint8Array(2);
  b[0] = n & 0xff;
  b[1] = (n >>> 8) & 0xff;
  return b;
}
function u32(n) {
  const b = new Uint8Array(4);
  b[0] = n & 0xff;
  b[1] = (n >>> 8) & 0xff;
  b[2] = (n >>> 16) & 0xff;
  b[3] = (n >>> 24) & 0xff;
  return b;
}
function concat(...parts) {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function buildLocalFileHeader(nameBytes, crc, size) {
  return concat(
    u32(0x04034b50),
    u16(20),
    u16(0),
    u16(0),
    u16(0), u16(0),
    u32(crc >>> 0),
    u32(size),
    u32(size),
    u16(nameBytes.length),
    u16(0)
  );
}

function buildCentralDirectoryRecord(nameBytes, crc, size, localOffset) {
  return concat(
    u32(0x02014b50),
    u16(20),
    u16(20),
    u16(0),
    u16(0),
    u16(0), u16(0),
    u32(crc >>> 0),
    u32(size),
    u32(size),
    u16(nameBytes.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(localOffset)
  );
}

function buildEndOfCentralDirectory(totalEntries, centralSize, centralOffset) {
  return concat(
    u32(0x06054b50),
    u16(0), u16(0),
    u16(totalEntries),
    u16(totalEntries),
    u32(centralSize),
    u32(centralOffset),
    u16(0)
  );
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/** Standard CRC-32 using the Castagnoli polynomial (required by the ZIP spec). */
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}
