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

test('dedupe canonical URL strips UTM params and trailing slash', () => {
  const deduped = searchUtils.dedupeByCanonicalUrl([
    { title: 'A', url: 'https://example.com/path/?utm_source=x', snippet: '1', provider: 'duckduckgo' },
    { title: 'B', url: 'https://example.com/path?utm_medium=y', snippet: '2', provider: 'duckduckgo' },
  ]);

  assert.equal(deduped.length, 1);
  assert.equal(deduped[0]?.url, 'https://example.com/path');
});
