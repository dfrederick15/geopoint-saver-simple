// tests/email-ingest.test.js
// Email ingest is not included in the simple version — no tests needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('email-ingest: not included in simple version', () => {
  assert.ok(true, 'Email ingest feature removed — skipped');
});
