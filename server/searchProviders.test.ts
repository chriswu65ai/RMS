import test from 'node:test';
import assert from 'node:assert/strict';
import { searchProviderRegistry, searchUtils } from './searchProviders.js';

test('domain policy only_list keeps only matching hostnames and subdomains', () => {
  const results = [
    { title: 'A', url: 'https://example.com/news', snippet: 'a', provider: 'duckduckgo' as const },
    { title: 'B', url: 'https://sub.example.com/report', snippet: 'b', provider: 'duckduckgo' as const },
    { title: 'C', url: 'https://another.org/post', snippet: 'c', provider: 'duckduckgo' as const },
  ];

  const filtered = searchUtils.applyDomainPolicy(results, 'only_list', ['example.com']);
  assert.deepEqual(filtered.map((item) => item.url), [
    'https://example.com/news',
    'https://sub.example.com/report',
  ]);
});

test('domain policy prefer_list keeps open-web result set unchanged', () => {
  const results = [
    { title: 'A', url: 'https://example.com/news', snippet: 'a', provider: 'duckduckgo' as const },
    { title: 'B', url: 'https://another.org/post', snippet: 'b', provider: 'duckduckgo' as const },
  ];

  const filtered = searchUtils.applyDomainPolicy(results, 'prefer_list', ['example.com']);
  assert.deepEqual(filtered.map((item) => item.url), [
    'https://example.com/news',
    'https://another.org/post',
  ]);
});

test('domain boosts reorder results by weighted preferred sources', () => {
  const ranked = searchUtils.applyDomainBoosts([
    { title: 'General', url: 'https://general.org/insight', snippet: 'general', provider: 'duckduckgo', score: 0.8 },
    { title: 'Preferred', url: 'https://docs.example.com/filing', snippet: 'preferred', provider: 'duckduckgo', score: 0.5 },
  ], {
    'example.com': 5,
  });

  assert.equal(ranked[0]?.url, 'https://docs.example.com/filing');
  assert.equal((ranked[0]?.score ?? 0) > (ranked[1]?.score ?? 0), true);
});

test('duckduckgo prefer_list applies domain boosts without filtering open-web results', async () => {
  const originalFetch = globalThis.fetch;
  const html = `
    <a class="result__a" href="https://general.org/insight">General result</a>
    <a class="result__snippet">General snippet</a>
    <a class="result__a" href="https://docs.example.com/filing">Preferred result</a>
    <a class="result__snippet">Preferred snippet</a>
  `;

  globalThis.fetch = async () => new Response(html, { status: 200 });

  try {
    const results = await searchProviderRegistry.duckduckgo.search('earnings', {
      policy: 'prefer_list',
      domainList: ['example.com'],
      domainBoost: {
        'example.com': 5,
      },
    });

    assert.deepEqual(results.map((item) => item.url), [
      'https://docs.example.com/filing',
      'https://general.org/insight',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('duckduckgo adapter accepts safeSearch and recency options with explicit fallback to provider defaults', async () => {
  const originalFetch = globalThis.fetch;
  const html = `
    <a class="result__a" href="https://example.com/news">Example result</a>
    <a class="result__snippet">Example snippet</a>
  `;
  const requestedUrls: string[] = [];
  globalThis.fetch = async (input) => {
    requestedUrls.push(String(input));
    return new Response(html, { status: 200 });
  };

  try {
    const results = await searchProviderRegistry.duckduckgo.search('earnings', {
      safeSearch: false,
      recency: '7d',
    });

    assert.equal(results.length, 1);
    assert.equal(requestedUrls.length, 1);
    assert.match(requestedUrls[0] ?? '', /duckduckgo\.com\/html\/\?q=earnings$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('duckduckgo adapter normalizes DDG redirect wrapper urls and preserves non-wrapper urls', async () => {
  const originalFetch = globalThis.fetch;
  const html = `
    <a class="result__a" href="/l/?uddg=https%253A%252F%252Fexample.com%252Fwrapped%253Futm_source%253Dddg">Wrapped result</a>
    <a class="result__snippet">Wrapped snippet</a>
    <a class="result__a" href="https://another.example.com/direct">Direct result</a>
    <a class="result__snippet">Direct snippet</a>
  `;
  globalThis.fetch = async () => new Response(html, { status: 200 });

  try {
    const results = await searchProviderRegistry.duckduckgo.search('earnings');
    assert.equal(results[0]?.url, 'https://example.com/wrapped');
    assert.equal(results[1]?.url, 'https://another.example.com/direct');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('duckduckgo adapter falls back to decoded href for malformed uddg redirect urls', async () => {
  const originalFetch = globalThis.fetch;
  const html = `
    <a class="result__a" href="/l/?uddg=%E0%A4%A">Malformed wrapped result</a>
    <a class="result__snippet">Malformed wrapped snippet</a>
  `;
  globalThis.fetch = async () => new Response(html, { status: 200 });

  try {
    const results = await searchProviderRegistry.duckduckgo.search('earnings');
    assert.equal(results[0]?.url, '/l/?uddg=%E0%A4%A');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('dedupe canonical URL strips UTM params and trailing slash', () => {
  const deduped = searchUtils.dedupeByCanonicalUrl([
    { title: 'A', url: 'https://example.com/path/?utm_source=x', snippet: '1', provider: 'duckduckgo' },
    { title: 'B', url: 'https://example.com/path?utm_medium=y', snippet: '2', provider: 'duckduckgo' },
  ]);

  assert.equal(deduped.length, 1);
  assert.equal(deduped[0]?.url, 'https://example.com/path');
});

test('searxng json adapter maps recency and safe search controls', async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  globalThis.fetch = async (input) => {
    requestedUrls.push(String(input));
    return new Response(JSON.stringify({
      results: [
        {
          title: 'Preferred result',
          url: 'https://docs.example.com/report',
          content: 'Preferred snippet',
          publishedDate: '2026-03-01',
        },
        {
          title: 'General result',
          url: 'https://general.org/insight',
          content: 'General snippet',
        },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const results = await searchProviderRegistry.searxng.search('earnings', {
      policy: 'prefer_list',
      safeSearch: false,
      recency: '30d',
      domainList: ['example.com'],
      domainBoost: { 'example.com': 10 },
      providerConfig: {
        searxng: {
          base_url: 'http://localhost:7777',
          use_json_api: true,
        },
      },
    });

    assert.equal(requestedUrls.length, 1);
    assert.match(requestedUrls[0] ?? '', /^http:\/\/localhost:7777\/search\?/);
    assert.match(requestedUrls[0] ?? '', /(?:\?|&)q=earnings(?:&|$)/);
    assert.match(requestedUrls[0] ?? '', /(?:\?|&)format=json(?:&|$)/);
    assert.match(requestedUrls[0] ?? '', /(?:\?|&)safesearch=0(?:&|$)/);
    assert.match(requestedUrls[0] ?? '', /(?:\?|&)time_range=month(?:&|$)/);
    assert.equal(results[0]?.url, 'https://docs.example.com/report');
    assert.equal(results[0]?.published_at, '2026-03-01');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('searxng json adapter sanitizes accidental full /search URL and keeps a single /search segment', async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  globalThis.fetch = async (input) => {
    requestedUrls.push(String(input));
    return new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    await searchProviderRegistry.searxng.search('test query', {
      providerConfig: {
        searxng: {
          base_url: 'http://localhost:8080/search?q=old&format=json#frag',
          use_json_api: true,
        },
      },
    });

    assert.equal(requestedUrls.length, 1);
    const requestUrl = new URL(requestedUrls[0] ?? '');
    assert.equal(requestUrl.origin, 'http://localhost:8080');
    assert.equal(requestUrl.pathname, '/search');
    assert.equal(requestUrl.searchParams.get('q'), 'test query');
    assert.equal(requestUrl.searchParams.get('format'), 'json');
    assert.equal(requestUrl.searchParams.get('safesearch'), '1');
    assert.equal(requestUrl.toString().match(/\/search/g)?.length ?? 0, 1);
    assert.equal(requestUrl.searchParams.get('old'), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('searxng html adapter sanitizes accidental full /search URL and omits format=json', async () => {
  const originalFetch = globalThis.fetch;
  let fetchAcceptHeader = '';
  const requestedUrls: string[] = [];
  const html = `
    <article class="result">
      <h3><a href="https://example.com/html">HTML Result</a></h3>
      <p class="content">snippet</p>
    </article>
  `;
  globalThis.fetch = async (input, init) => {
    requestedUrls.push(String(input));
    fetchAcceptHeader = String(new Headers(init?.headers).get('accept') ?? '');
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
  };

  try {
    await searchProviderRegistry.searxng.search('test query', {
      providerConfig: {
        searxng: {
          base_url: 'http://localhost:8080/search',
          use_json_api: false,
        },
      },
    });

    assert.equal(requestedUrls.length, 1);
    const requestUrl = new URL(requestedUrls[0] ?? '');
    assert.equal(requestUrl.origin, 'http://localhost:8080');
    assert.equal(requestUrl.pathname, '/search');
    assert.equal(requestUrl.searchParams.get('q'), 'test query');
    assert.equal(requestUrl.searchParams.get('format'), null);
    assert.equal(requestUrl.toString().match(/\/search/g)?.length ?? 0, 1);
    assert.equal(fetchAcceptHeader, 'text/html');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('searxng json adapter parses canonical result shape with title fallback', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    results: [
      { title: 'Result A', url: 'https://example.com/a', content: 'snippet a', publishedDate: '2026-01-10' },
      { title: '   ', url: 'https://example.com/b', content: 'snippet b' },
      { title: 'no-url', content: 'should be filtered out' },
    ],
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  try {
    const results = await searchProviderRegistry.searxng.search('query', {
      providerConfig: { searxng: { use_json_api: true } },
    });
    assert.deepEqual(results, [
      {
        title: 'Result A',
        url: 'https://example.com/a',
        snippet: 'snippet a',
        provider: 'searxng',
        score: 1,
        published_at: '2026-01-10',
      },
      {
        title: 'https://example.com/b',
        url: 'https://example.com/b',
        snippet: 'snippet b',
        provider: 'searxng',
        score: 0.99,
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('searxng adapter applies only_list policy and result cap', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    results: [
      { title: 'Keep', url: 'https://docs.example.com/one', content: 'one' },
      { title: 'Drop', url: 'https://other.org/two', content: 'two' },
      { title: 'Keep 2', url: 'https://sub.example.com/three', content: 'three' },
    ],
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  try {
    const results = await searchProviderRegistry.searxng.search('query', {
      policy: 'only_list',
      domainList: ['example.com'],
      resultCap: 1,
      providerConfig: { searxng: { use_json_api: true } },
    });

    assert.equal(results.length, 1);
    assert.equal(results[0]?.url, 'https://docs.example.com/one');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('searxng html adapter parses current expected markup', async () => {
  const originalFetch = globalThis.fetch;
  const html = `
    <article class="result">
      <h3 class="result_header">
        <a href="https://example.com/current">Current Theme Result</a>
      </h3>
      <p class="content">Current theme snippet text</p>
    </article>
  `;
  globalThis.fetch = async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });

  try {
    const results = await searchProviderRegistry.searxng.search('query', {
      providerConfig: { searxng: { use_json_api: false } },
    });
    assert.equal(results.length > 0, true);
    assert.equal(results[0]?.url, 'https://example.com/current');
    assert.equal(results[0]?.title, 'Current Theme Result');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('searxng html adapter parses slight markup and class variation', async () => {
  const originalFetch = globalThis.fetch;
  const html = `
    <ul>
      <li class="result result-default">
        <h4>
          <a class="url_header" href="https://example.org/variant">Variant Theme Result</a>
        </h4>
        <div class="snippet">Variant snippet text</div>
      </li>
    </ul>
  `;
  globalThis.fetch = async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });

  try {
    const results = await searchProviderRegistry.searxng.search('query', {
      providerConfig: { searxng: { use_json_api: false } },
    });
    assert.equal(results.length > 0, true);
    assert.equal(results[0]?.url, 'https://example.org/variant');
    assert.equal(results[0]?.title, 'Variant Theme Result');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('searxng html adapter parses heading+snippet fallback without result container', async () => {
  const originalFetch = globalThis.fetch;
  const html = `
    <main>
      <h3 class="result_header"><a href="https://fallback.example.net/story">Fallback Heading Result</a></h3>
      <p class="content">Fallback snippet text</p>
    </main>
  `;
  globalThis.fetch = async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });

  try {
    const results = await searchProviderRegistry.searxng.search('query', {
      providerConfig: { searxng: { use_json_api: false } },
    });
    assert.equal(results.length > 0, true);
    assert.equal(results[0]?.url, 'https://fallback.example.net/story');
    assert.equal(results[0]?.title, 'Fallback Heading Result');
    assert.equal(results[0]?.snippet, 'Fallback snippet text');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('searxng html adapter emits explicit parse mismatch error for unknown template', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('<html><body><div>No recognizable result blocks</div></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });

  try {
    await assert.rejects(
      searchProviderRegistry.searxng.search('query', {
        providerConfig: { searxng: { use_json_api: false } },
      }),
      /SearXNG HTML extraction empty despite HTTP 200 \(template mismatch: expected result containers or heading\+snippet pairs\)\./,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('searxng and duckduckgo adapters apply prefer_list domain boost parity', async () => {
  const originalFetch = globalThis.fetch;
  const searxPayload = JSON.stringify({
    results: [
      { title: 'General', url: 'https://general.org/insight', content: 'general' },
      { title: 'Preferred', url: 'https://docs.example.com/filing', content: 'preferred' },
    ],
  });
  const duckHtml = `
    <a class="result__a" href="https://general.org/insight">General</a>
    <a class="result__snippet">general</a>
    <a class="result__a" href="https://docs.example.com/filing">Preferred</a>
    <a class="result__snippet">preferred</a>
  `;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/search?')) {
      return new Response(searxPayload, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(duckHtml, { status: 200, headers: { 'content-type': 'text/html' } });
  };

  try {
    const options = {
      policy: 'prefer_list' as const,
      domainList: ['example.com'],
      domainBoost: { 'example.com': 5 },
    };
    const duck = await searchProviderRegistry.duckduckgo.search('earnings', options);
    const searxng = await searchProviderRegistry.searxng.search('earnings', {
      ...options,
      providerConfig: { searxng: { use_json_api: true } },
    });
    assert.deepEqual(duck.map((item) => item.url), [
      'https://docs.example.com/filing',
      'https://general.org/insight',
    ]);
    assert.deepEqual(searxng.map((item) => item.url), [
      'https://docs.example.com/filing',
      'https://general.org/insight',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('duckduckgo only_list uses constrained upstream queries before domain safety filter', async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  const genericHtml = `
    <a class="result__a" href="https://general.org/top-1">Generic top result</a>
    <a class="result__snippet">generic snippet</a>
  `;
  const targetedHtml = `
    <a class="result__a" href="https://docs.example.com/relevant">Preferred source</a>
    <a class="result__snippet">preferred snippet</a>
  `;

  globalThis.fetch = async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    const parsed = new URL(url);
    const q = parsed.searchParams.get('q') ?? '';
    if (q === 'earnings report') return new Response(genericHtml, { status: 200 });
    if (q.includes('site%3Aexample.com')) return new Response(targetedHtml, { status: 200 });
    if (q.includes('site:example.com')) return new Response(targetedHtml, { status: 200 });
    return new Response(genericHtml, { status: 200 });
  };

  try {
    const results = await searchProviderRegistry.duckduckgo.search('earnings report', {
      policy: 'only_list',
      domainList: ['example.com'],
    });

    assert.deepEqual(results.map((item) => item.url), ['https://docs.example.com/relevant']);
    assert.equal(requestedUrls.length >= 2, true);
    assert.equal(requestedUrls.some((url) => url.includes('site%3Aexample.com')), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('searxng only_list uses constrained upstream queries before domain safety filter', async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];

  globalThis.fetch = async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    const parsed = new URL(url);
    const q = parsed.searchParams.get('q') ?? '';
    if (q === 'capital expenditure') {
      return new Response(JSON.stringify({
        results: [
          { title: 'Generic top result', url: 'https://general.org/top-1', content: 'generic snippet' },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (q.includes('site:example.com')) {
      return new Response(JSON.stringify({
        results: [
          { title: 'Preferred source', url: 'https://research.example.com/relevant', content: 'preferred snippet' },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const results = await searchProviderRegistry.searxng.search('capital expenditure', {
      policy: 'only_list',
      domainList: ['example.com'],
      providerConfig: { searxng: { use_json_api: true } },
    });

    assert.deepEqual(results.map((item) => item.url), ['https://research.example.com/relevant']);
    assert.equal(requestedUrls.length >= 2, true);
    assert.equal(requestedUrls.some((url) => url.includes('site%3Aexample.com')), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
