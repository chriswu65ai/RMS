import type { AgentSettings, WebSearchDomainPolicy, WebSearchMode, WebSearchProvider, WebSearchRecency } from './types';
import { normalizeEndpointUrl } from './urlNormalization';

export const WEB_SEARCH_MAX_RESULTS_DEFAULT = 6;
export const WEB_SEARCH_TIMEOUT_MS_DEFAULT = 10_000;
export const WEB_SEARCH_SOURCE_CITATION_DEFAULT = false;
export const WEB_SEARCH_SAFE_SEARCH_DEFAULT = false;
export const WEB_SEARCH_SEARXNG_BASE_URL_DEFAULT = 'http://localhost:8080';
export const WEB_SEARCH_SEARXNG_USE_JSON_API_DEFAULT = true;
export const WEB_SEARCH_SEARXNG_USE_HTML_MODE_DEFAULT = !WEB_SEARCH_SEARXNG_USE_JSON_API_DEFAULT;
export const WEB_SEARCH_PROVIDER_OPTIONS: Array<{ value: WebSearchProvider; label: string }> = [
  { value: 'duckduckgo', label: 'DuckDuckGo' },
  { value: 'searxng', label: 'SearXNG' },
];
export const WEB_SEARCH_MODE_OPTIONS: Array<{ value: WebSearchMode; label: string; helper: string }> = [
  { value: 'single', label: 'Single search', helper: 'Run one web_search tool call.' },
  { value: 'deep', label: 'Extended search', helper: 'Allow up to three web_search tool calls for broader coverage.' },
];

export const WEB_SEARCH_MODE_RECOMMENDED_PRESETS: Record<WebSearchMode, { maxResults: number; timeoutSeconds: number }> = {
  single: { maxResults: 6, timeoutSeconds: 10 },
  deep: { maxResults: 10, timeoutSeconds: 18 },
};

export const WEB_SEARCH_PROVIDER_CAPABILITIES: Record<WebSearchProvider, { recency: boolean; safeSearch: boolean }> = {
  duckduckgo: { recency: false, safeSearch: false },
  searxng: { recency: true, safeSearch: true },
};

const normalizePositiveInteger = (value: string, fallback: number) => Math.max(1, Number(value) || fallback);
export const getWebSearchSourceCitationDefault = (sourceCitation: boolean | undefined) => sourceCitation ?? WEB_SEARCH_SOURCE_CITATION_DEFAULT;
export const shouldShowSearxngConfigFields = (provider: WebSearchProvider) => provider === 'searxng';
export const convertTimeoutMsToSeconds = (timeoutMs: number | undefined) => Math.max(1, Math.round((timeoutMs ?? WEB_SEARCH_TIMEOUT_MS_DEFAULT) / 1000));
export const convertTimeoutSecondsToMs = (timeoutSeconds: string) => normalizePositiveInteger(timeoutSeconds, WEB_SEARCH_TIMEOUT_MS_DEFAULT / 1000) * 1000;
export const getRecommendedPresetForMode = (mode: WebSearchMode) => WEB_SEARCH_MODE_RECOMMENDED_PRESETS[mode];

export const buildWebSearchSettingsPayload = (
  settings: AgentSettings,
  draft: {
    enabled: boolean;
    provider: WebSearchProvider;
    mode: WebSearchMode;
    maxResults: string;
    timeoutSeconds: string;
    safeSearch: boolean;
    recency: WebSearchRecency;
    domainPolicy: WebSearchDomainPolicy;
    sourceCitation: boolean;
    searxngBaseUrl: string;
    searxngUseHtmlMode: boolean;
  },
): AgentSettings => {
  const providerConfig = draft.provider === 'searxng'
    ? {
      searxng: {
        base_url: normalizeEndpointUrl(draft.searxngBaseUrl, WEB_SEARCH_SEARXNG_BASE_URL_DEFAULT),
        use_json_api: !draft.searxngUseHtmlMode,
      },
    }
    : undefined;
  return {
    ...settings,
    generation_params: {
      ...(settings.generation_params ?? {}),
      web_search: {
        enabled: draft.enabled,
        provider: draft.provider,
        ...(providerConfig ? { provider_config: providerConfig } : {}),
        mode: draft.mode,
        max_results: normalizePositiveInteger(draft.maxResults, WEB_SEARCH_MAX_RESULTS_DEFAULT),
        timeout_ms: convertTimeoutSecondsToMs(draft.timeoutSeconds),
        safe_search: draft.safeSearch,
        recency: draft.recency,
        domain_policy: draft.domainPolicy,
        source_citation: draft.sourceCitation,
      },
    },
  };
};
