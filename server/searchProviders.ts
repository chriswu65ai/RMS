export type WebSearchProvider = 'duckduckgo' | 'searxng' | 'google';

export type SearchPolicy = 'open_web' | 'prefer_list' | 'only_list';

export type SearchMode = 'single' | 'deep';

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
  provider: WebSearchProvider;
  score?: number;
  published_at?: string;
};

export type SearchOptions = {
  mode?: SearchMode;
  policy?: SearchPolicy;
  resultCap?: number;
  timeoutMs?: number;
  domainList?: string[];
  domainBoost?: Record<string, number>;
  safeSearch?: boolean;
  recency?: 'any' | '7d' | '30d' | '365d';
  providerConfig?: {
    searxng?: {
      base_url?: string;
      use_json_api?: boolean;
    };
  };
};

export interface SearchProviderAdapter {
  search(query: string, options?: SearchOptions, signal?: AbortSignal): Promise<SearchResult[]>;
}

const DEFAULT_RESULT_CAP = 10;
const MAX_RESULT_CAP = 50;

const sanitizeResultCap = (requestedCap?: number) => {
  if (!Number.isFinite(requestedCap)) return DEFAULT_RESULT_CAP;
  const normalized = Math.floor(requestedCap ?? DEFAULT_RESULT_CAP);
  if (normalized <= 0) return DEFAULT_RESULT_CAP;
  return Math.min(normalized, MAX_RESULT_CAP);
};

const canonicalizeUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLowerCase();
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (key.toLowerCase().startsWith('utm_')) {
        parsed.searchParams.delete(key);
      }
    }
    return parsed.toString();
  } catch {
    return url.trim();
  }
};

const dedupeByCanonicalUrl = (results: SearchResult[]): SearchResult[] => {
  const seen = new Set<string>();
  const deduped: SearchResult[] = [];
  for (const result of results) {
    const canonicalUrl = canonicalizeUrl(result.url);
    if (!canonicalUrl || seen.has(canonicalUrl)) continue;
    seen.add(canonicalUrl);
    deduped.push({ ...result, url: canonicalUrl });
  }
  return deduped;
};

const applyDomainPolicy = (results: SearchResult[], policy: SearchPolicy, domainList: string[] = []): SearchResult[] => {
  if (domainList.length === 0 || policy === 'open_web') return results;
  const allowedDomains = new Set(domainList.map((entry) => entry.trim().toLowerCase()).filter(Boolean));
  const allowedDomainList = Array.from(allowedDomains);

  return results.filter((result) => {
    try {
      const hostname = new URL(result.url).hostname.toLowerCase();
      const matched = allowedDomainList.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
      return policy === 'only_list' ? matched : true;
    } catch {
      return policy !== 'only_list';
    }
  });
};

const applyDomainBoosts = (results: SearchResult[], boostMap: Record<string, number> = {}): SearchResult[] => {
  if (Object.keys(boostMap).length === 0) return results;
  const normalizedBoosts = new Map<string, number>(
    Object.entries(boostMap)
      .map(([domain, value]) => [domain.trim().toLowerCase(), value] as const)
      .filter(([domain, value]) => domain.length > 0 && Number.isFinite(value)),
  );

  return results
    .map((result, index) => {
      let boost = 0;
      try {
        const hostname = new URL(result.url).hostname.toLowerCase();
        for (const [domain, value] of Array.from(normalizedBoosts.entries())) {
          if (hostname === domain || hostname.endsWith(`.${domain}`)) {
            boost = Math.max(boost, value);
          }
        }
      } catch {
        // ignore unparsable urls
      }
      return {
        ...result,
        score: (result.score ?? Math.max(0, 1 - (index * 0.01))) + boost,
      };
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
};

const enforceResultCap = (results: SearchResult[], resultCap?: number): SearchResult[] => results.slice(0, sanitizeResultCap(resultCap));



const SEARXNG_BASE_URL_DEFAULT = 'http://localhost:8080';
const SEARXNG_USE_JSON_API_DEFAULT = true;

const normalizeSearxngBaseUrl = (value?: string): string => {
  if (typeof value !== 'string' || !value.trim()) return SEARXNG_BASE_URL_DEFAULT;
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return SEARXNG_BASE_URL_DEFAULT;
  }
};

const mapRecencyToSearxngTimeRange = (recency?: SearchOptions['recency']): string | null => {
  if (recency === '7d') return 'week';
  if (recency === '30d') return 'month';
  if (recency === '365d') return 'year';
  return null;
};

const decodeHtml = (value: string): string => value
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&#x2F;/g, '/');

class DuckDuckGoSearchAdapter implements SearchProviderAdapter {
  async search(query: string, options: SearchOptions = {}, signal?: AbortSignal): Promise<SearchResult[]> {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return [];
    // DuckDuckGo's HTML endpoint does not provide stable, documented controls for
    // safe-search and recency filtering. We accept these options for cross-provider
    // parity and intentionally fall back to provider defaults when supplied.
    void options.safeSearch;
    void options.recency;

    const response = await fetch(`https://duckduckgo.com/html/?q=${encodeURIComponent(trimmedQuery)}`, {
      method: 'GET',
      signal,
      headers: {
        Accept: 'text/html',
      },
    });

    if (!response.ok) throw new Error('DuckDuckGo search failed.');
    const html = await response.text();

    const matches = Array.from(html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g));

    const rawResults: SearchResult[] = matches.map((match, index) => ({
      title: decodeHtml(match[2].replace(/<[^>]+>/g, '').trim()),
      url: decodeHtml(match[1].trim()),
      snippet: decodeHtml(match[3].replace(/<[^>]+>/g, '').trim()),
      provider: 'duckduckgo',
      score: Math.max(0, 1 - (index * 0.01)),
    }));

    const policy = options.policy ?? 'open_web';
    const deduped = dedupeByCanonicalUrl(rawResults);
    const domainFiltered = applyDomainPolicy(deduped, policy, options.domainList);
    const boosted = applyDomainBoosts(
      domainFiltered,
      policy === 'open_web' || policy === 'prefer_list' ? options.domainBoost : undefined,
    );
    return enforceResultCap(boosted, options.resultCap);
  }
}

class SearxngSearchAdapter implements SearchProviderAdapter {
  async search(query: string, options: SearchOptions = {}, signal?: AbortSignal): Promise<SearchResult[]> {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return [];

    const baseUrl = normalizeSearxngBaseUrl(options.providerConfig?.searxng?.base_url);
    const useJsonApi = options.providerConfig?.searxng?.use_json_api ?? SEARXNG_USE_JSON_API_DEFAULT;
    const requestUrl = new URL('/search', `${baseUrl}/`);
    requestUrl.searchParams.set('q', trimmedQuery);
    requestUrl.searchParams.set('safesearch', options.safeSearch === false ? '0' : '1');
    if (useJsonApi) requestUrl.searchParams.set('format', 'json');
    const timeRange = mapRecencyToSearxngTimeRange(options.recency);
    if (timeRange) requestUrl.searchParams.set('time_range', timeRange);

    const response = await fetch(requestUrl, {
      method: 'GET',
      signal,
      headers: {
        Accept: useJsonApi ? 'application/json' : 'text/html',
      },
    });

    if (!response.ok) throw new Error('SearXNG search failed.');

    let rawResults: SearchResult[] = [];
    if (useJsonApi) {
      const payload = await response.json() as {
        results?: Array<{
          title?: string;
          url?: string;
          content?: string;
          publishedDate?: string;
        }>;
      };
      rawResults = (payload.results ?? []).map((result, index) => ({
        title: (result.title ?? '').trim() || (result.url ?? '').trim(),
        url: (result.url ?? '').trim(),
        snippet: (result.content ?? '').trim(),
        provider: 'searxng' as const,
        score: Math.max(0, 1 - (index * 0.01)),
        ...(result.publishedDate ? { published_at: result.publishedDate } : {}),
      })).filter((result) => Boolean(result.url));
    } else {
      const html = await response.text();
      const matches = Array.from(html.matchAll(/<h3[^>]*class="[^"]*result_header[^"]*"[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<p[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/p>/g));
      rawResults = matches.map((match, index) => ({
        title: decodeHtml(match[2].replace(/<[^>]+>/g, '').trim()),
        url: decodeHtml(match[1].trim()),
        snippet: decodeHtml(match[3].replace(/<[^>]+>/g, '').trim()),
        provider: 'searxng' as const,
        score: Math.max(0, 1 - (index * 0.01)),
      }));
    }

    const policy = options.policy ?? 'open_web';
    const deduped = dedupeByCanonicalUrl(rawResults);
    const domainFiltered = applyDomainPolicy(deduped, policy, options.domainList);
    const boosted = applyDomainBoosts(
      domainFiltered,
      policy === 'open_web' || policy === 'prefer_list' ? options.domainBoost : undefined,
    );
    return enforceResultCap(boosted, options.resultCap);
  }
}

class UnimplementedSearchAdapter implements SearchProviderAdapter {
  constructor(private readonly provider: Exclude<WebSearchProvider, 'duckduckgo'>) {}

  async search(): Promise<SearchResult[]> {
    throw new Error(`${this.provider} search adapter is not implemented.`);
  }
}

export const searchProviderRegistry: Record<WebSearchProvider, SearchProviderAdapter> = {
  duckduckgo: new DuckDuckGoSearchAdapter(),
  searxng: new SearxngSearchAdapter(),
  google: new UnimplementedSearchAdapter('google'),
};

export const searchProviderPlaceholders: ReadonlyArray<Exclude<WebSearchProvider, 'duckduckgo' | 'searxng'>> = ['google'];

export const searchUtils = {
  canonicalizeUrl,
  dedupeByCanonicalUrl,
  enforceResultCap,
  applyDomainPolicy,
  applyDomainBoosts,
};
