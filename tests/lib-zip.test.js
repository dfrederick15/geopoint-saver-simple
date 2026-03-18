import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZipWriter } from '../lib-zip.js';

test('ZipWriter produces a valid ZIP with PK signature', () => {
  const zip = new ZipWriter();
  zip.addFile('hello.txt', new TextEncoder().encode('hello world'));
  const bytes = zip.finish();
  // ZIP local file header starts with PK\x03\x04
  assert.equal(bytes[0], 0x50); // P
  assert.equal(bytes[1], 0x4B); // K
  assert.equal(bytes[2], 0x03);
  assert.equal(bytes[3], 0x04);
});

test('ZipWriter end-of-central-directory signature present', () => {
  const zip = new ZipWriter();
  zip.addFile('a.csv', new TextEncoder().encode('col1,col2\n1,2\n'));
  const bytes = zip.finish();
  // End of central directory record: PK\x05\x06
  let found = false;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (bytes[i] === 0x50 && bytes[i+1] === 0x4B && bytes[i+2] === 0x05 && bytes[i+3] === 0x06) {
      found = true;
      break;
    }
  }
  assert.ok(found, 'End-of-central-directory record not found');
});
