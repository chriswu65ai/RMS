import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPersistWriteGuard,
  trimPersistedDraftByFileId,
  trimPersistedHistoryByFileId,
} from './researchStorePersistence.js';

test('persist draft trimming drops oversized drafts and keeps newest entries', () => {
  const now = Date.now();
  const trimmed = trimPersistedDraftByFileId({
    old: { body: 'ok', updatedAt: now - 100 },
    newest: { body: 'ok', updatedAt: now },
    oversized: { body: 'x'.repeat(40_000), updatedAt: now + 1000 },
  });

  assert.deepEqual(Object.keys(trimmed), ['newest', 'old']);
  assert.equal(trimmed.oversized, undefined);
});

test('persist history trimming limits entry count', () => {
  const source = Object.fromEntries(Array.from({ length: 35 }, (_, index) => [`file-${index}`, { updatedAt: index }]));
  const trimmed = trimPersistedHistoryByFileId(source);

  assert.equal(Object.keys(trimmed).length, 30);
});

test('persist write guard throttles frequent writes and drops oversized payload', () => {
  let current = 1_000;
  const guard = createPersistWriteGuard({
    throttleMs: 100,
    maxSerializedChars: 20,
    now: () => current,
  });

  assert.deepEqual(guard.shouldWriteNow('short'), { ok: true });
  assert.deepEqual(guard.shouldWriteNow('still-short'), { ok: false, reason: 'throttle' });
  assert.equal(guard.consumePending(), null);
  current = 1_101;
  assert.equal(guard.consumePending(), 'still-short');
  assert.deepEqual(guard.shouldWriteNow('x'.repeat(21)), { ok: false, reason: 'size' });
});
