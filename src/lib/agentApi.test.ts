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
