import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatPageActionBindings } from './chatPageActionBindings.js';

test('chat page action bindings expose all retained chat store actions through UI handlers', async () => {
  const calls: string[] = [];
  const bindings = createChatPageActionBindings({
    sendMessage: async (prompt) => {
      calls.push(`send:${prompt}`);
    },
    retryMessage: async (messageId) => {
      calls.push(`retry:${messageId}`);
    },
    cancelActive: () => {
      calls.push('cancel');
    },
    clearError: () => {
      calls.push('dismiss-error');
    },
    loadOlderMessages: async () => {
      calls.push('load-older');
    },
    clearHistory: async (range) => {
      calls.push(`clear:${range ?? 'all'}`);
    },
    resetContext: async () => {
      calls.push('reset-context');
    },
    exportSession: async (format = 'json') => {
      calls.push(`export:${format}`);
      return { ok: true };
    },
  });

  await bindings.sendMessage('hello');
  await bindings.retryMessage('assistant-1');
  bindings.cancelActive();
  bindings.dismissError();
  await bindings.loadOlderMessages();
  await bindings.clearHistory();
  await bindings.resetContext();
  await bindings.exportJson();
  await bindings.exportMarkdown();

  assert.deepEqual(calls, [
    'send:hello',
    'retry:assistant-1',
    'cancel',
    'dismiss-error',
    'load-older',
    'clear:all',
    'reset-context',
    'export:json',
    'export:markdown',
  ]);
});
