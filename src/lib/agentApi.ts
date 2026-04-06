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
export type ChatProfileSource = 'built_in' | 'file' | 'merged';
export type ChatActionMode = 'assist' | 'confirm_required' | 'manual_only';
export type ChatCommandName = 'task' | 'note' | 'confirm' | 'cancel' | 'help';
export type ChatCommandPrefixMode = 'on' | 'off' | boolean;
export type ChatCommandPrefixMap = Record<ChatCommandName, string>;
export type ChatSettingsPolicy = {
  action_mode?: ChatActionMode;
  ask_when_missing?: boolean;
  announce_actions?: boolean;
  detailed_tool_steps?: boolean;
  profile_source?: ChatProfileSource;
  profile_file_path?: string;
  reload_profile_every_message?: boolean;
  command_prefix_mode?: ChatCommandPrefixMode;
  command_prefix_map?: Partial<ChatCommandPrefixMap>;
} & Record<string, unknown>;
export type ChatSettings = {
  id: string;
  user_id: string;
  policy: ChatSettingsPolicy;
  profile: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};
type StreamSourceWeb = {
  kind: 'web';
  title: string;
  url: string;
  snippet: string;
  provider: string;
  published_at?: string;
};

type StreamSourceAttachment = {
  kind: 'attachment';
  attachment_id: string;
  label: string;
};

export type StreamSource = StreamSourceWeb | StreamSourceAttachment;

export type IngestionDiagnosticReason =
  | 'included_full'
  | 'budget_exceeded'
  | 'parse_pending'
  | 'parse_failed'
  | 'unsupported_type'
  | 'deleted'
  | 'missing';

export type IngestionDiagnosticFile = {
  attachment_id: string;
  filename: string;
  reason: IngestionDiagnosticReason;
  included_tokens: number;
  estimated_tokens: number;
  fully_included: boolean;
  partially_included: boolean;
};

export type IngestionDiagnostics = {
  total_eligible_attachments: number;
  fully_included_attachments: number;
  partially_included_attachments: number;
  excluded_attachments: number;
  token_budget: number;
  tokens_consumed: number;
  files: IngestionDiagnosticFile[];
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
  milestone?: string;
  stage?: string;
  detail?: string;
  provider?: string;
  diagnostics?: IngestionDiagnostics;
} & Record<string, unknown>;

const pickToolName = (payload: StreamPayload): string | undefined => (
  typeof payload.toolName === 'string'
    ? payload.toolName
    : (typeof payload.tool_name === 'string' ? payload.tool_name : undefined)
);

const pickToolCallId = (payload: StreamPayload): string | undefined => (
  typeof payload.toolCallId === 'string'
    ? payload.toolCallId
    : (typeof payload.tool_call_id === 'string' ? payload.tool_call_id : undefined)
);

const pickReasoningText = (payload: StreamPayload): string | undefined => {
  const candidates = [
    payload.summary,
    payload.reasoning,
    payload.message,
    payload.text,
    payload.milestone,
    payload.stage,
    payload.detail,
  ];
  const normalized = candidates.find((candidate) => typeof candidate === 'string' && candidate.trim().length > 0);
  return typeof normalized === 'string' ? normalized.trim() : undefined;
};

const isGenerationProgressPayload = (payload: StreamPayload): boolean => {
  const type = typeof payload.type === 'string' ? payload.type.toLowerCase() : '';
  if (!type) return false;
  if (type === 'provider_summary') return true;
  if (type.includes('reasoning')) return true;
  if (type.includes('summary')) return true;
  if (type.includes('progress')) return true;
  if (type.includes('milestone')) return true;
  return false;
};

const buildThinkingEvent = (payload: StreamPayload): ThinkingEvent | null => {
  if (payload.type === 'tool_call_started') {
    return {
      type: 'tool_call_started',
      toolName: pickToolName(payload),
      toolCallId: pickToolCallId(payload),
      message: payload.message,
      raw: payload,
    };
  }
  if (payload.type === 'tool_call_result') {
    return {
      type: 'tool_call_result',
      toolName: pickToolName(payload),
      toolCallId: pickToolCallId(payload),
      message: payload.message,
      raw: payload,
    };
  }
  if (payload.type === 'tool_call_failed') {
    return {
      type: 'tool_call_failed',
      toolName: pickToolName(payload),
      toolCallId: pickToolCallId(payload),
      message: payload.message,
      raw: payload,
    };
  }
  if (payload.type === 'reasoning' || isGenerationProgressPayload(payload)) {
    return {
      type: 'reasoning',
      summary: pickReasoningText(payload),
      message: payload.message,
      raw: payload,
    };
  }
  return null;
};

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

export async function getChatSettings(): Promise<ChatSettings> {
  const response = await fetch('/api/chat/settings');
  if (!response.ok) throw new Error(await asErrorMessage(response));
  return response.json() as Promise<ChatSettings>;
}

export async function saveChatSettings(settings: { policy?: ChatSettingsPolicy; profile?: Record<string, unknown> | null }): Promise<void> {
  const response = await fetch('/api/chat/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!response.ok) throw new Error(await asErrorMessage(response));
}

export async function reloadChatProfile(): Promise<{ profile: Record<string, unknown> }> {
  const response = await fetch('/api/chat/profile/reload', { method: 'POST' });
  if (!response.ok) throw new Error(await asErrorMessage(response));
  return response.json() as Promise<{ profile: Record<string, unknown> }>;
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
  onIngestionDiagnostics?: (diagnostics: IngestionDiagnostics) => void;
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
      let payload: StreamPayload;
      try {
        payload = JSON.parse(trimmed) as StreamPayload;
      } catch {
        continue;
      }
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
      if (payload.type === 'ingestion_diagnostics' && payload.diagnostics) {
        params.onIngestionDiagnostics?.(payload.diagnostics);
      }
      const thinkingEvent = buildThinkingEvent(payload);
      if (thinkingEvent) {
        params.onThinkingEvent?.(thinkingEvent);
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

export async function preflightGenerateIngestion(params: {
  provider: AgentProvider;
  model: string;
  noteId: string;
  taskId?: string;
  attachmentIds?: string[];
  inputText: string;
  triggerSource: TriggerSource;
  saveMode: SaveMode;
}): Promise<{ diagnostics: IngestionDiagnostics; predicted_truncation: boolean }> {
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
      preflight_only: true,
    }),
  });
  if (!response.ok) throw new Error(await asErrorMessage(response));
  return response.json() as Promise<{ diagnostics: IngestionDiagnostics; predicted_truncation: boolean }>;
}
