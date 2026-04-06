import test from 'node:test';
import assert from 'node:assert/strict';
import { useChatStore } from '../../hooks/useChatStore.js';

const flushMicrotasks = async () => new Promise((resolve) => setImmediate(resolve));
const encoder = new TextEncoder();

const jsonResponse = (payload: unknown, init?: ResponseInit) => new Response(JSON.stringify(payload), {
  status: init?.status ?? 200,
  headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
});

const ndjsonResponse = (lines: Array<Record<string, unknown>>) => new Response(new ReadableStream({
  start(controller) {
    lines.forEach((line) => controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`)));
    controller.close();
  },
}), { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });

test('chat store streaming resilience keeps retry flow when a stream fails', async () => {
  const originalWindow = (globalThis as { window?: unknown }).window;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalFetch = globalThis.fetch;

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
  let callCount = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/api/chat/session/current/messages?')) {
      return jsonResponse({ messages: [] });
    }
    if (url === '/api/chat/session/current/messages') {
      callCount += 1;
      if (callCount === 1) {
        return ndjsonResponse([
          { type: 'tool_planning_started' },
          { type: 'tool_planning_result', planned_tool_calls: [{ id: 'tool-1', name: 'create_task' }], message: 'Planned 1 tool call.' },
          { type: 'tool_call_started', tool_call_id: 'tool-1', tool_name: 'create_task', narration_before: 'planning' },
          { type: 'response_generation_started', trace_id: 'response-generation', trace_name: 'response_generation', message: 'Generating final response.' },
          { type: 'error', message: 'The stream failed before completion. You can retry.' },
        ]);
      }
      return ndjsonResponse([
        { type: 'response_generation_started', trace_id: 'response-generation', trace_name: 'response_generation', message: 'Generating final response.' },
        { type: 'response_generation_completed', trace_id: 'response-generation', trace_name: 'response_generation', message: 'Final response generated.' },
        { type: 'done', outputText: 'retry completed', latencyMs: 1 },
      ]);
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

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
    assert.equal(assistant?.traces.some((trace) => trace.toolName === 'tool_planning'), true);

    useChatStore.getState().retryMessage(assistant?.id ?? 'missing');
    await flushMicrotasks();

    const retried = useChatStore.getState();
    assert.equal(retried.messages.at(-1)?.role, 'assistant');
    assert.equal(retried.messages.at(-1)?.status, 'idle');
    assert.equal(retried.messages.at(-1)?.text, 'retry completed');
    assert.equal(retried.messages.at(-1)?.traces.some((trace) => trace.toolName === 'response_generation' && trace.detail === 'Final response generated.'), true);
    assert.equal(retried.messages.at(-1)?.traces.some((trace) => trace.detail === 'Output finalized.'), false);
  } finally {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    globalThis.fetch = originalFetch;
  }
});

test('chat store cancel marks in-flight assistant message as cancelled', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/api/chat/session/current/messages?')) return jsonResponse({ messages: [] });
    if (url === '/api/chat/session/current/messages') {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const rejectOnAbort = () => reject(new Error('aborted'));
        if (signal?.aborted) {
          rejectOnAbort();
          return;
        }
        signal?.addEventListener('abort', rejectOnAbort, { once: true });
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  try {
    useChatStore.setState({ messages: [], running: false, lastError: null });
    const sendPromise = useChatStore.getState().sendMessage('cancel me');
    await flushMicrotasks();
    useChatStore.getState().cancelActive();
    await sendPromise;
    const assistant = useChatStore.getState().messages.find((entry) => entry.role === 'assistant');
    assert.equal(useChatStore.getState().running, false);
    assert.equal(assistant?.status, 'error');
    assert.equal(assistant?.errorMessage, 'Cancelled before any output.');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('chat store history/export/reset-context helpers call expected endpoints', async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url}`);
    if (url.includes('/api/chat/session/current/messages?')) {
      return jsonResponse({
        messages: [{
          id: 'message-1',
          role: 'assistant',
          content: 'loaded',
          created_at: new Date().toISOString(),
        }],
      });
    }
    if (url.startsWith('/api/chat/session/current/history?range=all')) return jsonResponse({ deletedMessages: 2 });
    if (url === '/api/chat/session/current/reset-context') return jsonResponse({ ok: true });
    if (url === '/api/chat/session/current/export?format=json') return jsonResponse({ messages: [{ id: 'm1' }] });
    if (url === '/api/chat/session/current/export?format=markdown') return new Response('# transcript', { status: 200 });
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  try {
    useChatStore.setState({
      messages: [{ id: 'temp', role: 'assistant', text: 'stale', createdAt: Date.now(), status: 'idle', traces: [] }],
      running: false,
      lastError: null,
      initialized: true,
      initializing: false,
      hasOlderMessages: true,
    });
    await useChatStore.getState().clearHistory('all');
    assert.equal(useChatStore.getState().messages.length, 0);

    await useChatStore.getState().resetContext();
    assert.equal(useChatStore.getState().messages.some((message) => message.text === 'loaded'), true);

    const exportedJson = await useChatStore.getState().exportSession('json') as { messages?: Array<{ id: string }> };
    const exportedMarkdown = await useChatStore.getState().exportSession('markdown');
    assert.equal(exportedJson.messages?.[0]?.id, 'm1');
    assert.equal(exportedMarkdown, '# transcript');
    assert.equal(calls.some((call) => call === 'DELETE /api/chat/session/current/history?range=all'), true);
    assert.equal(calls.some((call) => call === 'POST /api/chat/session/current/reset-context'), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('chat store handles clarification-only turns without creating tool traces', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/api/chat/session/current/messages?')) return jsonResponse({ messages: [] });
    if (url === '/api/chat/session/current/messages') {
      return ndjsonResponse([
        { type: 'intent_routing', route: 'ambiguous', reason: 'needs_disambiguation' },
        { type: 'done', outputText: 'Do you want to run an action or just discuss this?' },
      ]);
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  try {
    useChatStore.setState({ messages: [], running: false, lastError: null });
    await useChatStore.getState().sendMessage('can you help with my tasks?');
    const assistant = useChatStore.getState().messages.find((message) => message.role === 'assistant');
    assert.equal(useChatStore.getState().running, false);
    assert.equal(assistant?.status, 'idle');
    assert.equal(assistant?.text, 'Do you want to run an action or just discuss this?');
    assert.equal(assistant?.traces.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
