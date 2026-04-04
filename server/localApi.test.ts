import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { providerRegistry } from './agentProviders.js';

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
