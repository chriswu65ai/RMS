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
    assert.match(requestedUrls[0] ?? '', /http:\/\/localhost:7777\/search\?/);
    assert.match(requestedUrls[0] ?? '', /format=json/);
    assert.match(requestedUrls[0] ?? '', /safesearch=0/);
    assert.match(requestedUrls[0] ?? '', /time_range=month/);
    assert.equal(results[0]?.url, 'https://docs.example.com/report');
    assert.equal(results[0]?.published_at, '2026-03-01');
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
