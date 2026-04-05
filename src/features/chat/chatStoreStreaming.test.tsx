import test from 'node:test';
import assert from 'node:assert/strict';
import { useChatStore } from '../../hooks/useChatStore.js';

const flushMicrotasks = async () => new Promise((resolve) => setImmediate(resolve));

test('chat store streaming resilience keeps retry flow when a stream fails', async () => {
  const originalWindow = (globalThis as { window?: unknown }).window;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;

  const fakeWindow = {
    setTimeout: ((cb: () => void) => {
      cb();
      return 1;
    }) as unknown as typeof globalThis.setTimeout,
    clearTimeout: (() => {}) as typeof globalThis.clearTimeout,
  };

  (globalThis as { window?: unknown }).window = fakeWindow;
  globalThis.setTimeout = fakeWindow.setTimeout;
  globalThis.clearTimeout = fakeWindow.clearTimeout;

  try {
    useChatStore.setState({ messages: [], running: false, lastError: null });
    useChatStore.getState().sendMessage('please fail this stream');
    await flushMicrotasks();

    const state = useChatStore.getState();
    const assistant = state.messages.find((message) => message.role === 'assistant');

    assert.equal(state.running, false);
    assert.equal(state.lastError, 'The stream failed before completion. You can retry.');
    assert.equal(assistant?.status, 'error');
    assert.equal(typeof assistant?.retryablePrompt, 'string');
    assert.equal((assistant?.traces.length ?? 0) > 0, true);
    assert.equal(assistant?.traces.some((trace) => trace.status === 'failed'), true);

    useChatStore.getState().retryMessage(assistant?.id ?? 'missing');
    await flushMicrotasks();

    const retried = useChatStore.getState();
    assert.equal(retried.messages.at(-1)?.role, 'assistant');
    assert.equal(retried.messages.at(-1)?.status, 'error');
  } finally {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});
