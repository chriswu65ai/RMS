import test from 'node:test';
import assert from 'node:assert/strict';
import { generateText } from './agentApi.js';

const encoder = new TextEncoder();

const makeNdjsonResponse = (lines: string[]) => new Response(new ReadableStream({
  start(controller) {
    controller.enqueue(encoder.encode(`${lines.join('\n')}\n`));
    controller.close();
  },
}), {
  headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
});

test('generateText parses sources events and forwards them to callback', async () => {
  const originalFetch = globalThis.fetch;
  const seenSources: Array<{ title: string; url: string }> = [];

  globalThis.fetch = async () => makeNdjsonResponse([
    JSON.stringify({ type: 'status', stage: 'started' }),
    JSON.stringify({
      type: 'sources',
      sources: [{ title: 'Doc', url: 'https://example.com/doc', snippet: 'snippet', provider: 'duckduckgo' }],
    }),
    JSON.stringify({ type: 'done', outputText: 'final output' }),
  ]);

  try {
    const result = await generateText({
      provider: 'openai',
      model: 'gpt-4.1',
      noteId: 'note-1',
      inputText: 'hello',
      triggerSource: 'manual',
      saveMode: 'manual_only',
      onSources: (sources) => {
        seenSources.push(...sources.map((source) => ({ title: source.title, url: source.url })));
      },
    });

    assert.equal(result.outputText, 'final output');
    assert.deepEqual(seenSources, [{ title: 'Doc', url: 'https://example.com/doc' }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generateText surfaces search_warning events', async () => {
  const originalFetch = globalThis.fetch;
  const warnings: string[] = [];

  globalThis.fetch = async () => makeNdjsonResponse([
    JSON.stringify({ type: 'search_warning', message: 'provider unavailable' }),
    JSON.stringify({ type: 'done', outputText: 'ok' }),
  ]);

  try {
    const result = await generateText({
      provider: 'openai',
      model: 'gpt-4.1',
      noteId: 'note-2',
      inputText: 'hello',
      triggerSource: 'manual',
      saveMode: 'manual_only',
      onSearchWarning: (message) => warnings.push(message),
    });

    assert.equal(result.outputText, 'ok');
    assert.deepEqual(warnings, ['provider unavailable']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generateText forwards thinking stream events', async () => {
  const originalFetch = globalThis.fetch;
  const seenEvents: Array<{ type: string; toolName?: string; summary?: string }> = [];

  globalThis.fetch = async () => makeNdjsonResponse([
    JSON.stringify({ type: 'tool_call_started', tool_name: 'web_search', tool_call_id: 'call_1', message: 'Searching...' }),
    JSON.stringify({ type: 'tool_call_result', tool_name: 'web_search', tool_call_id: 'call_1', message: 'Found results' }),
    JSON.stringify({ type: 'tool_call_failed', tool_name: 'web_fetch', tool_call_id: 'call_2', message: 'Timeout' }),
    JSON.stringify({ type: 'provider_summary', text: 'Compared and synthesized sources.' }),
    JSON.stringify({ type: 'done', outputText: 'ok' }),
  ]);

  try {
    const result = await generateText({
      provider: 'openai',
      model: 'gpt-4.1',
      noteId: 'note-3',
      inputText: 'hello',
      triggerSource: 'manual',
      saveMode: 'manual_only',
      onThinkingEvent: (event) => {
        seenEvents.push({
          type: event.type,
          toolName: 'toolName' in event ? event.toolName : undefined,
          summary: event.type === 'reasoning' ? event.summary : undefined,
        });
      },
    });

    assert.equal(result.outputText, 'ok');
    assert.deepEqual(seenEvents, [
      { type: 'tool_call_started', toolName: 'web_search', summary: undefined },
      { type: 'tool_call_result', toolName: 'web_search', summary: undefined },
      { type: 'tool_call_failed', toolName: 'web_fetch', summary: undefined },
      { type: 'reasoning', toolName: undefined, summary: 'Compared and synthesized sources.' },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
