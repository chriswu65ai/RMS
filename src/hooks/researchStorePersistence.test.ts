import test from 'node:test';
import assert from 'node:assert/strict';
import { GENERATION_INTERRUPTED_MESSAGE, sanitizePersistedGenerateJobsByFileId } from './researchStorePersistence.js';

test('rehydration sanitizes running jobs to failed interruptions', () => {
  const sanitized = sanitizePersistedGenerateJobsByFileId({
    fileA: { status: 'running' },
  });

  assert.deepEqual(sanitized, {
    fileA: {
      status: 'failed',
      error: GENERATION_INTERRUPTED_MESSAGE,
    },
  });
});

test('rehydration keeps only terminal statuses and drops idle/unknown jobs', () => {
  const sanitized = sanitizePersistedGenerateJobsByFileId({
    fileCompleted: { status: 'completed', completedAt: 1700000000000 },
    fileFailed: { status: 'failed', error: 'rate limit' },
    fileIdle: { status: 'idle' },
    fileUnknown: { status: 'queued' },
  });

  assert.deepEqual(sanitized, {
    fileCompleted: { status: 'completed', completedAt: 1700000000000 },
    fileFailed: { status: 'failed', error: 'rate limit' },
  });
});

test('rehydration can clear all persisted generate jobs when history is disabled', () => {
  const sanitized = sanitizePersistedGenerateJobsByFileId(
    {
      fileA: { status: 'completed', completedAt: 1700000000000 },
      fileB: { status: 'failed', error: 'bad request' },
      fileC: { status: 'running' },
    },
    { keepTerminalStatuses: false },
  );

  assert.deepEqual(sanitized, {});
});
