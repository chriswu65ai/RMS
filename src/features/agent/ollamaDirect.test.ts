import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchOllamaTagsDirect } from './ollamaDirect.js';

test('ollama_unreachable fallback can load /api/tags list directly from local runtime', async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify({
      models: [
        { name: 'llama3.1:8b' },
        { name: 'qwen2.5:14b' },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  try {
    const models = await fetchOllamaTagsDirect('http://host.docker.internal:11434/');
    assert.deepEqual(calls, ['http://host.docker.internal:11434/api/tags']);
    assert.deepEqual(models.map((entry) => entry.modelId), ['llama3.1:8b', 'qwen2.5:14b']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
