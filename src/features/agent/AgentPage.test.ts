import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSaveDefaultsPayload, getMirroredOllamaDraftModel, resolveOllamaFallbackSelectedModel } from './ollamaModelSync.js';
import {
  buildWebSearchSettingsPayload,
  getWebSearchSourceCitationDefault,
  shouldShowSearxngConfigFields,
  WEB_SEARCH_MODE_OPTIONS,
  WEB_SEARCH_PROVIDER_OPTIONS,
} from './webSearchSettings.js';
import { getWebSearchWarningBannerMessage } from './activityWarnings.js';
import type { AgentActivityLog } from './types.js';

test('top model selection mirrors into ollama runtime draft when provider is ollama', () => {
  assert.equal(getMirroredOllamaDraftModel('ollama', 'qwen2.5:14b', 'llama3.2:latest'), 'qwen2.5:14b');
  assert.equal(getMirroredOllamaDraftModel('openai', 'gpt-4.1', 'llama3.2:latest'), 'llama3.2:latest');
});

test('ollama unreachable fallback chooses selected model from fetched tags instead of stale placeholder', () => {
  const selectedModel = resolveOllamaFallbackSelectedModel(
    'llama3.2:latest',
    'mistral:7b',
    ['mistral:7b', 'qwen2.5:14b'],
    'placeholder-model',
  );
  assert.equal(selectedModel, 'mistral:7b');
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

test('web search provider dropdown options include SearXNG', () => {
  assert.deepEqual(WEB_SEARCH_PROVIDER_OPTIONS, [
    { value: 'duckduckgo', label: 'DuckDuckGo' },
    { value: 'searxng', label: 'SearXNG' },
  ]);
});

test('web search mode labels are renamed and helpers clarify pass count behavior', () => {
  assert.deepEqual(WEB_SEARCH_MODE_OPTIONS, [
    { value: 'single', label: 'Single search', helper: 'Run one web_search tool call.' },
    { value: 'deep', label: 'Extended search', helper: 'Allow up to two web_search tool calls for broader coverage.' },
  ]);
});

test('web search mode persists across save payload builds', () => {
  const payload = buildWebSearchSettingsPayload({
    default_provider: 'openai',
    default_model: 'gpt-4.1',
    generation_params: {},
  }, {
    enabled: true,
    provider: 'duckduckgo',
    mode: 'deep',
    maxResults: '5',
    timeoutMs: '3000',
    safeSearch: true,
    recency: '7d',
    domainPolicy: 'open_web',
    sourceCitation: false,
    searxngBaseUrl: 'http://localhost:8080',
    searxngUseJsonApi: true,
  });
  assert.equal(payload.generation_params?.web_search?.mode, 'deep');
});

test('SearXNG config controls show only when provider is searxng', () => {
  assert.equal(shouldShowSearxngConfigFields('duckduckgo'), false);
  assert.equal(shouldShowSearxngConfigFields('searxng'), true);
});

test('web search save payload omits searxng provider_config when provider is duckduckgo', () => {
  const payload = buildWebSearchSettingsPayload({
    default_provider: 'openai',
    default_model: 'gpt-4.1',
    generation_params: {},
  }, {
    enabled: true,
    provider: 'duckduckgo',
    mode: 'single',
    maxResults: '7',
    timeoutMs: '2500',
    safeSearch: true,
    recency: 'any',
    domainPolicy: 'open_web',
    sourceCitation: false,
    searxngBaseUrl: 'http://10.11.10.11:2000',
    searxngUseJsonApi: false,
  });

  assert.equal(payload.generation_params?.web_search?.provider, 'duckduckgo');
  assert.equal(payload.generation_params?.web_search?.provider_config, undefined);
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
