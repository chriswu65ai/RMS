import test from 'node:test';
import assert from 'node:assert/strict';
import { createUiAsyncGuard, runUiAsync } from './uiAsync.js';

test('runUiAsync catches rejected async work and reports a recoverable message', async () => {
  let statusMessage: string | null = null;

  await runUiAsync(
    async () => {
      throw new Error('Attachment API failed');
    },
    {
      fallbackMessage: 'Fallback error.',
      onError: (message) => {
        statusMessage = message;
      },
    },
  );

  assert.equal(statusMessage, 'Attachment API failed');
});

test('runUiAsync does not leak unhandled rejection events for rejected operations', async () => {
  let unhandledCount = 0;
  const onUnhandled = () => {
    unhandledCount += 1;
  };
  process.on('unhandledRejection', onUnhandled);

  try {
    await runUiAsync(
      async () => {
        throw new Error('List attachments blew up');
      },
      {
        fallbackMessage: 'Unable to list attachments.',
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(unhandledCount, 0);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('createUiAsyncGuard prevents success/error callbacks after cancellation', async () => {
  const guard = createUiAsyncGuard();
  let successCalls = 0;
  let errorCalls = 0;
  guard.cancel();

  await runUiAsync(
    async () => 'ok',
    {
      fallbackMessage: 'Should not be used',
      isCancelled: guard.isCancelled,
      onSuccess: () => {
        successCalls += 1;
      },
      onError: () => {
        errorCalls += 1;
      },
    },
  );

  await runUiAsync(
    async () => {
      throw new Error('nope');
    },
    {
      fallbackMessage: 'nope',
      isCancelled: guard.isCancelled,
      onSuccess: () => {
        successCalls += 1;
      },
      onError: () => {
        errorCalls += 1;
      },
    },
  );

  assert.equal(successCalls, 0);
  assert.equal(errorCalls, 0);
});
