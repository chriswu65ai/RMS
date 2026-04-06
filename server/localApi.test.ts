import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
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

const mkReq = (method: string, url: string, body?: unknown, headers?: Record<string, string>) => {
  const payload = body === undefined
    ? []
    : [typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)];
  const req = Readable.from(payload) as Readable & { method?: string; url?: string; on: (event: string, cb: () => void) => void };
  req.method = method;
  req.url = url;
  (req as Readable & { headers?: Record<string, string> }).headers = headers ?? {};
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

const callRoute = async (method: string, url: string, body?: unknown, headers?: Record<string, string>) => {
  const handler = await getHandler(false);
  const req = mkReq(method, url, body, headers);
  const res = new MockResponse();
  const handled = await handler(req, res);
  return { handled, status: res.statusCode, body: res.bodyText(), headers: res.headers };
};

const callRouteAfterRestart = async (method: string, url: string, body?: unknown, headers?: Record<string, string>) => {
  const handler = await getHandler(true);
  const req = mkReq(method, url, body, headers);
  const res = new MockResponse();
  const handled = await handler(req, res);
  return { handled, status: res.statusCode, body: res.bodyText(), headers: res.headers };
};

const buildMultipartUpload = (fields: Record<string, string>, file: { name: string; mimeType: string; content: Buffer }) => {
  const boundary = `----rms-boundary-${randomUUID()}`;
  const chunks: Buffer[] = [];
  const appendField = (name: string, value: string) => {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n`));
    chunks.push(Buffer.from(value));
    chunks.push(Buffer.from('\r\n'));
  };
  Object.entries(fields).forEach(([name, value]) => appendField(name, value));
  chunks.push(Buffer.from(`--${boundary}\r\n`));
  chunks.push(Buffer.from(`Content-Disposition: form-data; name="file"; filename="${file.name}"\r\n`));
  chunks.push(Buffer.from(`Content-Type: ${file.mimeType}\r\n\r\n`));
  chunks.push(file.content);
  chunks.push(Buffer.from('\r\n'));
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
  };
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

test('put agent settings rejects invalid URL fields with a 400 response', async () => {
  const invalidInterfaceResponse = await callRoute('PUT', '/api/agent/settings', {
    default_provider: 'ollama',
    default_model: 'llama3.2:latest',
    generation_params: {
      local_connection: {
        base_url: '/xxx',
        model: 'llama3.2:latest',
        B: 1,
      },
    },
  });
  assert.equal(invalidInterfaceResponse.status, 400);
  assert.match(invalidInterfaceResponse.body, /Interface URL must be a valid http:\/\/ or https:\/\/ URL with a hostname\./);

  const invalidSearxngResponse = await callRoute('PUT', '/api/agent/settings', {
    default_provider: 'openai',
    default_model: 'gpt-4.1',
    generation_params: {
      web_search: {
        enabled: true,
        provider: 'searxng',
        mode: 'single',
        max_results: 6,
        timeout_ms: 10000,
        safe_search: false,
        recency: 'any',
        domain_policy: 'open_web',
        source_citation: false,
        provider_config: {
          searxng: {
            base_url: '/xxx',
            use_json_api: true,
          },
        },
      },
    },
  });
  assert.equal(invalidSearxngResponse.status, 400);
  assert.match(invalidSearxngResponse.body, /SearXNG base URL must be a valid http:\/\/ or https:\/\/ URL with a hostname\./);
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

test('attachments migration/init and upload/list flow work', async () => {
  const bootstrap = await callRoute('GET', '/api/bootstrap');
  const bootstrapPayload = JSON.parse(bootstrap.body) as { workspace: { id: string }; files: Array<{ id: string }> };
  const taskCreate = await callRoute('POST', '/api/research-tasks', {
    ticker: 'MSFT',
    title: 'Task with attachment',
    details: 'x',
    note_type: 'Research',
    assignee: '',
    priority: '',
    deadline: '',
    status: 'ideas',
    date_completed: '',
    archived: false,
  });
  const task = JSON.parse(taskCreate.body) as { id: string };
  const csv = 'name,"comment"\nAlpha,"hello, world"\nBeta,"line1\nline2"';
  const multipart = buildMultipartUpload({
    workspace_id: bootstrapPayload.workspace.id,
    link_type: 'task',
    link_id: task.id,
    original_name: 'sample.csv',
    mime_type: 'text/csv',
  }, {
    name: 'sample.csv',
    mimeType: 'text/csv',
    content: Buffer.from(csv, 'utf8'),
  });
  const upload = await callRoute('POST', '/api/attachments/upload', multipart.body, multipart.headers);
  assert.equal(upload.status, 200);
  const uploaded = JSON.parse(upload.body) as { id: string; parse_status: string; parsed_text: string | null };
  assert.equal(uploaded.parse_status, 'parsed');
  assert.match(uploaded.parsed_text ?? '', /hello, world/);
  assert.match(uploaded.parsed_text ?? '', /line1\nline2/);

  const list = await callRoute('GET', `/api/attachments?linkType=task&linkId=${task.id}`);
  assert.equal(list.status, 200);
  const listPayload = JSON.parse(list.body) as Array<{ id: string }>;
  assert.equal(listPayload.length, 1);
  assert.equal(listPayload[0]?.id, uploaded.id);
});

test('attachments counts endpoint batches by link_id across note ids', async () => {
  const bootstrap = await callRoute('GET', '/api/bootstrap');
  const bootstrapPayload = JSON.parse(bootstrap.body) as { workspace: { id: string }; files: Array<{ id: string }> };
  let noteA = bootstrapPayload.files[0]?.id ?? '';
  let noteB = bootstrapPayload.files[1]?.id ?? '';
  if (!noteA || !noteB) {
    await callRoute('POST', '/api/files', {
      workspaceId: bootstrapPayload.workspace.id,
      folderId: null,
      name: 'count-a.md',
      path: 'count-a.md',
      content: 'A',
    });
    await callRoute('POST', '/api/files', {
      workspaceId: bootstrapPayload.workspace.id,
      folderId: null,
      name: 'count-b.md',
      path: 'count-b.md',
      content: 'B',
    });
    const refreshed = await callRoute('GET', '/api/bootstrap');
    const files = (JSON.parse(refreshed.body) as { files: Array<{ id: string }> }).files;
    noteA = files[0]?.id ?? '';
    noteB = files[1]?.id ?? '';
  }

  const uploadForNoteA = buildMultipartUpload({
    workspace_id: bootstrapPayload.workspace.id,
    link_type: 'note',
    link_id: noteA,
    original_name: 'count-a.txt',
    mime_type: 'text/plain',
  }, {
    name: 'count-a.txt',
    mimeType: 'text/plain',
    content: Buffer.from('count-a', 'utf8'),
  });
  const uploadForNoteB = buildMultipartUpload({
    workspace_id: bootstrapPayload.workspace.id,
    link_type: 'note',
    link_id: noteB,
    original_name: 'count-b.txt',
    mime_type: 'text/plain',
  }, {
    name: 'count-b.txt',
    mimeType: 'text/plain',
    content: Buffer.from('count-b', 'utf8'),
  });

  assert.equal((await callRoute('POST', '/api/attachments/upload', uploadForNoteA.body, uploadForNoteA.headers)).status, 200);
  assert.equal((await callRoute('POST', '/api/attachments/upload', uploadForNoteA.body, uploadForNoteA.headers)).status, 200);
  assert.equal((await callRoute('POST', '/api/attachments/upload', uploadForNoteB.body, uploadForNoteB.headers)).status, 200);

  const countsResponse = await callRoute('GET', `/api/attachments/counts?linkType=note&ids=${noteA},${noteB}`);
  assert.equal(countsResponse.status, 200);
  const counts = JSON.parse(countsResponse.body) as Array<{ link_id: string; count: number }>;
  const byId = new Map(counts.map((row) => [row.link_id, Number(row.count)]));
  assert.equal(byId.get(noteA), 2);
  assert.equal(byId.get(noteB), 1);
});

test('unlinking final link soft deletes attachment', async () => {
  const bootstrap = await callRoute('GET', '/api/bootstrap');
  const bootstrapPayload = JSON.parse(bootstrap.body) as { workspace: { id: string } };
  const taskCreate = await callRoute('POST', '/api/research-tasks', { ticker: 'AAPL' });
  const task = JSON.parse(taskCreate.body) as { id: string };
  const multipart = buildMultipartUpload({
    workspace_id: bootstrapPayload.workspace.id,
    link_type: 'task',
    link_id: task.id,
    original_name: 'notes.txt',
    mime_type: 'text/plain',
  }, {
    name: 'notes.txt',
    mimeType: 'text/plain',
    content: Buffer.from('hello world', 'utf8'),
  });
  const upload = await callRoute('POST', '/api/attachments/upload', multipart.body, multipart.headers);
  const uploaded = JSON.parse(upload.body) as { id: string };
  const removed = await callRoute('DELETE', `/api/attachments/${uploaded.id}`, { link_type: 'task', link_id: task.id });
  assert.equal(removed.status, 200);
  const list = await callRoute('GET', `/api/attachments?linkType=task&linkId=${task.id}`);
  const listPayload = JSON.parse(list.body) as Array<{ id: string }>;
  assert.equal(listPayload.length, 0);
});

test('multipart upload accepts file at size limit and rejects file above limit', async () => {
  const bootstrap = await callRoute('GET', '/api/bootstrap');
  const bootstrapPayload = JSON.parse(bootstrap.body) as { workspace: { id: string } };
  const taskCreate = await callRoute('POST', '/api/research-tasks', { ticker: 'NVDA' });
  const task = JSON.parse(taskCreate.body) as { id: string };
  const atLimit = Buffer.alloc(10 * 1024 * 1024, 65);
  const withinLimitMultipart = buildMultipartUpload({
    workspace_id: bootstrapPayload.workspace.id,
    link_type: 'task',
    link_id: task.id,
    original_name: 'limit.bin',
    mime_type: 'application/octet-stream',
  }, {
    name: 'limit.bin',
    mimeType: 'application/octet-stream',
    content: atLimit,
  });
  const accepted = await callRoute('POST', '/api/attachments/upload', withinLimitMultipart.body, withinLimitMultipart.headers);
  assert.equal(accepted.status, 200);

  const aboveLimit = Buffer.alloc((10 * 1024 * 1024) + 1, 66);
  const overLimitMultipart = buildMultipartUpload({
    workspace_id: bootstrapPayload.workspace.id,
    link_type: 'task',
    link_id: task.id,
    original_name: 'too-large.bin',
    mime_type: 'application/octet-stream',
  }, {
    name: 'too-large.bin',
    mimeType: 'application/octet-stream',
    content: aboveLimit,
  });
  const rejected = await callRoute('POST', '/api/attachments/upload', overLimitMultipart.body, overLimitMultipart.headers);
  assert.equal(rejected.status, 413);
  assert.match(rejected.body, /10MB upload limit/i);
});

test('multipart upload enforces quota once storage is near limit', async () => {
  const bootstrap = await callRoute('GET', '/api/bootstrap');
  const bootstrapPayload = JSON.parse(bootstrap.body) as { workspace: { id: string } };
  const taskCreate = await callRoute('POST', '/api/research-tasks', { ticker: 'TSLA' });
  const task = JSON.parse(taskCreate.body) as { id: string };
  await callRoute('PUT', '/api/attachments/settings', { quota_mb: 50, retention_days: 30 });

  for (let index = 0; index < 5; index += 1) {
    const multipart = buildMultipartUpload({
      workspace_id: bootstrapPayload.workspace.id,
      link_type: 'task',
      link_id: task.id,
      original_name: `bulk-${index}.bin`,
      mime_type: 'application/octet-stream',
    }, {
      name: `bulk-${index}.bin`,
      mimeType: 'application/octet-stream',
      content: Buffer.alloc(10 * 1024 * 1024, index),
    });
    const response = await callRoute('POST', '/api/attachments/upload', multipart.body, multipart.headers);
    assert.equal(response.status, 200);
  }

  const overflowMultipart = buildMultipartUpload({
    workspace_id: bootstrapPayload.workspace.id,
    link_type: 'task',
    link_id: task.id,
    original_name: 'overflow.bin',
    mime_type: 'application/octet-stream',
  }, {
    name: 'overflow.bin',
    mimeType: 'application/octet-stream',
    content: Buffer.from([1]),
  });
  const overflow = await callRoute('POST', '/api/attachments/upload', overflowMultipart.body, overflowMultipart.headers);
  assert.equal(overflow.status, 413);
  assert.match(overflow.body, /quota exceeded/i);
});

test('attachment parse and cleanup hooks remain scoped to explicit attachment actions', () => {
  const source = readFileSync(path.resolve(process.cwd(), 'server/localApi.ts'), 'utf8');

  assert.match(source, /if \(req\.method === 'POST' && url === '\/api\/attachments\/upload'\)[\s\S]*parseAttachmentText\(/);
  assert.match(source, /if \(req\.method === 'POST' && url === '\/api\/attachments\/cleanup'\)[\s\S]*runAttachmentCleanup\(/);
  assert.equal((source.match(/parseAttachmentText\(/g) ?? []).length, 1);
  assert.equal((source.match(/runAttachmentCleanup\(/g) ?? []).length, 1);
});

test('generate prepends parsed attachment context under token cap', async () => {
  const bootstrap = await callRoute('GET', '/api/bootstrap');
  const bootstrapPayload = JSON.parse(bootstrap.body) as { workspace: { id: string }; files: Array<{ id: string }> };
  let noteId = bootstrapPayload.files[0]?.id ?? '';
  if (!noteId) {
    await callRoute('POST', '/api/files', {
      workspaceId: bootstrapPayload.workspace.id,
      folderId: null,
      name: 'note.md',
      path: 'note.md',
      content: 'x',
    });
    const refreshed = await callRoute('GET', '/api/bootstrap');
    noteId = (JSON.parse(refreshed.body) as { files: Array<{ id: string }> }).files[0]?.id ?? '';
  }
  const multipart = buildMultipartUpload({
    workspace_id: bootstrapPayload.workspace.id,
    link_type: 'note',
    link_id: noteId,
    original_name: 'ctx.txt',
    mime_type: 'text/plain',
  }, {
    name: 'ctx.txt',
    mimeType: 'text/plain',
    content: Buffer.from('Attachment context payload', 'utf8'),
  });
  await callRoute('POST', '/api/attachments/upload', multipart.body, multipart.headers);
  let capturedInput = '';
  const originalGenerate = providerRegistry.minimax.generate;
  providerRegistry.minimax.generate = async (request) => {
    capturedInput = request.inputText;
    return { outputText: 'ok', latencyMs: 1 };
  };
  try {
    const response = await callRoute('POST', '/api/agent/generate', {
      provider: 'minimax',
      model: 'mini',
      note_id: noteId,
      input_text: 'Main prompt body',
    });
    assert.equal(response.status, 200);
    assert.match(capturedInput, /\[ATTACHMENT_CONTEXT_BEGIN\]/);
    assert.match(capturedInput, /Attachment context payload/);
  } finally {
    providerRegistry.minimax.generate = originalGenerate;
  }
});

test('agent generate keeps attachment context in final provider input on web-search success path', async () => {
  const bootstrap = await callRoute('GET', '/api/bootstrap');
  const bootstrapPayload = JSON.parse(bootstrap.body) as { workspace: { id: string }; files: Array<{ id: string }> };
  const noteId = bootstrapPayload.files[0]?.id ?? '';
  assert.equal(Boolean(noteId), true);
  const multipart = buildMultipartUpload({
    workspace_id: bootstrapPayload.workspace.id,
    link_type: 'note',
    link_id: noteId,
    original_name: 'ctx-success.txt',
    mime_type: 'text/plain',
  }, {
    name: 'ctx-success.txt',
    mimeType: 'text/plain',
    content: Buffer.from('Attachment context success path', 'utf8'),
  });
  await callRoute('POST', '/api/attachments/upload', multipart.body, multipart.headers);

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
        fail_open_on_tool_error: true,
        source_citation: false,
      },
    },
  });

  const originalSearch = searchProviderRegistry.duckduckgo.search;
  const originalGenerate = providerRegistry.openai.generate;
  let capturedInput = '';
  searchProviderRegistry.duckduckgo.search = async () => ([
    { title: 'A', url: 'https://example.com/a', snippet: 'A', provider: 'duckduckgo' },
  ]);
  providerRegistry.openai.generate = async (request) => {
    capturedInput = request.inputText;
    return { outputText: 'ok', latencyMs: 1 };
  };

  try {
    const response = await withOpenAiToolCalls(['latest ai news'], () => callRoute('POST', '/api/agent/generate', {
      provider: 'openai',
      model: 'gpt-4.1',
      note_id: noteId,
      input_text: 'latest ai news',
    }));
    assert.equal(response.status, 200);
    assert.match(capturedInput, /\[ATTACHMENT_CONTEXT_BEGIN\]/);
    assert.match(capturedInput, /Attachment context success path/);
    assert.match(capturedInput, /<tool_outputs>/);
  } finally {
    searchProviderRegistry.duckduckgo.search = originalSearch;
    providerRegistry.openai.generate = originalGenerate;
  }
});

test('agent generate keeps attachment context in final provider input on fail-open path', async () => {
  const bootstrap = await callRoute('GET', '/api/bootstrap');
  const bootstrapPayload = JSON.parse(bootstrap.body) as { workspace: { id: string }; files: Array<{ id: string }> };
  const noteId = bootstrapPayload.files[0]?.id ?? '';
  assert.equal(Boolean(noteId), true);
  const multipart = buildMultipartUpload({
    workspace_id: bootstrapPayload.workspace.id,
    link_type: 'note',
    link_id: noteId,
    original_name: 'ctx-fail-open.txt',
    mime_type: 'text/plain',
  }, {
    name: 'ctx-fail-open.txt',
    mimeType: 'text/plain',
    content: Buffer.from('Attachment context fail open path', 'utf8'),
  });
  await callRoute('POST', '/api/attachments/upload', multipart.body, multipart.headers);

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
        fail_open_on_tool_error: true,
        source_citation: false,
      },
    },
  });

  const originalSearch = searchProviderRegistry.duckduckgo.search;
  const originalGenerate = providerRegistry.openai.generate;
  let capturedInput = '';
  searchProviderRegistry.duckduckgo.search = async () => {
    throw new Error('simulated failure');
  };
  providerRegistry.openai.generate = async (request) => {
    capturedInput = request.inputText;
    return { outputText: 'ok', latencyMs: 1 };
  };

  try {
    const response = await withOpenAiToolCalls(['latest ai news'], () => callRoute('POST', '/api/agent/generate', {
      provider: 'openai',
      model: 'gpt-4.1',
      note_id: noteId,
      input_text: 'latest ai news',
    }));
    assert.equal(response.status, 200);
    assert.match(capturedInput, /\[ATTACHMENT_CONTEXT_BEGIN\]/);
    assert.match(capturedInput, /Attachment context fail open path/);
    assert.doesNotMatch(capturedInput, /<tool_outputs>/);
    const frames = response.body.trim().split('\n').map((line) => JSON.parse(line) as { type?: string });
    assert.equal(frames.some((frame) => frame.type === 'search_warning'), true);
  } finally {
    searchProviderRegistry.duckduckgo.search = originalSearch;
    providerRegistry.openai.generate = originalGenerate;
  }
});

test('agent generate keeps attachment context in final provider input on non-search path', async () => {
  const bootstrap = await callRoute('GET', '/api/bootstrap');
  const bootstrapPayload = JSON.parse(bootstrap.body) as { workspace: { id: string }; files: Array<{ id: string }> };
  const noteId = bootstrapPayload.files[0]?.id ?? '';
  assert.equal(Boolean(noteId), true);
  const multipart = buildMultipartUpload({
    workspace_id: bootstrapPayload.workspace.id,
    link_type: 'note',
    link_id: noteId,
    original_name: 'ctx-non-search.txt',
    mime_type: 'text/plain',
  }, {
    name: 'ctx-non-search.txt',
    mimeType: 'text/plain',
    content: Buffer.from('Attachment context non search path', 'utf8'),
  });
  await callRoute('POST', '/api/attachments/upload', multipart.body, multipart.headers);
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
        fail_open_on_tool_error: true,
        source_citation: false,
      },
    },
  });

  const originalGenerate = providerRegistry.openai.generate;
  let capturedInput = '';
  providerRegistry.openai.generate = async (request) => {
    capturedInput = request.inputText;
    return { outputText: 'ok', latencyMs: 1 };
  };

  try {
    const response = await callRoute('POST', '/api/agent/generate', {
      provider: 'openai',
      model: 'gpt-4.1',
      note_id: noteId,
      input_text: 'Explain this concept briefly.',
    });
    assert.equal(response.status, 200);
    assert.match(capturedInput, /\[ATTACHMENT_CONTEXT_BEGIN\]/);
    assert.match(capturedInput, /Attachment context non search path/);
    assert.doesNotMatch(capturedInput, /<tool_outputs>/);
    const frames = response.body.trim().split('\n').map((line) => JSON.parse(line) as { type?: string });
    assert.equal(frames.some((frame) => frame.type === 'search_skipped'), true);
  } finally {
    providerRegistry.openai.generate = originalGenerate;
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
  assert.match(payload.error?.message ?? '', /saved default provider\/model/i);
  assert.match(payload.error?.message ?? '', /ChatGPT/i);
  assert.match(payload.error?.message ?? '', /not selected/i);
});

test('web-search validation still uses saved default provider/model when request includes divergent draft context', async () => {
  const response = await callRoute('PUT', '/api/agent/settings', {
    default_provider: 'minimax',
    default_model: '',
    draft_provider: 'ollama',
    draft_model: 'llama3.2:latest',
    generation_params: {
      web_search: {
        enabled: true,
      },
    },
  });
  assert.equal(response.status, 400);
  const payload = JSON.parse(response.body) as { error?: { message?: string } };
  assert.match(payload.error?.message ?? '', /saved default provider\/model/i);
  assert.match(payload.error?.message ?? '', /Minimax/i);
  assert.doesNotMatch(payload.error?.message ?? '', /ollama/i);
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

test('ollama model refresh maps runtime_base_url override and strips trailing slash', async () => {
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
  let seenBaseUrl = '';
  providerRegistry.ollama.listModels = async (_apiKey, options) => {
    seenBaseUrl = options.baseUrl ?? '';
    return {
      models: [{ modelId: 'llama3.1:8b', displayName: 'Llama 3.1 8B', B: 1 }],
      selected_model: 'llama3.1:8b',
      selection_source: 'live_catalog',
      catalog_status: 'live',
      reason_code: 'ok',
    };
  };

  try {
    const response = await callRoute('GET', '/api/agent/models?provider=ollama&runtime_base_url=http%3A%2F%2F127.0.0.1%3A11500%2F');
    assert.equal(response.status, 200);
    assert.equal(seenBaseUrl, 'http://127.0.0.1:11500');
  } finally {
    providerRegistry.ollama.listModels = originalListModels;
  }
});

test('minimax model list falls back to static model ids when API key is missing', async () => {
  const response = await callRoute('GET', '/api/agent/models?provider=minimax');
  assert.equal(response.status, 200);
  const payload = JSON.parse(response.body) as {
    models: Array<{ modelId: string }>;
    selected_model: string;
    selection_source: string;
    reason_code: string;
  };
  assert.deepEqual(payload.models.map((entry) => entry.modelId), ['MiniMax-M2.5', 'MiniMax-M2.7']);
  assert.equal(payload.selected_model, 'MiniMax-M2.5');
  assert.equal(payload.selection_source, 'provider_fallback');
  assert.equal(payload.reason_code, 'missing_api_key');
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
      provider_timeouts?: {
        generate_ms?: number;
        tool_first_turn_ms?: number;
        tool_followup_ms?: number;
        model_list_ms?: number;
      };
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
        fail_open_on_tool_error?: boolean;
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
  assert.equal(payload.generation_params?.web_search?.max_results, 6);
  assert.equal(payload.generation_params?.web_search?.timeout_ms, 10000);
  assert.equal(payload.generation_params?.web_search?.safe_search, false);
  assert.equal(payload.generation_params?.web_search?.recency, '30d');
  assert.equal(payload.generation_params?.web_search?.domain_policy, 'prefer_list');
  assert.equal(payload.generation_params?.web_search?.source_citation, false);
  assert.equal(payload.generation_params?.web_search?.fail_open_on_tool_error, true);
  assert.equal(payload.generation_params?.web_search?.provider_config?.searxng?.base_url, 'http://localhost:8080');
  assert.equal(payload.generation_params?.web_search?.provider_config?.searxng?.use_json_api, true);
  assert.equal(payload.generation_params?.provider_timeouts?.generate_ms, 45000);
  assert.equal(payload.generation_params?.provider_timeouts?.tool_first_turn_ms, 45000);
  assert.equal(payload.generation_params?.provider_timeouts?.tool_followup_ms, 45000);
  assert.equal(payload.generation_params?.provider_timeouts?.model_list_ms, 15000);
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

test('agent generate hard-fails when web search tool call fails in strict mode', async () => {
  await callRoute('PUT', '/api/agent/settings', {
    default_provider: 'openai',
    default_model: 'gpt-4.1',
    generation_params: {
      web_search: {
        enabled: true,
        mode: 'single',
        max_results: 5,
        timeout_ms: 3000,
        fail_open_on_tool_error: false,
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
    assert.equal(frames.some((line) => line.type === 'search_warning' && line.message === 'search is down'), true);
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

test('agent generate classifies internal AbortError as failed (not cancelled)', async () => {
  await callRoute('DELETE', '/api/agent/activity-log');
  await callRoute('PUT', '/api/agent/settings', {
    default_provider: 'openai',
    default_model: 'gpt-4.1',
  });
  const credentialSave = await callRoute('PUT', '/api/agent/credentials/openai', { api_key: 'sk-test' });
  assert.equal(credentialSave.status, 200);

  const originalGenerate = providerRegistry.openai.generate;
  providerRegistry.openai.generate = async () => {
    const timeoutError = new Error('internal timeout');
    timeoutError.name = 'AbortError';
    throw timeoutError;
  };

  try {
    const response = await callRoute('POST', '/api/agent/generate', {
      provider: 'openai',
      model: 'gpt-4.1',
      input_text: 'hello',
    });
    assert.equal(response.status, 200);
    const frames = response.body.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(frames.some((line) => line.type === 'error' && line.message === 'internal timeout' && line.aborted === false), true);
    const activityResponse = await callRoute('GET', '/api/agent/activity-log?limit=5');
    const activity = JSON.parse(activityResponse.body) as Array<{ status: string; error_message_short?: string }>;
    assert.equal(activity[0]?.status, 'failed');
    assert.equal(activity[0]?.error_message_short, 'internal timeout');
  } finally {
    providerRegistry.openai.generate = originalGenerate;
  }
});

test('agent generate returns protocol mismatch errors as failed with precise NDJSON message', async () => {
  await callRoute('DELETE', '/api/agent/activity-log');
  await callRoute('PUT', '/api/agent/settings', {
    default_provider: 'openai',
    default_model: 'gpt-4.1',
    generation_params: {
      web_search: {
        enabled: true,
        mode: 'single',
        max_results: 5,
        timeout_ms: 3000,
      },
    },
  });
  const credentialSave = await callRoute('PUT', '/api/agent/credentials/openai', { api_key: 'sk-test' });
  assert.equal(credentialSave.status, 200);

  const originalFirst = providerRegistry.openai.generateToolFirstTurn;
  providerRegistry.openai.generateToolFirstTurn = async () => ({
    outputText: '<tool_code>visit("https://example.com")</tool_code>',
    latencyMs: 1,
    toolCalls: [],
  });

  try {
    const response = await callRoute('POST', '/api/agent/generate', {
      provider: 'openai',
      model: 'gpt-4.1',
      input_text: 'hello',
    });
    assert.equal(response.status, 200);
    const frames = response.body.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(frames.some((line) => line.type === 'error' && String(line.message ?? '').includes('Protocol mismatch') && line.aborted === false), true);

    const activityResponse = await callRoute('GET', '/api/agent/activity-log?limit=5');
    const activity = JSON.parse(activityResponse.body) as Array<{ status: string; tool_failure_reason?: string }>;
    assert.equal(activity[0]?.status, 'failed');
    assert.match(activity[0]?.tool_failure_reason ?? '', /Protocol mismatch/i);
  } finally {
    providerRegistry.openai.generateToolFirstTurn = originalFirst;
  }
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
    safe_search: false,
    recency: 'any',
    domain_policy: 'open_web',
    fail_open_on_tool_error: true,
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

test('ollama generate keeps baseUrl on citation retry during web-search-backed Generate flow', async () => {
  const originalSearch = searchProviderRegistry.duckduckgo.search;
  const originalGenerate = providerRegistry.ollama.generate;
  const seenCalls: Array<{ inputText: string; baseUrl?: string }> = [];

  providerRegistry.ollama.generate = async (request) => {
    seenCalls.push({
      inputText: request.inputText,
      baseUrl: request.generationParams?.baseUrl,
    });
    return { outputText: 'Summary body', latencyMs: 1 };
  };
  searchProviderRegistry.duckduckgo.search = async () => ([
    { title: 'A', url: 'https://example.com/a', snippet: 'A', provider: 'duckduckgo' },
  ]);

  try {
    await callRoute('PUT', '/api/agent/settings', {
      default_provider: 'ollama',
      default_model: 'llama3.2:latest',
      generation_params: {
        local_connection: {
          base_url: 'http://127.0.0.1:11434',
          model: 'llama3.2:latest',
          B: 1,
        },
        web_search: {
          enabled: true,
          provider: 'duckduckgo',
          mode: 'single',
          max_results: 5,
          timeout_ms: 3000,
          source_citation: true,
        },
      },
    });

    const response = await withOllamaToolCalls([{ query: 'hello' }], () => callRoute('POST', '/api/agent/generate', {
      provider: 'ollama',
      model: 'ignored-by-server',
      input_text: 'hello',
    }));
    assert.equal(response.status, 200);
    assert.equal(seenCalls.length, 2);
    assert.deepEqual(seenCalls.map((call) => call.baseUrl), ['http://127.0.0.1:11434', 'http://127.0.0.1:11434']);
    assert.match(seenCalls[1]?.inputText ?? '', /Retry pass: use canonical citation format \[n\]\./);

    const frames = response.body.trim().split('\n').map((line) => JSON.parse(line) as { type?: string; outputText?: string });
    const doneFrame = frames.find((frame) => frame.type === 'done');
    assert.equal(doneFrame?.outputText, 'Summary body[lack citation]');
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
    assert.equal(warningFrames.some((frame) => frame.type === 'search_warning' && frame.message === 'simulated failure'), true);
    assert.equal(warningFrames.some((frame) => frame.type === 'done'), true);
    const activityResponse = await callRoute('GET', '/api/agent/activity-log?limit=5');
    const activity = JSON.parse(activityResponse.body) as Array<{ status: string; search_warning: number; search_warning_message: string | null }>;
    const warningEntry = activity.find((entry) => entry.status === 'success' && entry.search_warning === 1);
    assert.equal(warningEntry?.search_warning_message, 'simulated failure');
  } finally {
    searchProviderRegistry.duckduckgo.search = originalSearch;
    providerRegistry.openai.generate = originalGenerate;
  }
});

test('agent generate failed runs retain attempted tool counts after tool phase starts', async () => {
  const originalSearch = searchProviderRegistry.duckduckgo.search;
  const originalGenerate = providerRegistry.openai.generate;
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
          fail_open_on_tool_error: false,
          mode: 'single',
          max_results: 5,
          timeout_ms: 3000,
        },
      },
    });

    searchProviderRegistry.duckduckgo.search = async () => {
      throw new Error('simulated hard failure');
    };
    const failedResponse = await withOpenAiToolCalls(['hello'], () => callRoute('POST', '/api/agent/generate', {
      provider: 'openai',
      model: 'gpt-4.1',
      input_text: 'hello',
    }));
    assert.equal(failedResponse.status, 200);
    const failedFrames = failedResponse.body.trim().split('\n').map((line) => JSON.parse(line) as {
      type?: string;
      reason?: string;
      message?: string;
      aborted?: boolean;
    });
    assert.equal(failedFrames.some((frame) => frame.type === 'tool_call_started'), true);
    assert.equal(failedFrames.some((frame) => frame.type === 'tool_call_failed' && frame.reason === 'simulated hard failure'), true);
    assert.equal(failedFrames.some((frame) => frame.type === 'error' && frame.message === 'simulated hard failure' && frame.aborted === false), true);

    const activityResponse = await callRoute('GET', '/api/agent/activity-log?limit=5');
    assert.equal(activityResponse.status, 200);
    const activity = JSON.parse(activityResponse.body) as Array<{
      status: string;
      tool_calls_attempted: number;
      tool_calls_succeeded: number;
      search_query_count: number;
      source_count: number;
      tool_failure_reason: string | null;
    }>;
    const failedEntry = activity.find((entry) => entry.status === 'failed' && entry.tool_failure_reason === 'simulated hard failure');
    assert.equal((failedEntry?.tool_calls_attempted ?? 0) > 0, true);
    assert.equal((failedEntry?.search_query_count ?? 0) > 0, true);
    assert.equal(failedEntry?.tool_calls_succeeded ?? 0, 0);
    assert.equal(failedEntry?.source_count ?? 0, 0);
  } finally {
    searchProviderRegistry.duckduckgo.search = originalSearch;
    providerRegistry.openai.generate = originalGenerate;
  }
});

test('agent generate honors persisted source_citation setting regardless of prompt wording', async () => {
  const originalSearch = searchProviderRegistry.duckduckgo.search;
  const originalGenerate = providerRegistry.openai.generate;
  const receivedInputs: string[] = [];
  const seenGenerationParams: Array<{ temperature?: number; maxTokens?: number; baseUrl?: string }> = [];
  providerRegistry.openai.generate = async (request) => {
    receivedInputs.push(request.inputText);
    seenGenerationParams.push(request.generationParams ?? {});
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
    assert.match(receivedInputs.at(-1) ?? '', /Citation mode is REQUIRED/);
    const enabledFrames = enabledResponse.body.trim().split('\n').map((line) => JSON.parse(line) as {
      type?: string;
      outputText?: string;
      web_search?: { sourceCount?: number };
    });
    const enabledDone = enabledFrames.find((frame) => frame.type === 'done');
    assert.equal(enabledDone?.outputText, 'Summary body[lack citation]');
    assert.equal((enabledDone?.web_search?.sourceCount ?? 0) > 0, true);

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
      input_text: 'hello with citations',
    }));
    assert.equal(disabledResponse.status, 200);
    assert.doesNotMatch(receivedInputs.at(-1) ?? '', /Citation mode is REQUIRED/);
    const disabledFrames = disabledResponse.body.trim().split('\n').map((line) => JSON.parse(line) as { type?: string; outputText?: string });
    const disabledDone = disabledFrames.find((frame) => frame.type === 'done');
    assert.equal(disabledDone?.outputText, 'Summary body');
    assert.doesNotMatch(disabledDone?.outputText ?? '', /snippet/i);

    assert.equal(receivedInputs.length >= 3, true);
    const retryInput = receivedInputs.at(-1) ?? '';
    assert.match(retryInput, /Retry pass: use canonical citation format \[n\]\./);
    assert.deepEqual(seenGenerationParams.every((params) => params.baseUrl === undefined), true);

    const activityResponse = await callRoute('GET', '/api/agent/activity-log?limit=5');
    assert.equal(activityResponse.status, 200);
    const activity = JSON.parse(activityResponse.body) as Array<{
      citation_events_json?: string | null;
      web_search_enabled: number;
    }>;
    const latestDisabled = activity[0];
    const latestEnabled = activity[1];
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

test('agent generate routes web search by prompt heuristics when enabled', async () => {
  const originalSearch = searchProviderRegistry.duckduckgo.search;
  const originalGenerate = providerRegistry.openai.generate;
  providerRegistry.openai.generate = async () => ({ outputText: 'ok', latencyMs: 1 });
  let searchCalls = 0;
  searchProviderRegistry.duckduckgo.search = async () => {
    searchCalls += 1;
    return [{ title: 'News', url: 'https://example.com/news', snippet: 'snippet', provider: 'duckduckgo' }];
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
          mode: 'single',
          max_results: 5,
          timeout_ms: 3000,
        },
      },
    });

    const recencyResponse = await withOpenAiToolCalls(['latest ai headlines'], () => callRoute('POST', '/api/agent/generate', {
      provider: 'openai',
      model: 'gpt-4.1',
      input_text: 'What are the latest AI headlines today?',
    }));
    assert.equal(recencyResponse.status, 200);
    assert.equal(searchCalls, 1);
    const recencyFrames = recencyResponse.body.trim().split('\n').map((line) => JSON.parse(line) as { type?: string });
    assert.equal(recencyFrames.some((frame) => frame.type === 'tool_call_started'), true);

    const conceptualResponse = await withOpenAiToolCalls(['brainstorm ideas'], () => callRoute('POST', '/api/agent/generate', {
      provider: 'openai',
      model: 'gpt-4.1',
      input_text: 'Brainstorm product ideas for students.',
    }));
    assert.equal(conceptualResponse.status, 200);
    assert.equal(searchCalls, 1);
    const conceptualFrames = conceptualResponse.body.trim().split('\n').map((line) => JSON.parse(line) as { type?: string; reason?: string });
    assert.equal(conceptualFrames.some((frame) => frame.type === 'tool_call_started'), false);
    assert.equal(conceptualFrames.some((frame) => frame.type === 'search_skipped' && frame.reason === 'conceptual_or_opinion_or_brainstorm'), true);

    const explicitNoWeb = await withOpenAiToolCalls(['latest market news'], () => callRoute('POST', '/api/agent/generate', {
      provider: 'openai',
      model: 'gpt-4.1',
      input_text: 'Give latest market updates but do not search the web.',
    }));
    assert.equal(explicitNoWeb.status, 200);
    assert.equal(searchCalls, 1);
    const explicitFrames = explicitNoWeb.body.trim().split('\n').map((line) => JSON.parse(line) as { type?: string; reason?: string });
    assert.equal(explicitFrames.some((frame) => frame.type === 'search_skipped' && frame.reason === 'explicit_no_web'), true);
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

test('research task create clears date_completed when status is not completed', async () => {
  const createResponse = await callRoute('POST', '/api/research-tasks', {
    title: 'Normalize completion date',
    ticker: 'ACME',
    status: 'researching',
    date_completed: '2026-01-01',
  });
  assert.equal(createResponse.status, 200);
  const createdTask = JSON.parse(createResponse.body) as { status: string; date_completed: string };
  assert.equal(createdTask.status, 'researching');
  assert.equal(createdTask.date_completed, '');
});

test('research task create preserves provided date_completed when status is completed', async () => {
  const createResponse = await callRoute('POST', '/api/research-tasks', {
    title: 'Keep completion date',
    ticker: 'ACME',
    status: 'completed',
    date_completed: ' 2026-01-01 ',
  });
  assert.equal(createResponse.status, 200);
  const createdTask = JSON.parse(createResponse.body) as { status: string; date_completed: string };
  assert.equal(createdTask.status, 'completed');
  assert.equal(createdTask.date_completed, '2026-01-01');
});

test('research task status transitions normalize date_completed correctly', async () => {
  const createResponse = await callRoute('POST', '/api/research-tasks', {
    title: 'Status transition normalization',
    ticker: 'ACME',
    status: 'ideas',
    date_completed: '2026-01-01',
  });
  assert.equal(createResponse.status, 200);
  const createdTask = JSON.parse(createResponse.body) as { id: string; status: string; date_completed: string };
  assert.equal(createdTask.status, 'ideas');
  assert.equal(createdTask.date_completed, '');

  const completeResponse = await callRoute('PATCH', `/api/research-tasks/${createdTask.id}`, {
    status: 'completed',
    date_completed: ' 2026-02-02 ',
  });
  assert.equal(completeResponse.status, 200);
  const completedTask = JSON.parse(completeResponse.body) as { status: string; date_completed: string };
  assert.equal(completedTask.status, 'completed');
  assert.equal(completedTask.date_completed, '2026-02-02');

  const reopenResponse = await callRoute('PATCH', `/api/research-tasks/${createdTask.id}`, {
    status: 'researching',
    date_completed: '2026-03-03',
  });
  assert.equal(reopenResponse.status, 200);
  const reopenedTask = JSON.parse(reopenResponse.body) as { status: string; date_completed: string };
  assert.equal(reopenedTask.status, 'researching');
  assert.equal(reopenedTask.date_completed, '');
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

test('chat session endpoints return session and support settings/update flow', async () => {
  const sessionResponse = await callRoute('GET', '/api/chat/session/current');
  assert.equal(sessionResponse.status, 200);
  const session = JSON.parse(sessionResponse.body) as { id: string; is_primary: number; user_id: string };
  assert.equal(typeof session.id, 'string');
  assert.equal(session.is_primary, 1);
  assert.equal(session.user_id, 'local-user');

  const settingsBefore = await callRoute('GET', '/api/chat/settings');
  assert.equal(settingsBefore.status, 200);
  const parsedBefore = JSON.parse(settingsBefore.body) as { policy?: Record<string, unknown> };
  assert.equal(typeof parsedBefore.policy, 'object');

  const updateResponse = await callRoute('PUT', '/api/chat/settings', {
    policy: { max_context_messages: 12 },
    profile: { persona: 'concise' },
  });
  assert.equal(updateResponse.status, 200);

  const settingsAfter = await callRoute('GET', '/api/chat/settings');
  assert.equal(settingsAfter.status, 200);
  const parsedAfter = JSON.parse(settingsAfter.body) as {
    policy?: { max_context_messages?: number };
    profile?: { persona?: string };
  };
  assert.equal(parsedAfter.policy?.max_context_messages, 12);
  assert.equal(parsedAfter.profile?.persona, 'concise');

  const reloadResponse = await callRoute('POST', '/api/chat/profile/reload');
  assert.equal(reloadResponse.status, 200);
  const reloadPayload = JSON.parse(reloadResponse.body) as { profile?: { reloaded_at?: string; persona?: string } };
  assert.equal(reloadPayload.profile?.persona, 'concise');
  assert.equal(typeof reloadPayload.profile?.reloaded_at, 'string');
});

test('chat settings normalizes legacy action mode values to canonical values', async () => {
  const updateResponse = await callRoute('PUT', '/api/chat/settings', {
    policy: { action_mode: 'act', max_context_messages: 12 },
  });
  assert.equal(updateResponse.status, 200);

  const settingsAfter = await callRoute('GET', '/api/chat/settings');
  assert.equal(settingsAfter.status, 200);
  const parsedAfter = JSON.parse(settingsAfter.body) as {
    policy?: { action_mode?: string; max_context_messages?: number };
  };
  assert.equal(parsedAfter.policy?.action_mode, 'confirm_required');
  assert.equal(parsedAfter.policy?.max_context_messages, 12);
});

test('chat settings unknown action mode falls back to assist and emits structured warning log', async () => {
  const originalInfo = console.info;
  const infoCalls: Array<{ message: string; payload?: string }> = [];
  console.info = ((message: unknown, payload?: unknown) => {
    infoCalls.push({
      message: String(message ?? ''),
      payload: typeof payload === 'string' ? payload : undefined,
    });
  }) as typeof console.info;
  try {
    const updateResponse = await callRoute('PUT', '/api/chat/settings', {
      policy: { action_mode: 'totally-unknown-mode' },
    });
    assert.equal(updateResponse.status, 200);
  } finally {
    console.info = originalInfo;
  }

  const settingsAfter = await callRoute('GET', '/api/chat/settings');
  assert.equal(settingsAfter.status, 200);
  const parsedAfter = JSON.parse(settingsAfter.body) as { policy?: { action_mode?: string } };
  assert.equal(parsedAfter.policy?.action_mode, 'assist');

  const warningLog = infoCalls
    .filter((entry) => entry.message.includes('[local-api:chat.action_mode.warning]'))
    .map((entry) => (entry.payload ? JSON.parse(entry.payload) as { code?: string; raw_value?: string; fallback_mode?: string } : null))
    .find((entry) => entry?.code === 'unknown_chat_action_mode');
  assert.equal(warningLog?.raw_value, 'totally-unknown-mode');
  assert.equal(warningLog?.fallback_mode, 'assist');
});

test('chat settings mode persistence round-trip stores canonical value', async () => {
  const firstSave = await callRoute('PUT', '/api/chat/settings', {
    policy: { action_mode: 'manual' },
  });
  assert.equal(firstSave.status, 200);

  const settingsBeforeRestart = await callRoute('GET', '/api/chat/settings');
  assert.equal(settingsBeforeRestart.status, 200);
  const beforeRestartPayload = JSON.parse(settingsBeforeRestart.body) as { policy?: { action_mode?: string } };
  assert.equal(beforeRestartPayload.policy?.action_mode, 'manual_only');

  const settingsAfterRestart = await callRouteAfterRestart('GET', '/api/chat/settings');
  assert.equal(settingsAfterRestart.status, 200);
  const afterRestartPayload = JSON.parse(settingsAfterRestart.body) as { policy?: { action_mode?: string } };
  assert.equal(afterRestartPayload.policy?.action_mode, 'manual_only');
});

test('chat message streaming persists user+assistant turn and supports exports/history', async () => {
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
  const originalGenerate = providerRegistry.ollama.generate;
  providerRegistry.ollama.generate = async (_request, _apiKey, _signal, callbacks) => {
    callbacks?.onTextDelta?.('hello ');
    callbacks?.onTextDelta?.('world');
    return { outputText: 'hello world', latencyMs: 1 };
  };

  try {
    const postResponse = await callRoute('POST', '/api/chat/session/current/messages', {
      content: 'ping',
    });
    assert.equal(postResponse.status, 200);
    const frames = postResponse.body.trim().split('\n').map((line) => JSON.parse(line) as { type?: string; deltaText?: string });
    assert.equal(frames[0]?.type, 'status');
    assert.equal(frames.some((frame) => frame.type === 'delta' && frame.deltaText === 'hello '), true);
    assert.equal(frames.some((frame) => frame.type === 'done'), true);

    const listResponse = await callRoute('GET', '/api/chat/session/current/messages');
    assert.equal(listResponse.status, 200);
    const listPayload = JSON.parse(listResponse.body) as { messages: Array<{ role: string; content: string }> };
    const tail = listPayload.messages.slice(-2);
    assert.equal(tail[0]?.role, 'user');
    assert.equal(tail[0]?.content, 'ping');
    assert.equal(tail[1]?.role, 'assistant');
    assert.equal(tail[1]?.content, 'hello world');

    const exportJsonResponse = await callRoute('GET', '/api/chat/session/current/export?format=json');
    assert.equal(exportJsonResponse.status, 200);
    const exportJsonPayload = JSON.parse(exportJsonResponse.body) as { messages?: Array<{ role: string }> };
    assert.equal((exportJsonPayload.messages?.length ?? 0) >= 2, true);

    const exportMarkdownResponse = await callRoute('GET', '/api/chat/session/current/export?format=markdown');
    assert.equal(exportMarkdownResponse.status, 200);
    assert.match(exportMarkdownResponse.body, /Chat Transcript:/);

    const historyDeleteResponse = await callRoute('DELETE', '/api/chat/session/current/history?range=all');
    assert.equal(historyDeleteResponse.status, 200);
    const historyDeletePayload = JSON.parse(historyDeleteResponse.body) as { deletedMessages?: number };
    assert.equal((historyDeletePayload.deletedMessages ?? 0) >= 2, true);
  } finally {
    providerRegistry.ollama.generate = originalGenerate;
  }
});

test('chat tool orchestration saves pending draft for missing fields and streams lifecycle events', async () => {
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
  const originalFirstTurn = providerRegistry.ollama.generateToolFirstTurn;
  const originalGenerate = providerRegistry.ollama.generate;
  providerRegistry.ollama.generateToolFirstTurn = async () => ({
    outputText: '',
    latencyMs: 1,
    toolCalls: [{
      id: 'chat-tool-1',
      name: 'create_task',
      arguments: { ticker: 'aapl', title: 'Apple follow-up' },
    }],
  });
  providerRegistry.ollama.generate = async () => ({ outputText: 'fallback', latencyMs: 1 });
  try {
    const response = await callRoute('POST', '/api/chat/session/current/messages', { content: 'create a task for apple' });
    assert.equal(response.status, 200);
    const frames = response.body.trim().split('\n').map((line) => JSON.parse(line) as { type?: string; outcome?: string });
    assert.equal(frames.some((frame) => frame.type === 'tool_planning_started'), true);
    assert.equal(frames.some((frame) => frame.type === 'tool_call_started'), true);
    assert.equal(frames.some((frame) => frame.type === 'tool_call_result' && frame.outcome === 'needs_confirmation'), true);
    assert.equal(frames.some((frame) => frame.type === 'response_generation_started'), false);
    assert.equal(frames.some((frame) => frame.type === 'done'), true);

    const exported = await callRoute('GET', '/api/chat/session/current/export?format=json');
    assert.equal(exported.status, 200);
    const payload = JSON.parse(exported.body) as { pendingActions?: Array<{ action_key?: string; status?: string }> };
    assert.equal(payload.pendingActions?.some((action) => action.action_key === 'chat_tool:create_task' && action.status === 'pending'), true);
  } finally {
    providerRegistry.ollama.generateToolFirstTurn = originalFirstTurn;
    providerRegistry.ollama.generate = originalGenerate;
  }
});

test('pending draft TTL expiry auto-cancels and notifies user to recreate', async () => {
  process.env.PENDING_ACTION_TTL_MINUTES = '0.001';
  await callRouteAfterRestart('PUT', '/api/agent/credentials/openai', { api_key: 'test-key' });
  await callRouteAfterRestart('PUT', '/api/agent/settings', {
    default_provider: 'openai',
    default_model: 'gpt-4.1',
    generation_params: {
      local_connection: { base_url: 'http://localhost:11434', model: 'llama3.2:latest', B: 1 },
    },
  });
  const originalFirstTurn = providerRegistry.openai.generateToolFirstTurn;
  const originalGenerate = providerRegistry.openai.generate;
  providerRegistry.openai.generate = async () => ({ outputText: 'ok', latencyMs: 1 });
  try {
    providerRegistry.openai.generateToolFirstTurn = async () => ({
      outputText: '',
      latencyMs: 1,
      toolCalls: [{
        id: 'ttl-pending-create',
        name: 'create_task',
        arguments: { ticker: 'IBM', title: 'TTL pending draft' },
      }],
    });
    const first = await callRouteAfterRestart('POST', '/api/chat/session/current/messages', { content: 'create ttl task draft' });
    assert.equal(first.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 120));
    providerRegistry.openai.generateToolFirstTurn = async () => ({ outputText: '', latencyMs: 1, toolCalls: [] });
    const confirm = await callRouteAfterRestart('POST', '/api/chat/session/current/messages', { content: '/confirm' });
    assert.equal(confirm.status, 200);
    assert.match(confirm.body, /pending draft expired/i);
    assert.match(confirm.body, /recreate/i);

    const exported = await callRouteAfterRestart('GET', '/api/chat/session/current/export?format=json');
    const payload = JSON.parse(exported.body) as { pendingActions?: Array<{ action_key?: string; status?: string }> };
    const draft = payload.pendingActions?.find((entry) => entry.action_key === 'chat_tool:create_task');
    assert.equal(draft?.status, 'cancelled');
  } finally {
    providerRegistry.openai.generateToolFirstTurn = originalFirstTurn;
    providerRegistry.openai.generate = originalGenerate;
    delete process.env.PENDING_ACTION_TTL_MINUTES;
    await callRouteAfterRestart('GET', '/api/chat/session/current/messages');
  }
});

test('/cancel clears all pending drafts for the current session', async () => {
  await callRoute('PUT', '/api/agent/credentials/openai', { api_key: 'test-key' });
  await callRoute('PUT', '/api/agent/settings', {
    default_provider: 'openai',
    default_model: 'gpt-4.1',
    generation_params: {
      local_connection: { base_url: 'http://localhost:11434', model: 'llama3.2:latest', B: 1 },
    },
  });
  const originalFirstTurn = providerRegistry.openai.generateToolFirstTurn;
  const originalGenerate = providerRegistry.openai.generate;
  providerRegistry.openai.generate = async () => ({ outputText: 'ok', latencyMs: 1 });
  try {
    providerRegistry.openai.generateToolFirstTurn = async () => ({
      outputText: '',
      latencyMs: 1,
      toolCalls: [{
        id: 'cancel-pending-create',
        name: 'create_task',
        arguments: { ticker: 'AMD', title: 'Cancel pending create' },
      }],
    });
    await callRoute('POST', '/api/chat/session/current/messages', { content: 'create pending create draft' });
    providerRegistry.openai.generateToolFirstTurn = async () => ({
      outputText: '',
      latencyMs: 1,
      toolCalls: [{
        id: 'cancel-pending-note',
        name: 'generate_note',
        arguments: { instruction: 'Cancel pending note draft', title: 'Pending note' },
      }],
    });
    await callRoute('POST', '/api/chat/session/current/messages', { content: 'draft pending note' });

    const cancelled = await callRoute('POST', '/api/chat/session/current/messages', { content: '/cancel' });
    assert.equal(cancelled.status, 200);
    assert.match(cancelled.body, /cancelled 2 pending action drafts/i);

    const exported = await callRoute('GET', '/api/chat/session/current/export?format=json');
    const payload = JSON.parse(exported.body) as { pendingActions?: Array<{ status?: string }> };
    const pendingCount = payload.pendingActions?.filter((entry) => entry.status === 'pending').length ?? 0;
    assert.equal(pendingCount, 0);
  } finally {
    providerRegistry.openai.generateToolFirstTurn = originalFirstTurn;
    providerRegistry.openai.generate = originalGenerate;
  }
});

test('saving newer pending draft replaces older pending entry for same action type', async () => {
  await callRoute('PUT', '/api/agent/credentials/openai', { api_key: 'test-key' });
  await callRoute('PUT', '/api/agent/settings', {
    default_provider: 'openai',
    default_model: 'gpt-4.1',
    generation_params: {
      local_connection: { base_url: 'http://localhost:11434', model: 'llama3.2:latest', B: 1 },
    },
  });
  const originalFirstTurn = providerRegistry.openai.generateToolFirstTurn;
  const originalGenerate = providerRegistry.openai.generate;
  providerRegistry.openai.generate = async () => ({ outputText: 'ok', latencyMs: 1 });
  try {
    providerRegistry.openai.generateToolFirstTurn = async () => ({
      outputText: '',
      latencyMs: 1,
      toolCalls: [{
        id: 'replace-pending-1',
        name: 'create_task',
        arguments: { ticker: 'NVDA', title: 'Original pending title' },
      }],
    });
    await callRoute('POST', '/api/chat/session/current/messages', { content: 'create first pending draft' });

    providerRegistry.openai.generateToolFirstTurn = async () => ({
      outputText: '',
      latencyMs: 1,
      toolCalls: [{
        id: 'replace-pending-2',
        name: 'create_task',
        arguments: { ticker: 'NVDA', title: 'Replacement pending title' },
      }],
    });
    await callRoute('POST', '/api/chat/session/current/messages', { content: 'create replacement pending draft' });

    const exported = await callRoute('GET', '/api/chat/session/current/export?format=json');
    const payload = JSON.parse(exported.body) as {
      pendingActions?: Array<{ action_key?: string; status?: string; draft?: { arguments?: { title?: string } } }>;
    };
    const createTaskDrafts = payload.pendingActions?.filter((entry) => entry.action_key === 'chat_tool:create_task') ?? [];
    assert.equal(createTaskDrafts.length, 1);
    assert.equal(createTaskDrafts[0]?.status, 'pending');
    assert.equal(createTaskDrafts[0]?.draft?.arguments?.title, 'Replacement pending title');
  } finally {
    providerRegistry.openai.generateToolFirstTurn = originalFirstTurn;
    providerRegistry.openai.generate = originalGenerate;
  }
});

test('chat intent routing treats general prompts as conversation and skips tool planning', async () => {
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
  const originalFirstTurn = providerRegistry.ollama.generateToolFirstTurn;
  const originalGenerate = providerRegistry.ollama.generate;
  providerRegistry.ollama.generateToolFirstTurn = async () => {
    throw new Error('tool planner should not run for conversational prompts');
  };
  providerRegistry.ollama.generate = async () => ({ outputText: 'Conversational answer', latencyMs: 1 });
  try {
    for (const content of ['What is the weather in Seattle?', 'Which model are you using right now?']) {
      const response = await callRoute('POST', '/api/chat/session/current/messages', { content });
      assert.equal(response.status, 200);
      const frames = response.body.trim().split('\n').map((line) => JSON.parse(line) as { type?: string; route?: string; outputText?: string });
      assert.equal(frames.some((frame) => frame.type === 'tool_planning_started'), false);
      assert.equal(frames.some((frame) => frame.type === 'intent_routing' && frame.route === 'conversation'), true);
      const done = frames.find((frame) => frame.type === 'done');
      assert.equal(done?.outputText, 'Conversational answer');
    }
  } finally {
    providerRegistry.ollama.generateToolFirstTurn = originalFirstTurn;
    providerRegistry.ollama.generate = originalGenerate;
  }
});

test('chat intent routing sends clear actions to tool planning', async () => {
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
  const originalFirstTurn = providerRegistry.ollama.generateToolFirstTurn;
  const originalGenerate = providerRegistry.ollama.generate;
  providerRegistry.ollama.generateToolFirstTurn = async () => ({
    outputText: '',
    latencyMs: 1,
    toolCalls: [{
      id: 'action-route-tool-1',
      name: 'list_tasks_by_status',
      arguments: { status: 'ideas' },
    }],
  });
  providerRegistry.ollama.generate = async () => ({ outputText: 'Listed.', latencyMs: 1 });
  try {
    const response = await callRoute('POST', '/api/chat/session/current/messages', { content: 'list my idea tasks', explicit_confirm: true });
    assert.equal(response.status, 200);
    const frames = response.body.trim().split('\n').map((line) => JSON.parse(line) as { type?: string; route?: string; outcome?: string });
    assert.equal(frames.some((frame) => frame.type === 'intent_routing' && frame.route === 'action'), true);
    assert.equal(frames.some((frame) => frame.type === 'tool_planning_started'), true);
    assert.equal(frames.some((frame) => frame.type === 'tool_call_result' && frame.outcome === 'executed'), true);
  } finally {
    providerRegistry.ollama.generateToolFirstTurn = originalFirstTurn;
    providerRegistry.ollama.generate = originalGenerate;
  }
});

test('chat intent routing asks clarification for ambiguous action-like prompts', async () => {
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
  const originalFirstTurn = providerRegistry.ollama.generateToolFirstTurn;
  const originalGenerate = providerRegistry.ollama.generate;
  providerRegistry.ollama.generateToolFirstTurn = async () => {
    throw new Error('tool planner should not run for ambiguous prompts');
  };
  providerRegistry.ollama.generate = async () => {
    throw new Error('normal generation should not run for ambiguous prompts');
  };
  try {
    const response = await callRoute('POST', '/api/chat/session/current/messages', { content: 'can you help with tasks?' });
    assert.equal(response.status, 200);
    const frames = response.body.trim().split('\n').map((line) => JSON.parse(line) as { type?: string; route?: string; outputText?: string });
    assert.equal(frames.some((frame) => frame.type === 'intent_routing' && frame.route === 'ambiguous'), true);
    assert.equal(frames.some((frame) => frame.type === 'tool_planning_started'), false);
    const done = frames.find((frame) => frame.type === 'done');
    assert.match(done?.outputText ?? '', /run an action|conversationally/i);
  } finally {
    providerRegistry.ollama.generateToolFirstTurn = originalFirstTurn;
    providerRegistry.ollama.generate = originalGenerate;
  }
});

test('chat acceptance matrix enforces conversation/action/ambiguous routing thresholds', async () => {
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
  await callRoute('PUT', '/api/chat/settings', {
    policy: {
      action_mode: 'act',
      command_prefix_mode: 'off',
    },
  });

  const conversationPrompts = [
    'Explain index funds in plain English.',
    'What are three study habits that improve retention?',
    'How can I structure my day for deep work?',
    'What is the difference between RAM and storage?',
    'Give me a short pep talk before an interview.',
    'How should I think about risk versus reward?',
    'Compare monoliths and microservices at a high level.',
    'What does opportunity cost mean?',
    'How do I get better at asking clarifying questions?',
    'What are common signs of burnout?',
  ];
  const ambiguousPrompts = [
    'Can you help with my tasks?',
    'I need something done for Tesla.',
    'Do something with my notes.',
    'Can we work on my backlog?',
    'Could you manage my todo list?',
    'Can you help me with AAPL?',
    'Handle my note workflow.',
    'Can you take care of this task list?',
    'Need help organizing my projects.',
    'Can we do something about this note?',
  ];
  const actionPrompts: Array<{ content: string; expectedTool: string }> = [
    { content: 'list my idea tasks', expectedTool: 'list_tasks_by_status' },
    { content: 'create a task for nvda titled momentum check', expectedTool: 'create_task' },
    { content: 'update task t1 status to active', expectedTool: 'update_task' },
    { content: 'archive task t1', expectedTool: 'archive_task' },
    { content: 'generate note from task t1', expectedTool: 'generate_note' },
    { content: 'list my blocked tasks', expectedTool: 'list_tasks_by_status' },
    { content: 'create a task for aapl titled earnings prep', expectedTool: 'create_task' },
    { content: 'update task t2 title to revised title', expectedTool: 'update_task' },
    { content: 'archive task t2 now', expectedTool: 'archive_task' },
    { content: 'draft a note from task t2', expectedTool: 'generate_note' },
  ];

  const routeFromBody = (body: string): string => {
    const frames = body.trim().split('\n').map((line) => JSON.parse(line) as { type?: string; route?: string });
    return frames.find((frame) => frame.type === 'intent_routing')?.route ?? 'missing';
  };

  const originalFirstTurn = providerRegistry.ollama.generateToolFirstTurn;
  const originalGenerate = providerRegistry.ollama.generate;
  providerRegistry.ollama.generateToolFirstTurn = async (request) => {
    const text = request.inputText.toLowerCase();
    const mapping: Array<{ token: string; name: string }> = [
      { token: 'list my idea tasks', name: 'list_tasks_by_status' },
      { token: 'list my blocked tasks', name: 'list_tasks_by_status' },
      { token: 'create a task', name: 'create_task' },
      { token: 'update task', name: 'update_task' },
      { token: 'archive task', name: 'archive_task' },
      { token: 'generate note from task', name: 'generate_note' },
      { token: 'draft a note from task', name: 'generate_note' },
    ];
    const matched = mapping.find((entry) => text.includes(entry.token));
    if (!matched) throw new Error(`unmapped action prompt: ${request.inputText}`);
    return {
      outputText: '',
      latencyMs: 1,
      toolCalls: [{
        id: `matrix-${matched.name}`,
        name: matched.name,
        arguments: matched.name === 'list_tasks_by_status' ? { status: 'ideas' } : {},
      }],
    };
  };
  providerRegistry.ollama.generate = async () => ({ outputText: 'Conversational answer', latencyMs: 1 });

  try {
    let conversationAsAction = 0;
    let conversationAsConversation = 0;
    for (const prompt of conversationPrompts) {
      const response = await callRoute('POST', '/api/chat/session/current/messages', { content: prompt });
      assert.equal(response.status, 200);
      const route = routeFromBody(response.body);
      if (route === 'action') conversationAsAction += 1;
      if (route === 'conversation') conversationAsConversation += 1;
    }

    let ambiguousClarified = 0;
    for (const prompt of ambiguousPrompts) {
      const response = await callRoute('POST', '/api/chat/session/current/messages', { content: prompt });
      assert.equal(response.status, 200);
      const route = routeFromBody(response.body);
      if (route === 'ambiguous') ambiguousClarified += 1;
      const frames = response.body.trim().split('\n').map((line) => JSON.parse(line) as { type?: string });
      assert.equal(frames.some((frame) => frame.type === 'tool_planning_started'), false);
    }

    let successfulActionCompletions = 0;
    for (const prompt of actionPrompts) {
      const response = await callRoute('POST', '/api/chat/session/current/messages', { content: prompt.content, explicit_confirm: true });
      assert.equal(response.status, 200);
      const frames = response.body.trim().split('\n').map((line) => JSON.parse(line) as { type?: string; route?: string; outcome?: string; tool_name?: string });
      assert.equal(frames.some((frame) => frame.type === 'intent_routing' && frame.route === 'action'), true);
      const toolResult = frames.find((frame) => frame.type === 'tool_call_result');
      assert.equal(toolResult?.tool_name, prompt.expectedTool);
      if (toolResult?.outcome === 'executed') successfulActionCompletions += 1;
    }

    const falsePositiveActionRate = conversationAsAction / conversationPrompts.length;
    const conversationSuccessRate = conversationAsConversation / conversationPrompts.length;
    const ambiguousClarificationRate = ambiguousClarified / ambiguousPrompts.length;
    const actionCompletionRate = successfulActionCompletions / actionPrompts.length;

    assert.equal(conversationPrompts.length, 10);
    assert.equal(actionPrompts.length, 10);
    assert.equal(ambiguousPrompts.length, 10);
    assert.equal(falsePositiveActionRate <= 0.1, true, `false-positive action routing ${falsePositiveActionRate.toFixed(2)} exceeded 0.10`);
    assert.equal(conversationSuccessRate >= 0.9, true, `conversation routing success ${conversationSuccessRate.toFixed(2)} below 0.90`);
    assert.equal(ambiguousClarificationRate >= 0.9, true, `ambiguous clarification rate ${ambiguousClarificationRate.toFixed(2)} below 0.90`);
    assert.equal(actionCompletionRate >= 0.9, true, `action completion rate ${actionCompletionRate.toFixed(2)} below 0.90`);
  } finally {
    providerRegistry.ollama.generateToolFirstTurn = originalFirstTurn;
    providerRegistry.ollama.generate = originalGenerate;
  }
});

test('command prefix mode ON blocks natural-language tool execution and returns guidance', async () => {
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
  await callRoute('PUT', '/api/chat/settings', {
    policy: {
      action_mode: 'act',
      command_prefix_mode: 'on',
    },
  });
  const originalFirstTurn = providerRegistry.ollama.generateToolFirstTurn;
  providerRegistry.ollama.generateToolFirstTurn = async () => {
    throw new Error('tool planner should not run when NL tool request is blocked');
  };
  try {
    const response = await callRoute('POST', '/api/chat/session/current/messages', { content: 'create a task for apple' });
    assert.equal(response.status, 200);
    const frames = response.body.trim().split('\n').map((line) => JSON.parse(line) as { type?: string; outputText?: string });
    assert.equal(frames.some((frame) => frame.type === 'tool_planning_started'), false);
    const done = frames.find((frame) => frame.type === 'done');
    assert.match(done?.outputText ?? '', /Command prefix mode is enabled/);
  } finally {
    providerRegistry.ollama.generateToolFirstTurn = originalFirstTurn;
  }
});

test('command prefix mode OFF allows natural-language tool execution via intent routing', async () => {
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
  await callRoute('PUT', '/api/chat/settings', {
    policy: {
      action_mode: 'act',
      command_prefix_mode: 'off',
    },
  });
  const originalFirstTurn = providerRegistry.ollama.generateToolFirstTurn;
  const originalGenerate = providerRegistry.ollama.generate;
  providerRegistry.ollama.generateToolFirstTurn = async () => ({
    outputText: '',
    latencyMs: 1,
    toolCalls: [{
      id: 'prefix-off-tool-1',
      name: 'list_tasks_by_status',
      arguments: { status: 'ideas' },
    }],
  });
  providerRegistry.ollama.generate = async () => ({ outputText: 'listed', latencyMs: 1 });
  try {
    const response = await callRoute('POST', '/api/chat/session/current/messages', { content: 'list my idea tasks', explicit_confirm: true });
    assert.equal(response.status, 200);
    const frames = response.body.trim().split('\n').map((line) => JSON.parse(line) as { type?: string; outcome?: string });
    assert.equal(frames.some((frame) => frame.type === 'tool_planning_started'), true);
    assert.equal(frames.some((frame) => frame.type === 'tool_call_result' && frame.outcome === 'executed'), true);
  } finally {
    providerRegistry.ollama.generateToolFirstTurn = originalFirstTurn;
    providerRegistry.ollama.generate = originalGenerate;
  }
});

test('custom command prefix map is reflected in command parsing', async () => {
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
  await callRoute('PUT', '/api/chat/settings', {
    policy: {
      action_mode: 'act',
      command_prefix_mode: 'on',
      command_prefix_map: {
        task: '!do',
        note: '!note',
        confirm: '!ok',
        cancel: '!stop',
        help: '!help',
      },
    },
  });
  const originalFirstTurn = providerRegistry.ollama.generateToolFirstTurn;
  const originalGenerate = providerRegistry.ollama.generate;
  providerRegistry.ollama.generateToolFirstTurn = async () => ({
    outputText: '',
    latencyMs: 1,
    toolCalls: [{
      id: 'custom-prefix-tool-1',
      name: 'list_tasks_by_status',
      arguments: { status: 'ideas' },
    }],
  });
  providerRegistry.ollama.generate = async () => ({ outputText: 'ok', latencyMs: 1 });
  try {
    const response = await callRoute('POST', '/api/chat/session/current/messages', { content: '!do list idea tasks', explicit_confirm: true });
    assert.equal(response.status, 200);
    const frames = response.body.trim().split('\n').map((line) => JSON.parse(line) as { type?: string; outcome?: string });
    assert.equal(frames.some((frame) => frame.type === 'tool_planning_started'), true);
    assert.equal(frames.some((frame) => frame.type === 'tool_call_result' && frame.outcome === 'executed'), true);
  } finally {
    providerRegistry.ollama.generateToolFirstTurn = originalFirstTurn;
    providerRegistry.ollama.generate = originalGenerate;
  }
});

test('chat runtime settings deterministically reject missing-info tool drafts when ask_when_missing is disabled', async () => {
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
        timeout_ms: 5000,
        safe_search: true,
        recency: 'any',
        domain_policy: 'open_web',
        source_citation: false,
        fail_open_on_tool_error: true,
      },
    },
  });
  await callRoute('PUT', '/api/chat/settings', {
    policy: {
      action_mode: 'act',
      ask_when_missing: false,
      command_prefix_mode: 'off',
      detailed_tool_steps: true,
    },
  });
  const originalFirstTurn = providerRegistry.ollama.generateToolFirstTurn;
  const originalGenerate = providerRegistry.ollama.generate;
  providerRegistry.ollama.generateToolFirstTurn = async () => ({
    outputText: '',
    latencyMs: 1,
    toolCalls: [{
      id: 'missing-required-1',
      name: 'create_task',
      arguments: { ticker: 'AAPL' },
    }],
  });
  providerRegistry.ollama.generate = async () => ({ outputText: 'fallback', latencyMs: 1 });
  try {
    const response = await callRoute('POST', '/api/chat/session/current/messages', { content: 'create a task for apple', explicit_confirm: true });
    assert.equal(response.status, 200);
    const frames = response.body.trim().split('\n').map((line) => JSON.parse(line) as { type?: string; outcome?: string; outputText?: string });
    assert.equal(frames.some((frame) => frame.type === 'intent_routing' && frame.outcome === undefined), true);
    assert.equal(frames.some((frame) => frame.type === 'tool_call_result' && frame.outcome === 'rejected'), true);
    const done = frames.find((frame) => frame.type === 'done');
    assert.match(done?.outputText ?? '', /missing required fields/i);
  } finally {
    providerRegistry.ollama.generateToolFirstTurn = originalFirstTurn;
    providerRegistry.ollama.generate = originalGenerate;
  }
});

test('chat runtime settings hide tool trace frames when detailed_tool_steps is disabled', async () => {
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
  await callRoute('PUT', '/api/chat/settings', {
    policy: {
      action_mode: 'act',
      ask_when_missing: true,
      command_prefix_mode: 'off',
      detailed_tool_steps: false,
    },
  });
  const originalFirstTurn = providerRegistry.ollama.generateToolFirstTurn;
  const originalGenerate = providerRegistry.ollama.generate;
  providerRegistry.ollama.generateToolFirstTurn = async () => ({
    outputText: '',
    latencyMs: 1,
    toolCalls: [{
      id: 'trace-hidden-1',
      name: 'list_tasks_by_status',
      arguments: { status: 'ideas' },
    }],
  });
  providerRegistry.ollama.generate = async () => ({ outputText: 'listed', latencyMs: 1 });
  try {
    const response = await callRoute('POST', '/api/chat/session/current/messages', { content: 'list my idea tasks', explicit_confirm: true });
    assert.equal(response.status, 200);
    const frames = response.body.trim().split('\n').map((line) => JSON.parse(line) as { type?: string; outputText?: string });
    assert.equal(frames.some((frame) => String(frame.type ?? '').startsWith('tool_')), false);
    assert.equal(frames.some((frame) => String(frame.type ?? '').startsWith('response_generation_')), false);
    assert.equal(frames.some((frame) => frame.type === 'done' && typeof frame.outputText === 'string'), true);
  } finally {
    providerRegistry.ollama.generateToolFirstTurn = originalFirstTurn;
    providerRegistry.ollama.generate = originalGenerate;
  }
});

test('chat tool orchestration executes approved action and persists structured tool metadata', async () => {
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
  const originalFirstTurn = providerRegistry.ollama.generateToolFirstTurn;
  const originalGenerate = providerRegistry.ollama.generate;
  providerRegistry.ollama.generateToolFirstTurn = async () => ({
    outputText: '',
    latencyMs: 1,
    toolCalls: [{
      id: 'chat-tool-2',
      name: 'create_task',
      arguments: { ticker: 'msft', title: 'Refresh model', note_type: 'update' },
    }],
  });
  providerRegistry.ollama.generate = async () => ({ outputText: 'Created and summarized.', latencyMs: 1 });
  try {
    const response = await callRoute('POST', '/api/chat/session/current/messages', {
      content: 'please create it',
      explicit_confirm: true,
    });
    assert.equal(response.status, 200);
    const frames = response.body.trim().split('\n').map((line) => JSON.parse(line) as { type?: string; outcome?: string });
    assert.equal(frames.some((frame) => frame.type === 'tool_call_result' && frame.outcome === 'executed'), true);
    assert.equal(frames.some((frame) => frame.type === 'response_generation_started'), true);
    assert.equal(frames.some((frame) => frame.type === 'response_generation_completed'), true);
    assert.equal(frames.some((frame) => frame.type === 'delta' || frame.type === 'done'), true);

    const tasksResponse = await callRoute('GET', '/api/research-tasks');
    assert.equal(tasksResponse.status, 200);
    const tasks = JSON.parse(tasksResponse.body) as Array<{ ticker: string; title: string }>;
    assert.equal(tasks.some((task) => task.ticker === 'MSFT' && task.title === 'Refresh model'), true);

    const messagesResponse = await callRoute('GET', '/api/chat/session/current/messages');
    assert.equal(messagesResponse.status, 200);
    const messagesPayload = JSON.parse(messagesResponse.body) as {
      messages: Array<{
        role: string;
        metadata?: {
          tool?: {
            note_id?: string | null;
            note_path?: string | null;
            task_id?: string | null;
            action?: string | null;
            tool_outcome?: string;
          };
        };
      }>;
    };
    const latestAssistant = [...messagesPayload.messages].reverse().find((message) => message.role === 'assistant');
    assert.equal(latestAssistant?.metadata?.tool?.tool_outcome, 'executed');
    assert.equal(latestAssistant?.metadata?.tool?.action, 'create_task');
    assert.equal(latestAssistant?.metadata?.tool?.note_id ?? null, null);
    assert.equal(latestAssistant?.metadata?.tool?.note_path ?? null, null);
    assert.equal(latestAssistant?.metadata?.tool?.task_id ?? null, null);

    const activityResponse = await callRoute('GET', '/api/agent/activity-log?limit=10');
    assert.equal(activityResponse.status, 200);
    const activity = JSON.parse(activityResponse.body) as Array<{ trigger_source: string; action: string; status: string }>;
    assert.equal(activity.some((entry) => entry.trigger_source === 'chat_tool' && entry.action === 'create_task' && entry.status === 'success'), true);
  } finally {
    providerRegistry.ollama.generateToolFirstTurn = originalFirstTurn;
    providerRegistry.ollama.generate = originalGenerate;
  }
});

test('chat generate_note execution persists note metadata for future deep links', async () => {
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
  const originalFirstTurn = providerRegistry.ollama.generateToolFirstTurn;
  const originalGenerate = providerRegistry.ollama.generate;
  providerRegistry.ollama.generateToolFirstTurn = async () => ({
    outputText: '',
    latencyMs: 1,
    toolCalls: [{
      id: 'chat-tool-note-metadata',
      name: 'generate_note',
      arguments: { instruction: 'Draft note for metadata coverage', title: 'Metadata Coverage Note' },
    }],
  });
  providerRegistry.ollama.generate = async () => ({ outputText: 'Created note and summarized.', latencyMs: 1 });
  try {
    const response = await callRoute('POST', '/api/chat/session/current/messages', {
      content: 'create a metadata note',
      explicit_confirm: true,
    });
    assert.equal(response.status, 200);

    const messagesResponse = await callRoute('GET', '/api/chat/session/current/messages');
    assert.equal(messagesResponse.status, 200);
    const messagesPayload = JSON.parse(messagesResponse.body) as {
      messages: Array<{
        role: string;
        metadata?: {
          tool?: {
            note_id?: string | null;
            note_path?: string | null;
            task_id?: string | null;
            action?: string | null;
            tool_outcome?: string;
          };
        };
      }>;
    };
    const latestAssistant = [...messagesPayload.messages].reverse().find((message) => message.role === 'assistant');
    assert.equal(latestAssistant?.metadata?.tool?.tool_outcome, 'executed');
    assert.equal(latestAssistant?.metadata?.tool?.action, 'created');
    assert.equal(typeof latestAssistant?.metadata?.tool?.note_id, 'string');
    assert.equal(typeof latestAssistant?.metadata?.tool?.note_path, 'string');
    assert.equal(latestAssistant?.metadata?.tool?.task_id ?? null, null);
  } finally {
    providerRegistry.ollama.generateToolFirstTurn = originalFirstTurn;
    providerRegistry.ollama.generate = originalGenerate;
  }
});

test('normal chat turns remain in chat history only and do not emit agent activity events', async () => {
  await callRoute('DELETE', '/api/agent/activity-log');
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
  const originalFirstTurn = providerRegistry.ollama.generateToolFirstTurn;
  const originalGenerate = providerRegistry.ollama.generate;
  providerRegistry.ollama.generateToolFirstTurn = async () => ({
    outputText: 'No tools needed.',
    latencyMs: 1,
    toolCalls: [],
  });
  providerRegistry.ollama.generate = async () => ({ outputText: 'Pure conversational response.', latencyMs: 1 });
  try {
    const response = await callRoute('POST', '/api/chat/session/current/messages', {
      content: 'explain what happened today without running tools',
      explicit_confirm: true,
    });
    assert.equal(response.status, 200);

    const messagesResponse = await callRoute('GET', '/api/chat/session/current/messages');
    assert.equal(messagesResponse.status, 200);
    const messagesPayload = JSON.parse(messagesResponse.body) as { messages: Array<{ role: string }> };
    assert.equal(messagesPayload.messages.some((message) => message.role === 'assistant'), true);

    const activityResponse = await callRoute('GET', '/api/agent/activity-log?limit=10');
    assert.equal(activityResponse.status, 200);
    const activity = JSON.parse(activityResponse.body) as Array<{ trigger_source: string }>;
    assert.equal(activity.some((entry) => entry.trigger_source === 'chat_tool'), false);
  } finally {
    providerRegistry.ollama.generateToolFirstTurn = originalFirstTurn;
    providerRegistry.ollama.generate = originalGenerate;
  }
});

test('stream done frame keeps meaningful outputText after successful tool execution', async () => {
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
  const originalFirstTurn = providerRegistry.ollama.generateToolFirstTurn;
  const originalGenerate = providerRegistry.ollama.generate;
  providerRegistry.ollama.generateToolFirstTurn = async () => ({
    outputText: '',
    latencyMs: 1,
    toolCalls: [{
      id: 'tool-success-meaningful-done',
      name: 'list_tasks_by_status',
      arguments: { status: 'ideas' },
    }],
  });
  providerRegistry.ollama.generate = async (_request, _apiKey, _signal, hooks) => {
    hooks?.onTextDelta?.('I listed your idea tasks. ');
    hooks?.onTextDelta?.('You can ask me to filter by ticker next.');
    return { outputText: '', latencyMs: 1 };
  };
  try {
    const response = await callRoute('POST', '/api/chat/session/current/messages', {
      content: 'list my idea tasks',
      explicit_confirm: true,
    });
    assert.equal(response.status, 200);
    const frames = response.body.trim().split('\n').map((line) => JSON.parse(line) as { type?: string; outputText?: string });
    const done = frames.find((frame) => frame.type === 'done');
    assert.equal(done?.outputText, 'I listed your idea tasks. You can ask me to filter by ticker next.');
  } finally {
    providerRegistry.ollama.generateToolFirstTurn = originalFirstTurn;
    providerRegistry.ollama.generate = originalGenerate;
  }
});

test('confirmation-required tool path emits natural-language done output with next step', async () => {
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
  const originalFirstTurn = providerRegistry.ollama.generateToolFirstTurn;
  const originalGenerate = providerRegistry.ollama.generate;
  providerRegistry.ollama.generateToolFirstTurn = async () => ({
    outputText: '',
    latencyMs: 1,
    toolCalls: [{
      id: 'tool-needs-confirm-meaningful-done',
      name: 'create_task',
      arguments: { ticker: 'aapl', title: 'Needs confirm draft' },
    }],
  });
  providerRegistry.ollama.generate = async () => ({ outputText: 'should not run', latencyMs: 1 });
  try {
    const response = await callRoute('POST', '/api/chat/session/current/messages', { content: 'create a task for apple' });
    assert.equal(response.status, 200);
    const frames = response.body.trim().split('\n').map((line) => JSON.parse(line) as { type?: string; outputText?: string });
    const done = frames.find((frame) => frame.type === 'done');
    assert.match(done?.outputText ?? '', /prepared the requested action/i);
    assert.match(done?.outputText ?? '', /reply with \/confirm|reply with confirm/i);
  } finally {
    providerRegistry.ollama.generateToolFirstTurn = originalFirstTurn;
    providerRegistry.ollama.generate = originalGenerate;
  }
});

test('tool rejection fallback emits natural-language done output with recovery guidance', async () => {
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
  const originalFirstTurn = providerRegistry.ollama.generateToolFirstTurn;
  const originalGenerate = providerRegistry.ollama.generate;
  providerRegistry.ollama.generateToolFirstTurn = async () => ({
    outputText: '',
    latencyMs: 1,
    toolCalls: [{
      id: 'tool-rejected-meaningful-done',
      name: 'update_task',
      arguments: { task_id: 'missing-task-id', status: 'researching' },
    }],
  });
  providerRegistry.ollama.generate = async () => ({ outputText: 'should not run', latencyMs: 1 });
  try {
    const response = await callRoute('POST', '/api/chat/session/current/messages', {
      content: 'update missing task',
      explicit_confirm: true,
    });
    assert.equal(response.status, 200);
    const frames = response.body.trim().split('\n').map((line) => JSON.parse(line) as { type?: string; outcome?: string; outputText?: string });
    assert.equal(frames.some((frame) => frame.type === 'tool_call_result' && frame.outcome === 'rejected'), true);
    const done = frames.find((frame) => frame.type === 'done');
    assert.match(done?.outputText ?? '', /attempted the action/i);
    assert.match(done?.outputText ?? '', /try again|help rewrite/i);
  } finally {
    providerRegistry.ollama.generateToolFirstTurn = originalFirstTurn;
    providerRegistry.ollama.generate = originalGenerate;
  }
});

test('chat tool orchestration keeps Tier C pending after disambiguation until structured confirmation is provided', async () => {
  await callRoute('PUT', '/api/agent/credentials/openai', { api_key: 'test-key' });
  await callRoute('PUT', '/api/agent/settings', {
    default_provider: 'openai',
    default_model: 'gpt-4.1',
    generation_params: {
      local_connection: { base_url: 'http://localhost:11434', model: 'llama3.2:latest', B: 1 },
    },
  });

  const seedOne = await callRoute('POST', '/api/research-tasks', {
    ticker: 'AAPL',
    title: 'Apple idea alpha',
    note_type: 'Research',
    status: 'ideas',
  });
  assert.equal(seedOne.status, 201);
  const seedTwo = await callRoute('POST', '/api/research-tasks', {
    ticker: 'AAPL',
    title: 'Apple idea beta',
    note_type: 'Research',
    status: 'ideas',
  });
  assert.equal(seedTwo.status, 201);

  const originalFirstTurn = providerRegistry.openai.generateToolFirstTurn;
  const originalGenerate = providerRegistry.openai.generate;
  providerRegistry.openai.generate = async () => ({ outputText: 'post-tool summary', latencyMs: 1 });

  try {
    providerRegistry.openai.generateToolFirstTurn = async () => ({
      outputText: '',
      latencyMs: 1,
      toolCalls: [{
        id: 'tool-archive-ambiguous',
        name: 'archive_task',
        arguments: { task_ref: 'aapl' },
      }],
    });

    const firstResponse = await callRoute('POST', '/api/chat/session/current/messages', {
      content: 'archive the apple task',
      explicit_confirm: true,
    });
    assert.equal(firstResponse.status, 200);
    const firstFrames = firstResponse.body.trim().split('\n').map((line) => JSON.parse(line) as {
      type?: string;
      outcome?: string;
      disambiguation_prompt?: string;
    });
    const firstOutcome = firstFrames.find((frame) => frame.type === 'tool_call_result');
    assert.equal(firstOutcome?.outcome, 'needs_disambiguation');
    assert.match(firstOutcome?.disambiguation_prompt ?? '', /Reply with the task number/);

    providerRegistry.openai.generateToolFirstTurn = async () => ({
      outputText: '',
      latencyMs: 1,
      toolCalls: [],
    });
    const secondResponse = await callRoute('POST', '/api/chat/session/current/messages', {
      content: '1',
    });
    assert.equal(secondResponse.status, 200);
    const secondFrames = secondResponse.body.trim().split('\n').map((line) => JSON.parse(line) as {
      type?: string;
      outputText?: string;
    });
    const secondDone = secondFrames.find((frame) => frame.type === 'done');
    assert.match(secondDone?.outputText ?? '', /Tier C.*\/confirm archive/i);

    const tasksBeforeConfirm = await callRoute('GET', '/api/research-tasks');
    assert.equal(tasksBeforeConfirm.status, 200);
    const tasksBefore = JSON.parse(tasksBeforeConfirm.body) as Array<{ id: string; archived: boolean }>;
    const pendingTask = tasksBefore.find((task) => !task.archived);
    assert.equal(typeof pendingTask?.id, 'string');

    const thirdResponse = await callRoute('POST', '/api/chat/session/current/messages', {
      content: `/confirm archive ${pendingTask?.id}`,
    });
    assert.equal(thirdResponse.status, 200);
    const thirdFrames = thirdResponse.body.trim().split('\n').map((line) => JSON.parse(line) as {
      type?: string;
      outcome?: string;
      resumed_from_pending?: boolean;
    });
    const resumedOutcome = thirdFrames.find((frame) => frame.type === 'tool_call_result');
    assert.equal(resumedOutcome?.resumed_from_pending, true);
    assert.equal(resumedOutcome?.outcome, 'executed');

    const tasksResponse = await callRoute('GET', '/api/research-tasks');
    assert.equal(tasksResponse.status, 200);
    const tasks = JSON.parse(tasksResponse.body) as Array<{ ticker: string; title: string; archived: boolean }>;
    const archivedAaplCount = tasks.filter((task) => task.ticker === 'AAPL' && task.archived).length;
    assert.equal(archivedAaplCount >= 1, true);
  } finally {
    providerRegistry.openai.generateToolFirstTurn = originalFirstTurn;
    providerRegistry.openai.generate = originalGenerate;
  }
});

test('Tier B pending actions accept /confirm and confirm', async () => {
  await callRoute('PUT', '/api/agent/credentials/openai', { api_key: 'test-key' });
  await callRoute('PUT', '/api/agent/settings', {
    default_provider: 'openai',
    default_model: 'gpt-4.1',
    generation_params: {
      local_connection: { base_url: 'http://localhost:11434', model: 'llama3.2:latest', B: 1 },
    },
  });
  const seeded = await callRoute('POST', '/api/research-tasks', {
    ticker: 'TSLA',
    title: 'Tesla baseline',
    note_type: 'Research',
    status: 'ideas',
  });
  const seededTask = JSON.parse(seeded.body) as { id: string };
  const originalFirstTurn = providerRegistry.openai.generateToolFirstTurn;
  const originalGenerate = providerRegistry.openai.generate;
  providerRegistry.openai.generate = async () => ({ outputText: 'ok', latencyMs: 1 });
  try {
    providerRegistry.openai.generateToolFirstTurn = async () => ({
      outputText: '',
      latencyMs: 1,
      toolCalls: [{
        id: 'tier-b-update',
        name: 'update_task',
        arguments: { task_id: seededTask.id, status: 'researching' },
      }],
    });
    const first = await callRoute('POST', '/api/chat/session/current/messages', { content: 'update task status' });
    const firstFrames = first.body.trim().split('\n').map((line) => JSON.parse(line) as { type?: string; outcome?: string });
    assert.equal(firstFrames.some((frame) => frame.type === 'tool_call_result' && frame.outcome === 'needs_confirmation'), true);

    providerRegistry.openai.generateToolFirstTurn = async () => ({ outputText: '', latencyMs: 1, toolCalls: [] });
    const confirmText = await callRoute('POST', '/api/chat/session/current/messages', { content: 'confirm' });
    const confirmFrames = confirmText.body.trim().split('\n').map((line) => JSON.parse(line) as { type?: string; outcome?: string; resumed_from_pending?: boolean });
    assert.equal(confirmFrames.some((frame) => frame.type === 'tool_call_result' && frame.outcome === 'executed' && frame.resumed_from_pending), true);

    providerRegistry.openai.generateToolFirstTurn = async () => ({
      outputText: '',
      latencyMs: 1,
      toolCalls: [{
        id: 'tier-b-update-2',
        name: 'update_task',
        arguments: { task_id: seededTask.id, details: 'new details' },
      }],
    });
    await callRoute('POST', '/api/chat/session/current/messages', { content: 'update details please' });
    providerRegistry.openai.generateToolFirstTurn = async () => ({ outputText: '', latencyMs: 1, toolCalls: [] });
    const slashConfirm = await callRoute('POST', '/api/chat/session/current/messages', { content: '/confirm' });
    const slashFrames = slashConfirm.body.trim().split('\n').map((line) => JSON.parse(line) as { type?: string; outcome?: string; resumed_from_pending?: boolean });
    assert.equal(slashFrames.some((frame) => frame.type === 'tool_call_result' && frame.outcome === 'executed' && frame.resumed_from_pending), true);
  } finally {
    providerRegistry.openai.generateToolFirstTurn = originalFirstTurn;
    providerRegistry.openai.generate = originalGenerate;
  }
});

test('Tier C pending archive requires target-specific structured confirmation and handles malformed forms', async () => {
  await callRoute('PUT', '/api/agent/credentials/openai', { api_key: 'test-key' });
  await callRoute('PUT', '/api/agent/settings', {
    default_provider: 'openai',
    default_model: 'gpt-4.1',
    generation_params: {
      local_connection: { base_url: 'http://localhost:11434', model: 'llama3.2:latest', B: 1 },
    },
  });
  const seeded = await callRoute('POST', '/api/research-tasks', {
    ticker: 'ORCL',
    title: 'Oracle archive candidate',
    note_type: 'Research',
    status: 'ideas',
  });
  const seededTask = JSON.parse(seeded.body) as { id: string };
  const originalFirstTurn = providerRegistry.openai.generateToolFirstTurn;
  const originalGenerate = providerRegistry.openai.generate;
  providerRegistry.openai.generate = async () => ({ outputText: 'ok', latencyMs: 1 });
  try {
    providerRegistry.openai.generateToolFirstTurn = async () => ({
      outputText: '',
      latencyMs: 1,
      toolCalls: [{
        id: 'tier-c-archive',
        name: 'archive_task',
        arguments: { task_id: seededTask.id },
      }],
    });
    await callRoute('POST', '/api/chat/session/current/messages', { content: 'archive this task' });
    providerRegistry.openai.generateToolFirstTurn = async () => ({ outputText: '', latencyMs: 1, toolCalls: [] });

    const plain = await callRoute('POST', '/api/chat/session/current/messages', { content: '/confirm' });
    assert.match(plain.body, /Tier C.*\/confirm archive/i);

    const malformed = await callRoute('POST', '/api/chat/session/current/messages', { content: '/confirm archive' });
    assert.match(malformed.body, /couldn't parse.*\/confirm archive/i);

    const wrongTarget = await callRoute('POST', '/api/chat/session/current/messages', { content: '/confirm archive wrong-id' });
    assert.match(wrongTarget.body, /target mismatch.*\/confirm archive/i);

    const success = await callRoute('POST', '/api/chat/session/current/messages', { content: `/confirm archive ${seededTask.id}` });
    const successFrames = success.body.trim().split('\n').map((line) => JSON.parse(line) as { type?: string; outcome?: string; resumed_from_pending?: boolean });
    assert.equal(successFrames.some((frame) => frame.type === 'tool_call_result' && frame.outcome === 'executed' && frame.resumed_from_pending), true);
  } finally {
    providerRegistry.openai.generateToolFirstTurn = originalFirstTurn;
    providerRegistry.openai.generate = originalGenerate;
  }
});

test('Tier C note overwrite requires /confirm overwrite <note_id>', async () => {
  await callRoute('PUT', '/api/agent/credentials/openai', { api_key: 'test-key' });
  await callRoute('PUT', '/api/agent/settings', {
    default_provider: 'openai',
    default_model: 'gpt-4.1',
    generation_params: {
      local_connection: { base_url: 'http://localhost:11434', model: 'llama3.2:latest', B: 1 },
    },
  });
  const bootstrap = await callRoute('GET', '/api/bootstrap');
  const bootstrapPayload = JSON.parse(bootstrap.body) as { files: Array<{ id: string }> };
  const noteId = bootstrapPayload.files[0]?.id ?? '';
  assert.equal(Boolean(noteId), true);
  const originalFirstTurn = providerRegistry.openai.generateToolFirstTurn;
  const originalGenerate = providerRegistry.openai.generate;
  providerRegistry.openai.generate = async () => ({ outputText: 'ok', latencyMs: 1 });
  try {
    providerRegistry.openai.generateToolFirstTurn = async () => ({
      outputText: '',
      latencyMs: 1,
      toolCalls: [{
        id: 'tier-c-overwrite',
        name: 'generate_note',
        arguments: { instruction: 'Overwrite note body', note_id: noteId },
      }],
    });
    await callRoute('POST', '/api/chat/session/current/messages', { content: 'overwrite note please' });
    providerRegistry.openai.generateToolFirstTurn = async () => ({ outputText: '', latencyMs: 1, toolCalls: [] });

    const plain = await callRoute('POST', '/api/chat/session/current/messages', { content: 'confirm' });
    assert.match(plain.body, /Tier C.*\/confirm overwrite/i);

    const success = await callRoute('POST', '/api/chat/session/current/messages', { content: `/confirm overwrite ${noteId}` });
    const successFrames = success.body.trim().split('\n').map((line) => JSON.parse(line) as { type?: string; outcome?: string; resumed_from_pending?: boolean });
    assert.equal(successFrames.some((frame) => frame.type === 'tool_call_result' && frame.outcome === 'executed' && frame.resumed_from_pending), true);
  } finally {
    providerRegistry.openai.generateToolFirstTurn = originalFirstTurn;
    providerRegistry.openai.generate = originalGenerate;
  }
});

test('chat tool actions create/update/archive/list/generate_note execute through streaming orchestration', async () => {
  await callRoute('PUT', '/api/agent/credentials/openai', { api_key: 'test-key' });
  await callRoute('PUT', '/api/agent/settings', {
    default_provider: 'openai',
    default_model: 'gpt-4.1',
    generation_params: {
      local_connection: { base_url: 'http://localhost:11434', model: 'llama3.2:latest', B: 1 },
    },
  });

  const originalFirstTurn = providerRegistry.openai.generateToolFirstTurn;
  const originalGenerate = providerRegistry.openai.generate;
  providerRegistry.openai.generate = async () => ({ outputText: 'chat summary', latencyMs: 1 });

  const runChatWithTool = async (toolCall: { id: string; name: string; arguments: Record<string, unknown> }, content: string) => {
    providerRegistry.openai.generateToolFirstTurn = async () => ({
      outputText: '',
      latencyMs: 1,
      toolCalls: [toolCall],
    });
    const response = await callRoute('POST', '/api/chat/session/current/messages', {
      content,
      explicit_confirm: true,
    });
    assert.equal(response.status, 200);
    const frames = response.body.trim().split('\n').map((line) => JSON.parse(line) as { type?: string; outcome?: string; result?: Record<string, unknown> });
    const outcome = frames.find((frame) => frame.type === 'tool_call_result');
    assert.equal(outcome?.outcome, 'executed');
    return outcome?.result ?? {};
  };

  try {
    await runChatWithTool({
      id: 'tool-create',
      name: 'create_task',
      arguments: { ticker: 'zzzq', title: 'Coverage expansion', note_type: 'Research', status: 'ideas' },
    }, 'create new task');

    const tasksAfterCreate = await callRoute('GET', '/api/research-tasks');
    const createdTask = (JSON.parse(tasksAfterCreate.body) as Array<{ id: string; ticker: string; title: string; status: string; archived: boolean }>)
      .find((task) => task.ticker === 'ZZZQ' && task.title === 'Coverage expansion');
    assert.equal(typeof createdTask?.id, 'string');

    await runChatWithTool({
      id: 'tool-update',
      name: 'update_task',
      arguments: { task_id: createdTask?.id, status: 'researching', details: 'Started model updates' },
    }, 'update task');

    const listResult = await runChatWithTool({
      id: 'tool-list',
      name: 'list_tasks_by_status',
      arguments: { status: 'researching' },
    }, 'list researching tasks');
    const listedTasks = (listResult.tasks as Array<{ id?: string }> | undefined) ?? [];
    assert.equal(listedTasks.some((task) => task.id === createdTask?.id), true);

    await runChatWithTool({
      id: 'tool-generate-note',
      name: 'generate_note',
      arguments: { instruction: 'Write investment summary', task_id: createdTask?.id, title: 'ZZZQ note' },
    }, 'generate task note');

    const tasksAfterNote = await callRoute('GET', '/api/research-tasks');
    const notedTask = (JSON.parse(tasksAfterNote.body) as Array<{ id: string; linked_note_file_id?: string; linked_note_path?: string }>)
      .find((task) => task.id === createdTask?.id);
    assert.equal(typeof notedTask?.linked_note_file_id, 'string');
    assert.match(notedTask?.linked_note_path ?? '', /ZZZQ note\.md/);

    await runChatWithTool({
      id: 'tool-archive',
      name: 'archive_task',
      arguments: { task_id: createdTask?.id },
    }, 'archive task');

    const tasksAfterArchive = await callRoute('GET', '/api/research-tasks');
    const archivedTask = (JSON.parse(tasksAfterArchive.body) as Array<{ id: string; archived: boolean }>)
      .find((task) => task.id === createdTask?.id);
    assert.equal(archivedTask?.archived, true);
  } finally {
    providerRegistry.openai.generateToolFirstTurn = originalFirstTurn;
    providerRegistry.openai.generate = originalGenerate;
  }
});

test('chat context builder uses bounded recent turns and rolling summary snapshots', async () => {
  await callRoute('PUT', '/api/chat/settings', {
    policy: { max_context_messages: 2, summarize_after_messages: 3, include_pinned_memory: true },
  });
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
  const originalGenerate = providerRegistry.ollama.generate;
  const seenInputs: string[] = [];
  providerRegistry.ollama.generate = async (request) => {
    seenInputs.push(request.inputText);
    return { outputText: 'ack', latencyMs: 1 };
  };
  try {
    await callRoute('POST', '/api/chat/session/current/messages', { content: 'm1' });
    await callRoute('POST', '/api/chat/session/current/messages', { content: 'm2' });
    await callRoute('POST', '/api/chat/session/current/messages', { content: 'm3' });
    await callRoute('POST', '/api/chat/session/current/messages', { content: 'm4' });
  } finally {
    providerRegistry.ollama.generate = originalGenerate;
  }

  const finalPrompt = seenInputs[3] ?? '';
  assert.match(finalPrompt, /\[RECENT_TURNS\]/);
  assert.match(finalPrompt, /\[ROLLING_SUMMARY\]/);
  assert.match(finalPrompt, /\[USER_INPUT\]\nm4/);
  assert.equal(finalPrompt.includes('m1'), false);
});

test('reset-context clears summary snapshot without deleting message history', async () => {
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
  const originalGenerate = providerRegistry.ollama.generate;
  providerRegistry.ollama.generate = async () => ({ outputText: 'ok', latencyMs: 1 });
  try {
    await callRoute('POST', '/api/chat/session/current/messages', { content: 'before reset' });
  } finally {
    providerRegistry.ollama.generate = originalGenerate;
  }
  const resetResponse = await callRoute('POST', '/api/chat/session/current/reset-context');
  assert.equal(resetResponse.status, 200);
  const listAfter = await callRoute('GET', '/api/chat/session/current/messages');
  assert.equal(listAfter.status, 200);
  const payload = JSON.parse(listAfter.body) as { messages: Array<{ content: string }> };
  assert.equal(payload.messages.some((message) => message.content.includes('Context summary reset by user.')), true);
  assert.equal(payload.messages.some((message) => message.content.includes('before reset')), true);
});

test('chat settings precedence applies immediately and profile reload is reflected on next message', async () => {
  await callRoute('PUT', '/api/chat/settings', {
    policy: { max_context_messages: 2, summarize_after_messages: 99, include_pinned_memory: true },
    profile: { persona: 'detailed' },
  });

  const initialSettings = await callRoute('GET', '/api/chat/settings');
  assert.equal(initialSettings.status, 200);
  const initialPayload = JSON.parse(initialSettings.body) as {
    policy?: { max_context_messages?: number; summarize_after_messages?: number; include_pinned_memory?: boolean };
    profile?: { persona?: string; reloaded_at?: string };
  };
  assert.equal(initialPayload.policy?.max_context_messages, 2);
  assert.equal(initialPayload.profile?.persona, 'detailed');

  const reloadResponse = await callRoute('POST', '/api/chat/profile/reload');
  assert.equal(reloadResponse.status, 200);
  const reloaded = JSON.parse(reloadResponse.body) as { profile?: { persona?: string; reloaded_at?: string } };
  assert.equal(reloaded.profile?.persona, 'detailed');
  assert.equal(typeof reloaded.profile?.reloaded_at, 'string');

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

  const originalGenerate = providerRegistry.ollama.generate;
  const seenInputPrompts: string[] = [];
  providerRegistry.ollama.generate = async (request) => {
    seenInputPrompts.push(request.inputText);
    return { outputText: 'ok', latencyMs: 1 };
  };

  try {
    await callRoute('POST', '/api/chat/session/current/messages', { content: 'verify immediate settings' });
  } finally {
    providerRegistry.ollama.generate = originalGenerate;
  }

  const latestPrompt = seenInputPrompts.at(-1) ?? '';
  assert.match(latestPrompt, /\[PROFILE\]/);
  assert.match(latestPrompt, /"persona":"detailed"/);
  assert.match(latestPrompt, /"reloaded_at":/);
  assert.match(latestPrompt, /\[USER_INPUT\]\nverify immediate settings/);
});

test('chat purge range and export stay consistent after purge-all', async () => {
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
  const originalGenerate = providerRegistry.ollama.generate;
  providerRegistry.ollama.generate = async () => ({ outputText: 'reply', latencyMs: 1 });

  try {
    await callRoute('POST', '/api/chat/session/current/messages', { content: 'purge target 1' });
    await callRoute('POST', '/api/chat/session/current/messages', { content: 'purge target 2' });
  } finally {
    providerRegistry.ollama.generate = originalGenerate;
  }

  const exportBefore = await callRoute('GET', '/api/chat/session/current/export?format=json');
  assert.equal(exportBefore.status, 200);
  const exportBeforePayload = JSON.parse(exportBefore.body) as { messages?: unknown[] };
  assert.equal((exportBeforePayload.messages?.length ?? 0) >= 4, true);

  const purge7d = await callRoute('DELETE', '/api/chat/session/current/history?range=7d');
  assert.equal(purge7d.status, 200);
  const purge7dPayload = JSON.parse(purge7d.body) as { deletedMessages?: number };
  assert.equal((purge7dPayload.deletedMessages ?? 0) >= 4, true);

  const exportAfter = await callRoute('GET', '/api/chat/session/current/export?format=json');
  assert.equal(exportAfter.status, 200);
  const exportAfterPayload = JSON.parse(exportAfter.body) as { messages?: unknown[]; pending_actions?: unknown[] };
  assert.equal((exportAfterPayload.messages?.length ?? 0), 0);
  assert.equal((exportAfterPayload.pending_actions?.length ?? 0), 0);
});
