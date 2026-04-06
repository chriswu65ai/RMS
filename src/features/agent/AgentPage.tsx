import { useEffect, useMemo, useState } from 'react';
import {
  clearActivityLog,
  deletePreferredSource,
  getChatSettings,
  getAgentSettings,
  getCredentialStatus,
  listActivityLog,
  loadPreferredSources,
  reloadChatProfile,
  saveAgentSettings,
  saveChatSettings,
  saveCredential,
  savePreferredSource,
  savePreferredSourceById,
  type ChatActionMode,
  type ChatCommandName,
  type ChatCommandPrefixMap,
  type ChatProfileSource,
} from '../../lib/agentApi';
import { useResearchStore } from '../../hooks/useResearchStore';
import { ModelCatalogService } from '../../lib/agent/ModelCatalogService';
import {
  AGENT_PROVIDERS,
  CLOUD_AGENT_PROVIDERS,
  type AgentActivityLog,
  type AgentProvider,
  type CloudAgentProvider,
  type PreferredSource,
  type WebSearchDomainPolicy,
  type WebSearchMode,
  type WebSearchProvider,
  type WebSearchRecency,
} from './types';
import { formatLocalDateTime } from '../../lib/time';
import { fetchOllamaTagsDirect } from './ollamaDirect';
import { getSavedLocalRuntime } from './runtimeConfig';
import { buildSaveDefaultsPayload, getMirroredOllamaDraftModel, resolveOllamaFallbackSelectedModel } from './ollamaModelSync';
import {
  buildWebSearchSettingsPayload,
  convertTimeoutMsToSeconds,
  getRecommendedPresetForMode,
  getWebSearchSourceCitationDefault,
  WEB_SEARCH_PROVIDER_CAPABILITIES,
  WEB_SEARCH_MAX_RESULTS_DEFAULT,
  WEB_SEARCH_MODE_OPTIONS,
  WEB_SEARCH_PROVIDER_OPTIONS,
  WEB_SEARCH_SEARXNG_BASE_URL_DEFAULT,
  WEB_SEARCH_SEARXNG_USE_HTML_MODE_DEFAULT,
  WEB_SEARCH_SAFE_SEARCH_DEFAULT,
  WEB_SEARCH_TIMEOUT_MS_DEFAULT,
  shouldShowSearxngConfigFields,
} from './webSearchSettings';
import { normalizeEndpointUrl } from './urlNormalization';

const modelCatalogService = new ModelCatalogService();
const LOCAL_BASE_URL_DEFAULT = 'http://localhost:11434';
const WEB_SEARCH_RECENCY_OPTIONS: Array<{ value: WebSearchRecency; label: string }> = [
  { value: 'any', label: 'Any time' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '365d', label: 'Last year' },
];
const WEB_SEARCH_DOMAIN_POLICIES: Array<{ value: WebSearchDomainPolicy; label: string }> = [
  { value: 'open_web', label: 'Use entire web' },
  { value: 'prefer_list', label: 'Use entire web + prioritize listed domains' },
  { value: 'only_list', label: 'Use only listed domains' },
];
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const CHECKBOX_WITH_LABEL_CLASS = 'inline-flex items-center gap-2 text-sm text-slate-700';
const CHECKBOX_INPUT_CLASS = 'h-4 w-4';
const CHAT_PROFILE_SOURCE_OPTIONS: Array<{ value: ChatProfileSource; label: string }> = [
  { value: 'built_in', label: 'Built-in' },
  { value: 'file', label: 'File' },
  { value: 'merged', label: 'Merged' },
];
const CHAT_ACTION_MODE_OPTIONS: Array<{ value: ChatActionMode; label: string; helper: string }> = [
  { value: 'assist', label: 'Assist (recommend only)', helper: 'Draft and explain actions without autonomously executing risky changes.' },
  { value: 'confirm_required', label: 'Confirm required', helper: 'Plan actions and ask for explicit confirmation before execution.' },
  { value: 'manual_only', label: 'Manual only', helper: 'Disable autonomous tool execution and stay conversational.' },
];
const CHAT_COMMAND_NAMES: ChatCommandName[] = ['task', 'note', 'confirm', 'cancel', 'help'];
const DEFAULT_CHAT_COMMAND_PREFIX_MAP: ChatCommandPrefixMap = {
  task: '/task',
  note: '/note',
  confirm: '/confirm',
  cancel: '/cancel',
  help: '/help',
};
const SOURCE_IMPORTANCE_LABELS: Record<number, string> = {
  1: 'Low',
  2: 'Medium-low',
  3: 'Medium',
  4: 'High',
  5: 'Critical',
};
const SOURCE_IMPORTANCE_COLORS: Record<number, string> = {
  1: '#84cc16',
  2: '#65a30d',
  3: '#4d7c0f',
  4: '#3f6212',
  5: '#365314',
};
const normalizeLocalBaseUrl = (value: string) => normalizeEndpointUrl(value, LOCAL_BASE_URL_DEFAULT);
const normalizeSearxngBaseUrlInput = (value: string) => normalizeEndpointUrl(value, WEB_SEARCH_SEARXNG_BASE_URL_DEFAULT);
const clampSourceImportance = (value: number) => Math.min(5, Math.max(1, value));
const getSourceImportanceLabel = (value: number) => SOURCE_IMPORTANCE_LABELS[clampSourceImportance(value)];
const getSourceImportanceColor = (value: number) => SOURCE_IMPORTANCE_COLORS[clampSourceImportance(value)];

const providerLabel = (provider: AgentProvider) => {
  if (provider === 'openai') return 'ChatGPT';
  if (provider === 'anthropic') return 'Claude';
  return provider.charAt(0).toUpperCase() + provider.slice(1);
};
const statusLabel = (status: AgentActivityLog['status']) => status.charAt(0).toUpperCase() + status.slice(1);
const formatDuration = (durationMs: number | null) => (durationMs && durationMs > 0 ? `${(durationMs / 1000).toFixed(1)}s` : '—');
const formatUsd = (amount: number | null) => (typeof amount === 'number' ? `$${amount.toFixed(4)}` : '—');
const catalogStatusBannerMessage = ({
  catalogStatus,
  modelCount,
}: {
  catalogStatus: 'live' | 'unsupported' | 'failed' | null;
  modelCount: number;
}) => {
  if (catalogStatus === 'live') return 'Model catalog loaded.';
  if (modelCount === 0 && (catalogStatus === 'unsupported' || catalogStatus === 'failed')) {
    return 'No models available yet. Press Refresh models to run live discovery.';
  }
  if (catalogStatus === 'unsupported') return 'Catalog unsupported; using configured fallback models.';
  if (catalogStatus === 'failed') return 'Failed to retrieve model catalog; using configured fallback models.';
  return null;
};

export function AgentPage() {
  const files = useResearchStore((state) => state.files);
  const modelsByProvider = useResearchStore((state) => state.agentModelsByProvider);
  const catalogStatusByProvider = useResearchStore((state) => state.agentCatalogStatusByProvider);
  const selectedModelByProvider = useResearchStore((state) => state.agentSelectedModelByProvider);
  const ollamaRuntimeModelDraft = useResearchStore((state) => state.agentOllamaRuntimeModelDraft);
  const setAgentProviderModels = useResearchStore((state) => state.setAgentProviderModels);
  const setAgentSelectedModel = useResearchStore((state) => state.setAgentSelectedModel);
  const setAgentOllamaRuntimeModelDraft = useResearchStore((state) => state.setAgentOllamaRuntimeModelDraft);
  const invalidateAgentOllamaModelsForBaseUrl = useResearchStore((state) => state.invalidateAgentOllamaModelsForBaseUrl);
  const [provider, setProvider] = useState<AgentProvider>('minimax');
  const [localBaseUrl, setLocalBaseUrl] = useState(LOCAL_BASE_URL_DEFAULT);
  const [savedLocalRuntime, setSavedLocalRuntime] = useState({ baseUrl: LOCAL_BASE_URL_DEFAULT, model: '' });
  const [modelLoadingByProvider, setModelLoadingByProvider] = useState<Record<AgentProvider, boolean>>({ minimax: false, openai: false, anthropic: false, ollama: false });
  const [activity, setActivity] = useState<AgentActivityLog[]>([]);
  const [statusByProvider, setStatusByProvider] = useState<Record<CloudAgentProvider, boolean>>({ minimax: false, openai: false, anthropic: false });
  const [draftKeyByProvider, setDraftKeyByProvider] = useState<Record<CloudAgentProvider, string>>({ minimax: '', openai: '', anthropic: '' });
  const [defaultAgentFeedbackMessage, setDefaultAgentFeedbackMessage] = useState('');
  const [localRuntimeFeedbackMessage, setLocalRuntimeFeedbackMessage] = useState('');
  const [credentialFeedbackMessage, setCredentialFeedbackMessage] = useState('');
  const [activityLogFeedbackMessage, setActivityLogFeedbackMessage] = useState('');
  const [defaultSaveMessage, setDefaultSaveMessage] = useState('');
  const [localSaveMessage, setLocalSaveMessage] = useState('');
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [webSearchProvider, setWebSearchProvider] = useState<WebSearchProvider>('duckduckgo');
  const [webSearchSearxngBaseUrl, setWebSearchSearxngBaseUrl] = useState(WEB_SEARCH_SEARXNG_BASE_URL_DEFAULT);
  const [webSearchSearxngUseHtmlMode, setWebSearchSearxngUseHtmlMode] = useState(WEB_SEARCH_SEARXNG_USE_HTML_MODE_DEFAULT);
  const [webSearchMode, setWebSearchMode] = useState<WebSearchMode>('single');
  const [webSearchMaxResults, setWebSearchMaxResults] = useState(String(WEB_SEARCH_MAX_RESULTS_DEFAULT));
  const [webSearchTimeoutSeconds, setWebSearchTimeoutSeconds] = useState(String(convertTimeoutMsToSeconds(WEB_SEARCH_TIMEOUT_MS_DEFAULT)));
  const [webSearchSafeSearch, setWebSearchSafeSearch] = useState(WEB_SEARCH_SAFE_SEARCH_DEFAULT);
  const [webSearchRecency, setWebSearchRecency] = useState<WebSearchRecency>('any');
  const [webSearchDomainPolicy, setWebSearchDomainPolicy] = useState<WebSearchDomainPolicy>('open_web');
  const [webSearchSourceCitation, setWebSearchSourceCitation] = useState(false);
  const [webSearchStatusMessage, setWebSearchStatusMessage] = useState('');
  const [preferredSources, setPreferredSources] = useState<PreferredSource[]>([]);
  const [preferredSourcesMessage, setPreferredSourcesMessage] = useState('');
  const [newDomain, setNewDomain] = useState('');
  const [newWeight, setNewWeight] = useState('1');
  const [newEnabled, setNewEnabled] = useState(true);
  const [domainInputError, setDomainInputError] = useState('');
  const [editingSourceId, setEditingSourceId] = useState<string | null>(null);
  const [editingDomain, setEditingDomain] = useState('');
  const [editingWeight, setEditingWeight] = useState('1');
  const [editingEnabled, setEditingEnabled] = useState(true);
  const [webSearchMaxResultsOverridden, setWebSearchMaxResultsOverridden] = useState(false);
  const [webSearchTimeoutOverridden, setWebSearchTimeoutOverridden] = useState(false);
  const [chatActionMode, setChatActionMode] = useState<ChatActionMode>('assist');
  const [chatAskWhenMissing, setChatAskWhenMissing] = useState(true);
  const [chatAnnounceActions, setChatAnnounceActions] = useState(true);
  const [chatShowDetailedToolSteps, setChatShowDetailedToolSteps] = useState(false);
  const [chatProfileSource, setChatProfileSource] = useState<ChatProfileSource>('built_in');
  const [chatProfileFilePath, setChatProfileFilePath] = useState('');
  const [chatReloadProfileEveryMessage, setChatReloadProfileEveryMessage] = useState(false);
  const [chatCommandPrefixMode, setChatCommandPrefixMode] = useState(false);
  const [chatCommandPrefixMap, setChatCommandPrefixMap] = useState<ChatCommandPrefixMap>(DEFAULT_CHAT_COMMAND_PREFIX_MAP);
  const [chatSettingsMessage, setChatSettingsMessage] = useState('');
  const [chatSettingsValidationError, setChatSettingsValidationError] = useState('');
  const selectedProviderModel = selectedModelByProvider[provider] ?? '';
  const models = modelsByProvider[provider] ?? [];
  const modelState = {
    loading: modelLoadingByProvider[provider],
    ...(catalogStatusByProvider[provider] ?? { catalogStatus: null, selectionSource: null, reasonCode: null }),
  };
  const modelOptions = models;
  const localModelValue = ollamaRuntimeModelDraft;
  const localModelOptions = (provider === 'ollama' && models.length > 0)
    ? models
    : (localModelValue.trim()
      ? [{ modelId: localModelValue, displayName: localModelValue }]
      : []);

  const refreshModels = async (nextProvider: AgentProvider, applySelection = true, runtimeBaseUrl = normalizeLocalBaseUrl(localBaseUrl)) => {
    setModelLoadingByProvider((current) => ({ ...current, [nextProvider]: true }));
    try {
      const response = await modelCatalogService.listModels(nextProvider, nextProvider === 'ollama' ? runtimeBaseUrl : undefined);
      let nextModels = response.models;
      let nextSelectedModel = response.selectedModel;
      let nextReasonCode = response.reasonCode;
      let nextCatalogStatus = response.catalogStatus;
      let nextSelectionSource = response.selectionSource;
      if (nextProvider === 'ollama' && response.reasonCode === 'ollama_unreachable') {
        try {
          const fallbackModels = await fetchOllamaTagsDirect(runtimeBaseUrl);
          if (fallbackModels.length > 0) {
            nextModels = fallbackModels;
            nextSelectedModel = resolveOllamaFallbackSelectedModel(
              ollamaRuntimeModelDraft,
              savedLocalRuntime.model,
              fallbackModels.map((model) => model.modelId),
              response.selectedModel,
            );
            nextReasonCode = 'ok';
            nextCatalogStatus = 'live';
            nextSelectionSource = 'live_catalog';
          }
        } catch {
          // Keep original unreachable state.
        }
      }
      setAgentProviderModels(nextProvider, nextModels, {
        catalogStatus: nextCatalogStatus,
        selectionSource: nextSelectionSource,
        reasonCode: nextReasonCode,
      });
      if (nextProvider === 'ollama') invalidateAgentOllamaModelsForBaseUrl(runtimeBaseUrl);
      const selectedModelStillAvailable = nextModels.some((model) => model.modelId === nextSelectedModel);
      const normalizedSelectedModel = selectedModelStillAvailable ? nextSelectedModel : '';
      if (applySelection) {
        setAgentSelectedModel(nextProvider, normalizedSelectedModel);
        if (nextProvider === 'ollama') setAgentOllamaRuntimeModelDraft(normalizedSelectedModel);
      } else {
        const currentSelectedModel = selectedModelByProvider[nextProvider] ?? '';
        const currentSelectionStillAvailable = nextModels.some((model) => model.modelId === currentSelectedModel);
        if (!currentSelectionStillAvailable) {
          setAgentSelectedModel(nextProvider, normalizedSelectedModel);
          if (nextProvider === 'ollama') setAgentOllamaRuntimeModelDraft(normalizedSelectedModel);
        }
      }
    } catch {
      setAgentProviderModels(nextProvider, [], {
        catalogStatus: 'failed',
        selectionSource: 'provider_fallback',
        reasonCode: 'network_error',
      });
    } finally {
      setModelLoadingByProvider((current) => ({ ...current, [nextProvider]: false }));
    }
  };

  useEffect(() => {
    void (async () => {
      try {
        const [settings, events, chatSettings] = await Promise.all([getAgentSettings(), listActivityLog(12), getChatSettings()]);
        const sources = await loadPreferredSources();
        setProvider(settings.default_provider);
        const savedRuntime = getSavedLocalRuntime(settings);
        setAgentSelectedModel(settings.default_provider, settings.default_model);
        setLocalBaseUrl(savedRuntime.baseUrl);
        setSavedLocalRuntime(savedRuntime);
        setAgentOllamaRuntimeModelDraft(savedRuntime.model);
        setAgentSelectedModel('ollama', savedRuntime.model || selectedModelByProvider.ollama);
        invalidateAgentOllamaModelsForBaseUrl(savedRuntime.baseUrl);
        setActivity(events);
        const webSearchSettings = settings.generation_params?.web_search;
        setWebSearchEnabled(Boolean(webSearchSettings?.enabled));
        setWebSearchProvider(webSearchSettings?.provider === 'searxng' ? 'searxng' : 'duckduckgo');
        setWebSearchSearxngBaseUrl(normalizeSearxngBaseUrlInput(webSearchSettings?.provider_config?.searxng?.base_url ?? ''));
        setWebSearchSearxngUseHtmlMode(!(webSearchSettings?.provider_config?.searxng?.use_json_api ?? true));
        const resolvedMode = webSearchSettings?.mode === 'deep' ? 'deep' : 'single';
        const recommendedPreset = getRecommendedPresetForMode(resolvedMode);
        const loadedMaxResults = webSearchSettings?.max_results ?? recommendedPreset.maxResults;
        const loadedTimeoutSeconds = convertTimeoutMsToSeconds(webSearchSettings?.timeout_ms ?? recommendedPreset.timeoutSeconds * 1000);
        setWebSearchMode(resolvedMode);
        setWebSearchMaxResults(String(loadedMaxResults));
        setWebSearchTimeoutSeconds(String(loadedTimeoutSeconds));
        setWebSearchSafeSearch(webSearchSettings?.safe_search ?? WEB_SEARCH_SAFE_SEARCH_DEFAULT);
        setWebSearchRecency(webSearchSettings?.recency ?? 'any');
        setWebSearchDomainPolicy(webSearchSettings?.domain_policy ?? 'open_web');
        setWebSearchSourceCitation(getWebSearchSourceCitationDefault(webSearchSettings?.source_citation));
        setWebSearchMaxResultsOverridden(loadedMaxResults !== recommendedPreset.maxResults);
        setWebSearchTimeoutOverridden(loadedTimeoutSeconds !== recommendedPreset.timeoutSeconds);
        setPreferredSources(sources);
        const chatPolicy = chatSettings.policy ?? {};
        const rawActionMode = chatPolicy.action_mode as string | undefined;
        const normalizedActionMode: ChatActionMode = rawActionMode === 'confirm_required' || rawActionMode === 'manual_only'
          ? rawActionMode
          : (rawActionMode === 'act' ? 'confirm_required' : 'assist');
        setChatActionMode(
          normalizedActionMode,
        );
        setChatAskWhenMissing(chatPolicy.ask_when_missing ?? true);
        setChatAnnounceActions(chatPolicy.announce_actions ?? true);
        setChatShowDetailedToolSteps(chatPolicy.detailed_tool_steps ?? false);
        setChatProfileSource(chatPolicy.profile_source === 'file' || chatPolicy.profile_source === 'merged' ? chatPolicy.profile_source : 'built_in');
        setChatProfileFilePath(typeof chatPolicy.profile_file_path === 'string' ? chatPolicy.profile_file_path : '');
        setChatReloadProfileEveryMessage(chatPolicy.reload_profile_every_message ?? false);
        setChatCommandPrefixMode(chatPolicy.command_prefix_mode === true || chatPolicy.command_prefix_mode === 'on');
        const configuredPrefixMap = chatPolicy.command_prefix_map && typeof chatPolicy.command_prefix_map === 'object'
          ? chatPolicy.command_prefix_map as Partial<ChatCommandPrefixMap>
          : {};
        setChatCommandPrefixMap({
          task: typeof configuredPrefixMap.task === 'string' && configuredPrefixMap.task.trim() ? configuredPrefixMap.task.trim() : DEFAULT_CHAT_COMMAND_PREFIX_MAP.task,
          note: typeof configuredPrefixMap.note === 'string' && configuredPrefixMap.note.trim() ? configuredPrefixMap.note.trim() : DEFAULT_CHAT_COMMAND_PREFIX_MAP.note,
          confirm: typeof configuredPrefixMap.confirm === 'string' && configuredPrefixMap.confirm.trim() ? configuredPrefixMap.confirm.trim() : DEFAULT_CHAT_COMMAND_PREFIX_MAP.confirm,
          cancel: typeof configuredPrefixMap.cancel === 'string' && configuredPrefixMap.cancel.trim() ? configuredPrefixMap.cancel.trim() : DEFAULT_CHAT_COMMAND_PREFIX_MAP.cancel,
          help: typeof configuredPrefixMap.help === 'string' && configuredPrefixMap.help.trim() ? configuredPrefixMap.help.trim() : DEFAULT_CHAT_COMMAND_PREFIX_MAP.help,
        });

        const hasCachedModelsForProvider = (modelsByProvider[settings.default_provider] ?? []).length > 0;
        const shouldRefreshOnMount = !hasCachedModelsForProvider || !settings.default_model.trim()
          || (settings.default_provider === 'ollama' && !savedRuntime.model.trim());
        if (shouldRefreshOnMount) {
          await refreshModels(settings.default_provider, !settings.default_model.trim(), savedRuntime.baseUrl);
        }

        const statuses = await Promise.all(CLOUD_AGENT_PROVIDERS.map(async (candidate) => ({ provider: candidate, has: (await getCredentialStatus(candidate)).has_key })));
        setStatusByProvider(statuses.reduce((acc, row) => ({ ...acc, [row.provider]: row.has }), { minimax: false, openai: false, anthropic: false }));
      } catch (error) {
        setDefaultAgentFeedbackMessage(error instanceof Error ? error.message : 'Failed loading Agent settings.');
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canSaveDefaults = selectedProviderModel.trim().length > 0;
  const canSaveLocalDefaults = localBaseUrl.trim().length > 0;
  const canSaveWebSearch = Number(webSearchMaxResults) > 0 && Number(webSearchTimeoutSeconds) > 0;
  const chatProfilePathRequired = chatProfileSource === 'file' || chatProfileSource === 'merged';
  const hasUnsavedLocalChanges = localBaseUrl.trim() !== savedLocalRuntime.baseUrl || ollamaRuntimeModelDraft.trim() !== savedLocalRuntime.model;
  const domainPolicyHelperText = useMemo(() => {
    if (webSearchDomainPolicy === 'open_web') return 'Search across the entire web. Listed domains can still receive an importance boost.';
    if (webSearchDomainPolicy === 'prefer_list') return 'Search across the entire web and prioritize enabled listed domains in ranking.';
    return 'Restrict search results to enabled listed domains only.';
  }, [webSearchDomainPolicy]);
  const isValidDomain = (value: string) => DOMAIN_PATTERN.test(value.trim());
  const webSearchModeHelperText = useMemo(() => {
    const matched = WEB_SEARCH_MODE_OPTIONS.find((candidate) => candidate.value === webSearchMode);
    return matched?.helper ?? '';
  }, [webSearchMode]);
  const webSearchProviderCapabilities = WEB_SEARCH_PROVIDER_CAPABILITIES[webSearchProvider];
  const activeCommandExamples = useMemo(() => [
    `${chatCommandPrefixMap.task} create task for NVDA`,
    `${chatCommandPrefixMap.note} summarize AAPL research`,
    `${chatCommandPrefixMap.confirm} to execute a pending action`,
    `${chatCommandPrefixMap.cancel} to cancel pending action`,
    `${chatCommandPrefixMap.help} to list commands`,
  ], [chatCommandPrefixMap]);
  const applyModeRecommendedPreset = (mode: WebSearchMode, force = false) => {
    const preset = getRecommendedPresetForMode(mode);
    if (force || !webSearchMaxResultsOverridden) {
      setWebSearchMaxResults(String(preset.maxResults));
      setWebSearchMaxResultsOverridden(false);
    }
    if (force || !webSearchTimeoutOverridden) {
      setWebSearchTimeoutSeconds(String(preset.timeoutSeconds));
      setWebSearchTimeoutOverridden(false);
    }
  };

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
                    setDefaultSaveMessage('');
                    if (nextProvider === 'ollama') setAgentSelectedModel('ollama', ollamaRuntimeModelDraft);
                    if ((modelsByProvider[nextProvider] ?? []).length === 0) {
                      void refreshModels(nextProvider, nextProvider !== 'ollama');
                    }
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
                    setAgentSelectedModel(provider, nextModel);
                    setDefaultSaveMessage('');
                    setDefaultAgentFeedbackMessage('');
                    setAgentOllamaRuntimeModelDraft(getMirroredOllamaDraftModel(provider, nextModel, ollamaRuntimeModelDraft));
                    if (provider === 'ollama') {
                      setLocalSaveMessage('');
                      setLocalRuntimeFeedbackMessage('');
                    }
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
                ? <span>{catalogStatusBannerMessage({ catalogStatus: modelState.catalogStatus, modelCount: modelOptions.length })}</span>
                : null}
              {!modelState.loading && provider === 'ollama' && modelState.reasonCode === 'ollama_unreachable'
                ? <span>Could not connect to Ollama at {localBaseUrl.trim() || LOCAL_BASE_URL_DEFAULT}.</span>
                : null}
              {!modelState.loading && !modelState.catalogStatus
                ? <span>Models shown from saved settings. Press Refresh models to fetch latest options.</span>
                : null}
            </div>
            <div className="mt-3">
              <button
                className="rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
                disabled={!canSaveDefaults}
                onClick={async () => {
                  setDefaultSaveMessage('');
                  setDefaultAgentFeedbackMessage('');
                  if (provider !== 'ollama' && hasUnsavedLocalChanges) {
                    setDefaultAgentFeedbackMessage(
                      `Unsaved local runtime edits are pending. Save local settings first before saving ${providerLabel(provider)} as the default agent to avoid ambiguous runtime context.`,
                    );
                    return;
                  }
                  try {
                    const settings = await getAgentSettings();
                    const canonicalBaseUrl = localBaseUrl.trim() || LOCAL_BASE_URL_DEFAULT;
                    const canonicalModel = selectedProviderModel.trim();
                    await saveAgentSettings(buildSaveDefaultsPayload(settings, provider, selectedProviderModel, localBaseUrl));
                    if (provider === 'ollama') {
                      setSavedLocalRuntime({ baseUrl: canonicalBaseUrl, model: canonicalModel });
                      setAgentSelectedModel('ollama', canonicalModel);
                      setAgentOllamaRuntimeModelDraft(canonicalModel);
                    }
                    setAgentSelectedModel(provider, canonicalModel);
                    setDefaultSaveMessage('Default provider/model saved.');
                    setDefaultAgentFeedbackMessage('');
                  } catch (error) {
                    setDefaultAgentFeedbackMessage(error instanceof Error ? error.message : 'Failed saving defaults.');
                  }
                }}
              >
                Save default agent
              </button>
              {defaultSaveMessage ? <p className="mt-2 text-xs text-emerald-700">{defaultSaveMessage}</p> : null}
              {defaultAgentFeedbackMessage ? <p className="mt-2 text-xs text-rose-700">{defaultAgentFeedbackMessage}</p> : null}
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Chat</h2>
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-1 text-sm">
                <span className="text-slate-600">Action mode</span>
                <select
                  className="input"
                  value={chatActionMode}
                  onChange={(event) => {
                    setChatActionMode(event.target.value as ChatActionMode);
                    setChatSettingsMessage('');
                    setChatSettingsValidationError('');
                  }}
                >
                  {CHAT_ACTION_MODE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
                <p className="text-xs text-slate-500">{CHAT_ACTION_MODE_OPTIONS.find((option) => option.value === chatActionMode)?.helper}</p>
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-slate-600">Profile source</span>
                <select
                  className="input"
                  value={chatProfileSource}
                  onChange={(event) => {
                    setChatProfileSource(event.target.value as ChatProfileSource);
                    setChatSettingsMessage('');
                    setChatSettingsValidationError('');
                  }}
                >
                  {CHAT_PROFILE_SOURCE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
                <p className="text-xs text-slate-500">Choose whether chat persona/profile comes from built-in defaults, a file, or merged behavior.</p>
              </label>
              <label className="space-y-1 text-sm md:col-span-2">
                <span className="text-slate-600">Profile file path</span>
                <input
                  className="input"
                  value={chatProfileFilePath}
                  placeholder="/absolute/or/workspace/path/to/profile.md"
                  onChange={(event) => {
                    setChatProfileFilePath(event.target.value);
                    setChatSettingsMessage('');
                    setChatSettingsValidationError('');
                  }}
                />
                <p className="text-xs text-slate-500">
                  {chatProfilePathRequired ? 'Required when profile source is File or Merged.' : 'Optional for Built-in source.'}
                </p>
              </label>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3">
              <label className={CHECKBOX_WITH_LABEL_CLASS}>
                <input
                  className={CHECKBOX_INPUT_CLASS}
                  type="checkbox"
                  checked={chatAskWhenMissing}
                  onChange={(event) => {
                    setChatAskWhenMissing(event.target.checked);
                    setChatSettingsMessage('');
                  }}
                />
                <span>Ask when required info missing</span>
              </label>
              <label className={CHECKBOX_WITH_LABEL_CLASS}>
                <input
                  className={CHECKBOX_INPUT_CLASS}
                  type="checkbox"
                  checked={chatAnnounceActions}
                  onChange={(event) => {
                    setChatAnnounceActions(event.target.checked);
                    setChatSettingsMessage('');
                  }}
                />
                <span>Announce actions in chat</span>
              </label>
              <label className={CHECKBOX_WITH_LABEL_CLASS}>
                <input
                  className={CHECKBOX_INPUT_CLASS}
                  type="checkbox"
                  checked={chatShowDetailedToolSteps}
                  onChange={(event) => {
                    setChatShowDetailedToolSteps(event.target.checked);
                    setChatSettingsMessage('');
                  }}
                />
                <span>Show detailed tool steps</span>
              </label>
              <label className={CHECKBOX_WITH_LABEL_CLASS}>
                <input
                  className={CHECKBOX_INPUT_CLASS}
                  type="checkbox"
                  checked={chatReloadProfileEveryMessage}
                  onChange={(event) => {
                    setChatReloadProfileEveryMessage(event.target.checked);
                    setChatSettingsMessage('');
                  }}
                />
                <span>Reload profile every message (immediate per-turn)</span>
              </label>
              <label className={CHECKBOX_WITH_LABEL_CLASS}>
                <input
                  className={CHECKBOX_INPUT_CLASS}
                  type="checkbox"
                  checked={chatCommandPrefixMode}
                  onChange={(event) => {
                    setChatCommandPrefixMode(event.target.checked);
                    setChatSettingsMessage('');
                  }}
                />
                <span>Enable command prefix mode for tool execution</span>
              </label>
            </div>
            <div className="mt-4">
              <p className="mb-2 text-sm font-medium text-slate-700">Command prefixes</p>
              <div className="grid gap-3 md:grid-cols-2">
                {CHAT_COMMAND_NAMES.map((commandName) => (
                  <label key={commandName} className="space-y-1 text-sm">
                    <span className="text-slate-600">{commandName}</span>
                    <input
                      className="input"
                      type="text"
                      value={chatCommandPrefixMap[commandName]}
                      onChange={(event) => {
                        const nextPrefix = event.target.value;
                        setChatCommandPrefixMap((current) => ({ ...current, [commandName]: nextPrefix }));
                        setChatSettingsMessage('');
                      }}
                    />
                  </label>
                ))}
              </div>
              <p className="mt-2 text-xs text-slate-500">
                Active commands: {CHAT_COMMAND_NAMES.map((commandName) => `${chatCommandPrefixMap[commandName]} (${commandName})`).join(', ')}
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-slate-500">
                {activeCommandExamples.map((example) => <li key={example}>{example}</li>)}
              </ul>
            </div>
            <div className="mt-2 min-h-[1.25rem]">
              {chatSettingsValidationError ? <p className="text-xs text-rose-700">{chatSettingsValidationError}</p> : null}
              {!chatSettingsValidationError && chatSettingsMessage
                ? <p className={`text-xs ${chatSettingsMessage.toLowerCase().includes('saved') ? 'text-emerald-700' : 'text-rose-700'}`}>{chatSettingsMessage}</p>
                : null}
            </div>
            <div className="mt-3">
              <button
                className="rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white"
                onClick={async () => {
                  setChatSettingsMessage('');
                  setChatSettingsValidationError('');
                  const normalizedPath = chatProfileFilePath.trim();
                  if (chatProfilePathRequired && !normalizedPath) {
                    setChatSettingsValidationError('Profile file path is required when profile source is File or Merged.');
                    return;
                  }
                  try {
                    await saveChatSettings({
                      policy: {
                        action_mode: chatActionMode,
                        ask_when_missing: chatAskWhenMissing,
                        announce_actions: chatAnnounceActions,
                        detailed_tool_steps: chatShowDetailedToolSteps,
                        profile_source: chatProfileSource,
                        profile_file_path: normalizedPath,
                        reload_profile_every_message: chatReloadProfileEveryMessage,
                        command_prefix_mode: chatCommandPrefixMode ? 'on' : 'off',
                        command_prefix_map: chatCommandPrefixMap,
                      },
                    });
                    if (chatReloadProfileEveryMessage) {
                      await reloadChatProfile();
                    }
                    setChatSettingsMessage('Chat settings saved. New turns will use this configuration.');
                  } catch (error) {
                    const message = error instanceof Error ? error.message : 'Failed saving chat settings.';
                    setChatSettingsMessage(message);
                  }
                }}
              >
                Save chat settings
              </button>
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Web Search</h2>
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="space-y-4">
              <label className={CHECKBOX_WITH_LABEL_CLASS}>
                <input
                  className={CHECKBOX_INPUT_CLASS}
                  type="checkbox"
                  checked={webSearchEnabled}
                  onChange={(event) => {
                    setWebSearchEnabled(event.target.checked);
                    setWebSearchStatusMessage('');
                  }}
                />
                <span>Enable web search</span>
              </label>
              <div className="grid gap-4 md:grid-cols-3">
                <label className="space-y-1 text-sm">
                  <span className="text-slate-600">Provider</span>
                  <select
                    className="input"
                    value={webSearchProvider}
                    onChange={(event) => {
                      const nextProvider = event.target.value as WebSearchProvider;
                      const capabilities = WEB_SEARCH_PROVIDER_CAPABILITIES[nextProvider];
                      setWebSearchProvider(nextProvider);
                      if (!capabilities.safeSearch) setWebSearchSafeSearch(false);
                      if (!capabilities.recency) setWebSearchRecency('any');
                      setWebSearchStatusMessage('');
                    }}
                  >
                    {WEB_SEARCH_PROVIDER_OPTIONS.map((candidate) => <option key={candidate.value} value={candidate.value}>{candidate.label}</option>)}
                  </select>
                </label>
                {shouldShowSearxngConfigFields(webSearchProvider) ? (
                  <label className="space-y-1 text-sm">
                    <span className="text-slate-600">SearXNG base URL</span>
                    <input
                      className="input"
                      type="text"
                      value={webSearchSearxngBaseUrl}
                      placeholder={WEB_SEARCH_SEARXNG_BASE_URL_DEFAULT}
                      onChange={(event) => {
                        setWebSearchSearxngBaseUrl(event.target.value);
                        setWebSearchStatusMessage('');
                      }}
                      onBlur={(event) => {
                        const normalized = normalizeSearxngBaseUrlInput(event.target.value);
                        setWebSearchSearxngBaseUrl(normalized);
                      }}
                    />
                  </label>
                ) : null}
                <label className="space-y-1 text-sm">
                  <span className="text-slate-600">Mode</span>
                  <select
                    className="input"
                    value={webSearchMode}
                    onChange={(event) => {
                      const nextMode = event.target.value as WebSearchMode;
                      setWebSearchMode(nextMode);
                      applyModeRecommendedPreset(nextMode);
                    }}
                  >
                    {WEB_SEARCH_MODE_OPTIONS.map((candidate) => <option key={candidate.value} value={candidate.value}>{candidate.label}</option>)}
                  </select>
                  <p className="text-xs text-slate-500">{webSearchModeHelperText}</p>
                  <p className="text-xs text-slate-500">This setting controls the number of web-search passes, not model reasoning depth.</p>
                  <button
                    type="button"
                    className="text-xs font-medium text-slate-700 underline underline-offset-2"
                    onClick={() => applyModeRecommendedPreset(webSearchMode, true)}
                  >
                    Use recommended
                  </button>
                </label>
                <label className="space-y-1 text-sm">
                  <span className="text-slate-600">Max results</span>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    value={webSearchMaxResults}
                    onChange={(event) => {
                      setWebSearchMaxResults(event.target.value);
                      setWebSearchMaxResultsOverridden(true);
                    }}
                  />
                  <p className="text-xs text-slate-500">Maximum results requested per search pass before deduplication.</p>
                </label>
                <label className="space-y-1 text-sm">
                  <span className="text-slate-600">Timeout (seconds)</span>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    value={webSearchTimeoutSeconds}
                    onChange={(event) => {
                      setWebSearchTimeoutSeconds(event.target.value);
                      setWebSearchTimeoutOverridden(true);
                    }}
                  />
                  <p className="text-xs text-slate-500">Maximum wait time per provider request; timed-out passes may return no web evidence.</p>
                </label>
                <label className="space-y-1 text-sm">
                  <span className="text-slate-600">Recency</span>
                  <select
                    className="input"
                    value={webSearchRecency}
                    disabled={!webSearchProviderCapabilities.recency}
                    onChange={(event) => setWebSearchRecency(event.target.value as WebSearchRecency)}
                  >
                    {WEB_SEARCH_RECENCY_OPTIONS.map((candidate) => <option key={candidate.value} value={candidate.value}>{candidate.label}</option>)}
                  </select>
                  {!webSearchProviderCapabilities.recency ? <p className="text-xs text-slate-500">Not supported by DuckDuckGo adapter.</p> : null}
                </label>
                <label className="space-y-1 text-sm">
                  <span className="text-slate-600">Domain policy</span>
                  <select className="input" value={webSearchDomainPolicy} onChange={(event) => setWebSearchDomainPolicy(event.target.value as WebSearchDomainPolicy)}>
                    {WEB_SEARCH_DOMAIN_POLICIES.map((candidate) => <option key={candidate.value} value={candidate.value}>{candidate.label}</option>)}
                  </select>
                  <p className="text-xs text-slate-500">{domainPolicyHelperText}</p>
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                {shouldShowSearxngConfigFields(webSearchProvider) ? (
                  <label className={CHECKBOX_WITH_LABEL_CLASS}>
                    <input
                      className={CHECKBOX_INPUT_CLASS}
                      type="checkbox"
                      checked={webSearchSearxngUseHtmlMode}
                      onChange={(event) => {
                        setWebSearchSearxngUseHtmlMode(event.target.checked);
                        setWebSearchStatusMessage('');
                      }}
                    />
                    <span>HTML instead of JSON API</span>
                  </label>
                ) : null}
                <label className={CHECKBOX_WITH_LABEL_CLASS}>
                  <input
                    className={CHECKBOX_INPUT_CLASS}
                    type="checkbox"
                    checked={webSearchSafeSearch}
                    disabled={!webSearchProviderCapabilities.safeSearch}
                    onChange={(event) => setWebSearchSafeSearch(event.target.checked)}
                  />
                  <span>Safe search</span>
                </label>
                {!webSearchProviderCapabilities.safeSearch ? <p className="text-xs text-slate-500">Safe search is not supported by DuckDuckGo adapter.</p> : null}
                <label className={CHECKBOX_WITH_LABEL_CLASS}>
                  <input
                    className={CHECKBOX_INPUT_CLASS}
                    type="checkbox"
                    checked={webSearchSourceCitation}
                    onChange={(event) => setWebSearchSourceCitation(event.target.checked)}
                  />
                  <span>Source citation</span>
                </label>
              </div>
            </div>
            <div className="mt-2 min-h-[1.25rem]">
              {webSearchStatusMessage
                ? <p className={`text-xs ${webSearchStatusMessage.toLowerCase().includes('saved') ? 'text-emerald-700' : 'text-rose-700'}`}>{webSearchStatusMessage}</p>
                : null}
            </div>
            <div className="mt-3">
              <button
                className="rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
                disabled={!canSaveWebSearch}
                onClick={async () => {
                  try {
                    setWebSearchStatusMessage('');
                    const settings = await getAgentSettings();
                    const draftModelForProvider = selectedModelByProvider[provider]?.trim() ?? '';
                    const defaultModelMatchesDraft = settings.default_model.trim() === draftModelForProvider;
                    const defaultProviderMatchesDraft = settings.default_provider === provider;
                    if (!defaultProviderMatchesDraft || !defaultModelMatchesDraft) {
                      setWebSearchStatusMessage(
                        'Select an agent before saving web search settings.',
                      );
                      return;
                    }
                    await saveAgentSettings(buildWebSearchSettingsPayload(settings, {
                      enabled: webSearchEnabled,
                      provider: webSearchProvider,
                      mode: webSearchMode,
                      maxResults: webSearchMaxResults,
                      timeoutSeconds: webSearchTimeoutSeconds,
                      safeSearch: webSearchSafeSearch,
                      recency: webSearchRecency,
                      domainPolicy: webSearchDomainPolicy,
                      sourceCitation: webSearchSourceCitation,
                      searxngBaseUrl: webSearchSearxngBaseUrl,
                      searxngUseHtmlMode: webSearchSearxngUseHtmlMode,
                    }));
                    setWebSearchStatusMessage('Web search settings saved.');
                  } catch (error) {
                    const message = error instanceof Error ? error.message : 'Failed saving web search settings.';
                    setWebSearchStatusMessage(message);
                  }
                }}
              >
                Save web search settings
              </button>
            </div>
          </div>
        </section>
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Custom domain sources</h2>
          <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
            <p className="text-xs text-slate-500">
              Source importance helps ranking when domain policy is set to “Use entire web” or “Use entire web + prioritize listed domains.” In “Use only listed domains,” source importance does not change rank; it only filters by domain.
            </p>
            <form
              className="grid gap-4 md:grid-cols-4"
              onSubmit={async (event) => {
                event.preventDefault();
                const canonicalDomain = newDomain.trim().toLowerCase();
                if (!isValidDomain(canonicalDomain)) {
                  setDomainInputError('Enter a valid domain like google.com (no protocol or path).');
                  return;
                }
                setDomainInputError('');
                try {
                  const normalizedWeight = clampSourceImportance(Number(newWeight) || 1);
                  const created = await savePreferredSource({
                    domain: canonicalDomain,
                    weight: normalizedWeight,
                    enabled: newEnabled,
                  });
                  setPreferredSources((current) => [...current, created]);
                  setPreferredSourcesMessage(`Added ${created.domain}.`);
                  setNewDomain('');
                  setNewWeight('1');
                  setNewEnabled(true);
                } catch (error) {
                  setPreferredSourcesMessage(error instanceof Error ? error.message : 'Failed creating preferred source.');
                }
              }}
            >
              <label className="space-y-1 text-sm">
                <span className="text-slate-600">Domain</span>
                <input
                  className="input"
                  value={newDomain}
                  placeholder="google.com"
                  onChange={(event) => {
                    setNewDomain(event.target.value);
                    setDomainInputError('');
                  }}
                />
                {domainInputError ? <p className="text-xs text-rose-600">{domainInputError}</p> : null}
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-slate-600">Source importance</span>
                <div className="flex items-center gap-3">
                  <input
                    className="h-2 w-full cursor-pointer"
                    type="range"
                    min={1}
                    max={5}
                    step={1}
                    value={newWeight}
                    aria-label="Source importance"
                    style={{ accentColor: getSourceImportanceColor(Number(newWeight) || 1) }}
                    onChange={(event) => setNewWeight(event.target.value)}
                  />
                  <span className="min-w-[7rem] text-xs font-medium text-slate-700">
                    {getSourceImportanceLabel(Number(newWeight) || 1)}
                  </span>
                </div>
              </label>
              <div className="flex items-end">
                <label className={CHECKBOX_WITH_LABEL_CLASS}>
                  <input className={CHECKBOX_INPUT_CLASS} type="checkbox" checked={newEnabled} onChange={(event) => setNewEnabled(event.target.checked)} />
                  <span>Enabled</span>
                </label>
              </div>
              <div className="flex items-end">
                <button className="rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white" type="submit">Add source</button>
              </div>
            </form>

            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-slate-600">
                    <th className="py-2 pr-3">Domain</th>
                    <th className="py-2 pr-3">Source importance</th>
                    <th className="py-2 pr-3">Enabled</th>
                    <th className="py-2 pr-3">Controls</th>
                  </tr>
                </thead>
                <tbody>
                  {preferredSources.map((source) => {
                    const isEditing = editingSourceId === source.id;
                    return (
                      <tr key={source.id} className="border-b border-slate-100">
                        <td className="py-2 pr-3">
                          {isEditing ? (
                            <input className="input" value={editingDomain} onChange={(event) => setEditingDomain(event.target.value)} />
                          ) : source.domain}
                        </td>
                        <td className="py-2 pr-3">
                          {isEditing ? (
                            <div className="flex items-center gap-3">
                              <input
                                className="h-2 w-full cursor-pointer"
                                type="range"
                                min={1}
                                max={5}
                                step={1}
                                value={editingWeight}
                                aria-label="Source importance"
                                style={{ accentColor: getSourceImportanceColor(Number(editingWeight) || 1) }}
                                onChange={(event) => setEditingWeight(event.target.value)}
                              />
                              <span className="min-w-[7rem] text-xs font-medium text-slate-700">
                                {getSourceImportanceLabel(Number(editingWeight) || 1)}
                              </span>
                            </div>
                          ) : (
                            <span title={`Importance level ${source.weight}`}>
                              {getSourceImportanceLabel(source.weight)}
                              <span className="ml-1 text-xs text-slate-400">({source.weight})</span>
                            </span>
                          )}
                        </td>
                        <td className="py-2 pr-3">
                          {isEditing ? (
                            <input className="h-4 w-4" type="checkbox" checked={editingEnabled} onChange={(event) => setEditingEnabled(event.target.checked)} />
                          ) : (source.enabled ? 'Yes' : 'No')}
                        </td>
                        <td className="py-2 pr-3">
                          <div className="flex gap-2">
                            {isEditing ? (
                              <>
                                <button
                                  className="rounded-md border border-slate-300 px-2 py-1 text-xs"
                                  onClick={async () => {
                                    const canonicalDomain = editingDomain.trim().toLowerCase();
                                    if (!isValidDomain(canonicalDomain)) {
                                      setPreferredSourcesMessage('Domain must be valid, such as google.com.');
                                      return;
                                    }
                                    try {
                                      const normalizedWeight = clampSourceImportance(Number(editingWeight) || 1);
                                      const updated = await savePreferredSourceById(source.id, {
                                        domain: canonicalDomain,
                                        weight: normalizedWeight,
                                        enabled: editingEnabled,
                                      });
                                      setPreferredSources((current) => current.map((entry) => (entry.id === source.id ? updated : entry)));
                                      setEditingSourceId(null);
                                      setPreferredSourcesMessage(`Updated ${updated.domain}.`);
                                    } catch (error) {
                                      setPreferredSourcesMessage(error instanceof Error ? error.message : 'Failed updating preferred source.');
                                    }
                                  }}
                                >
                                  Save
                                </button>
                                <button className="rounded-md border border-slate-300 px-2 py-1 text-xs" onClick={() => setEditingSourceId(null)}>Cancel</button>
                              </>
                            ) : (
                              <>
                                <button
                                  className="rounded-md border border-slate-300 px-2 py-1 text-xs"
                                  onClick={() => {
                                    setEditingSourceId(source.id);
                                    setEditingDomain(source.domain);
                                    setEditingWeight(String(source.weight));
                                    setEditingEnabled(source.enabled);
                                  }}
                                >
                                  Edit
                                </button>
                                <button
                                  className="rounded-md border border-rose-300 px-2 py-1 text-xs text-rose-700"
                                  onClick={async () => {
                                    try {
                                      await deletePreferredSource(source.id);
                                      setPreferredSources((current) => current.filter((entry) => entry.id !== source.id));
                                      setPreferredSourcesMessage(`Deleted ${source.domain}.`);
                                    } catch (error) {
                                      setPreferredSourcesMessage(error instanceof Error ? error.message : 'Failed deleting preferred source.');
                                    }
                                  }}
                                >
                                  Delete
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {preferredSources.length === 0 ? (
                    <tr>
                      <td className="py-2 text-slate-500" colSpan={4}>No preferred sources yet.</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
            {preferredSourcesMessage ? (
              <p className={`text-xs ${preferredSourcesMessage.toLowerCase().startsWith('failed') || preferredSourcesMessage.toLowerCase().startsWith('domain must') ? 'text-rose-700' : 'text-emerald-700'}`}>{preferredSourcesMessage}</p>
            ) : null}
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
                          setCredentialFeedbackMessage(`${providerLabel(candidate)} credential saved securely.`);
                        } catch (error) {
                          setCredentialFeedbackMessage(error instanceof Error ? error.message : 'Failed saving credential.');
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
            {credentialFeedbackMessage ? (
              <p className={`mt-3 text-xs ${credentialFeedbackMessage.toLowerCase().includes('saved securely') ? 'text-emerald-700' : 'text-rose-700'}`}>{credentialFeedbackMessage}</p>
            ) : null}
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
                    setLocalRuntimeFeedbackMessage('');
                    invalidateAgentOllamaModelsForBaseUrl(event.target.value.trim() || LOCAL_BASE_URL_DEFAULT);
                  }}
                  onBlur={(event) => {
                    const normalized = normalizeLocalBaseUrl(event.target.value);
                    setLocalBaseUrl(normalized);
                    invalidateAgentOllamaModelsForBaseUrl(normalized);
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
                    setAgentOllamaRuntimeModelDraft(nextLocalModel);
                    setAgentSelectedModel('ollama', nextLocalModel);
                    if (provider === 'ollama') setAgentSelectedModel(provider, nextLocalModel);
                    setLocalSaveMessage('');
                    setLocalRuntimeFeedbackMessage('');
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
            {localRuntimeFeedbackMessage ? <p className="mt-2 text-xs text-rose-700">{localRuntimeFeedbackMessage}</p> : null}
            <div className="mt-3 flex gap-2">
              <button
                className="rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
                disabled={!canSaveLocalDefaults}
                onClick={async () => {
                  try {
                    const settings = await getAgentSettings();
                    const canonicalBaseUrl = normalizeLocalBaseUrl(localBaseUrl);
                    const persistedModel = settings.generation_params?.local_connection?.model?.trim() ?? '';
                    const canonicalModel = localModelValue.trim() || persistedModel;
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
                      ...(settings.default_provider === 'ollama' && canonicalModel ? { default_model: canonicalModel } : {}),
                    });
                    setSavedLocalRuntime({ baseUrl: canonicalBaseUrl, model: canonicalModel });
                    setAgentOllamaRuntimeModelDraft(canonicalModel);
                    setAgentSelectedModel('ollama', canonicalModel);
                    if (provider === 'ollama') setAgentSelectedModel(provider, canonicalModel);
                    setLocalSaveMessage('Local settings saved.');
                    setLocalRuntimeFeedbackMessage('');
                  } catch (error) {
                    setLocalRuntimeFeedbackMessage(error instanceof Error ? error.message : 'Failed saving local model settings.');
                  }
                }}
              >
                Save local settings
              </button>
              <button
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm"
                onClick={() => {
                  if (provider !== 'ollama') setProvider('ollama');
                  void refreshModels('ollama', true, normalizeLocalBaseUrl(localBaseUrl));
                }}
              >
                Refresh models
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
                  setActivityLogFeedbackMessage('Activity log cleared.');
                } catch (error) {
                  setActivityLogFeedbackMessage(error instanceof Error ? error.message : 'Failed clearing activity log.');
                }
              }}
            >
              Clear log
            </button>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            {activityLogFeedbackMessage ? (
              <p className={`mb-3 text-xs ${activityLogFeedbackMessage.toLowerCase().includes('cleared') ? 'text-emerald-700' : 'text-rose-700'}`}>{activityLogFeedbackMessage}</p>
            ) : null}
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

      </div>
    </div>
  );
}
