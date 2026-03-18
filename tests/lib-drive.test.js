// tests/lib-drive.test.js
// lib-drive.js is not included in the simple version — no tests needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('lib-drive: not included in simple version', () => {
  assert.ok(true, 'lib-drive feature removed — skipped');
});
