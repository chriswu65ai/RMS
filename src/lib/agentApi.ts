import type {
  AgentActivityLog,
  AgentProvider,
  AgentSettings,
  CreatePreferredSourceInput,
  ModelCatalogReasonCode,
  ModelListItem,
  PreferredSource,
  SaveMode,
  TriggerSource,
  UpdatePreferredSourceInput,
} from '../features/agent/types';

type ApiError = { error?: { message?: string } | null };
export type StreamSource = {
  title: string;
  url: string;
  snippet: string;
  provider: string;
  published_at?: string;
};

export type ThinkingEvent =
  | {
    type: 'tool_call_started';
    toolName?: string;
    toolCallId?: string;
    message?: string;
    raw: Record<string, unknown>;
  }
  | {
    type: 'tool_call_result';
    toolName?: string;
    toolCallId?: string;
    message?: string;
    raw: Record<string, unknown>;
  }
  | {
    type: 'tool_call_failed';
    toolName?: string;
    toolCallId?: string;
    message?: string;
    raw: Record<string, unknown>;
  }
  | {
    type: 'reasoning';
    summary?: string;
    message?: string;
    raw: Record<string, unknown>;
  };

type StreamPayload = {
  type?: string;
  deltaText?: string;
  message?: string;
  outputText?: string;
  sources?: StreamSource[];
  toolName?: string;
  tool_name?: string;
  toolCallId?: string;
  tool_call_id?: string;
  summary?: string;
  reasoning?: string;
  text?: string;
} & Record<string, unknown>;

const asErrorMessage = async (response: Response) => {
  try {
    const payload = await response.json() as ApiError;
    return payload.error?.message ?? 'Request failed.';
  } catch {
    return await response.text();
  }
};

export async function getAgentSettings(): Promise<AgentSettings> {
  const response = await fetch('/api/agent/settings');
  if (!response.ok) throw new Error(await asErrorMessage(response));
  return response.json() as Promise<AgentSettings>;
}

export async function saveAgentSettings(settings: AgentSettings): Promise<void> {
  const response = await fetch('/api/agent/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!response.ok) throw new Error(await asErrorMessage(response));
}

export async function getCredentialStatus(provider: AgentProvider): Promise<{ has_key: boolean }> {
  const response = await fetch(`/api/agent/credentials/${provider}`);
  if (!response.ok) throw new Error(await asErrorMessage(response));
  return response.json() as Promise<{ has_key: boolean }>;
}

export async function saveCredential(provider: AgentProvider, apiKey: string): Promise<void> {
  const response = await fetch(`/api/agent/credentials/${provider}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey }),
  });
  if (!response.ok) throw new Error(await asErrorMessage(response));
}

export async function listActivityLog(limit = 10): Promise<AgentActivityLog[]> {
  const response = await fetch(`/api/agent/activity-log?limit=${limit}`);
  if (!response.ok) throw new Error(await asErrorMessage(response));
  return response.json() as Promise<AgentActivityLog[]>;
}

export async function clearActivityLog(): Promise<void> {
  const response = await fetch('/api/agent/activity-log', { method: 'DELETE' });
  if (!response.ok) throw new Error(await asErrorMessage(response));
}

export async function listPreferredSources(): Promise<PreferredSource[]> {
  const response = await fetch('/api/agent/preferred-sources');
  if (!response.ok) throw new Error(await asErrorMessage(response));
  return response.json() as Promise<PreferredSource[]>;
}

export async function loadPreferredSources(): Promise<PreferredSource[]> {
  return listPreferredSources();
}

export async function createPreferredSource(input: CreatePreferredSourceInput): Promise<PreferredSource> {
  const response = await fetch('/api/agent/preferred-sources', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await asErrorMessage(response));
  return response.json() as Promise<PreferredSource>;
}

export async function savePreferredSource(input: CreatePreferredSourceInput): Promise<PreferredSource> {
  return createPreferredSource(input);
}

export async function updatePreferredSource(id: string, input: UpdatePreferredSourceInput): Promise<PreferredSource> {
  const response = await fetch(`/api/agent/preferred-sources/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await asErrorMessage(response));
  return response.json() as Promise<PreferredSource>;
}

export async function savePreferredSourceById(id: string, input: UpdatePreferredSourceInput): Promise<PreferredSource> {
  return updatePreferredSource(id, input);
}

export async function deletePreferredSource(id: string): Promise<void> {
  const response = await fetch(`/api/agent/preferred-sources/${id}`, { method: 'DELETE' });
  if (!response.ok) throw new Error(await asErrorMessage(response));
}

export async function listModels(provider: AgentProvider, runtimeBaseUrl?: string): Promise<{
  models: ModelListItem[];
  selected_model: string;
  catalog_status: 'live' | 'unsupported' | 'failed';
  selection_source: 'live_catalog' | 'provider_fallback';
  reason_code: ModelCatalogReasonCode;
}> {
  const params = new URLSearchParams({ provider });
  if (runtimeBaseUrl && provider === 'ollama') params.set('runtime_base_url', runtimeBaseUrl);
  const response = await fetch(`/api/agent/models?${params.toString()}`);
  if (!response.ok) throw new Error(await asErrorMessage(response));
  return response.json() as Promise<{
    models: ModelListItem[];
    selected_model: string;
    catalog_status: 'live' | 'unsupported' | 'failed';
    selection_source: 'live_catalog' | 'provider_fallback';
    reason_code: ModelCatalogReasonCode;
  }>;
}

export async function generateText(params: {
  provider: AgentProvider;
  model: string;
  noteId: string;
  taskId?: string;
  attachmentIds?: string[];
  inputText: string;
  triggerSource: TriggerSource;
  saveMode: SaveMode;
  signal?: AbortSignal;
  onProgress?: (nextOutputText: string) => void;
  onSources?: (sources: StreamSource[]) => void;
  onSearchWarning?: (message: string) => void;
  onThinkingEvent?: (event: ThinkingEvent) => void;
}): Promise<{ outputText: string }> {
  const response = await fetch('/api/agent/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: params.provider,
      model: params.model,
      note_id: params.noteId,
      task_id: params.taskId ?? '',
      attachment_ids: params.attachmentIds ?? [],
      input_text: params.inputText,
      trigger_source: params.triggerSource,
      save_mode: params.saveMode,
      initiated_by: 'user',
    }),
    signal: params.signal,
  });
  if (!response.ok) throw new Error(await asErrorMessage(response));
  const contentType = response.headers.get('Content-Type') ?? '';
  if (!contentType.includes('application/x-ndjson')) {
    return response.json() as Promise<{ outputText: string }>;
  }
  if (!response.body) return { outputText: '' };
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
      const payload = JSON.parse(trimmed) as StreamPayload;
      if (payload.type === 'delta') {
        outputText += payload.deltaText ?? '';
        params.onProgress?.(outputText);
      }
      if (payload.type === 'sources') {
        params.onSources?.(Array.isArray(payload.sources) ? payload.sources : []);
      }
      if (payload.type === 'search_warning') {
        params.onSearchWarning?.(payload.message ?? 'Web search failed.');
      }
      if (payload.type === 'tool_call_started') {
        params.onThinkingEvent?.({
          type: 'tool_call_started',
          toolName: typeof payload.toolName === 'string' ? payload.toolName : (typeof payload.tool_name === 'string' ? payload.tool_name : undefined),
          toolCallId: typeof payload.toolCallId === 'string' ? payload.toolCallId : (typeof payload.tool_call_id === 'string' ? payload.tool_call_id : undefined),
          message: payload.message,
          raw: payload,
        });
      }
      if (payload.type === 'tool_call_result') {
        params.onThinkingEvent?.({
          type: 'tool_call_result',
          toolName: typeof payload.toolName === 'string' ? payload.toolName : (typeof payload.tool_name === 'string' ? payload.tool_name : undefined),
          toolCallId: typeof payload.toolCallId === 'string' ? payload.toolCallId : (typeof payload.tool_call_id === 'string' ? payload.tool_call_id : undefined),
          message: payload.message,
          raw: payload,
        });
      }
      if (payload.type === 'tool_call_failed') {
        params.onThinkingEvent?.({
          type: 'tool_call_failed',
          toolName: typeof payload.toolName === 'string' ? payload.toolName : (typeof payload.tool_name === 'string' ? payload.tool_name : undefined),
          toolCallId: typeof payload.toolCallId === 'string' ? payload.toolCallId : (typeof payload.tool_call_id === 'string' ? payload.tool_call_id : undefined),
          message: payload.message,
          raw: payload,
        });
      }
      if (payload.type === 'reasoning' || payload.type === 'provider_summary') {
        params.onThinkingEvent?.({
          type: 'reasoning',
          summary: typeof payload.summary === 'string'
            ? payload.summary
            : (typeof payload.reasoning === 'string' ? payload.reasoning : (typeof payload.text === 'string' ? payload.text : undefined)),
          message: payload.message,
          raw: payload,
        });
      }
      if (payload.type === 'done') {
        outputText = payload.outputText ?? outputText;
        params.onProgress?.(outputText);
        return { outputText };
      }
      if (payload.type === 'error') {
        throw new Error(payload.message ?? 'Generation failed.');
      }
    }
  }
  return { outputText };
}
