import type { AgentSettings, WebSearchDomainPolicy, WebSearchMode, WebSearchRecency } from './types';

export const WEB_SEARCH_MAX_RESULTS_DEFAULT = 5;
export const WEB_SEARCH_TIMEOUT_MS_DEFAULT = 5000;
export const WEB_SEARCH_SOURCE_CITATION_DEFAULT = false;

const normalizePositiveInteger = (value: string, fallback: number) => Math.max(1, Number(value) || fallback);
export const getWebSearchSourceCitationDefault = (sourceCitation: boolean | undefined) => sourceCitation ?? WEB_SEARCH_SOURCE_CITATION_DEFAULT;

export const buildWebSearchSettingsPayload = (
  settings: AgentSettings,
  draft: {
    enabled: boolean;
    provider: 'duckduckgo';
    mode: WebSearchMode;
    maxResults: string;
    timeoutMs: string;
    safeSearch: boolean;
    recency: WebSearchRecency;
    domainPolicy: WebSearchDomainPolicy;
    sourceCitation: boolean;
  },
): AgentSettings => ({
  ...settings,
  generation_params: {
    ...(settings.generation_params ?? {}),
    web_search: {
      enabled: draft.enabled,
      provider: draft.provider,
      mode: draft.mode,
      max_results: normalizePositiveInteger(draft.maxResults, WEB_SEARCH_MAX_RESULTS_DEFAULT),
      timeout_ms: normalizePositiveInteger(draft.timeoutMs, WEB_SEARCH_TIMEOUT_MS_DEFAULT),
      safe_search: draft.safeSearch,
      recency: draft.recency,
      domain_policy: draft.domainPolicy,
      source_citation: draft.sourceCitation,
    },
  },
});
