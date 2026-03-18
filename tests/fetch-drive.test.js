// tests/fetch-drive.test.js
// Google Drive fetch is not included in the simple version — no tests needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('fetch-drive: not included in simple version', () => {
  assert.ok(true, 'Google Drive feature removed — skipped');
});
