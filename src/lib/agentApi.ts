import type {
  AgentActivityLog,
  AgentProvider,
  AgentSettings,
  ModelCatalogReasonCode,
  ModelListItem,
  SaveMode,
  TriggerSource,
} from '../features/agent/types';

type ApiError = { error?: { message?: string } | null };

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

export async function listModels(provider: AgentProvider): Promise<{
  models: ModelListItem[];
  selected_model: string;
  catalog_status: 'live' | 'unavailable';
  selection_source: 'live_catalog' | 'provider_fallback';
  reason_code: ModelCatalogReasonCode;
}> {
  const response = await fetch(`/api/agent/models?provider=${provider}`);
  if (!response.ok) throw new Error(await asErrorMessage(response));
  return response.json() as Promise<{
    models: ModelListItem[];
    selected_model: string;
    catalog_status: 'live' | 'unavailable';
    selection_source: 'live_catalog' | 'provider_fallback';
    reason_code: ModelCatalogReasonCode;
  }>;
}

export async function generateText(params: {
  provider: AgentProvider;
  model: string;
  noteId: string;
  inputText: string;
  triggerSource: TriggerSource;
  saveMode: SaveMode;
  signal?: AbortSignal;
}): Promise<{ outputText: string }> {
  const response = await fetch('/api/agent/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: params.provider,
      model: params.model,
      note_id: params.noteId,
      input_text: params.inputText,
      trigger_source: params.triggerSource,
      save_mode: params.saveMode,
      initiated_by: 'user',
    }),
    signal: params.signal,
  });
  if (!response.ok) throw new Error(await asErrorMessage(response));
  return response.json() as Promise<{ outputText: string }>;
}
