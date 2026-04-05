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

const normalizeDomainList = (domainList: string[] = []): string[] => {
  const unique = new Set(
    domainList
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
  return Array.from(unique);
};

const buildOnlyListQueries = (query: string, domainList: string[] = []): string[] => {
  const normalizedDomains = normalizeDomainList(domainList);
  if (normalizedDomains.length === 0) return [query];

  const constrainedGroup = normalizedDomains.map((domain) => `site:${domain}`).join(' OR ');
  const groupedConstraintQuery = `${query} (${constrainedGroup})`;
  const perDomainQueries = normalizedDomains.map((domain) => `${query} site:${domain}`);

  return [groupedConstraintQuery, ...perDomainQueries];
};



const SEARXNG_BASE_URL_DEFAULT = 'http://localhost:8080';
const SEARXNG_USE_JSON_API_DEFAULT = true;

const normalizeSearxngBaseUrl = (value?: string): string => {
  if (typeof value !== 'string' || !value.trim()) return SEARXNG_BASE_URL_DEFAULT;
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    parsed.search = '';
    parsed.hash = '';
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    if (parsed.pathname === '/search' || parsed.pathname.endsWith('/search')) {
      parsed.pathname = parsed.pathname.slice(0, -('/search'.length)) || '/';
    }
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

const normalizeDuckDuckGoResultUrl = (rawHref: string): string => {
  const decodedHref = decodeHtml(rawHref).trim();
  if (!decodedHref) return decodedHref;

  let parsedHref: URL;
  try {
    parsedHref = new URL(decodedHref, 'https://duckduckgo.com');
  } catch {
    return decodedHref;
  }

  if (parsedHref.hostname !== 'duckduckgo.com' || !parsedHref.pathname.startsWith('/l/')) {
    return decodedHref;
  }

  const encodedDestination = parsedHref.searchParams.get('uddg');
  if (!encodedDestination) return decodedHref;

  let decodedDestination: string;
  try {
    decodedDestination = decodeURIComponent(encodedDestination);
  } catch {
    return decodedHref;
  }

  try {
    const destinationUrl = new URL(decodedDestination);
    if (destinationUrl.protocol === 'http:' || destinationUrl.protocol === 'https:') {
      return destinationUrl.toString();
    }
  } catch {
    return decodedHref;
  }

  return decodedHref;
};

const stripHtmlTags = (value: string): string => value
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const extractSearxngHtmlResultBlocks = (html: string): string[] => {
  const blockPatterns = [
    /<article\b[^>]*class="[^"]*\bresult\b[^"]*"[^>]*>[\s\S]*?<\/article>/gi,
    /<li\b[^>]*class="[^"]*\bresult\b[^"]*"[^>]*>[\s\S]*?<\/li>/gi,
    /<div\b[^>]*class="[^"]*\bresult\b[^"]*"[^>]*>[\s\S]*?<\/div>/gi,
    /<section\b[^>]*class="[^"]*\bresult\b[^"]*"[^>]*>[\s\S]*?<\/section>/gi,
    /<h[2-4]\b[^>]*>[\s\S]*?<\/h[2-4]>(?:[\s\S]{0,1200}?)(?=<h[2-4]\b|<\/section>|<\/main>|<\/body>)/gi,
  ];

  const unique = new Set<string>();
  for (const pattern of blockPatterns) {
    for (const match of Array.from(html.matchAll(pattern))) {
      const block = (match[0] ?? '').trim();
      if (block) unique.add(block);
    }
  }
  return Array.from(unique);
};

const extractAnchorFromSearxngHtmlBlock = (block: string): { href: string; labelHtml: string } | null => {
  const anchorPatterns = [
    /<h[1-6]\b[^>]*>[\s\S]*?<a\b[^>]*href=(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h[1-6]>/i,
    /<a\b[^>]*class="[^"]*(?:result_header|url_header|result-title|result_link)[^"]*"[^>]*href=(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/a>/i,
    /<a\b[^>]*href=(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/a>/i,
  ];

  for (const pattern of anchorPatterns) {
    const match = block.match(pattern);
    const href = decodeHtml((match?.[1] ?? match?.[2] ?? '').trim());
    if (!href) continue;
    return { href, labelHtml: match?.[3] ?? '' };
  }
  return null;
};

const parseSearxngHtmlBlock = (block: string, index: number): SearchResult | null => {
  const anchor = extractAnchorFromSearxngHtmlBlock(block);
  const href = anchor?.href ?? '';
  if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) return null;

  let parsedHref: URL;
  try {
    parsedHref = new URL(href);
  } catch {
    return null;
  }
  if (parsedHref.protocol !== 'http:' && parsedHref.protocol !== 'https:') return null;

  const headingTitle = block.match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i)?.[1] ?? '';
  const title = decodeHtml(stripHtmlTags(anchor?.labelHtml ?? headingTitle)).trim() || href;

  const snippetMatches = [
    block.match(/<(?:p|div|span)\b[^>]*class="[^"]*(?:content|snippet|description|result-content|result_snippet)[^"]*"[^>]*>([\s\S]*?)<\/(?:p|div|span)>/i),
    block.match(/<(?:p|div)\b[^>]*data-testid="result-snippet"[^>]*>([\s\S]*?)<\/(?:p|div)>/i),
    block.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i),
    block.match(/<(?:div|span)\b[^>]*>([\s\S]*?)<\/(?:div|span)>/i),
  ];
  const snippetCandidate = snippetMatches.find(Boolean)?.[1] ?? '';
  const snippet = decodeHtml(stripHtmlTags(snippetCandidate)).trim();

  return {
    title,
    url: href,
    snippet,
    provider: 'searxng',
    score: Math.max(0, 1 - (index * 0.01)),
  };
};

class DuckDuckGoSearchAdapter implements SearchProviderAdapter {
  async search(query: string, options: SearchOptions = {}, signal?: AbortSignal): Promise<SearchResult[]> {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return [];
    // DuckDuckGo's HTML endpoint does not provide stable, documented controls for
    // safe-search and recency filtering. We accept these options for cross-provider
    // parity and intentionally fall back to provider defaults when supplied.
    void options.safeSearch;
    void options.recency;

    const policy = options.policy ?? 'open_web';
    const upstreamQueries = policy === 'only_list'
      ? buildOnlyListQueries(trimmedQuery, options.domainList)
      : [trimmedQuery];

    const rawResults: SearchResult[] = [];
    for (const upstreamQuery of upstreamQueries) {
      const response = await fetch(`https://duckduckgo.com/html/?q=${encodeURIComponent(upstreamQuery)}`, {
        method: 'GET',
        signal,
        headers: {
          Accept: 'text/html',
        },
      });

      if (!response.ok) throw new Error('DuckDuckGo search failed.');
      const html = await response.text();

      const matches = Array.from(html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g));

      const parsedResults = matches.map((match, index) => ({
        title: decodeHtml(match[2].replace(/<[^>]+>/g, '').trim()),
        url: normalizeDuckDuckGoResultUrl(match[1]),
        snippet: decodeHtml(match[3].replace(/<[^>]+>/g, '').trim()),
        provider: 'duckduckgo' as const,
        score: Math.max(0, 1 - (index * 0.01)),
      }));
      rawResults.push(...parsedResults);
    }

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

    const policy = options.policy ?? 'open_web';
    const upstreamQueries = policy === 'only_list'
      ? buildOnlyListQueries(trimmedQuery, options.domainList)
      : [trimmedQuery];

    const baseUrl = normalizeSearxngBaseUrl(options.providerConfig?.searxng?.base_url);
    const useJsonApi = options.providerConfig?.searxng?.use_json_api ?? SEARXNG_USE_JSON_API_DEFAULT;
    let rawResults: SearchResult[] = [];
    for (const upstreamQuery of upstreamQueries) {
      const requestUrl = new URL('/search', `${baseUrl}/`);
      requestUrl.searchParams.set('q', upstreamQuery);
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

      if (useJsonApi) {
        const payload = await response.json() as {
          results?: Array<{
            title?: string;
            url?: string;
            content?: string;
            publishedDate?: string;
          }>;
        };
        const parsedResults = (payload.results ?? []).map((result, index) => ({
          title: (result.title ?? '').trim() || (result.url ?? '').trim(),
          url: (result.url ?? '').trim(),
          snippet: (result.content ?? '').trim(),
          provider: 'searxng' as const,
          score: Math.max(0, 1 - (index * 0.01)),
          ...(result.publishedDate ? { published_at: result.publishedDate } : {}),
        })).filter((result) => Boolean(result.url));
        rawResults.push(...parsedResults);
      } else {
        const html = await response.text();
        const candidateBlocks = extractSearxngHtmlResultBlocks(html);
        const parsedResults = candidateBlocks
          .map((block, index) => parseSearxngHtmlBlock(block, index))
          .filter((result): result is SearchResult => Boolean(result));
        if (parsedResults.length === 0) {
          throw new Error('SearXNG HTML extraction empty despite HTTP 200 (template mismatch: expected result containers or heading+snippet pairs).');
        }
        rawResults.push(...parsedResults);
      }
    }

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
