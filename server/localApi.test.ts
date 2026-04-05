import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { providerRegistry } from './agentProviders.js';
import { searchProviderRegistry, searchUtils } from './searchProviders.js';

type RouteHandler = (req: Readable & { method?: string; url?: string; on: (event: string, cb: () => void) => void }, res: MockResponse) => Promise<boolean>;

class MockResponse {
  statusCode = 200;
  headers = new Map<string, string>();
  headersSent = false;
  private chunks: Buffer[] = [];

  setHeader(name: string, value: string) {
    this.headers.set(name.toLowerCase(), value);
    this.headersSent = true;
  }

  write(chunk: string | Buffer) {
    this.headersSent = true;
    this.chunks.push(Buffer.from(chunk));
    return true;
  }

  end(chunk?: string | Buffer) {
    if (chunk) this.chunks.push(Buffer.from(chunk));
    this.headersSent = true;
  }

  bodyText() {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

const mkReq = (method: string, url: string, body?: unknown) => {
  const payload = body === undefined ? [] : [JSON.stringify(body)];
  const req = Readable.from(payload) as Readable & { method?: string; url?: string; on: (event: string, cb: () => void) => void };
  req.method = method;
  req.url = url;
  return req;
};

let handleLocalApiRoute: RouteHandler | undefined;
const testDbPath = path.join(os.tmpdir(), `rms-local-api-${randomUUID()}.db`);
const testSecureStorePath = path.join(os.tmpdir(), `rms-secure-${randomUUID()}.json`);
let localApiImportCounter = 0;

const getHandler = async (fresh = false) => {
  if (fresh) handleLocalApiRoute = undefined;
  if (handleLocalApiRoute) return handleLocalApiRoute;
  process.env.SQLITE_PATH = testDbPath;
  process.env.SECURE_STORE_PATH = testSecureStorePath;
  const localApiModule = await import(new URL(`./localApi.js?instance=${localApiImportCounter += 1}`, import.meta.url).href);
  handleLocalApiRoute = localApiModule.handleLocalApiRoute as RouteHandler;
  return handleLocalApiRoute;
};

const callRoute = async (method: string, url: string, body?: unknown) => {
  const handler = await getHandler(false);
  const req = mkReq(method, url, body);
  const res = new MockResponse();
  const handled = await handler(req, res);
  return { handled, status: res.statusCode, body: res.bodyText(), headers: res.headers };
};

const callRouteAfterRestart = async (method: string, url: string, body?: unknown) => {
  const handler = await getHandler(true);
  const req = mkReq(method, url, body);
  const res = new MockResponse();
  const handled = await handler(req, res);
  return { handled, status: res.statusCode, body: res.bodyText(), headers: res.headers };
};

const withOpenAiToolCalls = async <T>(
  queries: string[],
  callback: () => Promise<T>,
): Promise<T> => {
  return withProviderToolCalls('openai', queries.map((query) => ({ query })), callback);
};

const withProviderToolCalls = async <T>(
  provider: 'openai' | 'minimax' | 'ollama',
  toolArguments: Array<Record<string, unknown> | null>,
  callback: () => Promise<T>,
): Promise<T> => {
  const originalFirst = providerRegistry[provider].generateToolFirstTurn;
  const originalFollowup = providerRegistry[provider].generateToolFollowupTurn;
  providerRegistry[provider].generateToolFirstTurn = async () => ({
    outputText: '',
    latencyMs: 1,
    toolCalls: toolArguments[0]
      ? [{ id: 'tool-1', name: 'web_search', arguments: toolArguments[0] }]
      : [],
  });
  providerRegistry[provider].generateToolFollowupTurn = async (request) => {
    const index = request.toolResults.length;
    const nextArguments = toolArguments[index];
    return {
      outputText: '',
      latencyMs: 1,
      toolCalls: nextArguments
        ? [{ id: `tool-${index + 1}`, name: 'web_search', arguments: nextArguments }]
        : [],
    };
  };
  try {
    return await callback();
  } finally {
    providerRegistry[provider].generateToolFirstTurn = originalFirst;
    providerRegistry[provider].generateToolFollowupTurn = originalFollowup;
  }
};

const withMinimaxToolCalls = async <T>(
  toolArguments: Array<Record<string, unknown> | null>,
  callback: () => Promise<T>,
): Promise<T> => withProviderToolCalls('minimax', toolArguments, callback);

const withOllamaToolCalls = async <T>(
  toolArguments: Array<Record<string, unknown> | null>,
  callback: () => Promise<T>,
): Promise<T> => withProviderToolCalls('ollama', toolArguments, callback);

test('saving ollama defaults keeps default_model and local_connection.model in sync', async () => {
  const saveResponse = await callRoute('PUT', '/api/agent/settings', {
    default_provider: 'ollama',
    default_model: 'llama3.2:latest',
    generation_params: {
      local_connection: {
        base_url: 'http://localhost:11500/',
        model: 'mistral:7b',
        B: 1,
      },
    },
  });
  assert.equal(saveResponse.status, 200);

  const settingsResponse = await callRoute('GET', '/api/agent/settings');
  assert.equal(settingsResponse.status, 200);
  const payload = JSON.parse(settingsResponse.body) as {
    default_model: string;
    generation_params?: { local_connection?: { base_url?: string; model?: string } };
  };
  assert.equal(payload.default_model, 'llama3.2:latest');
  assert.equal(payload.generation_params?.local_connection?.base_url, 'http://localhost:11500');
  assert.equal(payload.generation_params?.local_connection?.model, 'llama3.2:latest');
});

test('saving ollama defaults persists switched model as a single source of truth', async () => {
  const firstSave = await callRoute('PUT', '/api/agent/settings', {
    default_provider: 'ollama',
    default_model: 'llama3.2:latest',
    generation_params: {
      local_connection: {
        base_url: 'http://localhost:11434',
        model: 'llama3.2:latest',
        B: 1,
      },
    },
  });
  assert.equal(firstSave.status, 200);

  const secondSave = await callRoute('PUT', '/api/agent/settings', {
    default_provider: 'ollama',
    default_model: 'deepseek-r1:8b',
    generation_params: {
      local_connection: {
        base_url: 'http://localhost:11434',
        model: 'llama3.2:latest',
        B: 1,
      },
    },
  });
  assert.equal(secondSave.status, 200);

  const settingsResponse = await callRoute('GET', '/api/agent/settings');
  assert.equal(settingsResponse.status, 200);
  const payload = JSON.parse(settingsResponse.body) as {
    default_model: string;
    generation_params?: { local_connection?: { model?: string } };
  };
  assert.equal(payload.default_model, 'deepseek-r1:8b');
  assert.equal(payload.generation_params?.local_connection?.model, 'deepseek-r1:8b');
});

test('ollama generate uses unified runtime model and base URL from settings', async () => {
  await callRoute('PUT', '/api/agent/settings', {
    default_provider: 'ollama',
    default_model: 'qwen2.5:14b',
    generation_params: {
      local_connection: {
        base_url: 'http://127.0.0.1:11434',
        model: 'different-legacy-model',
        B: 1,
      },
    },
  });

  let captured: { model?: string; baseUrl?: string } = {};
  const originalGenerate = providerRegistry.ollama.generate;
  providerRegistry.ollama.generate = async (request) => {
    captured = {
      model: request.model,
      baseUrl: request.generationParams?.baseUrl,
    };
    return { outputText: 'ok', latencyMs: 1 };
  };

  try {
    const response = await callRoute('POST', '/api/agent/generate', {
      provider: 'ollama',
      model: 'payload-model-should-be-ignored',
      input_text: 'hello',
      note_id: 'note-1',
    });
    assert.equal(response.status, 200);
    assert.equal(captured.model, 'qwen2.5:14b');
    assert.equal(captured.baseUrl, 'http://127.0.0.1:11434');
  } finally {
    providerRegistry.ollama.generate = originalGenerate;
  }
});

test('ollama generate uses model selected in subsequent defaults save instead of stale llama3.2:latest', async () => {
  await callRoute('PUT', '/api/agent/settings', {
    default_provider: 'ollama',
    default_model: 'llama3.2:latest',
    generation_params: {
      local_connection: {
        base_url: 'http://localhost:11434',
        model: 'llama3.2:latest',
        B: 1,
      },
    },
  });

  await callRoute('PUT', '/api/agent/settings', {
    default_provider: 'ollama',
    default_model: 'qwen2.5:14b',
    generation_params: {
      local_connection: {
        base_url: 'http://localhost:11434',
        model: 'llama3.2:latest',
        B: 1,
      },
    },
  });

  let capturedModel = '';
  const originalGenerate = providerRegistry.ollama.generate;
  providerRegistry.ollama.generate = async (request) => {
    capturedModel = request.model;
    return { outputText: 'ok', latencyMs: 1 };
  };

  try {
    const response = await callRoute('POST', '/api/agent/generate', {
      provider: 'ollama',
      model: 'payload-model-should-be-ignored',
      input_text: 'hello',
      note_id: 'note-2',
    });
    assert.equal(response.status, 200);
    assert.equal(capturedModel, 'qwen2.5:14b');
  } finally {
    providerRegistry.ollama.generate = originalGenerate;
  }
});

test('non-ollama default model does not overwrite saved local_connection.model', async () => {
  await callRoute('PUT', '/api/agent/settings', {
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

  const settingsResponse = await callRoute('GET', '/api/agent/settings');
  assert.equal(settingsResponse.status, 200);
  const payload = JSON.parse(settingsResponse.body) as {
    default_provider: string;
    default_model: string;
    generation_params?: { local_connection?: { model?: string } };
  };
  assert.equal(payload.default_provider, 'openai');
  assert.equal(payload.default_model, 'gpt-4.1');
  assert.equal(payload.generation_params?.local_connection?.model, 'llama3.1:8b');
});

test('saving settings rejects enabled web search when tool-capable model is not selected', async () => {
  const response = await callRoute('PUT', '/api/agent/settings', {
    default_provider: 'openai',
    default_model: '',
    generation_params: {
      web_search: {
        enabled: true,
      },
    },
  });
  assert.equal(response.status, 400);
  const payload = JSON.parse(response.body) as { error?: { message?: string } };
  assert.match(payload.error?.message ?? '', /tool calling support/i);
});

test('generate rejects when web search is enabled but provider/model lacks tool-calling support', async () => {
  await callRoute('PUT', '/api/agent/settings', {
    default_provider: 'openai',
    default_model: 'gpt-4.1',
    generation_params: {
      web_search: {
        enabled: true,
      },
    },
  });
  await callRoute('PUT', '/api/agent/credentials/openai', { api_key: 'sk-test' });
  const response = await callRoute('POST', '/api/agent/generate', {
    provider: 'openai',
    model: 'text-embedding-3-large',
    input_text: 'hello',
  });
  assert.equal(response.status, 400);
  const payload = JSON.parse(response.body) as { error?: { message?: string } };
  assert.match(payload.error?.message ?? '', /tool calling support/i);
});

test('ollama model list endpoint mirrors installed list and selected model', async () => {
  await callRoute('PUT', '/api/agent/settings', {
    default_provider: 'ollama',
    default_model: 'llama3.1:8b',
    generation_params: {
      local_connection: {
        base_url: 'http://localhost:11434',
        model: 'llama3.1:8b',
        B: 1,
      },
    },
  });

  const originalListModels = providerRegistry.ollama.listModels;
  providerRegistry.ollama.listModels = async () => ({
    models: [
      { modelId: 'llama3.1:8b', displayName: 'Llama 3.1 8B', B: 1 },
      { modelId: 'qwen2.5:14b', displayName: 'Qwen 2.5 14B', B: 1 },
    ],
    selected_model: 'llama3.1:8b',
    selection_source: 'live_catalog',
    catalog_status: 'live',
    reason_code: 'ok',
  });

  try {
    const response = await callRoute('GET', '/api/agent/models?provider=ollama');
    assert.equal(response.status, 200);
    const payload = JSON.parse(response.body) as { models: Array<{ modelId: string }>; selected_model: string };
    assert.deepEqual(payload.models.map((entry) => entry.modelId), ['llama3.1:8b', 'qwen2.5:14b']);
    assert.equal(payload.selected_model, 'llama3.1:8b');
  } finally {
    providerRegistry.ollama.listModels = originalListModels;
  }
});


test('agent settings web_search defaults and round-trip persistence', async () => {
  const saveResponse = await callRoute('PUT', '/api/agent/settings', {
    default_provider: 'openai',
    default_model: 'gpt-4.1',
    generation_params: {
      temperature: 0.2,
      web_search: {
        enabled: true,
        provider: 'searxng',
        mode: 'deep',
        safe_search: false,
        recency: '30d',
        domain_policy: 'prefer_list',
      },
    },
  });
  assert.equal(saveResponse.status, 200);

  const settingsResponse = await callRoute('GET', '/api/agent/settings');
  assert.equal(settingsResponse.status, 200);
  const payload = JSON.parse(settingsResponse.body) as {
    generation_params?: {
      web_search?: {
        enabled?: boolean;
        provider?: string;
        mode?: string;
        max_results?: number;
        timeout_ms?: number;
        safe_search?: boolean;
        recency?: string;
        domain_policy?: string;
        source_citation?: boolean;
        provider_config?: {
          searxng?: {
            base_url?: string;
            use_json_api?: boolean;
          };
        };
      };
    };
  };
  assert.equal(payload.generation_params?.web_search?.enabled, true);
  assert.equal(payload.generation_params?.web_search?.provider, 'searxng');
  assert.equal(payload.generation_params?.web_search?.mode, 'deep');
  assert.equal(payload.generation_params?.web_search?.max_results, 5);
  assert.equal(payload.generation_params?.web_search?.timeout_ms, 5000);
  assert.equal(payload.generation_params?.web_search?.safe_search, false);
  assert.equal(payload.generation_params?.web_search?.recency, '30d');
  assert.equal(payload.generation_params?.web_search?.domain_policy, 'prefer_list');
  assert.equal(payload.generation_params?.web_search?.source_citation, false);
  assert.equal(payload.generation_params?.web_search?.provider_config?.searxng?.base_url, 'http://localhost:8080');
  assert.equal(payload.generation_params?.web_search?.provider_config?.searxng?.use_json_api, true);
});

test('preferred sources create normalizes domain and supports listing', async () => {
  const createResponse = await callRoute('POST', '/api/agent/preferred-sources', {
    domain: 'HTTPS://WWW.Example.COM/path?q=1',
    weight: 25,
  });
  assert.equal(createResponse.status, 200);
  const created = JSON.parse(createResponse.body) as { domain: string; weight: number; enabled: boolean };
  assert.equal(created.domain, 'example.com');
  assert.equal(created.weight, 25);
  assert.equal(created.enabled, true);

  const listResponse = await callRoute('GET', '/api/agent/preferred-sources');
  assert.equal(listResponse.status, 200);
  const listPayload = JSON.parse(listResponse.body) as Array<{ domain: string }>;
  assert.equal(listPayload.some((item) => item.domain === 'example.com'), true);
});

test('preferred sources validate domain, weight, and uniqueness', async () => {
  const invalidDomainResponse = await callRoute('POST', '/api/agent/preferred-sources', { domain: 'not a domain' });
  assert.equal(invalidDomainResponse.status, 400);

  const invalidWeightResponse = await callRoute('POST', '/api/agent/preferred-sources', {
    domain: 'valid-example.com',
    weight: 0,
  });
  assert.equal(invalidWeightResponse.status, 400);

  const firstCreate = await callRoute('POST', '/api/agent/preferred-sources', { domain: 'duplicate.example.com' });
  assert.equal(firstCreate.status, 200);
  const duplicateCreate = await callRoute('POST', '/api/agent/preferred-sources', { domain: 'DUPLICATE.EXAMPLE.COM' });
  assert.equal(duplicateCreate.status, 409);

  const withProtocolPathPort = await callRoute('POST', '/api/agent/preferred-sources', {
    domain: 'https://www.pref-source.example.com:8443/research/report?x=1#section',
  });
  assert.equal(withProtocolPathPort.status, 200);
  const normalized = JSON.parse(withProtocolPathPort.body) as { domain: string };
  assert.equal(normalized.domain, 'pref-source.example.com');
});

test('preferred sources patch and delete endpoints update rows', async () => {
  const createResponse = await callRoute('POST', '/api/agent/preferred-sources', {
    domain: 'before-update.example.com',
    weight: 10,
    enabled: false,
  });
  assert.equal(createResponse.status, 200);
  const created = JSON.parse(createResponse.body) as { id: string };

  const patchResponse = await callRoute('PATCH', `/api/agent/preferred-sources/${created.id}`, {
    domain: 'after-update.example.com/path',
    weight: 75,
    enabled: true,
  });
  assert.equal(patchResponse.status, 200);
  const patched = JSON.parse(patchResponse.body) as { domain: string; weight: number; enabled: boolean };
  assert.equal(patched.domain, 'after-update.example.com');
  assert.equal(patched.weight, 75);
  assert.equal(patched.enabled, true);

  const deleteResponse = await callRoute('DELETE', `/api/agent/preferred-sources/${created.id}`);
  assert.equal(deleteResponse.status, 200);
  const secondDeleteResponse = await callRoute('DELETE', `/api/agent/preferred-sources/${created.id}`);
  assert.equal(secondDeleteResponse.status, 404);
});

test('agent generate enriches input with deep web search context and caps sources', async () => {
  await callRoute('PUT', '/api/agent/settings', {
    default_provider: 'openai',
    default_model: 'gpt-4.1',
    generation_params: {
      web_search: {
        enabled: true,
        mode: 'deep',
        max_results: 12,
        timeout_ms: 3000,
        domain_policy: 'open_web',
        source_citation: true,
      },
    },
  });

  let receivedInput = '';
  const originalSearch = searchProviderRegistry.duckduckgo.search;
  const originalGenerate = providerRegistry.openai.generate;
  searchProviderRegistry.duckduckgo.search = async (query) => ([
    { title: `${query}-A`, url: 'https://example.com/shared', snippet: 'shared', provider: 'duckduckgo' },
    { title: `${query}-B`, url: `https://example.com/${encodeURIComponent(query)}`, snippet: 'unique', provider: 'duckduckgo' },
    { title: `${query}-C`, url: `https://example.org/${encodeURIComponent(query)}`, snippet: 'unique-2', provider: 'duckduckgo' },
  ]);
  providerRegistry.openai.generate = async (request) => {
    receivedInput = request.inputText;
    return { outputText: 'ok', latencyMs: 1 };
  };

  await withOpenAiToolCalls(['Analyze ACME earnings', 'Analyze ACME earnings latest updates'], async () => {
    const credentialSave = await callRoute('PUT', '/api/agent/credentials/openai', { api_key: 'sk-test' });
    assert.equal(credentialSave.status, 200);
    const response = await callRoute('POST', '/api/agent/generate', {
      provider: 'openai',
      model: 'gpt-4.1',
      input_text: 'Analyze ACME earnings',
    });
    assert.equal(response.status, 200);
    assert.match(receivedInput, /<tool_outputs>/);
    assert.match(receivedInput, /Citation mode is REQUIRED/);
    assert.match(receivedInput, /\[1\]/);
    const frames = response.body.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const sourcesFrame = frames.find((line) => line.type === 'sources') as { sources?: Array<{ url?: string }> } | undefined;
    assert.equal(Array.isArray(sourcesFrame?.sources), true);
    assert.equal((sourcesFrame?.sources?.length ?? 0) <= 8, true);
    const doneFrame = frames.find((line) => line.type === 'done');
    assert.equal((doneFrame?.web_search as { sourceCount?: number } | undefined)?.sourceCount, 8);
  }).finally(() => {
    searchProviderRegistry.duckduckgo.search = originalSearch;
    providerRegistry.openai.generate = originalGenerate;
  });
});

test('agent generate hard-fails when web search tool call fails', async () => {
  await callRoute('PUT', '/api/agent/settings', {
    default_provider: 'openai',
    default_model: 'gpt-4.1',
    generation_params: {
      web_search: {
        enabled: true,
        mode: 'single',
        max_results: 5,
        timeout_ms: 3000,
        domain_policy: 'open_web',
      },
    },
  });

  const originalSearch = searchProviderRegistry.duckduckgo.search;
  const originalGenerate = providerRegistry.openai.generate;
  searchProviderRegistry.duckduckgo.search = async () => {
    throw new Error('search is down');
  };
  providerRegistry.openai.generate = async (request) => ({ outputText: request.inputText, latencyMs: 1 });

  await withOpenAiToolCalls(['hello'], async () => {
    const credentialSave = await callRoute('PUT', '/api/agent/credentials/openai', { api_key: 'sk-test' });
    assert.equal(credentialSave.status, 200);
    const response = await callRoute('POST', '/api/agent/generate', {
      provider: 'openai',
      model: 'gpt-4.1',
      input_text: 'hello',
    });
    assert.equal(response.status, 200);
    const frames = response.body.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(frames.some((line) => line.type === 'error' && line.message === 'search is down'), true);
    assert.equal(frames.some((line) => line.type === 'done'), false);
    const activityResponse = await callRoute('GET', '/api/agent/activity-log?limit=10');
    assert.equal(activityResponse.status, 200);
    const activity = JSON.parse(activityResponse.body) as Array<{
      status: string;
      tool_failure_reason: string | null;
    }>;
    const failedEntry = activity.find((entry) => entry.status === 'failed');
    assert.equal(failedEntry?.tool_failure_reason, 'search is down');
  }).finally(() => {
    searchProviderRegistry.duckduckgo.search = originalSearch;
    providerRegistry.openai.generate = originalGenerate;
  });
});

test('agent activity log is runtime-only and resets on restart', async () => {
  await callRoute('DELETE', '/api/agent/activity-log');
  const clearResponse = await callRoute('GET', '/api/agent/activity-log?limit=10');
  assert.equal(clearResponse.status, 200);
  assert.deepEqual(JSON.parse(clearResponse.body), []);

  await callRoute('PUT', '/api/agent/settings', {
    default_provider: 'openai',
    default_model: 'gpt-4.1',
  });
  await callRoute('PUT', '/api/agent/credentials/openai', { api_key: 'sk-test' });

  const originalGenerate = providerRegistry.openai.generate;
  providerRegistry.openai.generate = async () => ({ outputText: 'ok', latencyMs: 1 });
  try {
    const generateResponse = await callRoute('POST', '/api/agent/generate', {
      provider: 'openai',
      model: 'gpt-4.1',
      input_text: 'hello',
    });
    assert.equal(generateResponse.status, 200);
  } finally {
    providerRegistry.openai.generate = originalGenerate;
  }

  const beforeRestart = await callRoute('GET', '/api/agent/activity-log?limit=10');
  const beforeRows = JSON.parse(beforeRestart.body) as Array<{ status: string }>;
  assert.equal(beforeRows.some((entry) => entry.status === 'success'), true);

  const afterRestart = await callRouteAfterRestart('GET', '/api/agent/activity-log?limit=10');
  assert.equal(afterRestart.status, 200);
  assert.deepEqual(JSON.parse(afterRestart.body), []);
});

test('agent settings normalize invalid web search values to defaults', async () => {
  const saveResponse = await callRoute('PUT', '/api/agent/settings', {
    default_provider: 'openai',
    default_model: 'gpt-4.1',
    generation_params: {
      web_search: {
        enabled: 'yes',
        provider: 'google',
        mode: 'invalid-mode',
        max_results: 0,
        timeout_ms: -10,
        safe_search: 'sometimes',
        recency: '90d',
        domain_policy: 'invalid-policy',
        source_citation: 'yes',
      },
    },
  });
  assert.equal(saveResponse.status, 200);

  const settingsResponse = await callRoute('GET', '/api/agent/settings');
  assert.equal(settingsResponse.status, 200);
  const payload = JSON.parse(settingsResponse.body) as {
    generation_params?: {
      web_search?: {
        enabled: boolean;
        provider: string;
        mode: string;
        max_results: number;
        timeout_ms: number;
        safe_search: boolean;
        recency: string;
        domain_policy: string;
      };
    };
  };
  assert.deepEqual(payload.generation_params?.web_search, {
    enabled: false,
    provider: 'duckduckgo',
    mode: 'single',
    max_results: 1,
    timeout_ms: 1,
    safe_search: true,
    recency: 'any',
    domain_policy: 'open_web',
    source_citation: false,
    provider_config: {
      searxng: {
        base_url: 'http://localhost:8080',
        use_json_api: true,
      },
    },
  });
});



test('agent settings normalize and persist searxng provider config', async () => {
  const saveResponse = await callRoute('PUT', '/api/agent/settings', {
    default_provider: 'openai',
    default_model: 'gpt-4.1',
    generation_params: {
      web_search: {
        enabled: true,
        provider: 'searxng',
        mode: 'single',
        provider_config: {
          searxng: {
            base_url: 'http://127.0.0.1:9999/',
            use_json_api: false,
          },
        },
      },
    },
  });
  assert.equal(saveResponse.status, 200);

  const settingsResponse = await callRoute('GET', '/api/agent/settings');
  assert.equal(settingsResponse.status, 200);
  const payload = JSON.parse(settingsResponse.body) as {
    generation_params?: {
      web_search?: {
        provider?: string;
        provider_config?: {
          searxng?: {
            base_url?: string;
            use_json_api?: boolean;
          };
        };
      };
    };
  };

  assert.equal(payload.generation_params?.web_search?.provider, 'searxng');
  assert.equal(payload.generation_params?.web_search?.provider_config?.searxng?.base_url, 'http://127.0.0.1:9999');
  assert.equal(payload.generation_params?.web_search?.provider_config?.searxng?.use_json_api, false);
});
test('agent generate routes single and deep mode with expected query fan-out', async () => {
  const originalSearch = searchProviderRegistry.duckduckgo.search;
  const originalGenerate = providerRegistry.openai.generate;
  const seenQueries: string[] = [];
  const seenModes: string[] = [];
  const seenSafeSearch: boolean[] = [];
  const seenRecency: string[] = [];

  searchProviderRegistry.duckduckgo.search = async (query, options) => {
    seenQueries.push(query);
    seenModes.push(options?.mode ?? 'single');
    seenSafeSearch.push(options?.safeSearch ?? true);
    seenRecency.push(options?.recency ?? 'any');
    return [{
      title: `source for ${query}`,
      url: `https://example.com/${encodeURIComponent(query)}`,
      snippet: 'snippet',
      provider: 'duckduckgo',
    }];
  };
  providerRegistry.openai.generate = async () => ({ outputText: 'ok', latencyMs: 1 });

  try {
    const credentialSave = await callRoute('PUT', '/api/agent/credentials/openai', { api_key: 'sk-test' });
    assert.equal(credentialSave.status, 200);

    await callRoute('PUT', '/api/agent/settings', {
      default_provider: 'openai',
      default_model: 'gpt-4.1',
      generation_params: {
        web_search: {
          enabled: true,
          mode: 'single',
          max_results: 4,
          timeout_ms: 3000,
          safe_search: false,
          recency: '30d',
        },
      },
    });
    const singleResponse = await withOpenAiToolCalls(['NVIDIA guidance', 'NVIDIA guidance latest updates'], () => callRoute('POST', '/api/agent/generate', {
      provider: 'openai',
      model: 'gpt-4.1',
      input_text: 'NVIDIA guidance',
    }));
    assert.equal(singleResponse.status, 200);
    const singleFrames = singleResponse.body.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const singleDone = singleFrames.find((line) => line.type === 'done') as { web_search?: { queryCount?: number; mode?: string } } | undefined;
    assert.equal(seenQueries.length, 1);
    assert.deepEqual(seenModes, ['single']);
    assert.deepEqual(seenSafeSearch, [false]);
    assert.deepEqual(seenRecency, ['30d']);
    assert.equal(singleDone?.web_search?.queryCount, 1);

    seenQueries.length = 0;
    seenModes.length = 0;
    seenSafeSearch.length = 0;
    seenRecency.length = 0;

    await callRoute('PUT', '/api/agent/settings', {
      default_provider: 'openai',
      default_model: 'gpt-4.1',
      generation_params: {
        web_search: {
          enabled: true,
          mode: 'deep',
          max_results: 6,
          timeout_ms: 3000,
          safe_search: true,
          recency: '7d',
        },
      },
    });
    const deepResponse = await withOpenAiToolCalls(['NVIDIA guidance', 'NVIDIA guidance latest updates', 'NVIDIA guidance official source'], () => callRoute('POST', '/api/agent/generate', {
      provider: 'openai',
      model: 'gpt-4.1',
      input_text: 'NVIDIA guidance',
    }));
    assert.equal(deepResponse.status, 200);
    const deepFrames = deepResponse.body.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const deepDone = deepFrames.find((line) => line.type === 'done') as { web_search?: { queryCount?: number; mode?: string } } | undefined;
    assert.deepEqual(seenQueries, ['NVIDIA guidance', 'NVIDIA guidance latest updates']);
    assert.deepEqual(seenModes, ['deep', 'deep', 'deep']);
    assert.deepEqual(seenSafeSearch, [true, true, true]);
    assert.deepEqual(seenRecency, ['7d', '7d', '7d']);
    assert.equal(deepDone?.web_search?.queryCount, 2);

    seenQueries.length = 0;
    seenModes.length = 0;
    seenSafeSearch.length = 0;
    seenRecency.length = 0;
    searchProviderRegistry.duckduckgo.search = async (query, options) => {
      seenQueries.push(query);
      seenModes.push(options?.mode ?? 'single');
      seenSafeSearch.push(options?.safeSearch ?? true);
      seenRecency.push(options?.recency ?? 'any');
      return [
        {
          title: `source for ${query} a`,
          url: `https://example.com/${encodeURIComponent(query)}/a`,
          snippet: 'snippet a',
          provider: 'duckduckgo',
        },
        {
          title: `source for ${query} b`,
          url: `https://example.com/${encodeURIComponent(query)}/b`,
          snippet: 'snippet b',
          provider: 'duckduckgo',
        },
      ];
    };

    await callRoute('PUT', '/api/agent/settings', {
      default_provider: 'openai',
      default_model: 'gpt-4.1',
      generation_params: {
        web_search: {
          enabled: true,
          mode: 'deep',
          max_results: 1,
          timeout_ms: 3000,
          safe_search: true,
          recency: '7d',
        },
      },
    });
    const deepEarlyBreakResponse = await withOpenAiToolCalls(['NVIDIA guidance'], () => callRoute('POST', '/api/agent/generate', {
      provider: 'openai',
      model: 'gpt-4.1',
      input_text: 'NVIDIA guidance',
    }));
    assert.equal(deepEarlyBreakResponse.status, 200);
    const deepEarlyBreakFrames = deepEarlyBreakResponse.body.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const deepEarlyBreakDone = deepEarlyBreakFrames.find((line) => line.type === 'done') as { web_search?: { queryCount?: number; mode?: string } } | undefined;
    assert.deepEqual(seenQueries, ['NVIDIA guidance']);
    assert.deepEqual(seenModes, ['deep']);
    assert.deepEqual(seenSafeSearch, [true]);
    assert.deepEqual(seenRecency, ['7d']);
    assert.equal(deepEarlyBreakDone?.web_search?.queryCount, 1);
  } finally {
    searchProviderRegistry.duckduckgo.search = originalSearch;
    providerRegistry.openai.generate = originalGenerate;
  }
});

test('agent generate forwards web search controls for duckduckgo and searxng providers', async () => {
  const originalDuckSearch = searchProviderRegistry.duckduckgo.search;
  const originalSearxngSearch = searchProviderRegistry.searxng.search;
  const originalGenerate = providerRegistry.openai.generate;
  const seenDuckOptions: Array<Record<string, unknown>> = [];
  const seenSearxngOptions: Array<Record<string, unknown>> = [];

  providerRegistry.openai.generate = async () => ({ outputText: 'ok', latencyMs: 1 });
  searchProviderRegistry.duckduckgo.search = async (_query, options) => {
    seenDuckOptions.push({
      mode: options?.mode,
      resultCap: options?.resultCap,
      timeoutMs: options?.timeoutMs,
      safeSearch: options?.safeSearch,
      recency: options?.recency,
      policy: options?.policy,
    });
    return [{ title: 'duck', url: 'https://example.com/duck', snippet: 'duck', provider: 'duckduckgo' }];
  };
  searchProviderRegistry.searxng.search = async (_query, options) => {
    seenSearxngOptions.push({
      mode: options?.mode,
      resultCap: options?.resultCap,
      timeoutMs: options?.timeoutMs,
      safeSearch: options?.safeSearch,
      recency: options?.recency,
      policy: options?.policy,
    });
    return [{ title: 'searxng', url: 'https://example.com/searxng', snippet: 'searxng', provider: 'searxng' }];
  };

  try {
    const credentialSave = await callRoute('PUT', '/api/agent/credentials/openai', { api_key: 'sk-test' });
    assert.equal(credentialSave.status, 200);

    await callRoute('PUT', '/api/agent/settings', {
      default_provider: 'openai',
      default_model: 'gpt-4.1',
      generation_params: {
        web_search: {
          enabled: true,
          provider: 'duckduckgo',
          mode: 'single',
          max_results: 3,
          timeout_ms: 2500,
          safe_search: false,
          recency: '30d',
          domain_policy: 'only_list',
        },
      },
    });
    const duckResponse = await withOpenAiToolCalls(['ACME'], () => callRoute('POST', '/api/agent/generate', {
      provider: 'openai',
      model: 'gpt-4.1',
      input_text: 'ACME',
    }));
    assert.equal(duckResponse.status, 200);
    assert.deepEqual(seenDuckOptions, [{
      mode: 'single',
      resultCap: 3,
      timeoutMs: 2500,
      safeSearch: false,
      recency: '30d',
      policy: 'only_list',
    }]);

    await callRoute('PUT', '/api/agent/settings', {
      default_provider: 'openai',
      default_model: 'gpt-4.1',
      generation_params: {
        web_search: {
          enabled: true,
          provider: 'searxng',
          mode: 'deep',
          max_results: 6,
          timeout_ms: 4100,
          safe_search: true,
          recency: '7d',
          domain_policy: 'prefer_list',
          provider_config: {
            searxng: {
              base_url: 'http://10.11.10.11:2000',
              use_json_api: true,
            },
          },
        },
      },
    });
    const searxngResponse = await withOpenAiToolCalls(['ACME', 'ACME latest updates', 'ACME official source'], () => callRoute('POST', '/api/agent/generate', {
      provider: 'openai',
      model: 'gpt-4.1',
      input_text: 'ACME',
    }));
    assert.equal(searxngResponse.status, 200);
    assert.deepEqual(seenSearxngOptions, [
      {
        mode: 'deep',
        resultCap: 6,
        timeoutMs: 4100,
        safeSearch: true,
        recency: '7d',
        policy: 'prefer_list',
      },
      {
        mode: 'deep',
        resultCap: 6,
        timeoutMs: 4100,
        safeSearch: true,
        recency: '7d',
        policy: 'prefer_list',
      },
    ]);
  } finally {
    searchProviderRegistry.duckduckgo.search = originalDuckSearch;
    searchProviderRegistry.searxng.search = originalSearxngSearch;
    providerRegistry.openai.generate = originalGenerate;
  }
});

test('minimax web search prefer_list forwards preferred list/boost and blocks model override args', async () => {
  const originalSearch = searchProviderRegistry.duckduckgo.search;
  const originalGenerate = providerRegistry.minimax.generate;
  const seenSearchOptions: Array<Record<string, unknown>> = [];

  providerRegistry.minimax.generate = async () => ({ outputText: 'ok', latencyMs: 1 });
  searchProviderRegistry.duckduckgo.search = async (_query, options) => {
    seenSearchOptions.push({
      policy: options?.policy,
      domainList: options?.domainList,
      domainBoost: options?.domainBoost,
    });
    return [{ title: 'trusted', url: 'https://trusted.example/report', snippet: 'trusted', provider: 'duckduckgo' }];
  };

  try {
    await callRoute('DELETE', '/api/agent/activity-log');
    const credentialSave = await callRoute('PUT', '/api/agent/credentials/minimax', { api_key: 'mm-test' });
    assert.equal(credentialSave.status, 200);
    assert.equal((await callRoute('POST', '/api/agent/preferred-sources', { domain: 'trusted-minimax.example', weight: 90 })).status, 200);
    assert.equal((await callRoute('POST', '/api/agent/preferred-sources', { domain: 'another-minimax.example', weight: 40 })).status, 200);
    await callRoute('PUT', '/api/agent/settings', {
      default_provider: 'minimax',
      default_model: 'MiniMax-M2.5',
      generation_params: {
        web_search: {
          enabled: true,
          provider: 'duckduckgo',
          mode: 'single',
          max_results: 4,
          timeout_ms: 3000,
          domain_policy: 'prefer_list',
        },
      },
    });

    const response = await withMinimaxToolCalls([{
      query: 'ACME guidance',
      domain_policy: 'only_list',
      domain_list: ['malicious.example'],
      provider: 'searxng',
    }], () => callRoute('POST', '/api/agent/generate', {
      provider: 'minimax',
      model: 'MiniMax-M2.5',
      input_text: 'ACME guidance',
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(seenSearchOptions, [{
      policy: 'prefer_list',
      domainList: ['trusted-minimax.example', 'another-minimax.example'],
      domainBoost: { 'trusted-minimax.example': 90, 'another-minimax.example': 40 },
    }]);
    const frames = response.body.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const started = frames.find((frame) => frame.type === 'tool_call_started') as { args?: Record<string, unknown> } | undefined;
    assert.deepEqual(started?.args, {
      query: 'ACME guidance',
      mode: 'single',
      max_results: 4,
      recency: 'any',
      safe_search: true,
      domain_policy: 'prefer_list',
      domain_list: ['trusted-minimax.example', 'another-minimax.example'],
      provider: 'duckduckgo',
      provider_config: {
        searxng: {
          base_url: 'http://localhost:8080',
          use_json_api: true,
        },
      },
    });
  } finally {
    searchProviderRegistry.duckduckgo.search = originalSearch;
    providerRegistry.minimax.generate = originalGenerate;
  }
});

test('ollama web search only_list enforces preferred-domain filtering and ignores model overrides', async () => {
  const originalSearch = searchProviderRegistry.duckduckgo.search;
  const originalGenerate = providerRegistry.ollama.generate;
  const seenSearchOptions: Array<Record<string, unknown>> = [];

  providerRegistry.ollama.generate = async () => ({ outputText: 'ok', latencyMs: 1 });
  searchProviderRegistry.duckduckgo.search = async (_query, options) => {
    seenSearchOptions.push({
      policy: options?.policy,
      domainList: options?.domainList,
      domainBoost: options?.domainBoost,
    });
    const raw = [
      { title: 'trusted', url: 'https://trusted-ollama.example/1', snippet: 'trusted', provider: 'duckduckgo' as const },
      { title: 'blocked', url: 'https://untrusted.example/2', snippet: 'blocked', provider: 'duckduckgo' as const },
    ];
    return searchUtils.applyDomainPolicy(raw, options?.policy ?? 'open_web', options?.domainList ?? []);
  };

  try {
    await callRoute('DELETE', '/api/agent/activity-log');
    assert.equal((await callRoute('POST', '/api/agent/preferred-sources', { domain: 'trusted-ollama.example', weight: 55 })).status, 200);
    await callRoute('PUT', '/api/agent/settings', {
      default_provider: 'ollama',
      default_model: 'llama3.2:latest',
      generation_params: {
        local_connection: {
          base_url: 'http://localhost:11434',
          model: 'llama3.2:latest',
          B: 1,
        },
        web_search: {
          enabled: true,
          provider: 'duckduckgo',
          mode: 'single',
          max_results: 5,
          timeout_ms: 3000,
          domain_policy: 'only_list',
        },
      },
    });

    const response = await withOllamaToolCalls([{
      query: 'Local model grounding',
      domain_policy: 'open_web',
      domain_list: ['bad.example'],
      provider: 'searxng',
    }], () => callRoute('POST', '/api/agent/generate', {
      provider: 'ollama',
      model: 'llama3.2:latest',
      input_text: 'Local model grounding',
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(seenSearchOptions, [{
      policy: 'only_list',
      domainList: ['trusted-ollama.example'],
      domainBoost: undefined,
    }]);

    const frames = response.body.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const sourcesFrame = frames.find((frame) => frame.type === 'sources') as { sources?: Array<{ url?: string }> } | undefined;
    assert.deepEqual(sourcesFrame?.sources?.map((entry) => entry.url), ['https://trusted-ollama.example/1']);
    const started = frames.find((frame) => frame.type === 'tool_call_started') as { args?: Record<string, unknown> } | undefined;
    assert.equal(started?.args?.domain_policy, 'only_list');
    assert.deepEqual(started?.args?.domain_list, ['trusted-ollama.example']);
    assert.equal(started?.args?.provider, 'duckduckgo');
  } finally {
    searchProviderRegistry.duckduckgo.search = originalSearch;
    providerRegistry.ollama.generate = originalGenerate;
  }
});

test('agent generate emits stream sources before done and warning frames on search failure', async () => {
  const originalSearch = searchProviderRegistry.duckduckgo.search;
  const originalGenerate = providerRegistry.openai.generate;
  providerRegistry.openai.generate = async () => ({ outputText: 'ok', latencyMs: 1 });

  try {
    const credentialSave = await callRoute('PUT', '/api/agent/credentials/openai', { api_key: 'sk-test' });
    assert.equal(credentialSave.status, 200);

    await callRoute('PUT', '/api/agent/settings', {
      default_provider: 'openai',
      default_model: 'gpt-4.1',
      generation_params: { web_search: { enabled: true, mode: 'single', max_results: 5, timeout_ms: 3000 } },
    });

    searchProviderRegistry.duckduckgo.search = async () => ([
      { title: 'A', url: 'https://example.com/a', snippet: 'A', provider: 'duckduckgo' },
    ]);
    const successResponse = await withOpenAiToolCalls(['hello'], () => callRoute('POST', '/api/agent/generate', {
      provider: 'openai',
      model: 'gpt-4.1',
      input_text: 'hello',
    }));
    assert.equal(successResponse.status, 200);
    const successFrames = successResponse.body.trim().split('\n').map((line) => JSON.parse(line) as { type?: string });
    assert.equal(successFrames[0]?.type, 'status');
    assert.equal(successFrames.some((frame) => frame.type === 'tool_call_started'), true);
    assert.equal(successFrames.some((frame) => frame.type === 'tool_call_result'), true);
    assert.equal(successFrames.some((frame) => frame.type === 'sources'), true);
    assert.equal(successFrames.findIndex((frame) => frame.type === 'sources') < successFrames.findIndex((frame) => frame.type === 'done'), true);

    searchProviderRegistry.duckduckgo.search = async () => {
      throw new Error('simulated failure');
    };
    const warningResponse = await withOpenAiToolCalls(['hello'], () => callRoute('POST', '/api/agent/generate', {
      provider: 'openai',
      model: 'gpt-4.1',
      input_text: 'hello',
    }));
    assert.equal(warningResponse.status, 200);
    const warningFrames = warningResponse.body.trim().split('\n').map((line) => JSON.parse(line) as { type?: string; message?: string; stage?: string; reason?: string });
    assert.equal(warningFrames.some((frame) => frame.type === 'tool_call_failed' && frame.reason === 'simulated failure'), true);
    assert.equal(warningFrames.some((frame) => frame.type === 'error' && frame.message === 'simulated failure'), true);
  } finally {
    searchProviderRegistry.duckduckgo.search = originalSearch;
    providerRegistry.openai.generate = originalGenerate;
  }
});

test('agent generate handles citation on/off output policy while keeping metadata and logging citation events', async () => {
  const originalSearch = searchProviderRegistry.duckduckgo.search;
  const originalGenerate = providerRegistry.openai.generate;
  let receivedInput = '';
  providerRegistry.openai.generate = async (request) => {
    receivedInput = request.inputText;
    return { outputText: 'Summary body', latencyMs: 1 };
  };
  searchProviderRegistry.duckduckgo.search = async () => ([
    { title: 'Example Title', url: 'https://example.com/a', snippet: 'example snippet A', provider: 'duckduckgo' },
    { title: '', url: 'https://example.com/b', snippet: 'example snippet B', provider: 'duckduckgo' },
  ]);

  try {
    const credentialSave = await callRoute('PUT', '/api/agent/credentials/openai', { api_key: 'sk-test' });
    assert.equal(credentialSave.status, 200);

    await callRoute('PUT', '/api/agent/settings', {
      default_provider: 'openai',
      default_model: 'gpt-4.1',
      generation_params: {
        web_search: {
          enabled: true,
          mode: 'single',
          max_results: 5,
          timeout_ms: 3000,
          source_citation: false,
        },
      },
    });
    const disabledResponse = await withOpenAiToolCalls(['hello'], () => callRoute('POST', '/api/agent/generate', {
      provider: 'openai',
      model: 'gpt-4.1',
      input_text: 'hello',
    }));
    assert.equal(disabledResponse.status, 200);
    assert.doesNotMatch(receivedInput, /Citation mode is REQUIRED/);
    const disabledFrames = disabledResponse.body.trim().split('\n').map((line) => JSON.parse(line) as {
      type?: string;
      outputText?: string;
      web_search?: { sourceCount?: number };
    });
    const disabledDone = disabledFrames.find((frame) => frame.type === 'done');
    assert.equal(disabledDone?.outputText, 'Summary body');
    assert.equal((disabledDone?.web_search?.sourceCount ?? 0) > 0, true);

    await callRoute('PUT', '/api/agent/settings', {
      default_provider: 'openai',
      default_model: 'gpt-4.1',
      generation_params: {
        web_search: {
          enabled: true,
          mode: 'single',
          max_results: 5,
          timeout_ms: 3000,
          source_citation: true,
        },
      },
    });
    const enabledResponse = await withOpenAiToolCalls(['hello'], () => callRoute('POST', '/api/agent/generate', {
      provider: 'openai',
      model: 'gpt-4.1',
      input_text: 'hello',
    }));
    assert.equal(enabledResponse.status, 200);
    assert.match(receivedInput, /Citation mode is REQUIRED/);
    const enabledFrames = enabledResponse.body.trim().split('\n').map((line) => JSON.parse(line) as { type?: string; outputText?: string });
    const enabledDone = enabledFrames.find((frame) => frame.type === 'done');
    assert.equal(enabledDone?.outputText, 'Summary body[lack citation]');
    assert.doesNotMatch(enabledDone?.outputText ?? '', /snippet/i);

    const activityResponse = await callRoute('GET', '/api/agent/activity-log?limit=5');
    assert.equal(activityResponse.status, 200);
    const activity = JSON.parse(activityResponse.body) as Array<{
      citation_events_json?: string | null;
      web_search_enabled: number;
    }>;
    const latestEnabled = activity[0];
    const latestDisabled = activity[1];
    assert.equal(latestEnabled?.web_search_enabled, 1);
    assert.equal(latestDisabled?.web_search_enabled, 1);
    assert.equal(typeof latestEnabled?.citation_events_json, 'string');
    const parsedEvents = JSON.parse(latestEnabled?.citation_events_json ?? '[]') as Array<{ event_type?: string }>;
    assert.equal(parsedEvents.some((event) => event.event_type === 'retry_invoked'), true);
    assert.equal(latestDisabled?.citation_events_json, null);
  } finally {
    searchProviderRegistry.duckduckgo.search = originalSearch;
    providerRegistry.openai.generate = originalGenerate;
  }
});

test('archiving a research task preserves activity events', async () => {
  const createResponse = await callRoute('POST', '/api/research-tasks', {
    title: 'Archive me',
    ticker: 'ACME',
    status: 'ideas',
  });
  assert.equal(createResponse.status, 200);
  const createdTask = JSON.parse(createResponse.body) as { id: string };

  const updateResponse = await callRoute('PATCH', `/api/research-tasks/${createdTask.id}`, {
    status: 'researching',
    assignee: 'Analyst',
  });
  assert.equal(updateResponse.status, 200);

  const activityBeforeArchive = await callRoute('GET', `/api/research-tasks/${createdTask.id}/activity`);
  assert.equal(activityBeforeArchive.status, 200);
  const eventsBeforeArchive = JSON.parse(activityBeforeArchive.body) as Array<{ event_type: string }>;
  assert.equal(eventsBeforeArchive.length > 0, true);

  const archiveResponse = await callRoute('PATCH', `/api/research-tasks/${createdTask.id}`, {
    archived: true,
  });
  assert.equal(archiveResponse.status, 200);

  const activityAfterArchive = await callRoute('GET', `/api/research-tasks/${createdTask.id}/activity`);
  assert.equal(activityAfterArchive.status, 200);
  const eventsAfterArchive = JSON.parse(activityAfterArchive.body) as Array<{ event_type: string }>;
  assert.equal(eventsAfterArchive.length >= eventsBeforeArchive.length, true);
  assert.equal(eventsAfterArchive.some((event) => event.event_type === 'archive'), true);
});

test('deleting a research task also removes activity events', async () => {
  const createResponse = await callRoute('POST', '/api/research-tasks', {
    title: 'Delete me',
    ticker: 'ACME',
    status: 'ideas',
  });
  assert.equal(createResponse.status, 200);
  const createdTask = JSON.parse(createResponse.body) as { id: string };

  const updateResponse = await callRoute('PATCH', `/api/research-tasks/${createdTask.id}`, {
    status: 'researching',
    assignee: 'Analyst',
  });
  assert.equal(updateResponse.status, 200);

  const activityBeforeDelete = await callRoute('GET', `/api/research-tasks/${createdTask.id}/activity`);
  assert.equal(activityBeforeDelete.status, 200);
  const eventsBeforeDelete = JSON.parse(activityBeforeDelete.body) as Array<{ event_type: string }>;
  assert.equal(eventsBeforeDelete.length > 0, true);

  const deleteResponse = await callRoute('DELETE', `/api/research-tasks/${createdTask.id}`);
  assert.equal(deleteResponse.status, 200);

  const activityAfterDelete = await callRoute('GET', `/api/research-tasks/${createdTask.id}/activity`);
  assert.equal(activityAfterDelete.status, 200);
  const eventsAfterDelete = JSON.parse(activityAfterDelete.body) as Array<{ event_type: string }>;
  assert.deepEqual(eventsAfterDelete, []);
});

test('deleting a non-existent research task returns 404', async () => {
  const deleteResponse = await callRoute('DELETE', `/api/research-tasks/${randomUUID()}`);
  assert.equal(deleteResponse.status, 404);
  const payload = JSON.parse(deleteResponse.body) as { error?: { message?: string } };
  assert.equal(payload.error?.message, 'Task not found.');
});
