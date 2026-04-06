import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildSaveDefaultsPayload, getMirroredOllamaDraftModel, resolveOllamaFallbackSelectedModel } from './ollamaModelSync.js';
import {
  buildWebSearchSettingsPayload,
  convertTimeoutMsToSeconds,
  getRecommendedPresetForMode,
  getWebSearchSourceCitationDefault,
  shouldShowSearxngConfigFields,
  WEB_SEARCH_MODE_RECOMMENDED_PRESETS,
  WEB_SEARCH_MODE_OPTIONS,
  WEB_SEARCH_PROVIDER_CAPABILITIES,
  WEB_SEARCH_PROVIDER_OPTIONS,
} from './webSearchSettings.js';

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
    timeoutSeconds: '',
    safeSearch: false,
    recency: '30d',
    domainPolicy: 'prefer_list',
    sourceCitation: false,
    searxngBaseUrl: 'http://localhost:8080',
    searxngUseHtmlMode: false,
  });

  assert.equal(payload.generation_params?.temperature, 0.2);
  assert.equal(payload.generation_params?.local_connection?.base_url, 'http://localhost:11434');
  assert.deepEqual(payload.generation_params?.web_search, {
    enabled: true,
    provider: 'duckduckgo',
    mode: 'deep',
    max_results: 6,
    timeout_ms: 10000,
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
    timeoutSeconds: '5',
    safeSearch: false,
    recency: 'any',
    domainPolicy: 'open_web',
    sourceCitation: true,
    searxngBaseUrl: 'http://localhost:8080',
    searxngUseHtmlMode: false,
  });

  assert.equal(payload.generation_params?.web_search?.source_citation, true);
});

test('web search save payload maps HTML toggle to inverted searxng use_json_api flag', () => {
  const payload = buildWebSearchSettingsPayload({
    default_provider: 'openai',
    default_model: 'gpt-4.1',
    generation_params: {},
  }, {
    enabled: true,
    provider: 'searxng',
    mode: 'single',
    maxResults: '5',
    timeoutSeconds: '5',
    safeSearch: true,
    recency: 'any',
    domainPolicy: 'open_web',
    sourceCitation: false,
    searxngBaseUrl: 'http://127.0.0.1:8080',
    searxngUseHtmlMode: true,
  });

  assert.deepEqual(payload.generation_params?.web_search?.provider_config, {
    searxng: {
      base_url: 'http://127.0.0.1:8080',
      use_json_api: false,
    },
  });
});

test('web search save payload keeps JSON API enabled when HTML toggle is unchecked', () => {
  const payload = buildWebSearchSettingsPayload({
    default_provider: 'openai',
    default_model: 'gpt-4.1',
    generation_params: {},
  }, {
    enabled: true,
    provider: 'searxng',
    mode: 'single',
    maxResults: '5',
    timeoutSeconds: '5',
    safeSearch: true,
    recency: 'any',
    domainPolicy: 'open_web',
    sourceCitation: false,
    searxngBaseUrl: 'http://127.0.0.1:8080',
    searxngUseHtmlMode: false,
  });

  assert.equal(payload.generation_params?.web_search?.provider_config?.searxng?.use_json_api, true);
});

test('web search save payload normalizes searxng base URL by removing trailing slashes', () => {
  const payload = buildWebSearchSettingsPayload({
    default_provider: 'openai',
    default_model: 'gpt-4.1',
    generation_params: {},
  }, {
    enabled: true,
    provider: 'searxng',
    mode: 'single',
    maxResults: '5',
    timeoutSeconds: '5',
    safeSearch: true,
    recency: 'any',
    domainPolicy: 'open_web',
    sourceCitation: false,
    searxngBaseUrl: 'http://127.0.0.1:8080///',
    searxngUseHtmlMode: false,
  });

  assert.equal(payload.generation_params?.web_search?.provider_config?.searxng?.base_url, 'http://127.0.0.1:8080');
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
    { value: 'deep', label: 'Extended search', helper: 'Allow up to three web_search tool calls for broader coverage.' },
  ]);
});

test('web search mode recommended presets expose single and extended defaults', () => {
  assert.deepEqual(WEB_SEARCH_MODE_RECOMMENDED_PRESETS, {
    single: { maxResults: 6, timeoutSeconds: 10 },
    deep: { maxResults: 10, timeoutSeconds: 18 },
  });
  assert.deepEqual(getRecommendedPresetForMode('single'), { maxResults: 6, timeoutSeconds: 10 });
  assert.deepEqual(getRecommendedPresetForMode('deep'), { maxResults: 10, timeoutSeconds: 18 });
});

test('timeout conversion helpers map seconds to milliseconds and back', () => {
  const payload = buildWebSearchSettingsPayload({
    default_provider: 'openai',
    default_model: 'gpt-4.1',
    generation_params: {},
  }, {
    enabled: true,
    provider: 'duckduckgo',
    mode: 'single',
    maxResults: '6',
    timeoutSeconds: '18',
    safeSearch: false,
    recency: 'any',
    domainPolicy: 'open_web',
    sourceCitation: false,
    searxngBaseUrl: 'http://localhost:8080',
    searxngUseHtmlMode: false,
  });
  assert.equal(payload.generation_params?.web_search?.timeout_ms, 18000);
  assert.equal(convertTimeoutMsToSeconds(18000), 18);
});

test('web search provider capabilities mark duckduckgo controls as unsupported', () => {
  assert.deepEqual(WEB_SEARCH_PROVIDER_CAPABILITIES.duckduckgo, { recency: false, safeSearch: false });
  assert.deepEqual(WEB_SEARCH_PROVIDER_CAPABILITIES.searxng, { recency: true, safeSearch: true });
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
    timeoutSeconds: '3',
    safeSearch: true,
    recency: '7d',
    domainPolicy: 'open_web',
    sourceCitation: false,
    searxngBaseUrl: 'http://localhost:8080',
    searxngUseHtmlMode: false,
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
    timeoutSeconds: '3',
    safeSearch: true,
    recency: 'any',
    domainPolicy: 'open_web',
    sourceCitation: false,
    searxngBaseUrl: 'http://10.11.10.11:2000',
    searxngUseHtmlMode: true,
  });

  assert.equal(payload.generation_params?.web_search?.provider, 'duckduckgo');
  assert.equal(payload.generation_params?.web_search?.provider_config, undefined);
});


test('AgentPage disables model select when no catalog models are available', () => {
  const source = readFileSync(path.resolve(process.cwd(), 'src/features/agent/AgentPage.tsx'), 'utf-8');
  assert.equal(source.includes('const modelOptions = models;'), true);
  assert.equal(source.includes('disabled={modelState.loading || modelOptions.length === 0}'), true);
});

test('AgentPage empty-model status message instructs user to refresh live discovery', () => {
  const source = readFileSync(path.resolve(process.cwd(), 'src/features/agent/AgentPage.tsx'), 'utf-8');
  assert.equal(source.includes('No models available yet. Press Refresh models to run live discovery.'), true);
});

test('AgentPage clears selected model when refreshed list no longer contains it', () => {
  const source = readFileSync(path.resolve(process.cwd(), 'src/features/agent/AgentPage.tsx'), 'utf-8');
  assert.equal(source.includes("const normalizedSelectedModel = selectedModelStillAvailable ? nextSelectedModel : '';"), true);
  assert.equal(source.includes('if (!currentSelectionStillAvailable) {'), true);
});


test('local runtime save button requires only base URL so URL can be persisted before model discovery succeeds', () => {
  const source = readFileSync(path.resolve(process.cwd(), 'src/features/agent/AgentPage.tsx'), 'utf-8');
  assert.equal(source.includes('const canSaveLocalDefaults = localBaseUrl.trim().length > 0;'), true);
  assert.equal(source.includes("const canonicalModel = localModelValue.trim() || persistedModel;"), true);
});

test('local runtime actions render Save local settings before Refresh models', () => {
  const source = readFileSync(path.resolve(process.cwd(), 'src/features/agent/AgentPage.tsx'), 'utf-8');
  const localActionsStart = source.indexOf('<div className="mt-3 flex gap-2">');
  const saveIndex = source.indexOf('Save local settings', localActionsStart);
  const refreshIndex = source.indexOf('Refresh models', localActionsStart);
  assert.ok(localActionsStart >= 0);
  assert.ok(saveIndex > localActionsStart);
  assert.ok(refreshIndex > saveIndex);
});
test('AgentPage UI no longer references the top web-search warning banner message', () => {
  const source = readFileSync(path.resolve(process.cwd(), 'src/features/agent/AgentPage.tsx'), 'utf-8');
  assert.equal(source.includes('Web search is enabled, but recent runs reported search warnings'), false);
});

test('AgentPage does not render a generic warning/error paragraph below the Activity log section', () => {
  const source = readFileSync(path.resolve(process.cwd(), 'src/features/agent/AgentPage.tsx'), 'utf-8');
  assert.equal(source.includes('{message ? <p className="text-sm text-rose-700">{message}</p> : null}'), false);
  assert.equal(source.includes('setActivityLogFeedbackMessage'), true);
});

test('AgentPage chat settings expose command prefix mode, editable command map, and active examples', () => {
  const source = readFileSync(path.resolve(process.cwd(), 'src/features/agent/AgentPage.tsx'), 'utf-8');
  assert.equal(source.includes('Enable command prefix mode for tool execution'), true);
  assert.equal(source.includes('Command prefixes'), true);
  assert.equal(source.includes("const CHAT_COMMAND_NAMES: ChatCommandName[] = ['task', 'note', 'confirm', 'cancel', 'help'];"), true);
  assert.equal(source.includes('Active commands:'), true);
  assert.equal(source.includes('setChatCommandPrefixMap((current) => ({ ...current, [commandName]: nextPrefix }));'), true);
});

test('AgentPage chat action mode normalization maps legacy act to confirm_required via raw string parsing', () => {
  const source = readFileSync(path.resolve(process.cwd(), 'src/features/agent/AgentPage.tsx'), 'utf-8');
  assert.equal(source.includes('const rawActionMode = chatPolicy.action_mode as string | undefined;'), true);
  assert.equal(source.includes("const normalizedActionMode: ChatActionMode = rawActionMode === 'confirm_required' || rawActionMode === 'manual_only'"), true);
  assert.equal(source.includes(": (rawActionMode === 'act' ? 'confirm_required' : 'assist');"), true);
  assert.equal(source.includes('setChatActionMode('), true);
  assert.equal(source.includes('normalizedActionMode,'), true);
});

test('AgentPage save chat settings payload includes command prefix mode and command prefix map', () => {
  const source = readFileSync(path.resolve(process.cwd(), 'src/features/agent/AgentPage.tsx'), 'utf-8');
  assert.equal(source.includes("command_prefix_mode: chatCommandPrefixMode ? 'on' : 'off'"), true);
  assert.equal(source.includes('command_prefix_map: chatCommandPrefixMap,'), true);
});

test('preferred source domain placeholder and validation copy use google.com examples', () => {
  const source = readFileSync(path.resolve(process.cwd(), 'src/features/agent/AgentPage.tsx'), 'utf-8');
  assert.equal(source.includes('placeholder="google.com"'), true);
  assert.equal(source.includes('Enter a valid domain like google.com (no protocol or path).'), true);
  assert.equal(source.includes('Domain must be valid, such as google.com.'), true);
});

test('domain policy labels and helper text are user-friendly and do not expose internal policy keys', () => {
  const source = readFileSync(path.resolve(process.cwd(), 'src/features/agent/AgentPage.tsx'), 'utf-8');
  assert.equal(source.includes("{ value: 'open_web', label: 'Use entire web' }"), true);
  assert.equal(source.includes("{ value: 'prefer_list', label: 'Use entire web + prioritize listed domains' }"), true);
  assert.equal(source.includes("{ value: 'only_list', label: 'Use only listed domains' }"), true);
  assert.equal(source.includes('open_web: Search the web normally'), false);
  assert.equal(source.includes('prefer_list (boost)'), false);
  assert.equal(source.includes('only_list (strict filter)'), false);
});

test('custom domain source section uses renamed source importance terminology and ranking explanation', () => {
  const source = readFileSync(path.resolve(process.cwd(), 'src/features/agent/AgentPage.tsx'), 'utf-8');
  assert.equal(source.includes('Custom domain sources'), true);
  assert.equal(source.includes('Source importance'), true);
  assert.equal(source.includes('Source importance helps ranking when domain policy is set to “Use entire web”'), true);
  assert.equal(source.includes('In “Use only listed domains,” source importance does not change rank; it only filters by domain.'), true);
});

test('source importance controls use canonical 1-100 range with slider + numeric input and dynamic label/color helpers', () => {
  const source = readFileSync(path.resolve(process.cwd(), 'src/features/agent/AgentPage.tsx'), 'utf-8');
  assert.equal(source.includes('const SOURCE_IMPORTANCE_MIN = 1;'), true);
  assert.equal(source.includes('const SOURCE_IMPORTANCE_MAX = 100;'), true);
  assert.equal(source.includes('if (normalized <= 20) return \'Low\';'), true);
  assert.equal(source.includes('return `hsl(${hue}, 75%, ${lightness}%)`;'), true);
  assert.equal(source.includes('type="range"'), true);
  assert.equal(source.includes('min={SOURCE_IMPORTANCE_MIN}'), true);
  assert.equal(source.includes('max={SOURCE_IMPORTANCE_MAX}'), true);
  assert.equal(source.includes('step={1}'), true);
  assert.equal(source.includes('type="number"'), true);
  assert.equal(source.includes('aria-label="Source importance numeric"'), true);
  assert.equal(source.includes('style={{ accentColor: getSourceImportanceColor(Number(newWeight) || 1) }}'), true);
  assert.equal(source.includes('style={{ accentColor: getSourceImportanceColor(Number(editingWeight) || 1) }}'), true);
});

test('preferred source table displays exact stored importance and label without hard clamp mismatch', () => {
  const source = readFileSync(path.resolve(process.cwd(), 'src/features/agent/AgentPage.tsx'), 'utf-8');
  assert.equal(source.includes('getSourceImportanceLabel(source.weight)'), true);
  assert.equal(source.includes('title={`Importance level ${source.weight} (${getSourceImportanceLabel(source.weight)})`}'), true);
  assert.equal(source.includes('<span className="ml-1 text-xs text-slate-400">({source.weight})</span>'), true);
});

test('preferred source payload clamps numeric input to canonical 1-100 before submit/edit', () => {
  const source = readFileSync(path.resolve(process.cwd(), 'src/features/agent/AgentPage.tsx'), 'utf-8');
  assert.equal(source.includes('const clampSourceImportance = (value: number) => Math.min(SOURCE_IMPORTANCE_MAX, Math.max(SOURCE_IMPORTANCE_MIN, value));'), true);
  assert.equal(source.includes('const normalizedWeight = clampSourceImportance(Number(newWeight) || 1);'), true);
  assert.equal(source.includes('const normalizedWeight = clampSourceImportance(Number(editingWeight) || 1);'), true);
  assert.equal(source.includes('weight: normalizedWeight,'), true);
});

test('web search controls render in expected order with checkbox row grouped at the bottom', () => {
  const source = readFileSync(path.resolve(process.cwd(), 'src/features/agent/AgentPage.tsx'), 'utf-8');
  const enableIndex = source.indexOf('<span>Enable web search</span>');
  const settingsGridIndex = source.indexOf('md:grid-cols-3');
  const checkboxRowIndex = source.indexOf('flex flex-wrap items-center gap-x-6 gap-y-3');
  const safeSearchIndex = source.indexOf('<span>Safe search</span>');
  assert.ok(enableIndex >= 0);
  assert.ok(settingsGridIndex > enableIndex);
  assert.ok(checkboxRowIndex > settingsGridIndex);
  assert.ok(safeSearchIndex > checkboxRowIndex);
});

test('AgentPage web search UI includes recommended action, timeout seconds label, helper copy, and provider capability notices', () => {
  const source = readFileSync(path.resolve(process.cwd(), 'src/features/agent/AgentPage.tsx'), 'utf-8');
  assert.equal(source.includes('Use recommended'), true);
  assert.equal(source.includes('Timeout (seconds)'), true);
  assert.equal(source.includes('Maximum results requested per search pass before deduplication.'), true);
  assert.equal(source.includes('Maximum wait time per provider request; timed-out passes may return no web evidence.'), true);
  assert.equal(source.includes('Not supported by DuckDuckGo adapter.'), true);
  assert.equal(source.includes('Safe search is not supported by DuckDuckGo adapter.'), true);
});

test('EditorPane thinking stream keeps a max-5 render policy and rotates queue in groups of five', () => {
  const source = readFileSync(path.resolve(process.cwd(), 'src/features/editor/EditorPane.tsx'), 'utf-8');
  assert.equal(source.includes('const THINKING_VISIBLE_LINE_LIMIT = 5;'), true);
  assert.equal(source.includes('currentQueue.slice(0, THINKING_VISIBLE_LINE_LIMIT)'), true);
  assert.equal(source.includes('thinkingVisibleLines.slice(0, THINKING_VISIBLE_LINE_LIMIT)'), true);
});

test('EditorPane thinking bubble lifecycle resets on run start and auto-closes on successful completion', () => {
  const source = readFileSync(path.resolve(process.cwd(), 'src/features/editor/EditorPane.tsx'), 'utf-8');
  assert.equal(source.includes("clearThinkingCloseTimer(file.id);"), true);
  assert.equal(source.includes("clearThinkingFadeTimer(file.id);"), true);
  assert.equal(source.includes("setThinkingQueueByFileId((current) => ({ ...current, [file.id]: [] }));"), true);
  assert.equal(source.includes("setThinkingVisibleLinesByFileId((current) => ({ ...current, [file.id]: [] }));"), true);
  assert.equal(source.includes("setThinkingBubbleClosedByFileId((current) => ({ ...current, [file.id]: false }));"), true);
  assert.equal(source.includes("window.setTimeout(() => {\n        setThinkingBubbleClosedByFileId((current) => ({ ...current, [file.id]: true }));\n      }, THINKING_SUCCESS_AUTO_CLOSE_MS);"), true);
});

test('EditorPane closes thinking bubble immediately on cancelled/failed runs and keeps per-note visibility state', () => {
  const source = readFileSync(path.resolve(process.cwd(), 'src/features/editor/EditorPane.tsx'), 'utf-8');
  const closeStateMatches = source.match(/setThinkingBubbleClosedByFileId\(\(current\) => \(\{ \.\.\.current, \[file\.id\]: true \}\)\);/g) ?? [];
  assert.ok(closeStateMatches.length >= 2);
  assert.equal(source.includes("const isThinkingBubbleClosed = thinkingBubbleClosedByFileId[file.id] ?? false;"), true);
});

test('EditorPane generate action still calls startGenerate and preserves citation/search callbacks for note generation', () => {
  const source = readFileSync(path.resolve(process.cwd(), 'src/features/editor/EditorPane.tsx'), 'utf-8');
  assert.equal(source.includes('const outputText = await startGenerate(targetFileId, {'), true);
  assert.equal(source.includes('onSources: (sources) => {'), true);
  assert.equal(source.includes('setGeneratedSourcesByFileId((current) => ({ ...current, [targetFileId]: sources }));'), true);
  assert.equal(source.includes('onSearchWarning: (message) => {'), true);
  assert.equal(source.includes('setSearchWarningMessage(message);'), true);
});

test('startGenerate pipeline still targets /api/agent/generate with manual note-generation trigger and citation forwarding', () => {
  const storeSource = readFileSync(path.resolve(process.cwd(), 'src/hooks/useResearchStore.ts'), 'utf-8');
  const generateUseCaseSource = readFileSync(path.resolve(process.cwd(), 'src/features/agent/GenerateUseCase.ts'), 'utf-8');
  const apiSource = readFileSync(path.resolve(process.cwd(), 'src/lib/agentApi.ts'), 'utf-8');

  assert.equal(storeSource.includes('onSources: (sources) => activeGenerationCallbacksByFileId.get(fileId)?.onSources?.(sources),'), true);
  assert.equal(generateUseCaseSource.includes('triggerSource: TriggerSource.Manual,'), true);
  assert.equal(generateUseCaseSource.includes('saveMode: SaveMode.ManualOnly,'), true);
  assert.equal(generateUseCaseSource.includes('onSources: params.onSources,'), true);
  assert.equal(apiSource.includes("const response = await fetch('/api/agent/generate', {"), true);
  assert.equal(apiSource.includes("if (payload.type === 'sources') {"), true);
  assert.equal(apiSource.includes('params.onSources?.(Array.isArray(payload.sources) ? payload.sources : []);'), true);
});
