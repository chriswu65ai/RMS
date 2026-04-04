import test from 'node:test';
import assert from 'node:assert/strict';
import { getSavedLocalRuntime } from './runtimeConfig.js';

test('runtime summary source prefers saved local_connection model over cloud default model', () => {
  const runtime = getSavedLocalRuntime({
    default_provider: 'openai',
    default_model: 'gpt-4.1',
    generation_params: {
      local_connection: {
        base_url: 'http://localhost:11434',
        model: 'llama3.1:8b',
        B: 1,
      },
    },
  });
  assert.deepEqual(runtime, {
    baseUrl: 'http://localhost:11434',
    model: 'llama3.1:8b',
  });
});
