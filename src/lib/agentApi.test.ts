import test from 'node:test';
import assert from 'node:assert/strict';
import { generateText, getChatSettings, listModels, reloadChatProfile, saveChatSettings } from './agentApi.js';

const encoder = new TextEncoder();

const makeNdjsonResponse = (lines: string[]) => new Response(new ReadableStream({
  start(controller) {
    controller.enqueue(encoder.encode(`${lines.join('\n')}\n`));
    controller.close();
  },
}), {
  headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
});

const makeChunkedNdjsonResponse = (chunks: string[]) => new Response(new ReadableStream({
  start(controller) {
    chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
    controller.close();
  },
}), {
  headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
});


test('generateText keeps request payload contract and done-frame output semantics stable for Generate button', async () => {
  const originalFetch = globalThis.fetch;
  let seenUrl = '';
  let seenMethod = '';
  let seenBody: Record<string, unknown> | null = null;
  const seenProgress: string[] = [];

  globalThis.fetch = async (input, init) => {
    seenUrl = String(input);
    seenMethod = String(init?.method ?? 'GET');
    seenBody = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    return makeNdjsonResponse([
      JSON.stringify({ type: 'delta', deltaText: 'Draft' }),
      JSON.stringify({ type: 'done' }),
    ]);
  };

  try {
    const result = await generateText({
      provider: 'openai',
      model: 'gpt-4.1',
      noteId: 'note-generate',
      inputText: 'Summarize',
      triggerSource: 'manual',
      saveMode: 'manual_only',
      onProgress: (nextOutputText) => seenProgress.push(nextOutputText),
    });

    assert.equal(seenUrl, '/api/agent/generate');
    assert.equal(seenMethod, 'POST');
    assert.deepEqual(seenBody, {
      provider: 'openai',
      model: 'gpt-4.1',
      note_id: 'note-generate',
      task_id: '',
      attachment_ids: [],
      input_text: 'Summarize',
      trigger_source: 'manual',
      save_mode: 'manual_only',
      initiated_by: 'user',
    });
    assert.equal(result.outputText, 'Draft');
    assert.deepEqual(seenProgress, ['Draft', 'Draft']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generateText parses sources events and forwards them to callback', async () => {
  const originalFetch = globalThis.fetch;
  const seenSources: Array<{ title: string; url: string }> = [];

  globalThis.fetch = async () => makeNdjsonResponse([
    JSON.stringify({ type: 'status', stage: 'started' }),
    JSON.stringify({
      type: 'sources',
      sources: [{ title: 'Doc', url: 'https://example.com/doc', snippet: 'snippet', provider: 'duckduckgo' }],
    }),
    JSON.stringify({ type: 'done', outputText: 'final output' }),
  ]);

  try {
    const result = await generateText({
      provider: 'openai',
      model: 'gpt-4.1',
      noteId: 'note-1',
      inputText: 'hello',
      triggerSource: 'manual',
      saveMode: 'manual_only',
      onSources: (sources) => {
        seenSources.push(...sources.map((source) => ({ title: source.title, url: source.url })));
      },
    });

    assert.equal(result.outputText, 'final output');
    assert.deepEqual(seenSources, [{ title: 'Doc', url: 'https://example.com/doc' }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generateText surfaces search_warning events', async () => {
  const originalFetch = globalThis.fetch;
  const warnings: string[] = [];

  globalThis.fetch = async () => makeNdjsonResponse([
    JSON.stringify({ type: 'search_warning', message: 'provider unavailable' }),
    JSON.stringify({ type: 'done', outputText: 'ok' }),
  ]);

  try {
    const result = await generateText({
      provider: 'openai',
      model: 'gpt-4.1',
      noteId: 'note-2',
      inputText: 'hello',
      triggerSource: 'manual',
      saveMode: 'manual_only',
      onSearchWarning: (message) => warnings.push(message),
    });

    assert.equal(result.outputText, 'ok');
    assert.deepEqual(warnings, ['provider unavailable']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generateText forwards thinking stream events', async () => {
  const originalFetch = globalThis.fetch;
  const seenEvents: Array<{ type: string; toolName?: string; summary?: string }> = [];

  globalThis.fetch = async () => makeNdjsonResponse([
    JSON.stringify({ type: 'tool_call_started', tool_name: 'web_search', tool_call_id: 'call_1', message: 'Searching...' }),
    JSON.stringify({ type: 'tool_call_result', tool_name: 'web_search', tool_call_id: 'call_1', message: 'Found results' }),
    JSON.stringify({ type: 'tool_call_failed', tool_name: 'web_fetch', tool_call_id: 'call_2', message: 'Timeout' }),
    JSON.stringify({ type: 'provider_summary', text: 'Compared and synthesized sources.' }),
    JSON.stringify({ type: 'done', outputText: 'ok' }),
  ]);

  try {
    const result = await generateText({
      provider: 'openai',
      model: 'gpt-4.1',
      noteId: 'note-3',
      inputText: 'hello',
      triggerSource: 'manual',
      saveMode: 'manual_only',
      onThinkingEvent: (event) => {
        seenEvents.push({
          type: event.type,
          toolName: 'toolName' in event ? event.toolName : undefined,
          summary: event.type === 'reasoning' ? event.summary : undefined,
        });
      },
    });

    assert.equal(result.outputText, 'ok');
    assert.deepEqual(seenEvents, [
      { type: 'tool_call_started', toolName: 'web_search', summary: undefined },
      { type: 'tool_call_result', toolName: 'web_search', summary: undefined },
      { type: 'tool_call_failed', toolName: 'web_fetch', summary: undefined },
      { type: 'reasoning', toolName: undefined, summary: 'Compared and synthesized sources.' },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generateText parses split NDJSON chunks and forwards full thinking stream sequence', async () => {
  const originalFetch = globalThis.fetch;
  const seenEvents: string[] = [];
  const seenProgress: string[] = [];

  globalThis.fetch = async () => makeChunkedNdjsonResponse([
    '{"type":"tool_call_started","tool_name":"web_search","tool_call_id":"call_1"}\n{"type":"tool_call_result","tool_n',
    'ame":"web_search","tool_call_id":"call_1"}\n{"type":"reasoning","summary":"Synthesizing findings"}\n{"type":"delta","deltaText":"hello"}\n{"type":"done","outputText":"hello world"}\n',
  ]);

  try {
    const result = await generateText({
      provider: 'openai',
      model: 'gpt-4.1',
      noteId: 'note-4',
      inputText: 'hello',
      triggerSource: 'manual',
      saveMode: 'manual_only',
      onProgress: (nextOutputText) => seenProgress.push(nextOutputText),
      onThinkingEvent: (event) => seenEvents.push(event.type),
    });

    assert.equal(result.outputText, 'hello world');
    assert.deepEqual(seenEvents, ['tool_call_started', 'tool_call_result', 'reasoning']);
    assert.deepEqual(seenProgress, ['hello', 'hello world']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('listModels forwards runtime base URL for ollama refresh without mutating slash behavior in saved settings', async () => {
  const originalFetch = globalThis.fetch;
  let seenUrl = '';

  globalThis.fetch = async (input) => {
    seenUrl = String(input);
    return new Response(JSON.stringify({
      models: [],
      selected_model: '',
      catalog_status: 'failed',
      selection_source: 'provider_fallback',
      reason_code: 'ollama_unreachable',
    }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    });
  };

  try {
    await listModels('ollama', 'http://127.0.0.1:11434');
    assert.equal(seenUrl, '/api/agent/models?provider=ollama&runtime_base_url=http%3A%2F%2F127.0.0.1%3A11434');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('chat settings API uses dedicated endpoints for load/save/reload', async () => {
  const originalFetch = globalThis.fetch;
  const seen: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = String(init?.method ?? 'GET');
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    seen.push({ url, method, body });

    if (url === '/api/chat/settings' && method === 'GET') {
      return new Response(JSON.stringify({
        id: 'chat-settings-1',
        user_id: 'local-user',
        policy: { action_mode: 'assist', ask_when_missing: true },
        profile: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: null, profile: { reloaded_at: '2026-01-01T00:00:01.000Z' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const loaded = await getChatSettings();
    assert.equal(loaded.policy.action_mode, 'assist');

    await saveChatSettings({
      policy: {
        action_mode: 'confirm_required',
        ask_when_missing: false,
        profile_source: 'file',
        profile_file_path: '/tmp/profile.md',
      },
    });
    await reloadChatProfile();

    assert.deepEqual(seen.map((call) => ({ url: call.url, method: call.method })), [
      { url: '/api/chat/settings', method: 'GET' },
      { url: '/api/chat/settings', method: 'PUT' },
      { url: '/api/chat/profile/reload', method: 'POST' },
    ]);
    assert.deepEqual(seen[1]?.body, {
      policy: {
        action_mode: 'confirm_required',
        ask_when_missing: false,
        profile_source: 'file',
        profile_file_path: '/tmp/profile.md',
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generateText ignores malformed NDJSON frames and continues streaming', async () => {
  const originalFetch = globalThis.fetch;
  const seenProgress: string[] = [];

  globalThis.fetch = async () => makeChunkedNdjsonResponse([
    '{"type":"delta","deltaText":"hello"}\n',
    'not-json\n',
    '{"type":"delta","deltaText":" world"}\n{"type":"done","outputText":"hello world"}\n',
  ]);

  try {
    const result = await generateText({
      provider: 'openai',
      model: 'gpt-4.1',
      noteId: 'note-resilient',
      inputText: 'hello',
      triggerSource: 'manual',
      saveMode: 'manual_only',
      onProgress: (next) => seenProgress.push(next),
    });

    assert.equal(result.outputText, 'hello world');
    assert.deepEqual(seenProgress, ['hello', 'hello world', 'hello world']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generateText remains backward compatible with legacy JSON response mode', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => new Response(JSON.stringify({ outputText: 'legacy response' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  try {
    const result = await generateText({
      provider: 'openai',
      model: 'gpt-4.1',
      noteId: 'legacy-note',
      inputText: 'legacy mode',
      triggerSource: 'manual',
      saveMode: 'manual_only',
    });
    assert.equal(result.outputText, 'legacy response');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
