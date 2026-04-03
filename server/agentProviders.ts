export type AgentProvider = 'minimax' | 'openai' | 'anthropic';

export type AgentGenerateRequest = {
  model: string;
  inputText: string;
  generationParams?: {
    temperature?: number;
    maxTokens?: number;
  };
};

export type AgentGenerateResponse = {
  outputText: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  latencyMs: number;
  costEstimate?: number;
};

export type ModelListEntry = { modelId: string; displayName: string };

export type CatalogStatus = 'live' | 'unavailable';
export type ModelCatalogReasonCode =
  | 'ok'
  | 'missing_api_key'
  | 'unsupported_endpoint'
  | 'auth_failed'
  | 'network_error'
  | 'empty_response';

export type ListModelsResult = {
  models: ModelListEntry[];
  catalogStatus: CatalogStatus;
  reasonCode: ModelCatalogReasonCode;
};

export interface ProviderAdapter {
  generate(request: AgentGenerateRequest, apiKey: string, signal?: AbortSignal): Promise<AgentGenerateResponse>;
  listModels(apiKey: string, signal?: AbortSignal): Promise<ListModelsResult>;
}

const estimateTokens = (text: string) => Math.max(1, Math.round(text.length / 4));

// Must match current MiniMax official docs; review when MiniMax provider docs change.
const MINIMAX_BASE_URLS = ['https://api.minimax.io'];

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

const mapStatusToReasonCode = (status: number): ModelCatalogReasonCode => {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 404 || status === 405 || status === 501) return 'unsupported_endpoint';
  return 'network_error';
};

const normalizeModelList = (raw: Array<{ id?: string; model?: string; name?: string }>): ModelListEntry[] => raw
  .map((entry) => {
    const modelId = (entry.id ?? entry.model ?? '').trim();
    return {
      modelId,
      displayName: (entry.name ?? modelId).trim() || modelId,
    };
  })
  .filter((entry) => entry.modelId.length > 0);

const fetchFromMirrors = async (path: string, init: RequestInit): Promise<Response> => {
  const attempts: string[] = [];
  for (const baseUrl of MINIMAX_BASE_URLS) {
    const url = `${baseUrl}${path}`;
    try {
      const response = await fetch(url, init);
      if (response.ok) return response;
      attempts.push(`${url} -> HTTP ${response.status}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Network error while contacting MiniMax.';
      attempts.push(`${url} -> ${message}`);
    }
  }
  throw new Error(`MiniMax request failed after trying: ${attempts.join('; ')}`);
};

class MinimaxAdapter implements ProviderAdapter {
  async generate(request: AgentGenerateRequest, apiKey: string, signal?: AbortSignal): Promise<AgentGenerateResponse> {
    const startedAt = Date.now();
    const response = await fetchFromMirrors('/v1/text/chatcompletion_v2', {
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
      }),
      signal,
    });
    if (!response.ok) throw new Error(`Minimax generate failed (${response.status}).`);
    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      reply?: string;
      output_text?: string;
      text?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const outputText = [
      extractTextFromUnknown(data.choices?.[0]?.message?.content),
      extractTextFromUnknown(data.reply),
      extractTextFromUnknown(data.output_text),
      extractTextFromUnknown(data.text),
    ].find((item) => item.trim()) ?? '';
    if (!outputText.trim()) throw new Error('Minimax returned empty output.');
    return {
      outputText,
      usage: {
        inputTokens: data.usage?.prompt_tokens,
        outputTokens: data.usage?.completion_tokens,
        totalTokens: data.usage?.total_tokens,
      },
      latencyMs: Date.now() - startedAt,
    };
  }

  async listModels(apiKey: string, signal?: AbortSignal): Promise<ListModelsResult> {
    const candidates = ['/v1/models', '/v1/text/models'];
    for (const path of candidates) {
      try {
        const response = await fetchFromMirrors(path, {
          method: 'GET',
          headers: { Authorization: `Bearer ${apiKey}` },
          signal,
        });
        if (!response.ok) {
          const reasonCode = mapStatusToReasonCode(response.status);
          if (reasonCode === 'unsupported_endpoint') continue;
          return { models: [], catalogStatus: 'unavailable', reasonCode };
        }
        const data = await response.json() as {
          data?: Array<{ id?: string; model?: string; name?: string }>;
          models?: Array<{ id?: string; model?: string; name?: string }>;
        };
        const models = normalizeModelList(data.data ?? data.models ?? []);
        if (models.length === 0) {
          return { models: [], catalogStatus: 'unavailable', reasonCode: 'empty_response' };
        }
        return { models, catalogStatus: 'live', reasonCode: 'ok' };
      } catch {
        return { models: [], catalogStatus: 'unavailable', reasonCode: 'network_error' };
      }
    }
    return { models: [], catalogStatus: 'unavailable', reasonCode: 'unsupported_endpoint' };
  }
}

class OpenAIAdapter implements ProviderAdapter {
  async generate(_request: AgentGenerateRequest, _apiKey: string, _signal?: AbortSignal): Promise<AgentGenerateResponse> {
    throw new Error('OpenAI adapter is not implemented yet.');
  }

  async listModels(apiKey: string, signal?: AbortSignal): Promise<ListModelsResult> {
    try {
      const response = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal,
      });
      if (!response.ok) {
        return { models: [], catalogStatus: 'unavailable', reasonCode: mapStatusToReasonCode(response.status) };
      }
      const data = await response.json() as { data?: Array<{ id?: string }> };
      const models = normalizeModelList((data.data ?? []).map((entry) => ({ id: entry.id, name: entry.id })));
      if (models.length === 0) {
        return { models: [], catalogStatus: 'unavailable', reasonCode: 'empty_response' };
      }
      return { models, catalogStatus: 'live', reasonCode: 'ok' };
    } catch {
      return { models: [], catalogStatus: 'unavailable', reasonCode: 'network_error' };
    }
  }
}

class AnthropicAdapter implements ProviderAdapter {
  async generate(_request: AgentGenerateRequest, _apiKey: string, _signal?: AbortSignal): Promise<AgentGenerateResponse> {
    throw new Error('Anthropic adapter is not implemented yet.');
  }

  async listModels(apiKey: string, signal?: AbortSignal): Promise<ListModelsResult> {
    try {
      const response = await fetch('https://api.anthropic.com/v1/models', {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        signal,
      });
      if (!response.ok) {
        return { models: [], catalogStatus: 'unavailable', reasonCode: mapStatusToReasonCode(response.status) };
      }
      const data = await response.json() as { data?: Array<{ id?: string; display_name?: string }> };
      const models = normalizeModelList((data.data ?? []).map((entry) => ({ id: entry.id, name: entry.display_name ?? entry.id })));
      if (models.length === 0) {
        return { models: [], catalogStatus: 'unavailable', reasonCode: 'empty_response' };
      }
      return { models, catalogStatus: 'live', reasonCode: 'ok' };
    } catch {
      return { models: [], catalogStatus: 'unavailable', reasonCode: 'network_error' };
    }
  }
}

export const providerRegistry: Record<AgentProvider, ProviderAdapter> = {
  minimax: new MinimaxAdapter(),
  openai: new OpenAIAdapter(),
  anthropic: new AnthropicAdapter(),
};

export const FALLBACK_MODELS: Record<AgentProvider, ModelListEntry[]> = {
  minimax: [
    { modelId: 'MiniMax-M2.5', displayName: 'MiniMax M2.5' },
  ],
  openai: [
    { modelId: 'gpt-4.1-mini', displayName: 'GPT-4.1 mini' },
  ],
  anthropic: [
    { modelId: 'claude-3-5-sonnet-latest', displayName: 'Claude 3.5 Sonnet' },
  ],
};

const MODEL_PRIORITY: Record<AgentProvider, string[]> = {
  minimax: ['MiniMax-M2.5', 'MiniMax-Text-01', 'abab6.5-chat'],
  openai: ['gpt-4.1-mini', 'gpt-4.1'],
  anthropic: ['claude-3-5-sonnet-latest', 'claude-3-7-sonnet-latest'],
};

export const selectBestModel = (
  provider: AgentProvider,
  discoveredModels: ModelListEntry[],
  fallbackModels: ModelListEntry[],
  preferredModel?: string,
): string => {
  const preferred = preferredModel?.trim() ?? '';
  if (preferred && discoveredModels.some((entry) => entry.modelId === preferred)) {
    return preferred;
  }

  const priority = MODEL_PRIORITY[provider];
  for (const modelId of priority) {
    const found = discoveredModels.find((entry) => entry.modelId === modelId);
    if (found) return found.modelId;
  }

  if (discoveredModels[0]?.modelId) return discoveredModels[0].modelId;

  for (const modelId of priority) {
    const found = fallbackModels.find((entry) => entry.modelId === modelId);
    if (found) return found.modelId;
  }

  return fallbackModels[0]?.modelId ?? 'model-not-configured';
};

export const estimateUsage = (inputText: string, outputText: string) => {
  const inputTokens = estimateTokens(inputText);
  const outputTokens = estimateTokens(outputText);
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
};
