import type { AgentSettings, WebSearchDomainPolicy, WebSearchMode, WebSearchProvider, WebSearchRecency } from './types';
import { normalizeEndpointUrl } from './urlNormalization';

export const WEB_SEARCH_MAX_RESULTS_DEFAULT = 5;
export const WEB_SEARCH_TIMEOUT_MS_DEFAULT = 5000;
export const WEB_SEARCH_SOURCE_CITATION_DEFAULT = false;
export const WEB_SEARCH_SEARXNG_BASE_URL_DEFAULT = 'http://localhost:8080';
export const WEB_SEARCH_SEARXNG_USE_JSON_API_DEFAULT = true;
export const WEB_SEARCH_SEARXNG_USE_HTML_MODE_DEFAULT = !WEB_SEARCH_SEARXNG_USE_JSON_API_DEFAULT;
export const WEB_SEARCH_PROVIDER_OPTIONS: Array<{ value: WebSearchProvider; label: string }> = [
  { value: 'duckduckgo', label: 'DuckDuckGo' },
  { value: 'searxng', label: 'SearXNG' },
];
export const WEB_SEARCH_MODE_OPTIONS: Array<{ value: WebSearchMode; label: string; helper: string }> = [
  { value: 'single', label: 'Single search', helper: 'Run one web_search tool call.' },
  { value: 'deep', label: 'Extended search', helper: 'Allow up to two web_search tool calls for broader coverage.' },
];

const normalizePositiveInteger = (value: string, fallback: number) => Math.max(1, Number(value) || fallback);
export const getWebSearchSourceCitationDefault = (sourceCitation: boolean | undefined) => sourceCitation ?? WEB_SEARCH_SOURCE_CITATION_DEFAULT;
export const shouldShowSearxngConfigFields = (provider: WebSearchProvider) => provider === 'searxng';

export const buildWebSearchSettingsPayload = (
  settings: AgentSettings,
  draft: {
    enabled: boolean;
    provider: WebSearchProvider;
    mode: WebSearchMode;
    maxResults: string;
    timeoutMs: string;
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
        timeout_ms: normalizePositiveInteger(draft.timeoutMs, WEB_SEARCH_TIMEOUT_MS_DEFAULT),
        safe_search: draft.safeSearch,
        recency: draft.recency,
        domain_policy: draft.domainPolicy,
        source_citation: draft.sourceCitation,
      },
    },
  };
};
