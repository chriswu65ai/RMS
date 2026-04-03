import test from 'node:test';
import assert from 'node:assert/strict';
import { FALLBACK_MODELS, selectBestModel, type ModelListEntry } from './agentProviders.js';

test('selectBestModel keeps preferred model when present in discovered models', () => {
  const discovered: ModelListEntry[] = [
    { modelId: 'gpt-4.1', displayName: 'GPT-4.1' },
    { modelId: 'gpt-4.1-mini', displayName: 'GPT-4.1 mini' },
  ];
  const selected = selectBestModel('openai', discovered, FALLBACK_MODELS.openai, 'gpt-4.1');
  assert.equal(selected, 'gpt-4.1');
});

test('selectBestModel chooses provider priority default when preferred model missing but live models exist', () => {
  const discovered: ModelListEntry[] = [
    { modelId: 'gpt-4.1', displayName: 'GPT-4.1' },
    { modelId: 'custom-model', displayName: 'Custom' },
  ];
  const selected = selectBestModel('openai', discovered, FALLBACK_MODELS.openai, 'does-not-exist');
  assert.equal(selected, 'gpt-4.1');
});

test('selectBestModel picks fallback when live catalog is unavailable', () => {
  const selected = selectBestModel('anthropic', [], FALLBACK_MODELS.anthropic, 'claude-3-opus');
  assert.equal(selected, FALLBACK_MODELS.anthropic[0]?.modelId);
});

test('selectBestModel picks fallback when live response is empty', () => {
  const selected = selectBestModel('minimax', [], FALLBACK_MODELS.minimax);
  assert.equal(selected, FALLBACK_MODELS.minimax[0]?.modelId);
});
