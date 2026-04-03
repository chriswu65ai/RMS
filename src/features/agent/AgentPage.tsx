import { useEffect, useMemo, useState } from 'react';
import { getAgentSettings, getCredentialStatus, listActivityLog, saveAgentSettings, saveCredential } from '../../lib/agentApi';
import { ModelCatalogService } from '../../lib/agent/ModelCatalogService';
import { AGENT_PROVIDERS, type AgentActivityLog, type AgentProvider, type ModelListItem } from './types';

const modelCatalogService = new ModelCatalogService();

const providerLabel = (provider: AgentProvider) => provider.charAt(0).toUpperCase() + provider.slice(1);

export function AgentPage() {
  const [provider, setProvider] = useState<AgentProvider>('minimax');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<ModelListItem[]>([]);
  const [modelState, setModelState] = useState<{ loading: boolean; source: 'provider' | 'fallback' | null; reason: string | null }>({ loading: false, source: null, reason: null });
  const [activity, setActivity] = useState<AgentActivityLog[]>([]);
  const [statusByProvider, setStatusByProvider] = useState<Record<AgentProvider, boolean>>({ minimax: false, openai: false, anthropic: false });
  const [draftKeyByProvider, setDraftKeyByProvider] = useState<Record<AgentProvider, string>>({ minimax: '', openai: '', anthropic: '' });
  const [message, setMessage] = useState('');

  const refreshModels = async (nextProvider: AgentProvider, preserveModel = false) => {
    setModelState({ loading: true, source: null, reason: null });
    try {
      const response = await modelCatalogService.listModels(nextProvider);
      setModels(response.models);
      setModelState({ loading: false, source: response.source, reason: response.reason ?? null });
      if (!preserveModel || !response.models.some((entry) => entry.modelId === model)) {
        setModel(response.models[0]?.modelId ?? '');
      }
    } catch (error) {
      setModels([]);
      setModelState({ loading: false, source: 'fallback', reason: error instanceof Error ? error.message : 'Failed listing models.' });
      setModel('');
    }
  };

  useEffect(() => {
    void (async () => {
      try {
        const [settings, events] = await Promise.all([getAgentSettings(), listActivityLog(12)]);
        setProvider(settings.default_provider);
        setModel(settings.default_model);
        setActivity(events);

        const statuses = await Promise.all(AGENT_PROVIDERS.map(async (candidate) => ({ provider: candidate, has: (await getCredentialStatus(candidate)).has_key })));
        setStatusByProvider(statuses.reduce((acc, row) => ({ ...acc, [row.provider]: row.has }), { minimax: false, openai: false, anthropic: false }));
        await refreshModels(settings.default_provider, true);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : 'Failed loading Agent settings.');
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canSaveDefaults = model.trim().length > 0;

  const latestSummary = useMemo(() => activity.map((entry) => {
    const duration = entry.duration_ms ? `${(entry.duration_ms / 1000).toFixed(1)}s` : '—';
    return `${entry.action} ${entry.status} • ${providerLabel(entry.provider as AgentProvider)} • ${duration}`;
  }), [activity]);

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Provider config</h2>
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-1 text-sm">
                <span className="text-slate-600">Default provider</span>
                <select
                  className="input"
                  value={provider}
                  onChange={(event) => {
                    const nextProvider = event.target.value as AgentProvider;
                    setProvider(nextProvider);
                    void refreshModels(nextProvider, false);
                  }}
                >
                  {AGENT_PROVIDERS.map((candidate) => <option key={candidate} value={candidate}>{providerLabel(candidate)}</option>)}
                </select>
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-slate-600">Default model</span>
                <select className="input" value={model} onChange={(event) => setModel(event.target.value)} disabled={modelState.loading || models.length === 0}>
                  {models.map((entry) => <option key={entry.modelId} value={entry.modelId}>{entry.displayName}</option>)}
                </select>
              </label>
            </div>
            <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
              {modelState.loading ? <span>Refreshing models…</span> : null}
              {!modelState.loading && modelState.source === 'fallback' ? <span>Using fallback catalog. {modelState.reason ? `(${modelState.reason})` : ''}</span> : null}
              {!modelState.loading && modelState.source === 'provider' ? <span>Loaded models from provider account.</span> : null}
            </div>
            <div className="mt-3">
              <button
                className="rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
                disabled={!canSaveDefaults}
                onClick={async () => {
                  try {
                    await saveAgentSettings({ default_provider: provider, default_model: model });
                    setMessage('Default provider/model saved.');
                  } catch (error) {
                    setMessage(error instanceof Error ? error.message : 'Failed saving defaults.');
                  }
                }}
              >
                Save defaults
              </button>
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Credentials</h2>
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="grid gap-4 md:grid-cols-3">
              {AGENT_PROVIDERS.map((candidate) => (
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
                          if (candidate === provider) await refreshModels(provider, false);
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
          <h2 className="text-lg font-semibold">Activity log preview</h2>
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <ul className="space-y-2 text-sm text-slate-700">
              {latestSummary.map((line, index) => <li key={`${line}-${index}`}>{line}</li>)}
              {latestSummary.length === 0 ? <li className="text-slate-500">No activity yet.</li> : null}
            </ul>
          </div>
        </section>

        {message ? <p className="text-sm text-emerald-700">{message}</p> : null}
      </div>
    </div>
  );
}
