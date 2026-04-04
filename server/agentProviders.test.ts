import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { FALLBACK_MODELS, providerRegistry, selectBestModel, supportsToolCalling, type ModelListEntry } from './agentProviders.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const jsonResponse = (status: number, payload: unknown) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const sseResponse = (frames: unknown[]) => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
};

test('selectBestModel keeps preferred model when present in discovered models', () => {
  const discovered: ModelListEntry[] = [
    { modelId: 'gpt-4.1', displayName: 'GPT-4.1', B: 1 },
    { modelId: 'gpt-4.1-mini', displayName: 'GPT-4.1 mini', B: 1 },
  ];
  const selected = selectBestModel('openai', discovered, FALLBACK_MODELS.openai, 'gpt-4.1');
  assert.equal(selected.selected_model, 'gpt-4.1');
  assert.equal(selected.selection_source, 'live_catalog');
});

test('selectBestModel chooses provider-ranked live model when preferred is missing', () => {
  const discovered: ModelListEntry[] = [
    { modelId: 'gpt-4.1', displayName: 'GPT-4.1', B: 1 },
    { modelId: 'custom-model', displayName: 'Custom', B: 1 },
  ];
  const selected = selectBestModel('openai', discovered, FALLBACK_MODELS.openai, 'does-not-exist');
  assert.equal(selected.selected_model, 'gpt-4.1');
  assert.equal(selected.selection_source, 'live_catalog');
});

test('selectBestModel ensures non-empty fallback selection when live catalog is unavailable', () => {
  const selected = selectBestModel('anthropic', [], FALLBACK_MODELS.anthropic, 'claude-3-opus');
  assert.equal(selected.selected_model, FALLBACK_MODELS.anthropic[0]?.modelId);
  assert.equal(selected.selection_source, 'provider_fallback');
});

test('openai live discovery success filters non-generation models and selects ranked model', async () => {
  globalThis.fetch = async (input) => {
    assert.equal(String(input), 'https://api.openai.com/v1/models');
    return jsonResponse(200, {
      data: [
        { id: 'text-embedding-3-small' },
        { id: 'gpt-4.1' },
        { id: 'gpt-4.1-mini' },
      ],
    });
  };

  const result = await providerRegistry.openai.listModels('test-key', { fallbackModels: FALLBACK_MODELS.openai });
  assert.equal(result.catalog_status, 'live');
  assert.equal(result.reason_code, 'ok');
  assert.equal(result.selected_model, 'gpt-4.1-mini');
  assert.deepEqual(result.models.map((m) => m.modelId), ['gpt-4.1-mini', 'gpt-4.1']);
  assert.ok(result.models.every((m) => m.B === 1));
});

test('anthropic live discovery success returns claude models', async () => {
  globalThis.fetch = async (input) => {
    assert.equal(String(input), 'https://api.anthropic.com/v1/models');
    return jsonResponse(200, {
      data: [
        { id: 'claude-3-5-sonnet-latest', display_name: 'Claude 3.5 Sonnet' },
        { id: 'claude-3-5-haiku-latest', display_name: 'Claude 3.5 Haiku' },
      ],
    });
  };

  const result = await providerRegistry.anthropic.listModels('test-key', { fallbackModels: FALLBACK_MODELS.anthropic });
  assert.equal(result.catalog_status, 'live');
  assert.equal(result.reason_code, 'ok');
  assert.equal(result.selected_model, 'claude-3-5-sonnet-latest');
});

test('minimax unsupported listing returns fallback with unsupported status', async () => {
  globalThis.fetch = async () => jsonResponse(404, {});

  const result = await providerRegistry.minimax.listModels('test-key', { fallbackModels: FALLBACK_MODELS.minimax });
  assert.equal(result.catalog_status, 'unsupported');
  assert.equal(result.reason_code, 'unsupported_endpoint');
  assert.equal(result.selection_source, 'provider_fallback');
  assert.equal(result.selected_model, FALLBACK_MODELS.minimax[0]?.modelId);
});

test('empty live list response maps to empty_response and fallback', async () => {
  globalThis.fetch = async () => jsonResponse(200, { data: [] });

  const result = await providerRegistry.openai.listModels('test-key', { fallbackModels: FALLBACK_MODELS.openai });
  assert.equal(result.catalog_status, 'failed');
  assert.equal(result.reason_code, 'empty_response');
  assert.equal(result.selection_source, 'provider_fallback');
  assert.equal(result.selected_model, FALLBACK_MODELS.openai[0]?.modelId);
});

test('auth failure classification is normalized', async () => {
  globalThis.fetch = async () => jsonResponse(401, {});

  const result = await providerRegistry.anthropic.listModels('bad-key', { fallbackModels: FALLBACK_MODELS.anthropic });
  assert.equal(result.catalog_status, 'failed');
  assert.equal(result.reason_code, 'auth_failed');
  assert.equal(result.selected_model, FALLBACK_MODELS.anthropic[0]?.modelId);
});

test('selected_model remains populated whenever fallback has a valid entry', async () => {
  globalThis.fetch = async () => {
    throw new Error('network down');
  };

  const result = await providerRegistry.openai.listModels('test-key', { fallbackModels: FALLBACK_MODELS.openai });
  assert.equal(result.catalog_status, 'failed');
  assert.ok(result.selected_model.length > 0);
  assert.equal(result.selected_model, FALLBACK_MODELS.openai[0]?.modelId);
});

test('ollama returns explicit unreachable reason when local daemon is down', async () => {
  globalThis.fetch = async () => {
    throw new Error('connection refused');
  };

  const result = await providerRegistry.ollama.listModels('', { fallbackModels: FALLBACK_MODELS.ollama, baseUrl: 'http://localhost:11434' });
  assert.equal(result.catalog_status, 'failed');
  assert.equal(result.reason_code, 'ollama_unreachable');
});

test('selectBestModel keeps ollama preferred model stable when live list contains it', () => {
  const discovered: ModelListEntry[] = [
    { modelId: 'llama3.1:8b', displayName: 'Llama 3.1 8B', B: 1 },
    { modelId: 'qwen2.5:14b', displayName: 'Qwen 2.5 14B', B: 1 },
  ];
  const selected = selectBestModel('ollama', discovered, FALLBACK_MODELS.ollama, 'qwen2.5:14b');
  assert.equal(selected.selected_model, 'qwen2.5:14b');
  assert.equal(selected.selection_source, 'live_catalog');
});

test('supportsToolCalling requires a non-empty model id', () => {
  assert.equal(supportsToolCalling('openai', ''), false);
  assert.equal(supportsToolCalling('openai', 'gpt-4.1-mini'), true);
});

test('openai tool first turn parses tool call payload and followup forwards tool results', async () => {
  const seenBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    seenBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    return jsonResponse(200, {
      choices: [{
        message: {
          tool_calls: [{ id: 'call-1', function: { name: 'web_search', arguments: '{"query":"nvidia earnings"}' } }],
          content: 'tool requested',
        },
      }],
    });
  };
  const tool = { name: 'web_search', description: 'Search', input_schema: { type: 'object' } };
  const first = await providerRegistry.openai.generateToolFirstTurn({ model: 'gpt-4.1', inputText: 'Find latest', tools: [tool] }, 'test-key');
  assert.equal(first.toolCalls[0]?.name, 'web_search');
  assert.deepEqual(first.toolCalls[0]?.arguments, { query: 'nvidia earnings' });

  await providerRegistry.openai.generateToolFollowupTurn({
    model: 'gpt-4.1',
    inputText: 'Find latest',
    tools: [tool],
    toolCalls: [{ id: 'call-1', name: 'web_search', arguments: { query: 'nvidia earnings' } }],
    toolResults: [{ tool_call_id: 'call-1', name: 'web_search', result: '[]' }],
  }, 'test-key');

  const followupMessages = seenBodies[1]?.messages as Array<Record<string, unknown>>;
  assert.equal(Array.isArray(followupMessages), true);
  assert.equal(followupMessages.some((entry) => entry.role === 'tool'), true);
});

test('anthropic tool parsing returns tool_use calls', async () => {
  globalThis.fetch = async () => jsonResponse(200, {
    content: [
      { type: 'text', text: 'checking...' },
      { type: 'tool_use', id: 'toolu_1', name: 'web_search', input: { query: 'latest sec filing' } },
    ],
  });
  const tool = { name: 'web_search', description: 'Search', input_schema: { type: 'object' } };
  const first = await providerRegistry.anthropic.generateToolFirstTurn({ model: 'claude-3-5-sonnet-latest', inputText: 'Find latest', tools: [tool] }, 'test-key');
  assert.equal(first.toolCalls.length, 1);
  assert.equal(first.toolCalls[0]?.id, 'toolu_1');
  assert.deepEqual(first.toolCalls[0]?.arguments, { query: 'latest sec filing' });
});

test('ollama tool parsing extracts function arguments object', async () => {
  globalThis.fetch = async () => jsonResponse(200, {
    message: {
      content: 'tool request',
      tool_calls: [{ function: { name: 'web_search', arguments: '{"query":"amd outlook"}' } }],
    },
  });
  const tool = { name: 'web_search', description: 'Search', input_schema: { type: 'object' } };
  const first = await providerRegistry.ollama.generateToolFirstTurn({ model: 'llama3.1:8b', inputText: 'Find latest', tools: [tool], generationParams: { baseUrl: 'http://localhost:11434' } }, '');
  assert.equal(first.toolCalls[0]?.name, 'web_search');
  assert.deepEqual(first.toolCalls[0]?.arguments, { query: 'amd outlook' });
});

test('minimax generate keeps delta chunks incremental and ignores fallback full message replay', async () => {
  globalThis.fetch = async () => sseResponse([
    { choices: [{ delta: { content: 'Hello ' } }] },
    { choices: [{ delta: { content: 'world' } }] },
    { choices: [{ message: { content: 'Hello world' } }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } },
  ]);

  const deltas: string[] = [];
  const result = await providerRegistry.minimax.generate(
    { model: 'abab6.5s-chat', inputText: 'Say hello' },
    'test-key',
    undefined,
    { onTextDelta: (delta) => deltas.push(delta) },
  );

  assert.equal(result.outputText, 'Hello world');
  assert.deepEqual(deltas, ['Hello ', 'world']);
  assert.equal(deltas.join(''), result.outputText);
});
