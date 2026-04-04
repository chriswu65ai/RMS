import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { providerRegistry } from './agentProviders.js';
import { searchProviderRegistry } from './searchProviders.js';

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

let handleLocalApiRoute: RouteHandler;

const getHandler = async () => {
  if (handleLocalApiRoute) return handleLocalApiRoute;
  const testDbPath = path.join(os.tmpdir(), `rms-local-api-${randomUUID()}.db`);
  process.env.SQLITE_PATH = testDbPath;
  process.env.SECURE_STORE_PATH = path.join(os.tmpdir(), `rms-secure-${randomUUID()}.json`);
  const localApiModule = await import(new URL('./localApi.js', import.meta.url).href);
  handleLocalApiRoute = localApiModule.handleLocalApiRoute as RouteHandler;
  return handleLocalApiRoute;
};

const callRoute = async (method: string, url: string, body?: unknown) => {
  const handler = await getHandler();
  const req = mkReq(method, url, body);
  const res = new MockResponse();
  const handled = await handler(req, res);
  return { handled, status: res.statusCode, body: res.bodyText(), headers: res.headers };
};

test('saving ollama defaults keeps default_model and local_connection.model in sync', async () => {
  const saveResponse = await callRoute('PUT', '/api/agent/settings', {
    default_provider: 'ollama',
    default_model: 'llama3.2:latest',
    generation_params: {
      local_connection: {
        base_url: 'http://localhost:11500',
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
    generation_params?: { local_connection?: { model?: string } };
  };
  assert.equal(payload.default_model, 'llama3.2:latest');
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
        provider: 'duckduckgo',
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
      };
    };
  };
  assert.equal(payload.generation_params?.web_search?.enabled, true);
  assert.equal(payload.generation_params?.web_search?.provider, 'duckduckgo');
  assert.equal(payload.generation_params?.web_search?.mode, 'deep');
  assert.equal(payload.generation_params?.web_search?.max_results, 5);
  assert.equal(payload.generation_params?.web_search?.timeout_ms, 5000);
  assert.equal(payload.generation_params?.web_search?.safe_search, false);
  assert.equal(payload.generation_params?.web_search?.recency, '30d');
  assert.equal(payload.generation_params?.web_search?.domain_policy, 'prefer_list');
  assert.equal(payload.generation_params?.web_search?.source_citation, false);
});

test('preferred sources create normalizes domain and supports listing', async () => {
  const createResponse = await callRoute('POST', '/api/agent/preferred-sources', {
    domain: 'HTTPS://WWW.Example.COM/path?q=1',
    weight: 25,
  });
  assert.equal(createResponse.status, 200);
  const created = JSON.parse(createResponse.body) as { domain: string; weight: number; enabled: boolean };
  assert.equal(created.domain, 'www.example.com');
  assert.equal(created.weight, 25);
  assert.equal(created.enabled, true);

  const listResponse = await callRoute('GET', '/api/agent/preferred-sources');
  assert.equal(listResponse.status, 200);
  const listPayload = JSON.parse(listResponse.body) as Array<{ domain: string }>;
  assert.equal(listPayload.some((item) => item.domain === 'www.example.com'), true);
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

  try {
    const credentialSave = await callRoute('PUT', '/api/agent/credentials/openai', { api_key: 'sk-test' });
    assert.equal(credentialSave.status, 200);
    const response = await callRoute('POST', '/api/agent/generate', {
      provider: 'openai',
      model: 'gpt-4.1',
      input_text: 'Analyze ACME earnings',
    });
    assert.equal(response.status, 200);
    assert.match(receivedInput, /<web_search_context>/);
    assert.match(receivedInput, /Strict citation mode/);
    assert.match(receivedInput, /\[1\]/);
    const frames = response.body.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const sourcesFrame = frames.find((line) => line.type === 'sources') as { sources?: Array<{ url?: string }> } | undefined;
    assert.equal(Array.isArray(sourcesFrame?.sources), true);
    assert.equal((sourcesFrame?.sources?.length ?? 0) <= 8, true);
    const doneFrame = frames.find((line) => line.type === 'done');
    assert.equal((doneFrame?.web_search as { sourceCount?: number } | undefined)?.sourceCount, 8);
  } finally {
    searchProviderRegistry.duckduckgo.search = originalSearch;
    providerRegistry.openai.generate = originalGenerate;
  }
});

test('agent generate fails open when web search errors', async () => {
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

  try {
    const credentialSave = await callRoute('PUT', '/api/agent/credentials/openai', { api_key: 'sk-test' });
    assert.equal(credentialSave.status, 200);
    const response = await callRoute('POST', '/api/agent/generate', {
      provider: 'openai',
      model: 'gpt-4.1',
      input_text: 'hello',
    });
    assert.equal(response.status, 200);
    const frames = response.body.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(frames.some((line) => line.type === 'search_warning' && line.message === 'search is down'), true);
    assert.equal(frames.some((line) => line.type === 'status' && line.stage === 'web_search_warning'), true);
    const activityResponse = await callRoute('GET', '/api/agent/activity-log?limit=10');
    assert.equal(activityResponse.status, 200);
    const activity = JSON.parse(activityResponse.body) as Array<{
      status: string;
      search_warning: number;
      search_warning_message: string | null;
    }>;
    const successEntry = activity.find((entry) => entry.status === 'success');
    assert.equal(successEntry?.search_warning, 1);
    assert.equal(successEntry?.search_warning_message, 'search is down');
  } finally {
    searchProviderRegistry.duckduckgo.search = originalSearch;
    providerRegistry.openai.generate = originalGenerate;
  }
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
  });
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
    const singleResponse = await callRoute('POST', '/api/agent/generate', {
      provider: 'openai',
      model: 'gpt-4.1',
      input_text: 'NVIDIA guidance',
    });
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
    const deepResponse = await callRoute('POST', '/api/agent/generate', {
      provider: 'openai',
      model: 'gpt-4.1',
      input_text: 'NVIDIA guidance',
    });
    assert.equal(deepResponse.status, 200);
    const deepFrames = deepResponse.body.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const deepDone = deepFrames.find((line) => line.type === 'done') as { web_search?: { queryCount?: number; mode?: string } } | undefined;
    assert.deepEqual(seenQueries, ['NVIDIA guidance', 'NVIDIA guidance latest updates', 'NVIDIA guidance official source']);
    assert.deepEqual(seenModes, ['deep', 'deep', 'deep']);
    assert.deepEqual(seenSafeSearch, [true, true, true]);
    assert.deepEqual(seenRecency, ['7d', '7d', '7d']);
    assert.equal(deepDone?.web_search?.queryCount, 3);

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
    const deepEarlyBreakResponse = await callRoute('POST', '/api/agent/generate', {
      provider: 'openai',
      model: 'gpt-4.1',
      input_text: 'NVIDIA guidance',
    });
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
    const successResponse = await callRoute('POST', '/api/agent/generate', {
      provider: 'openai',
      model: 'gpt-4.1',
      input_text: 'hello',
    });
    assert.equal(successResponse.status, 200);
    const successFrames = successResponse.body.trim().split('\n').map((line) => JSON.parse(line) as { type?: string });
    assert.equal(successFrames[0]?.type, 'status');
    assert.equal(successFrames.some((frame) => frame.type === 'sources'), true);
    assert.equal(successFrames.findIndex((frame) => frame.type === 'sources') < successFrames.findIndex((frame) => frame.type === 'done'), true);

    searchProviderRegistry.duckduckgo.search = async () => {
      throw new Error('simulated failure');
    };
    const warningResponse = await callRoute('POST', '/api/agent/generate', {
      provider: 'openai',
      model: 'gpt-4.1',
      input_text: 'hello',
    });
    assert.equal(warningResponse.status, 200);
    const warningFrames = warningResponse.body.trim().split('\n').map((line) => JSON.parse(line) as { type?: string; message?: string; stage?: string });
    assert.equal(warningFrames.some((frame) => frame.type === 'search_warning' && frame.message === 'simulated failure'), true);
    assert.equal(warningFrames.some((frame) => frame.type === 'status' && frame.stage === 'web_search_warning'), true);
  } finally {
    searchProviderRegistry.duckduckgo.search = originalSearch;
    providerRegistry.openai.generate = originalGenerate;
  }
});

test('agent generate only injects citation instruction and appends Sources block when source_citation is enabled', async () => {
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
    const disabledResponse = await callRoute('POST', '/api/agent/generate', {
      provider: 'openai',
      model: 'gpt-4.1',
      input_text: 'hello',
    });
    assert.equal(disabledResponse.status, 200);
    assert.doesNotMatch(receivedInput, /Strict citation mode/);
    const disabledFrames = disabledResponse.body.trim().split('\n').map((line) => JSON.parse(line) as { type?: string; outputText?: string });
    const disabledDone = disabledFrames.find((frame) => frame.type === 'done');
    assert.equal(disabledDone?.outputText, 'Summary body');

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
    const enabledResponse = await callRoute('POST', '/api/agent/generate', {
      provider: 'openai',
      model: 'gpt-4.1',
      input_text: 'hello',
    });
    assert.equal(enabledResponse.status, 200);
    assert.match(receivedInput, /Strict citation mode/);
    const enabledFrames = enabledResponse.body.trim().split('\n').map((line) => JSON.parse(line) as { type?: string; outputText?: string });
    const enabledDone = enabledFrames.find((frame) => frame.type === 'done');
    assert.match(enabledDone?.outputText ?? '', /Summary body\n\n---\nSources\n1\. \[Example Title\]\(https:\/\/example\.com\/a\)\n2\. \[https:\/\/example\.com\/b\]\(https:\/\/example\.com\/b\)\n---$/);
    assert.doesNotMatch(enabledDone?.outputText ?? '', /snippet/i);
  } finally {
    searchProviderRegistry.duckduckgo.search = originalSearch;
    providerRegistry.openai.generate = originalGenerate;
  }
});
