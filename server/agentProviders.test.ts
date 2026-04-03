import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { FALLBACK_MODELS, providerRegistry, selectBestModel, type ModelListEntry } from './agentProviders.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const jsonResponse = (status: number, payload: unknown) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

test('selectBestModel keeps preferred model when present in discovered models', () => {
  const discovered: ModelListEntry[] = [
    { modelId: 'gpt-4.1', displayName: 'GPT-4.1' },
    { modelId: 'gpt-4.1-mini', displayName: 'GPT-4.1 mini' },
  ];
  const selected = selectBestModel('openai', discovered, FALLBACK_MODELS.openai, 'gpt-4.1');
  assert.equal(selected.selected_model, 'gpt-4.1');
  assert.equal(selected.selection_source, 'live_catalog');
});

test('selectBestModel chooses provider-ranked live model when preferred is missing', () => {
  const discovered: ModelListEntry[] = [
    { modelId: 'gpt-4.1', displayName: 'GPT-4.1' },
    { modelId: 'custom-model', displayName: 'Custom' },
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
