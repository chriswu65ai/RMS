export type AgentProvider = 'minimax' | 'openai' | 'anthropic' | 'ollama';

export type AgentGenerateRequest = {
  model: string;
  inputText: string;
  generationParams?: {
    temperature?: number;
    maxTokens?: number;
    baseUrl?: string;
  };
};

export type AgentGenerateResponse = {
  outputText: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  latencyMs: number;
  costEstimate?: number;
};

export type AgentToolDefinition = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type AgentToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type AgentToolResult = {
  tool_call_id: string;
  name: string;
  result: string;
};

export type AgentToolTurnRequest = {
  model: string;
  inputText: string;
  tools: AgentToolDefinition[];
  generationParams?: {
    temperature?: number;
    maxTokens?: number;
    baseUrl?: string;
  };
};

export type AgentToolContinueRequest = {
  model: string;
  inputText: string;
  tools: AgentToolDefinition[];
  toolCalls: AgentToolCall[];
  toolResults: AgentToolResult[];
  generationParams?: {
    temperature?: number;
    maxTokens?: number;
    baseUrl?: string;
  };
};

export type AgentToolTurnResponse = {
  outputText: string;
  toolCalls: AgentToolCall[];
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  latencyMs: number;
};

export type AgentGenerateCallbacks = {
  onTextDelta?: (deltaText: string) => void;
};

export type ModelListEntry = { modelId: string; displayName: string; B: number };

export type CatalogStatus = 'live' | 'unsupported' | 'failed';
export type ModelCatalogReasonCode =
  | 'ok'
  | 'missing_api_key'
  | 'auth_failed'
  | 'rate_limited'
  | 'unsupported_endpoint'
  | 'network_error'
  | 'empty_response'
  | 'ollama_unreachable';

export type SelectionSource = 'live_catalog' | 'provider_fallback';

export type ListModelsResult = {
  models: ModelListEntry[];
  catalog_status: CatalogStatus;
  reason_code: ModelCatalogReasonCode;
  selected_model: string;
  selection_source: SelectionSource;
};

export interface ProviderAdapter {
  generate(request: AgentGenerateRequest, apiKey: string, signal?: AbortSignal, callbacks?: AgentGenerateCallbacks): Promise<AgentGenerateResponse>;
  generateToolFirstTurn(request: AgentToolTurnRequest, apiKey: string, signal?: AbortSignal): Promise<AgentToolTurnResponse>;
  generateToolFollowupTurn(request: AgentToolContinueRequest, apiKey: string, signal?: AbortSignal): Promise<AgentToolTurnResponse>;
  listModels(apiKey: string, options: { fallbackModels: ModelListEntry[]; preferredModel?: string; baseUrl?: string }, signal?: AbortSignal): Promise<ListModelsResult>;
}

const estimateTokens = (text: string) => Math.max(1, Math.round(text.length / 4));

// Keep both known MiniMax endpoints for regional routing.
const MINIMAX_BASE_URLS = ['https://api.minimax.io', 'https://api.minimaxi.com'];

const extractTextFromUnknown = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          const record = item as Record<string, unknown>;
          if (typeof record.text === 'string') return record.text;
          if (typeof record.content === 'string') return record.content;
        }
        return '';
      })
      .join('')
      .trim();
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.content === 'string') return record.content;
  }
  return '';
};

const emitTextDelta = (callbacks: AgentGenerateCallbacks | undefined, deltaText: string) => {
  if (!deltaText) return;
  callbacks?.onTextDelta?.(deltaText);
};

const parseToolArguments = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
};

const toolResponseUsage = (usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }) => ({
  inputTokens: usage?.prompt_tokens,
  outputTokens: usage?.completion_tokens,
  totalTokens: usage?.total_tokens,
});

const normalizeModelList = (raw: Array<{ id?: string; model?: string; name?: string }>): ModelListEntry[] => raw
  .map((entry) => {
    const modelId = (entry.id ?? entry.model ?? '').trim();
    return {
      modelId,
      displayName: (entry.name ?? modelId).trim() || modelId,
      B: 1,
    };
  })
  .filter((entry) => entry.modelId.length > 0);

const toReasonCodeFromStatus = (status: number): ModelCatalogReasonCode => {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 429) return 'rate_limited';
  if (status === 404 || status === 405 || status === 501) return 'unsupported_endpoint';
  return 'network_error';
};

const uniqueModels = (models: ModelListEntry[]): ModelListEntry[] => {
  const seen = new Set<string>();
  return models.filter((entry) => {
    const modelId = entry.modelId.trim();
    if (!modelId || seen.has(modelId)) return false;
    seen.add(modelId);
    return true;
  });
};

const rankByPriority = (provider: AgentProvider, models: ModelListEntry[]): ModelListEntry[] => {
  const priority = MODEL_PRIORITY[provider];
  const score = (modelId: string) => {
    const index = priority.indexOf(modelId);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  return [...models].sort((a, b) => {
    const byPriority = score(a.modelId) - score(b.modelId);
    if (byPriority !== 0) return byPriority;
    return a.modelId.localeCompare(b.modelId);
  });
};

export const selectBestModel = (
  provider: AgentProvider,
  discoveredModels: ModelListEntry[],
  fallbackModels: ModelListEntry[],
  preferredModel?: string,
): { selected_model: string; selection_source: SelectionSource } => {
  const live = uniqueModels(discoveredModels);
  const fallback = uniqueModels(fallbackModels);
  const preferred = preferredModel?.trim() ?? '';

  if (preferred && live.some((entry) => entry.modelId === preferred)) {
    return { selected_model: preferred, selection_source: 'live_catalog' };
  }

  const rankedLive = rankByPriority(provider, live);
  if (rankedLive[0]?.modelId) {
    return { selected_model: rankedLive[0].modelId, selection_source: 'live_catalog' };
  }

  const rankedFallback = rankByPriority(provider, fallback);
  if (rankedFallback[0]?.modelId) {
    return { selected_model: rankedFallback[0].modelId, selection_source: 'provider_fallback' };
  }

  return { selected_model: '', selection_source: 'provider_fallback' };
};

const asDiscoveryResult = ({
  provider,
  discoveredModels,
  fallbackModels,
  preferredModel,
  catalogStatus,
  reasonCode,
}: {
  provider: AgentProvider;
  discoveredModels: ModelListEntry[];
  fallbackModels: ModelListEntry[];
  preferredModel?: string;
  catalogStatus: CatalogStatus;
  reasonCode: ModelCatalogReasonCode;
}): ListModelsResult => {
  const selection = selectBestModel(provider, discoveredModels, fallbackModels, preferredModel);
  return {
    models: selection.selection_source === 'live_catalog' ? uniqueModels(discoveredModels) : uniqueModels(fallbackModels),
    selected_model: selection.selected_model,
    selection_source: selection.selection_source,
    catalog_status: catalogStatus,
    reason_code: reasonCode,
  };
};

const isOpenAITextModel = (modelId: string) => {
  const id = modelId.toLowerCase();
  if (id.includes('embedding') || id.includes('whisper') || id.includes('tts') || id.includes('audio') || id.includes('moderation')) return false;
  return id.startsWith('gpt-') || id.startsWith('o1') || id.startsWith('o3') || id.startsWith('o4');
};

const isAnthropicTextModel = (modelId: string) => modelId.toLowerCase().startsWith('claude-');

const getMiniMaxBaseUrls = (apiKey: string): string[] => {
  const key = apiKey.toLowerCase();
  if (key.startsWith('cn-') || key.includes('minimaxi')) {
    return ['https://api.minimaxi.com', 'https://api.minimax.io'];
  }
  return MINIMAX_BASE_URLS;
};

class MinimaxAdapter implements ProviderAdapter {
  private async callToolChat(
    requestBody: Record<string, unknown>,
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<AgentToolTurnResponse> {
    const startedAt = Date.now();
    let response: Response | null = null;
    for (const baseUrl of getMiniMaxBaseUrls(apiKey)) {
      try {
        const candidate = await fetch(`${baseUrl}/v1/text/chatcompletion_v2`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(requestBody),
          signal,
        });
        if (candidate.ok) {
          response = candidate;
          break;
        }
      } catch {
        // try next endpoint
      }
    }
    if (!response?.ok) throw new Error('MiniMax tool generation failed.');
    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: unknown; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      reply?: string;
      output_text?: string;
      text?: string;
    };
    const choice = payload.choices?.[0]?.message;
    const toolCalls = (choice?.tool_calls ?? []).map((entry, index) => ({
      id: String(entry.id ?? `minimax-tool-${index + 1}`),
      name: String(entry.function?.name ?? '').trim(),
      arguments: parseToolArguments(entry.function?.arguments),
    })).filter((entry) => entry.name.length > 0);
    const outputText = [
      extractTextFromUnknown(choice?.content),
      extractTextFromUnknown(payload.reply),
      extractTextFromUnknown(payload.output_text),
      extractTextFromUnknown(payload.text),
    ].find((text) => text.trim()) ?? '';
    return {
      outputText: outputText.trim(),
      toolCalls,
      usage: toolResponseUsage(payload.usage),
      latencyMs: Date.now() - startedAt,
    };
  }

  async generate(
    request: AgentGenerateRequest,
    apiKey: string,
    signal?: AbortSignal,
    callbacks?: AgentGenerateCallbacks,
  ): Promise<AgentGenerateResponse> {
    const startedAt = Date.now();
    let response: Response | null = null;
    for (const baseUrl of getMiniMaxBaseUrls(apiKey)) {
      try {
        const candidate = await fetch(`${baseUrl}/v1/text/chatcompletion_v2`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: request.model,
            messages: [{ role: 'user', content: request.inputText }],
            temperature: request.generationParams?.temperature ?? 0.2,
            max_tokens: request.generationParams?.maxTokens,
            stream: true,
          }),
          signal,
        });
        if (candidate.ok) {
          response = candidate;
          break;
        }
      } catch {
        // try next regional endpoint
      }
    }

    if (!response?.ok) throw new Error('MiniMax generate failed.');

    const chunks: string[] = [];
    let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
    const body = response.body;
    if (!body) throw new Error('MiniMax returned empty output.');
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    let sawDelta = false;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const frames = buffered.split('\n\n');
      buffered = frames.pop() ?? '';
      for (const frame of frames) {
        const line = frame.split('\n').find((entry) => entry.startsWith('data:'));
        if (!line) continue;
        const dataPayload = line.slice(5).trim();
        if (!dataPayload || dataPayload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(dataPayload) as {
            choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
            reply?: string;
            output_text?: string;
            text?: string;
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          };
          const deltaText = extractTextFromUnknown(parsed.choices?.[0]?.delta?.content);
          if (deltaText) {
            sawDelta = true;
            chunks.push(deltaText);
            emitTextDelta(callbacks, deltaText);
            if (parsed.usage) usage = parsed.usage;
            continue;
          }
          if (!sawDelta) {
            const fallbackText = [
              extractTextFromUnknown(parsed.choices?.[0]?.message?.content),
              extractTextFromUnknown(parsed.reply),
              extractTextFromUnknown(parsed.output_text),
              extractTextFromUnknown(parsed.text),
            ].find((item) => item.trim()) ?? '';
            if (fallbackText) {
              chunks.push(fallbackText);
              emitTextDelta(callbacks, fallbackText);
            }
          }
          if (parsed.usage) usage = parsed.usage;
        } catch {
          // ignore malformed chunks
        }
      }
    }
    buffered += decoder.decode();
    if (!sawDelta && chunks.length === 0 && buffered.trim()) {
      try {
        const parsed = JSON.parse(buffered.trim()) as {
          choices?: Array<{ message?: { content?: string } }>;
          reply?: string;
          output_text?: string;
          text?: string;
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        };
        const fallbackText = [
          extractTextFromUnknown(parsed.choices?.[0]?.message?.content),
          extractTextFromUnknown(parsed.reply),
          extractTextFromUnknown(parsed.output_text),
          extractTextFromUnknown(parsed.text),
        ].find((item) => item.trim()) ?? '';
        if (fallbackText) {
          chunks.push(fallbackText);
          emitTextDelta(callbacks, fallbackText);
        }
        if (parsed.usage) usage = parsed.usage;
      } catch {
        // ignore malformed non-stream fallback
      }
    }
    const outputText = chunks.join('').trim();
    if (!outputText.trim()) throw new Error('MiniMax returned empty output.');
    return {
      outputText,
      usage: {
        inputTokens: usage?.prompt_tokens,
        outputTokens: usage?.completion_tokens,
        totalTokens: usage?.total_tokens,
      },
      latencyMs: Date.now() - startedAt,
    };
  }

  async generateToolFirstTurn(request: AgentToolTurnRequest, apiKey: string, signal?: AbortSignal): Promise<AgentToolTurnResponse> {
    return this.callToolChat({
      model: request.model,
      messages: [{ role: 'user', content: request.inputText }],
      tools: request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema,
        },
      })),
      tool_choice: 'auto',
      temperature: request.generationParams?.temperature ?? 0.2,
      max_tokens: request.generationParams?.maxTokens,
      stream: false,
    }, apiKey, signal);
  }

  async generateToolFollowupTurn(request: AgentToolContinueRequest, apiKey: string, signal?: AbortSignal): Promise<AgentToolTurnResponse> {
    return this.callToolChat({
      model: request.model,
      messages: [
        { role: 'user', content: request.inputText },
        {
          role: 'assistant',
          tool_calls: request.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: {
              name: call.name,
              arguments: JSON.stringify(call.arguments),
            },
          })),
        },
        ...request.toolResults.map((result) => ({
          role: 'tool',
          tool_call_id: result.tool_call_id,
          content: result.result,
        })),
      ],
      tools: request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema,
        },
      })),
      tool_choice: 'auto',
      temperature: request.generationParams?.temperature ?? 0.2,
      max_tokens: request.generationParams?.maxTokens,
      stream: false,
    }, apiKey, signal);
  }

  async listModels(apiKey: string, options: { fallbackModels: ModelListEntry[]; preferredModel?: string }, signal?: AbortSignal): Promise<ListModelsResult> {
    const paths = ['/v1/models', '/v1/text/models'];
    let unsupportedOnly = true;

    for (const path of paths) {
      for (const baseUrl of getMiniMaxBaseUrls(apiKey)) {
        try {
          const response = await fetch(`${baseUrl}${path}`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${apiKey}` },
            signal,
          });

          if (!response.ok) {
            const reason = toReasonCodeFromStatus(response.status);
            if (reason === 'unsupported_endpoint') continue;
            unsupportedOnly = false;
            return asDiscoveryResult({
              provider: 'minimax',
              discoveredModels: [],
              fallbackModels: options.fallbackModels,
              preferredModel: options.preferredModel,
              catalogStatus: 'failed',
              reasonCode: reason,
            });
          }

          const payload = await response.json() as {
            data?: Array<{ id?: string; model?: string; name?: string }>;
            models?: Array<{ id?: string; model?: string; name?: string }>;
          };
          const liveModels = rankByPriority('minimax', normalizeModelList(payload.data ?? payload.models ?? []));
          if (liveModels.length === 0) {
            unsupportedOnly = false;
            return asDiscoveryResult({
              provider: 'minimax',
              discoveredModels: [],
              fallbackModels: options.fallbackModels,
              preferredModel: options.preferredModel,
              catalogStatus: 'failed',
              reasonCode: 'empty_response',
            });
          }
          return asDiscoveryResult({
            provider: 'minimax',
            discoveredModels: liveModels,
            fallbackModels: options.fallbackModels,
            preferredModel: options.preferredModel,
            catalogStatus: 'live',
            reasonCode: 'ok',
          });
        } catch {
          unsupportedOnly = false;
        }
      }
    }

    return asDiscoveryResult({
      provider: 'minimax',
      discoveredModels: [],
      fallbackModels: options.fallbackModels,
      preferredModel: options.preferredModel,
      catalogStatus: unsupportedOnly ? 'unsupported' : 'failed',
      reasonCode: unsupportedOnly ? 'unsupported_endpoint' : 'network_error',
    });
  }
}

class OpenAIAdapter implements ProviderAdapter {
  private async callChatCompletions(
    body: Record<string, unknown>,
    apiKey: string,
    signal?: AbortSignal,
    callbacks?: AgentGenerateCallbacks,
  ): Promise<AgentToolTurnResponse> {
    const startedAt = Date.now();
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw new Error('OpenAI generate failed.');
    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: unknown; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const message = payload.choices?.[0]?.message;
    const outputText = extractTextFromUnknown(message?.content).trim();
    if (outputText) emitTextDelta(callbacks, outputText);
    return {
      outputText,
      toolCalls: (message?.tool_calls ?? []).map((entry, index) => ({
        id: String(entry.id ?? `openai-tool-${index + 1}`),
        name: String(entry.function?.name ?? '').trim(),
        arguments: parseToolArguments(entry.function?.arguments),
      })).filter((entry) => entry.name.length > 0),
      usage: toolResponseUsage(payload.usage),
      latencyMs: Date.now() - startedAt,
    };
  }

  async generate(
    request: AgentGenerateRequest,
    apiKey: string,
    signal?: AbortSignal,
    callbacks?: AgentGenerateCallbacks,
  ): Promise<AgentGenerateResponse> {
    const result = await this.callChatCompletions({
      model: request.model,
      messages: [{ role: 'user', content: request.inputText }],
      temperature: request.generationParams?.temperature,
      max_tokens: request.generationParams?.maxTokens,
    }, apiKey, signal, callbacks);
    if (!result.outputText) throw new Error('OpenAI returned empty output.');
    return result;
  }

  async generateToolFirstTurn(request: AgentToolTurnRequest, apiKey: string, signal?: AbortSignal): Promise<AgentToolTurnResponse> {
    return this.callChatCompletions({
      model: request.model,
      messages: [{ role: 'user', content: request.inputText }],
      tools: request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema,
        },
      })),
      tool_choice: 'auto',
      temperature: request.generationParams?.temperature,
      max_tokens: request.generationParams?.maxTokens,
    }, apiKey, signal);
  }

  async generateToolFollowupTurn(request: AgentToolContinueRequest, apiKey: string, signal?: AbortSignal): Promise<AgentToolTurnResponse> {
    return this.callChatCompletions({
      model: request.model,
      messages: [
        { role: 'user', content: request.inputText },
        {
          role: 'assistant',
          tool_calls: request.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: {
              name: call.name,
              arguments: JSON.stringify(call.arguments),
            },
          })),
        },
        ...request.toolResults.map((result) => ({
          role: 'tool',
          tool_call_id: result.tool_call_id,
          content: result.result,
        })),
      ],
      tools: request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema,
        },
      })),
      tool_choice: 'auto',
      temperature: request.generationParams?.temperature,
      max_tokens: request.generationParams?.maxTokens,
    }, apiKey, signal);
  }

  async listModels(apiKey: string, options: { fallbackModels: ModelListEntry[]; preferredModel?: string }, signal?: AbortSignal): Promise<ListModelsResult> {
    try {
      const response = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal,
      });
      if (!response.ok) {
        return asDiscoveryResult({
          provider: 'openai',
          discoveredModels: [],
          fallbackModels: options.fallbackModels,
          preferredModel: options.preferredModel,
          catalogStatus: 'failed',
          reasonCode: toReasonCodeFromStatus(response.status),
        });
      }
      const payload = await response.json() as { data?: Array<{ id?: string }> };
      const models = rankByPriority('openai', normalizeModelList((payload.data ?? [])
        .map((entry) => ({ id: entry.id, name: entry.id }))
        .filter((entry) => isOpenAITextModel(entry.id ?? ''))));

      if (models.length === 0) {
        return asDiscoveryResult({
          provider: 'openai',
          discoveredModels: [],
          fallbackModels: options.fallbackModels,
          preferredModel: options.preferredModel,
          catalogStatus: 'failed',
          reasonCode: 'empty_response',
        });
      }

      return asDiscoveryResult({
        provider: 'openai',
        discoveredModels: models,
        fallbackModels: options.fallbackModels,
        preferredModel: options.preferredModel,
        catalogStatus: 'live',
        reasonCode: 'ok',
      });
    } catch {
      return asDiscoveryResult({
        provider: 'openai',
        discoveredModels: [],
        fallbackModels: options.fallbackModels,
        preferredModel: options.preferredModel,
        catalogStatus: 'failed',
        reasonCode: 'network_error',
      });
    }
  }
}

class AnthropicAdapter implements ProviderAdapter {
  private async callMessages(
    body: Record<string, unknown>,
    apiKey: string,
    signal?: AbortSignal,
    callbacks?: AgentGenerateCallbacks,
  ): Promise<AgentToolTurnResponse> {
    const startedAt = Date.now();
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw new Error('Anthropic generate failed.');
    const payload = await response.json() as {
      content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const outputText = (payload.content ?? [])
      .filter((item) => item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text ?? '')
      .join('')
      .trim();
    if (outputText) emitTextDelta(callbacks, outputText);
    const toolCalls = (payload.content ?? [])
      .filter((item) => item.type === 'tool_use' && typeof item.name === 'string')
      .map((item, index) => ({
        id: String(item.id ?? `anthropic-tool-${index + 1}`),
        name: String(item.name ?? '').trim(),
        arguments: parseToolArguments(item.input),
      }))
      .filter((item) => item.name.length > 0);
    return {
      outputText,
      toolCalls,
      usage: {
        inputTokens: payload.usage?.input_tokens,
        outputTokens: payload.usage?.output_tokens,
        totalTokens: (payload.usage?.input_tokens ?? 0) + (payload.usage?.output_tokens ?? 0),
      },
      latencyMs: Date.now() - startedAt,
    };
  }

  async generate(
    request: AgentGenerateRequest,
    apiKey: string,
    signal?: AbortSignal,
    callbacks?: AgentGenerateCallbacks,
  ): Promise<AgentGenerateResponse> {
    const result = await this.callMessages({
      model: request.model,
      max_tokens: request.generationParams?.maxTokens ?? 1024,
      temperature: request.generationParams?.temperature,
      messages: [{ role: 'user', content: request.inputText }],
    }, apiKey, signal, callbacks);
    if (!result.outputText) throw new Error('Anthropic returned empty output.');
    return result;
  }

  async generateToolFirstTurn(request: AgentToolTurnRequest, apiKey: string, signal?: AbortSignal): Promise<AgentToolTurnResponse> {
    return this.callMessages({
      model: request.model,
      max_tokens: request.generationParams?.maxTokens ?? 1024,
      temperature: request.generationParams?.temperature,
      messages: [{ role: 'user', content: request.inputText }],
      tools: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema,
      })),
    }, apiKey, signal);
  }

  async generateToolFollowupTurn(request: AgentToolContinueRequest, apiKey: string, signal?: AbortSignal): Promise<AgentToolTurnResponse> {
    return this.callMessages({
      model: request.model,
      max_tokens: request.generationParams?.maxTokens ?? 1024,
      temperature: request.generationParams?.temperature,
      messages: [
        { role: 'user', content: request.inputText },
        {
          role: 'assistant',
          content: request.toolCalls.map((call) => ({
            type: 'tool_use',
            id: call.id,
            name: call.name,
            input: call.arguments,
          })),
        },
        {
          role: 'user',
          content: request.toolResults.map((result) => ({
            type: 'tool_result',
            tool_use_id: result.tool_call_id,
            content: result.result,
          })),
        },
      ],
      tools: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema,
      })),
    }, apiKey, signal);
  }

  async listModels(apiKey: string, options: { fallbackModels: ModelListEntry[]; preferredModel?: string }, signal?: AbortSignal): Promise<ListModelsResult> {
    try {
      const response = await fetch('https://api.anthropic.com/v1/models', {
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        signal,
      });
      if (!response.ok) {
        const reason = toReasonCodeFromStatus(response.status);
        return asDiscoveryResult({
          provider: 'anthropic',
          discoveredModels: [],
          fallbackModels: options.fallbackModels,
          preferredModel: options.preferredModel,
          catalogStatus: reason === 'unsupported_endpoint' ? 'unsupported' : 'failed',
          reasonCode: reason,
        });
      }
      const payload = await response.json() as { data?: Array<{ id?: string; display_name?: string }> };
      const models = rankByPriority('anthropic', normalizeModelList((payload.data ?? [])
        .map((entry) => ({ id: entry.id, name: entry.display_name ?? entry.id }))
        .filter((entry) => isAnthropicTextModel(entry.id ?? ''))));
      if (models.length === 0) {
        return asDiscoveryResult({
          provider: 'anthropic',
          discoveredModels: [],
          fallbackModels: options.fallbackModels,
          preferredModel: options.preferredModel,
          catalogStatus: 'failed',
          reasonCode: 'empty_response',
        });
      }
      return asDiscoveryResult({
        provider: 'anthropic',
        discoveredModels: models,
        fallbackModels: options.fallbackModels,
        preferredModel: options.preferredModel,
        catalogStatus: 'live',
        reasonCode: 'ok',
      });
    } catch {
      return asDiscoveryResult({
        provider: 'anthropic',
        discoveredModels: [],
        fallbackModels: options.fallbackModels,
        preferredModel: options.preferredModel,
        catalogStatus: 'failed',
        reasonCode: 'network_error',
      });
    }
  }
}

const normalizeOllamaBaseUrl = (baseUrl?: string) => {
  const trimmed = (baseUrl ?? '').trim();
  return (trimmed || 'http://localhost:11434').replace(/\/+$/, '');
};

class OllamaAdapter implements ProviderAdapter {
  private async callChat(
    requestBody: Record<string, unknown>,
    baseUrl: string,
    signal?: AbortSignal,
    callbacks?: AgentGenerateCallbacks,
  ): Promise<AgentToolTurnResponse> {
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal,
      });
    } catch {
      throw new Error(`Ollama unavailable/unreachable at ${baseUrl}.`);
    }
    if (!response.ok) throw new Error('Ollama generate failed.');
    const payload = await response.json() as {
      message?: { content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }> };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    const outputText = String(payload.message?.content ?? '').trim();
    if (outputText) emitTextDelta(callbacks, outputText);
    const inputTokens = payload.prompt_eval_count;
    const outputTokens = payload.eval_count;
    return {
      outputText,
      toolCalls: (payload.message?.tool_calls ?? []).map((call, index) => ({
        id: `ollama-tool-${index + 1}`,
        name: String(call.function?.name ?? '').trim(),
        arguments: parseToolArguments(call.function?.arguments),
      })).filter((call) => call.name.length > 0),
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
      },
      latencyMs: Date.now() - startedAt,
    };
  }

  async generate(
    request: AgentGenerateRequest,
    _apiKey: string,
    signal?: AbortSignal,
    callbacks?: AgentGenerateCallbacks,
  ): Promise<AgentGenerateResponse> {
    const startedAt = Date.now();
    const baseUrl = normalizeOllamaBaseUrl((request.generationParams as { baseUrl?: string } | undefined)?.baseUrl);
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: request.model,
          prompt: request.inputText,
          stream: true,
          options: {
            temperature: request.generationParams?.temperature,
            num_predict: request.generationParams?.maxTokens,
          },
        }),
        signal,
      });
    } catch {
      throw new Error(`Ollama unavailable/unreachable at ${baseUrl}.`);
    }

    if (!response.ok) {
      const status = response.status;
      if (status >= 500 || status === 404 || status === 503) {
        throw new Error(`Ollama unavailable/unreachable at ${baseUrl}.`);
      }
      throw new Error('Ollama generate failed.');
    }

    if (!response.body) throw new Error('Ollama returned empty output.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    let outputText = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const payload = JSON.parse(trimmed) as { response?: string };
          const deltaText = payload.response ?? '';
          if (!deltaText) continue;
          outputText += deltaText;
          emitTextDelta(callbacks, deltaText);
        } catch {
          // ignore malformed line
        }
      }
    }
    buffered += decoder.decode();
    if (buffered.trim()) {
      try {
        const payload = JSON.parse(buffered.trim()) as { response?: string };
        const deltaText = payload.response ?? '';
        if (deltaText) {
          outputText += deltaText;
          emitTextDelta(callbacks, deltaText);
        }
      } catch {
        // ignore trailing malformed chunk
      }
    }
    outputText = outputText.trim();
    if (!outputText) throw new Error('Ollama returned empty output.');
    return {
      outputText,
      usage: estimateUsage(request.inputText, outputText),
      latencyMs: Date.now() - startedAt,
    };
  }

  async generateToolFirstTurn(request: AgentToolTurnRequest, _apiKey: string, signal?: AbortSignal): Promise<AgentToolTurnResponse> {
    const baseUrl = normalizeOllamaBaseUrl(request.generationParams?.baseUrl);
    return this.callChat({
      model: request.model,
      stream: false,
      messages: [{ role: 'user', content: request.inputText }],
      tools: request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema,
        },
      })),
      options: {
        temperature: request.generationParams?.temperature,
        num_predict: request.generationParams?.maxTokens,
      },
    }, baseUrl, signal);
  }

  async generateToolFollowupTurn(request: AgentToolContinueRequest, _apiKey: string, signal?: AbortSignal): Promise<AgentToolTurnResponse> {
    const baseUrl = normalizeOllamaBaseUrl(request.generationParams?.baseUrl);
    return this.callChat({
      model: request.model,
      stream: false,
      messages: [
        { role: 'user', content: request.inputText },
        {
          role: 'assistant',
          content: '',
          tool_calls: request.toolCalls.map((call) => ({
            function: {
              name: call.name,
              arguments: call.arguments,
            },
          })),
        },
        ...request.toolResults.map((result) => ({
          role: 'tool',
          content: result.result,
        })),
      ],
      tools: request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema,
        },
      })),
      options: {
        temperature: request.generationParams?.temperature,
        num_predict: request.generationParams?.maxTokens,
      },
    }, baseUrl, signal);
  }

  async listModels(_apiKey: string, options: { fallbackModels: ModelListEntry[]; preferredModel?: string; baseUrl?: string }, signal?: AbortSignal): Promise<ListModelsResult> {
    const baseUrl = normalizeOllamaBaseUrl(options.baseUrl);
    try {
      const response = await fetch(`${baseUrl}/api/tags`, { method: 'GET', signal });
      if (!response.ok) {
        return asDiscoveryResult({
          provider: 'ollama',
          discoveredModels: [],
          fallbackModels: options.fallbackModels,
          preferredModel: options.preferredModel,
          catalogStatus: 'failed',
          reasonCode: 'ollama_unreachable',
        });
      }
      const payload = await response.json() as { models?: Array<{ name?: string; model?: string }> };
      const discovered = uniqueModels((payload.models ?? [])
        .map((entry) => {
          const modelId = (entry.name ?? entry.model ?? '').trim();
          return { modelId, displayName: modelId, B: 1 };
        })
        .filter((entry) => entry.modelId.length > 0));
      if (discovered.length === 0) {
        return asDiscoveryResult({
          provider: 'ollama',
          discoveredModels: [],
          fallbackModels: options.fallbackModels,
          preferredModel: options.preferredModel,
          catalogStatus: 'failed',
          reasonCode: 'empty_response',
        });
      }
      return asDiscoveryResult({
        provider: 'ollama',
        discoveredModels: rankByPriority('ollama', discovered),
        fallbackModels: options.fallbackModels,
        preferredModel: options.preferredModel,
        catalogStatus: 'live',
        reasonCode: 'ok',
      });
    } catch {
      return asDiscoveryResult({
        provider: 'ollama',
        discoveredModels: [],
        fallbackModels: options.fallbackModels,
        preferredModel: options.preferredModel,
        catalogStatus: 'failed',
        reasonCode: 'ollama_unreachable',
      });
    }
  }
}

export const providerRegistry: Record<AgentProvider, ProviderAdapter> = {
  minimax: new MinimaxAdapter(),
  openai: new OpenAIAdapter(),
  anthropic: new AnthropicAdapter(),
  ollama: new OllamaAdapter(),
};

export const FALLBACK_MODELS: Record<AgentProvider, ModelListEntry[]> = {
  minimax: [
    { modelId: 'MiniMax-M2.5', displayName: 'MiniMax M2.5', B: 1 },
    { modelId: 'MiniMax-M2.7', displayName: 'MiniMax M2.7', B: 1 },
  ],
  openai: [],
  anthropic: [],
  ollama: [],
};

export const PROVIDER_CAPABILITIES: Record<AgentProvider, {
  supports_tool_calling: boolean;
  model_overrides?: Record<string, { supports_tool_calling: boolean }>;
}> = {
  minimax: { supports_tool_calling: true },
  openai: { supports_tool_calling: true },
  anthropic: { supports_tool_calling: true },
  ollama: { supports_tool_calling: true },
};

export const supportsToolCalling = (provider: AgentProvider, model: string): boolean => {
  const modelId = model.trim();
  if (!modelId) return false;
  const capabilities = PROVIDER_CAPABILITIES[provider];
  const override = capabilities.model_overrides?.[modelId];
  return override?.supports_tool_calling ?? capabilities.supports_tool_calling;
};

const MODEL_PRIORITY: Record<AgentProvider, string[]> = {
  minimax: ['MiniMax-M2.5', 'MiniMax-Text-01'],
  openai: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini', 'gpt-4o'],
  anthropic: ['claude-3-7-sonnet-latest', 'claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest'],
  ollama: ['llama3.2:latest', 'qwen2.5:latest', 'mistral:latest'],
};

export const estimateUsage = (inputText: string, outputText: string) => {
  const inputTokens = estimateTokens(inputText);
  const outputTokens = estimateTokens(outputText);
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
};
