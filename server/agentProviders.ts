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
  generate(request: AgentGenerateRequest, apiKey: string, signal?: AbortSignal): Promise<AgentGenerateResponse>;
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

  return { selected_model: 'model-not-configured', selection_source: 'provider_fallback' };
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
  async generate(request: AgentGenerateRequest, apiKey: string, signal?: AbortSignal): Promise<AgentGenerateResponse> {
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
    if (!outputText.trim()) throw new Error('MiniMax returned empty output.');
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
  async generate(_request: AgentGenerateRequest, _apiKey: string, _signal?: AbortSignal): Promise<AgentGenerateResponse> {
    throw new Error('OpenAI adapter is not implemented yet.');
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
  async generate(_request: AgentGenerateRequest, _apiKey: string, _signal?: AbortSignal): Promise<AgentGenerateResponse> {
    throw new Error('Anthropic adapter is not implemented yet.');
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
  async generate(request: AgentGenerateRequest, _apiKey: string, signal?: AbortSignal): Promise<AgentGenerateResponse> {
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
          stream: false,
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

    const payload = await response.json() as { response?: string };
    const outputText = (payload.response ?? '').trim();
    if (!outputText) throw new Error('Ollama returned empty output.');
    return {
      outputText,
      usage: estimateUsage(request.inputText, outputText),
      latencyMs: Date.now() - startedAt,
    };
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
  minimax: [{ modelId: 'MiniMax-M2.5', displayName: 'MiniMax M2.5', B: 1 }],
  openai: [{ modelId: 'gpt-4.1-mini', displayName: 'GPT-4.1 mini', B: 1 }],
  anthropic: [{ modelId: 'claude-3-5-sonnet-latest', displayName: 'Claude 3.5 Sonnet', B: 1 }],
  ollama: [{ modelId: 'llama3.2:latest', displayName: 'Llama 3.2', B: 1 }],
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
