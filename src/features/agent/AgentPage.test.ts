import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSaveDefaultsPayload, getMirroredOllamaDraftModel } from './ollamaModelSync.js';
import { buildWebSearchSettingsPayload, getWebSearchSourceCitationDefault } from './webSearchSettings.js';
import { getWebSearchWarningBannerMessage } from './activityWarnings.js';
import type { AgentActivityLog } from './types.js';

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
    sourceCitation: false,
    searxngBaseUrl: 'http://localhost:8080',
    searxngUseJsonApi: true,
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
    source_citation: false,
  });
});

test('web search save payload includes source_citation when enabled', () => {
  const payload = buildWebSearchSettingsPayload({
    default_provider: 'openai',
    default_model: 'gpt-4.1',
    generation_params: {},
  }, {
    enabled: true,
    provider: 'duckduckgo',
    mode: 'single',
    maxResults: '5',
    timeoutMs: '5000',
    safeSearch: true,
    recency: 'any',
    domainPolicy: 'open_web',
    sourceCitation: true,
    searxngBaseUrl: 'http://localhost:8080',
    searxngUseJsonApi: true,
  });

  assert.equal(payload.generation_params?.web_search?.source_citation, true);
});

test('web search save payload stores searxng provider config under provider_config.searxng', () => {
  const payload = buildWebSearchSettingsPayload({
    default_provider: 'openai',
    default_model: 'gpt-4.1',
    generation_params: {},
  }, {
    enabled: true,
    provider: 'searxng',
    mode: 'single',
    maxResults: '5',
    timeoutMs: '5000',
    safeSearch: true,
    recency: 'any',
    domainPolicy: 'open_web',
    sourceCitation: false,
    searxngBaseUrl: 'http://127.0.0.1:8080',
    searxngUseJsonApi: false,
  });

  assert.deepEqual(payload.generation_params?.web_search?.provider_config, {
    searxng: {
      base_url: 'http://127.0.0.1:8080',
      use_json_api: false,
    },
  });
});

test('web search source citation UI default is unchecked for fresh and legacy settings', () => {
  assert.equal(getWebSearchSourceCitationDefault(undefined), false);
  assert.equal(getWebSearchSourceCitationDefault(false), false);
});

const makeActivityEntry = (overrides: Partial<AgentActivityLog>): AgentActivityLog => ({
  id: 'log-1',
  timestamp: '2026-04-04T00:00:00.000Z',
  note_id: '',
  action: 'generate',
  trigger_source: 'manual',
  initiated_by: 'user',
  provider: 'openai',
  model: 'gpt-4.1',
  status: 'success',
  duration_ms: 100,
  input_chars: 10,
  output_chars: 20,
  token_estimate: 12,
  cost_estimate_usd: 0.001,
  error_message_short: null,
  search_warning: 0,
  search_warning_message: null,
  ...overrides,
});

test('web search warning banner shows fail-open warning for successful generation entries', () => {
  const message = getWebSearchWarningBannerMessage([
    makeActivityEntry({
      status: 'success',
      search_warning: 1,
      search_warning_message: 'DuckDuckGo timed out',
    }),
  ], true);
  assert.equal(message, 'Web search is enabled, but recent runs reported search warnings: DuckDuckGo timed out');
});

test('web search warning banner is hidden when web search is disabled', () => {
  const message = getWebSearchWarningBannerMessage([
    makeActivityEntry({
      search_warning: 1,
      search_warning_message: 'DuckDuckGo timed out',
    }),
  ], false);
  assert.equal(message, '');
});
