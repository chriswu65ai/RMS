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

export interface ProviderAdapter {
  generate(request: AgentGenerateRequest, apiKey: string, signal?: AbortSignal): Promise<AgentGenerateResponse>;
  listModels(apiKey: string, signal?: AbortSignal): Promise<ModelListEntry[]>;
}

const estimateTokens = (text: string) => Math.max(1, Math.round(text.length / 4));

class MinimaxAdapter implements ProviderAdapter {
  async generate(request: AgentGenerateRequest, apiKey: string, signal?: AbortSignal): Promise<AgentGenerateResponse> {
    const startedAt = Date.now();
    const response = await fetch('https://api.minimax.chat/v1/text/chatcompletion_v2', {
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
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const outputText = data.choices?.[0]?.message?.content?.toString() ?? '';
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

  async listModels(apiKey: string, signal?: AbortSignal): Promise<ModelListEntry[]> {
    const response = await fetch('https://api.minimax.chat/v1/text/models', {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });
    if (!response.ok) throw new Error('Model listing unsupported or failed.');
    const data = await response.json() as { data?: Array<{ id?: string; name?: string }> };
    return (data.data ?? [])
      .map((item) => ({ modelId: item.id ?? '', displayName: item.name ?? item.id ?? '' }))
      .filter((item) => item.modelId);
  }
}

class OpenAIAdapter implements ProviderAdapter {
  async generate(_request: AgentGenerateRequest, _apiKey: string, _signal?: AbortSignal): Promise<AgentGenerateResponse> {
    throw new Error('OpenAI adapter is not implemented yet.');
  }

  async listModels(apiKey: string, signal?: AbortSignal): Promise<ModelListEntry[]> {
    const response = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });
    if (!response.ok) throw new Error(`OpenAI model listing failed (${response.status}).`);
    const data = await response.json() as { data?: Array<{ id?: string }> };
    return (data.data ?? []).map((item) => ({ modelId: item.id ?? '', displayName: item.id ?? '' })).filter((item) => item.modelId);
  }
}

class AnthropicAdapter implements ProviderAdapter {
  async generate(_request: AgentGenerateRequest, _apiKey: string, _signal?: AbortSignal): Promise<AgentGenerateResponse> {
    throw new Error('Anthropic adapter is not implemented yet.');
  }

  async listModels(_apiKey: string, _signal?: AbortSignal): Promise<ModelListEntry[]> {
    throw new Error('Anthropic model listing is currently unsupported.');
  }
}

export const providerRegistry: Record<AgentProvider, ProviderAdapter> = {
  minimax: new MinimaxAdapter(),
  openai: new OpenAIAdapter(),
  anthropic: new AnthropicAdapter(),
};

export const FALLBACK_MODELS: Record<AgentProvider, ModelListEntry[]> = {
  minimax: [
    { modelId: 'MiniMax-Text-01', displayName: 'MiniMax Text 01' },
    { modelId: 'abab6.5-chat', displayName: 'ABAB 6.5 Chat' },
  ],
  openai: [
    { modelId: 'gpt-4.1-mini', displayName: 'GPT-4.1 mini' },
    { modelId: 'gpt-4.1', displayName: 'GPT-4.1' },
  ],
  anthropic: [
    { modelId: 'claude-3-5-sonnet-latest', displayName: 'Claude 3.5 Sonnet' },
    { modelId: 'claude-3-7-sonnet-latest', displayName: 'Claude 3.7 Sonnet' },
  ],
};

export const estimateUsage = (inputText: string, outputText: string) => {
  const inputTokens = estimateTokens(inputText);
  const outputTokens = estimateTokens(outputText);
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
};
