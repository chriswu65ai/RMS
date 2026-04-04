import { useEffect, useMemo, useState } from 'react';
import { clearActivityLog, getAgentSettings, getCredentialStatus, listActivityLog, saveAgentSettings, saveCredential } from '../../lib/agentApi';
import { useResearchStore } from '../../hooks/useResearchStore';
import { ModelCatalogService } from '../../lib/agent/ModelCatalogService';
import { AGENT_PROVIDERS, CLOUD_AGENT_PROVIDERS, type AgentActivityLog, type AgentProvider, type CloudAgentProvider, type ModelCatalogReasonCode, type ModelListItem } from './types';
import { formatLocalDateTime } from '../../lib/time';
import { fetchOllamaTagsDirect } from './ollamaDirect';
import { getSavedLocalRuntime } from './runtimeConfig';
import { buildSaveDefaultsPayload, getMirroredOllamaDraftModel } from './ollamaModelSync';

const modelCatalogService = new ModelCatalogService();
const LOCAL_BASE_URL_DEFAULT = 'http://localhost:11434';

const providerLabel = (provider: AgentProvider) => {
  if (provider === 'openai') return 'ChatGPT';
  if (provider === 'anthropic') return 'Claude';
  return provider.charAt(0).toUpperCase() + provider.slice(1);
};
const statusLabel = (status: AgentActivityLog['status']) => status.charAt(0).toUpperCase() + status.slice(1);
const formatDuration = (durationMs: number | null) => (durationMs && durationMs > 0 ? `${(durationMs / 1000).toFixed(1)}s` : '—');
const formatUsd = (amount: number | null) => (typeof amount === 'number' ? `$${amount.toFixed(4)}` : '—');
const catalogStatusBannerMessage = (catalogStatus: 'live' | 'unsupported' | 'failed' | null) => {
  if (catalogStatus === 'live') return 'Model catalog loaded.';
  if (catalogStatus === 'unsupported') return 'Catalog unsupported; fallback auto-selected.';
  if (catalogStatus === 'failed') return 'Failed to retrieve model catalog: fallback to auto-selected.';
  return null;
};

export function AgentPage() {
  const files = useResearchStore((state) => state.files);
  const [provider, setProvider] = useState<AgentProvider>('minimax');
  const [selectedProviderModel, setSelectedProviderModel] = useState('');
  const [models, setModels] = useState<ModelListItem[]>([]);
  const [localBaseUrl, setLocalBaseUrl] = useState(LOCAL_BASE_URL_DEFAULT);
  const [ollamaRuntimeModelDraft, setOllamaRuntimeModelDraft] = useState('');
  const [savedLocalRuntime, setSavedLocalRuntime] = useState({ baseUrl: LOCAL_BASE_URL_DEFAULT, model: '' });
  const [modelState, setModelState] = useState<{
    loading: boolean;
    catalogStatus: 'live' | 'unsupported' | 'failed' | null;
    selectionSource: 'live_catalog' | 'provider_fallback' | null;
    reasonCode: ModelCatalogReasonCode | null;
  }>({ loading: false, catalogStatus: null, selectionSource: null, reasonCode: null });
  const [activity, setActivity] = useState<AgentActivityLog[]>([]);
  const [statusByProvider, setStatusByProvider] = useState<Record<CloudAgentProvider, boolean>>({ minimax: false, openai: false, anthropic: false });
  const [draftKeyByProvider, setDraftKeyByProvider] = useState<Record<CloudAgentProvider, string>>({ minimax: '', openai: '', anthropic: '' });
  const [message, setMessage] = useState('');
  const [localSaveMessage, setLocalSaveMessage] = useState('');
  const modelOptions = models.length > 0
    ? models
    : (selectedProviderModel.trim()
      ? [{ modelId: selectedProviderModel, displayName: selectedProviderModel }]
      : []);
  const localModelValue = ollamaRuntimeModelDraft;
  const localModelOptions = (provider === 'ollama' && models.length > 0)
    ? models
    : (localModelValue.trim()
      ? [{ modelId: localModelValue, displayName: localModelValue }]
      : []);

  const refreshModels = async (nextProvider: AgentProvider, applySelection = true, runtimeBaseUrl = localBaseUrl.trim() || LOCAL_BASE_URL_DEFAULT) => {
    setModelState({ loading: true, catalogStatus: null, selectionSource: null, reasonCode: null });
    try {
      const response = await modelCatalogService.listModels(nextProvider);
      let nextModels = response.models;
      let nextReasonCode = response.reasonCode;
      let nextCatalogStatus = response.catalogStatus;
      let nextSelectionSource = response.selectionSource;
      if (nextProvider === 'ollama' && response.reasonCode === 'ollama_unreachable') {
        try {
          const fallbackModels = await fetchOllamaTagsDirect(runtimeBaseUrl);
          if (fallbackModels.length > 0) {
            nextModels = fallbackModels;
            nextReasonCode = 'ok';
            nextCatalogStatus = 'live';
            nextSelectionSource = 'live_catalog';
          }
        } catch {
          // Keep original unreachable state.
        }
      }
      setModels(nextModels);
      setModelState({
        loading: false,
        catalogStatus: nextCatalogStatus,
        selectionSource: nextSelectionSource,
        reasonCode: nextReasonCode,
      });
      if (applySelection) {
        setSelectedProviderModel(response.selectedModel);
        if (nextProvider === 'ollama') setOllamaRuntimeModelDraft(response.selectedModel);
      }
    } catch {
      setModels([]);
      setModelState({
        loading: false,
        catalogStatus: 'failed',
        selectionSource: 'provider_fallback',
        reasonCode: 'network_error',
      });
    }
  };

  useEffect(() => {
    void (async () => {
      try {
        const [settings, events] = await Promise.all([getAgentSettings(), listActivityLog(12)]);
        setProvider(settings.default_provider);
        const savedRuntime = getSavedLocalRuntime(settings);
        setSelectedProviderModel(settings.default_model);
        setLocalBaseUrl(savedRuntime.baseUrl);
        setSavedLocalRuntime(savedRuntime);
        setOllamaRuntimeModelDraft(savedRuntime.model);
        setActivity(events);
        await refreshModels(settings.default_provider, !settings.default_model.trim(), savedRuntime.baseUrl);

        const statuses = await Promise.all(CLOUD_AGENT_PROVIDERS.map(async (candidate) => ({ provider: candidate, has: (await getCredentialStatus(candidate)).has_key })));
        setStatusByProvider(statuses.reduce((acc, row) => ({ ...acc, [row.provider]: row.has }), { minimax: false, openai: false, anthropic: false }));
      } catch (error) {
        setMessage(error instanceof Error ? error.message : 'Failed loading Agent settings.');
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canSaveDefaults = selectedProviderModel.trim().length > 0;
  const canSaveLocalDefaults = localBaseUrl.trim().length > 0 && localModelValue.trim().length > 0;
  const hasUnsavedLocalChanges = localBaseUrl.trim() !== savedLocalRuntime.baseUrl || ollamaRuntimeModelDraft.trim() !== savedLocalRuntime.model;

  const latestSummary = useMemo(() => activity.map((entry) => {
    const matchingFile = files.find((file) => file.id === entry.note_id);
    const target = matchingFile?.name || matchingFile?.path || (entry.note_id ? `note ${entry.note_id.slice(0, 8)}` : 'current note');
    const verb = entry.action === 'generate' ? 'edit' : entry.action;
    const modelName = entry.model || 'unknown model';
    const providerName = providerLabel(entry.provider as AgentProvider);
    const lead = `Called ${providerName} model ${modelName} to ${verb} ${target}`;
    return {
      id: entry.id,
      lead,
      status: statusLabel(entry.status),
      duration: formatDuration(entry.duration_ms),
      tokens: entry.token_estimate ?? null,
      cost: formatUsd(entry.cost_estimate_usd),
      timestamp: formatLocalDateTime(entry.timestamp),
      details: entry.error_message_short,
      chars: `${entry.input_chars} in / ${entry.output_chars} out`,
    };
  }), [activity, files]);

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Choose agent</h2>
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-1 text-sm">
                <span className="text-slate-600">Provider</span>
                <select
                  className="input"
                  value={provider}
                  onChange={(event) => {
                    const nextProvider = event.target.value as AgentProvider;
                    setProvider(nextProvider);
                    if (nextProvider === 'ollama') setSelectedProviderModel(ollamaRuntimeModelDraft);
                    void refreshModels(nextProvider, nextProvider !== 'ollama');
                  }}
                >
                  {AGENT_PROVIDERS.map((candidate) => <option key={candidate} value={candidate}>{providerLabel(candidate)}</option>)}
                </select>
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-slate-600">Model</span>
                <select
                  className="input"
                  value={selectedProviderModel}
                  onChange={(event) => {
                    const nextModel = event.target.value;
                    setSelectedProviderModel(nextModel);
                    setOllamaRuntimeModelDraft((currentDraft) => getMirroredOllamaDraftModel(provider, nextModel, currentDraft));
                    if (provider === 'ollama') setLocalSaveMessage('');
                  }}
                  disabled={modelState.loading || modelOptions.length === 0}
                >
                  {modelOptions.map((entry) => <option key={entry.modelId} value={entry.modelId}>{entry.displayName}</option>)}
                </select>
              </label>
            </div>
            <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
              {modelState.loading ? <span>Refreshing models…</span> : null}
              {!modelState.loading && modelState.catalogStatus
                ? <span>{catalogStatusBannerMessage(modelState.catalogStatus)}</span>
                : null}
              {!modelState.loading && provider === 'ollama' && modelState.reasonCode === 'ollama_unreachable'
                ? <span>Could not connect to Ollama at {localBaseUrl.trim() || LOCAL_BASE_URL_DEFAULT}.</span>
                : null}
            </div>
            <div className="mt-3">
              <button
                className="rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
                disabled={!canSaveDefaults}
                onClick={async () => {
                  if (provider !== 'ollama' && hasUnsavedLocalChanges) {
                    setMessage('Unsaved Ollama runtime changes detected. Save local settings first to avoid ambiguity.');
                    return;
                  }
                  try {
                    const settings = await getAgentSettings();
                    const canonicalBaseUrl = localBaseUrl.trim() || LOCAL_BASE_URL_DEFAULT;
                    const canonicalModel = selectedProviderModel.trim();
                    await saveAgentSettings(buildSaveDefaultsPayload(settings, provider, selectedProviderModel, localBaseUrl));
                    if (provider === 'ollama') {
                      setSavedLocalRuntime({ baseUrl: canonicalBaseUrl, model: canonicalModel });
                      setSelectedProviderModel(canonicalModel);
                      setOllamaRuntimeModelDraft(canonicalModel);
                    }
                    setMessage('Default provider/model saved.');
                  } catch (error) {
                    setMessage(error instanceof Error ? error.message : 'Failed saving defaults.');
                  }
                }}
              >
                Save default agent
              </button>
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Cloud APIs</h2>
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="grid gap-4 md:grid-cols-3">
              {CLOUD_AGENT_PROVIDERS.map((candidate) => (
                <div key={candidate} className="space-y-2 rounded-lg border border-slate-200 p-3">
                  <div className="flex items-center justify-between">
                    <h3 className="font-medium">{providerLabel(candidate)}</h3>
                    <span className={`text-xs ${statusByProvider[candidate] ? 'text-emerald-600' : 'text-slate-500'}`}>{statusByProvider[candidate] ? 'Key saved' : 'No key'}</span>
                  </div>
                  <input
                    className="input"
                    type="password"
                    value={draftKeyByProvider[candidate]}
                    placeholder="sk-..."
                    onChange={(event) => setDraftKeyByProvider((prev) => ({ ...prev, [candidate]: event.target.value }))}
                  />
                  <div className="flex gap-2">
                    <button
                      className="rounded-md border border-slate-300 px-2 py-1 text-xs"
                      onClick={async () => {
                        try {
                          await saveCredential(candidate, draftKeyByProvider[candidate]);
                          setStatusByProvider((prev) => ({ ...prev, [candidate]: true }));
                          setDraftKeyByProvider((prev) => ({ ...prev, [candidate]: '' }));
                          if (candidate === provider) await refreshModels(provider);
                          setMessage(`${providerLabel(candidate)} credential saved securely.`);
                        } catch (error) {
                          setMessage(error instanceof Error ? error.message : 'Failed saving credential.');
                        }
                      }}
                    >
                      Save key
                    </button>
                    <button className="rounded-md border border-slate-300 px-2 py-1 text-xs" onClick={() => void refreshModels(candidate, candidate === provider)}>Refresh models</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Local provider (Ollama)</h2>
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-1 text-sm">
                <span className="text-slate-600">Interface URL</span>
                <input
                  className="input"
                  value={localBaseUrl}
                  placeholder={LOCAL_BASE_URL_DEFAULT}
                  onChange={(event) => {
                    setLocalBaseUrl(event.target.value);
                    setLocalSaveMessage('');
                  }}
                />
                {localBaseUrl.trim() === LOCAL_BASE_URL_DEFAULT && provider === 'ollama' && modelState.reasonCode === 'ollama_unreachable'
                  ? <p className="text-xs text-amber-700">If Ollama runs on host, use http://host.docker.internal:11434.</p>
                  : null}
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-slate-600">Installed model</span>
                <select
                  className="input"
                  value={localModelValue}
                  onChange={(event) => {
                    const nextLocalModel = event.target.value;
                    setOllamaRuntimeModelDraft(nextLocalModel);
                    if (provider === 'ollama') setSelectedProviderModel(nextLocalModel);
                    setLocalSaveMessage('');
                  }}
                  disabled={(provider === 'ollama' && modelState.loading) || localModelOptions.length === 0}
                >
                  {localModelOptions.map((entry) => <option key={entry.modelId} value={entry.modelId}>{entry.displayName}</option>)}
                </select>
              </label>
            </div>
            <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
              {modelState.loading ? <span>Refreshing models…</span> : null}
              {!modelState.loading && provider === 'ollama' && modelState.catalogStatus === 'live' ? <span>Model catalog loaded.</span> : null}
              {!modelState.loading && provider === 'ollama' && modelState.reasonCode === 'empty_response'
                ? <span>No installed Ollama models found.</span>
                : null}
              {!modelState.loading && provider === 'ollama' && modelState.reasonCode === 'ollama_unreachable'
                ? <span>Could not connect to local model service.</span>
                : null}
            </div>
            <p className="mt-2 text-xs text-slate-600">Active Ollama runtime: <span className="font-medium">{savedLocalRuntime.baseUrl || LOCAL_BASE_URL_DEFAULT}</span> / <span className="font-medium">{savedLocalRuntime.model || 'not configured'}</span></p>
            {hasUnsavedLocalChanges ? <p className="mt-2 text-xs text-amber-700">Unsaved local runtime changes.</p> : null}
            {!hasUnsavedLocalChanges && localSaveMessage ? <p className="mt-2 text-xs text-emerald-700">{localSaveMessage}</p> : null}
            <div className="mt-3 flex gap-2">
              <button
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm"
                onClick={() => {
                  if (provider !== 'ollama') setProvider('ollama');
                  void refreshModels('ollama', true, localBaseUrl.trim() || LOCAL_BASE_URL_DEFAULT);
                }}
              >
                Refresh models
              </button>
              <button
                className="rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
                disabled={!canSaveLocalDefaults}
                onClick={async () => {
                  try {
                    const settings = await getAgentSettings();
                    const canonicalBaseUrl = localBaseUrl.trim() || LOCAL_BASE_URL_DEFAULT;
                    const canonicalModel = localModelValue.trim();
                    await saveAgentSettings({
                      ...settings,
                      generation_params: {
                        ...(settings.generation_params ?? {}),
                        local_connection: {
                          base_url: canonicalBaseUrl,
                          model: canonicalModel,
                          B: settings.generation_params?.local_connection?.B ?? 1,
                        },
                      },
                      ...(settings.default_provider === 'ollama' ? { default_model: canonicalModel } : {}),
                    });
                    setSavedLocalRuntime({ baseUrl: canonicalBaseUrl, model: canonicalModel });
                    setOllamaRuntimeModelDraft(canonicalModel);
                    if (provider === 'ollama') setSelectedProviderModel(canonicalModel);
                    setLocalSaveMessage('Local settings saved.');
                    setMessage('Local model settings saved.');
                  } catch (error) {
                    setMessage(error instanceof Error ? error.message : 'Failed saving local model settings.');
                  }
                }}
              >
                Save local settings
              </button>
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">Activity log</h2>
            <button
              className="rounded-md border border-slate-300 px-3 py-1.5 text-xs"
              onClick={async () => {
                try {
                  await clearActivityLog();
                  setActivity([]);
                  setMessage('Activity log cleared.');
                } catch (error) {
                  setMessage(error instanceof Error ? error.message : 'Failed clearing activity log.');
                }
              }}
            >
              Clear log
            </button>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <ul className="max-h-[26rem] space-y-2 overflow-y-auto pr-1 text-sm text-slate-700">
              {latestSummary.map((entry) => (
                <li key={entry.id} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                  <p className="text-sm text-slate-800">{entry.lead}.</p>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-600">
                    <span>Status: {entry.status}</span>
                    <span>Duration: {entry.duration}</span>
                    <span>Tokens: {entry.tokens ?? '—'}</span>
                    <span>Cost: {entry.cost}</span>
                    <span>Chars: {entry.chars}</span>
                  </div>
                  <p className="mt-1 text-[11px] text-slate-500">{entry.timestamp}</p>
                  {entry.details ? <p className="mt-1 text-xs text-rose-600">{entry.details}</p> : null}
                </li>
              ))}
              {latestSummary.length === 0 ? <li className="text-slate-500">No activity yet.</li> : null}
            </ul>
          </div>
        </section>

        {message ? <p className="text-sm text-emerald-700">{message}</p> : null}
      </div>
    </div>
  );
}
