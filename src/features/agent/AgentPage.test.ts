import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSaveDefaultsPayload, getMirroredOllamaDraftModel } from './ollamaModelSync.js';
import { buildWebSearchSettingsPayload } from './webSearchSettings.js';

test('top model selection mirrors into ollama runtime draft when provider is ollama', () => {
  assert.equal(getMirroredOllamaDraftModel('ollama', 'qwen2.5:14b', 'llama3.2:latest'), 'qwen2.5:14b');
  assert.equal(getMirroredOllamaDraftModel('openai', 'gpt-4.1', 'llama3.2:latest'), 'llama3.2:latest');
});

test('save defaults payload for ollama uses selected model and current base URL as source of truth', () => {
  const payload = buildSaveDefaultsPayload({
    default_provider: 'ollama',
    default_model: 'llama3.2:latest',
    generation_params: {
      local_connection: {
        base_url: 'http://localhost:11434',
        model: 'llama3.2:latest',
        B: 2,
      },
    },
  }, 'ollama', 'deepseek-r1:8b', 'http://127.0.0.1:11434');

  assert.equal(payload.default_provider, 'ollama');
  assert.equal(payload.default_model, 'deepseek-r1:8b');
  assert.equal(payload.generation_params?.local_connection?.base_url, 'http://127.0.0.1:11434');
  assert.equal(payload.generation_params?.local_connection?.model, 'deepseek-r1:8b');
  assert.equal(payload.generation_params?.local_connection?.B, 2);
});

test('web search save payload preserves existing params and normalizes numeric controls', () => {
  const payload = buildWebSearchSettingsPayload({
    default_provider: 'openai',
    default_model: 'gpt-4.1',
    generation_params: {
      temperature: 0.2,
      local_connection: {
        base_url: 'http://localhost:11434',
        model: 'llama3.2:latest',
        B: 1,
      },
    },
  }, {
    enabled: true,
    provider: 'duckduckgo',
    mode: 'deep',
    maxResults: '0',
    timeoutMs: '',
    safeSearch: false,
    recency: '30d',
    domainPolicy: 'prefer_list',
  });

  assert.equal(payload.generation_params?.temperature, 0.2);
  assert.equal(payload.generation_params?.local_connection?.base_url, 'http://localhost:11434');
  assert.deepEqual(payload.generation_params?.web_search, {
    enabled: true,
    provider: 'duckduckgo',
    mode: 'deep',
    max_results: 5,
    timeout_ms: 5000,
    safe_search: false,
    recency: '30d',
    domain_policy: 'prefer_list',
  });
});
