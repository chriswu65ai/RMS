import { appendSearchDiagnostic } from './searchLogging';
import { providerRegistry, type AgentProvider } from './agentProviders';
import { searchProviderRegistry, searchUtils, type SearchResult } from './searchProviders';

type WebSearchProvider = 'duckduckgo' | 'searxng';
type WebSearchMode = 'single' | 'deep';
type WebSearchRecency = 'any' | '7d' | '30d' | '365d';
type WebSearchDomainPolicy = 'open_web' | 'prefer_list' | 'only_list';

type WebSearchToolArgs = {
  query: string;
  mode: WebSearchMode;
  max_results: number;
  recency: WebSearchRecency;
  safe_search: boolean;
  domain_policy: WebSearchDomainPolicy;
  domain_list: string[];
  provider: WebSearchProvider;
  provider_config?: {
    searxng?: {
      base_url: string;
      use_json_api: boolean;
    };
  };
};

type WebSearchSettings = {
  enabled: boolean;
  provider: WebSearchProvider;
  mode: WebSearchMode;
  max_results: number;
  timeout_ms: number;
  safe_search: boolean;
  recency: WebSearchRecency;
  domain_policy: WebSearchDomainPolicy;
  source_citation: boolean;
  provider_config?: {
    searxng?: {
      base_url: string;
      use_json_api: boolean;
    };
  };
};

type PreferredSource = { domain: string; weight: number };

type ToolCallRecord = {
  name: 'web_search';
  arguments: WebSearchToolArgs;
  sources: SearchResult[];
};

export type AgentToolOrchestrationResult = {
  toolCalls: ToolCallRecord[];
  allSources: SearchResult[];
  queryCount: number;
  sourceCount: number;
  mode: WebSearchMode;
  provider: WebSearchProvider;
  citationRequired: boolean;
  consumedInputText: string;
};

const supportsToolOrchestration = (provider: AgentProvider, _model: string) => provider !== 'ollama';

const extractJsonObject = (text: string): Record<string, unknown> | null => {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const toPositiveInt = (value: unknown, fallback: number) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
};

const normalizeToolArgs = (raw: Record<string, unknown>, settings: WebSearchSettings, domainList: string[]): WebSearchToolArgs => {
  const query = typeof raw.query === 'string' && raw.query.trim() ? raw.query.trim() : '';
  if (!query) throw new Error('web_search tool call is missing a query.');
  return {
    query,
    mode: raw.mode === 'deep' ? 'deep' : settings.mode,
    max_results: toPositiveInt(raw.max_results, settings.max_results),
    recency: raw.recency === '7d' || raw.recency === '30d' || raw.recency === '365d' || raw.recency === 'any' ? raw.recency : settings.recency,
    safe_search: typeof raw.safe_search === 'boolean' ? raw.safe_search : settings.safe_search,
    domain_policy: raw.domain_policy === 'prefer_list' || raw.domain_policy === 'only_list' || raw.domain_policy === 'open_web'
      ? raw.domain_policy
      : settings.domain_policy,
    domain_list: Array.isArray(raw.domain_list)
      ? raw.domain_list.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim().toLowerCase())
      : domainList,
    provider: raw.provider === 'searxng' ? 'searxng' : settings.provider,
    provider_config: settings.provider_config,
  };
};

export const runAgentToolOrchestration = async ({
  provider,
  model,
  inputText,
  apiKey,
  baseUrl,
  settings,
  preferredSources,
  signal,
}: {
  provider: AgentProvider;
  model: string;
  inputText: string;
  apiKey: string;
  baseUrl?: string;
  settings: WebSearchSettings;
  preferredSources: PreferredSource[];
  signal?: AbortSignal;
}): Promise<AgentToolOrchestrationResult> => {
  if (!supportsToolOrchestration(provider, model)) {
    throw new Error(`Provider/model does not support tool mode: ${provider}/${model}.`);
  }
  const maxToolCalls = settings.mode === 'deep' ? 2 : 1;
  const domainList = preferredSources.map((item) => item.domain.toLowerCase());
  const domainBoost = preferredSources.reduce<Record<string, number>>((acc, item) => {
    acc[item.domain.toLowerCase()] = item.weight;
    return acc;
  }, {});
  const toolCalls: ToolCallRecord[] = [];
  const transcript: string[] = [];

  for (let i = 0; i < maxToolCalls; i += 1) {
    const plannerPrompt = [
      'You may call exactly one tool named web_search before answering.',
      'Return ONLY JSON with one of these shapes:',
      '{"type":"tool_call","name":"web_search","arguments":{"query":"...","mode":"single|deep","max_results":number,"recency":"any|7d|30d|365d","safe_search":boolean,"domain_policy":"open_web|prefer_list|only_list","domain_list":["..."],"provider":"duckduckgo|searxng","provider_config":{}}}',
      '{"type":"final","answer":"..."}',
      `User request:\n${inputText}`,
      transcript.length > 0 ? `Prior tool transcript:\n${transcript.join('\n\n')}` : '',
    ].filter(Boolean).join('\n\n');

    const plannerResult = await providerRegistry[provider].generate({
      model,
      inputText: plannerPrompt,
      generationParams: baseUrl ? { baseUrl } : undefined,
    }, apiKey, signal);
    const parsed = extractJsonObject(plannerResult.outputText);
    if (!parsed) throw new Error('Tool orchestration failed: model did not return valid JSON.');
    if (parsed.type === 'final') break;
    if (parsed.type !== 'tool_call' || parsed.name !== 'web_search' || !parsed.arguments || typeof parsed.arguments !== 'object') {
      throw new Error('Tool orchestration failed: model returned an invalid tool request.');
    }
    const args = normalizeToolArgs(parsed.arguments as Record<string, unknown>, settings, domainList);
    const searchTimeoutController = new AbortController();
    const timeoutId = setTimeout(() => searchTimeoutController.abort(), settings.timeout_ms);
    signal?.addEventListener('abort', () => searchTimeoutController.abort(), { once: true });
    try {
      const startedAt = Date.now();
      const results = await searchProviderRegistry[args.provider].search(args.query, {
        mode: args.mode,
        policy: args.domain_policy,
        resultCap: args.max_results,
        timeoutMs: settings.timeout_ms,
        safeSearch: args.safe_search,
        recency: args.recency,
        domainList: args.domain_list,
        domainBoost: args.domain_policy === 'open_web' || args.domain_policy === 'prefer_list' ? domainBoost : undefined,
        providerConfig: args.provider_config,
      }, searchTimeoutController.signal);
      appendSearchDiagnostic({ provider: args.provider, mode: args.mode, query: args.query, resultCount: results.length, latencyMs: Date.now() - startedAt });
      if (results.length === 0) throw new Error('web_search returned no sources.');
      toolCalls.push({ name: 'web_search', arguments: args, sources: results });
      transcript.push(`tool_call_${i + 1}: query="${args.query}" returned ${results.length} results.`);
    } catch (error) {
      appendSearchDiagnostic({ provider: args.provider, mode: args.mode, query: args.query, resultCount: 0, latencyMs: 0, status: 'error', error });
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  if (toolCalls.length === 0) {
    throw new Error('Web search enabled, but no tool calls were executed.');
  }

  const deduped = searchUtils.dedupeByCanonicalUrl(toolCalls.flatMap((call) => call.sources));
  const finalCap = settings.mode === 'deep' ? Math.min(8, Math.max(1, settings.max_results)) : Math.max(1, settings.max_results);
  const allSources = searchUtils.enforceResultCap(deduped, finalCap);
  if (allSources.length === 0) {
    throw new Error('Web search enabled, but no usable sources were returned.');
  }

  const consumedInputText = [
    inputText,
    '',
    '<tool_outputs>',
    ...allSources.map((source, index) => `${index + 1}. title="${source.title}" | url=${source.url} | snippet="${source.snippet}"`),
    '</tool_outputs>',
    settings.source_citation
      ? 'Citation mode is REQUIRED. Every factual claim from tool outputs must include [n] indices matching tool_outputs.'
      : 'Tool outputs are available for grounding. Citation brackets are optional.',
  ].join('\n');

  return {
    toolCalls,
    allSources,
    queryCount: toolCalls.length,
    sourceCount: allSources.length,
    mode: settings.mode,
    provider: settings.provider,
    citationRequired: settings.source_citation,
    consumedInputText,
  };
};
