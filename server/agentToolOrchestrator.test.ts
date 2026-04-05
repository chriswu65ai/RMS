import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgentToolOrchestration } from './agentToolOrchestrator.js';
import { providerRegistry } from './agentProviders.js';
import { searchProviderRegistry } from './searchProviders.js';

type WebSearchSettings = {
  enabled: boolean;
  provider: 'duckduckgo' | 'searxng';
  mode: 'single' | 'deep';
  max_results: number;
  timeout_ms: number;
  safe_search: boolean;
  recency: 'any' | '7d' | '30d' | '365d';
  domain_policy: 'open_web' | 'prefer_list' | 'only_list';
  source_citation: boolean;
  provider_config?: {
    searxng?: {
      base_url: string;
      use_json_api: boolean;
    };
  };
};

const baseSettings: WebSearchSettings = {
  enabled: true,
  provider: 'duckduckgo',
  mode: 'single',
  max_results: 5,
  timeout_ms: 2_000,
  safe_search: true,
  recency: '30d',
  domain_policy: 'prefer_list',
  source_citation: true,
};

test('runAgentToolOrchestration ignores model overrides for domain policy/list and provider', async () => {
  const originalFirst = providerRegistry.openai.generateToolFirstTurn;
  const originalFollowup = providerRegistry.openai.generateToolFollowupTurn;
  const originalDdgSearch = searchProviderRegistry.duckduckgo.search;
  const originalSearxngSearch = searchProviderRegistry.searxng.search;

  const capturedCalls: Array<{ query: string; options?: unknown }> = [];

  providerRegistry.openai.generateToolFirstTurn = async () => ({
    outputText: '',
    latencyMs: 1,
    toolCalls: [{
      id: 'call-1',
      name: 'web_search',
      arguments: {
        query: 'earnings transcript',
        mode: 'deep',
        max_results: 2,
        domain_policy: 'only_list',
        domain_list: ['attacker.example'],
        provider: 'searxng',
      },
    }],
  });
  providerRegistry.openai.generateToolFollowupTurn = async () => ({ outputText: '', latencyMs: 1, toolCalls: [] });

  searchProviderRegistry.duckduckgo.search = async (query, options) => {
    capturedCalls.push({ query, options });
    return [{
      title: 'Trusted source',
      url: 'https://trusted.example/article',
      snippet: 'Snippet',
      provider: 'duckduckgo',
    }];
  };
  searchProviderRegistry.searxng.search = async () => {
    throw new Error('Expected orchestrator to ignore model provider override and avoid searxng search.');
  };

  try {
    const result = await runAgentToolOrchestration({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      inputText: 'Find latest guidance',
      apiKey: 'test-key',
      settings: baseSettings,
      preferredSources: [{ domain: 'trusted.example', weight: 0.9 }],
    });

    assert.equal(capturedCalls.length, 1);
    assert.equal(result.toolCalls[0]?.arguments.domain_policy, 'prefer_list');
    assert.deepEqual(result.toolCalls[0]?.arguments.domain_list, ['trusted.example']);
    assert.equal(result.toolCalls[0]?.arguments.provider, 'duckduckgo');
    assert.equal(result.toolCalls[0]?.arguments.mode, 'deep');
    assert.equal(result.toolCalls[0]?.arguments.max_results, 2);

    const firstCallOptions = capturedCalls[0]?.options as {
      policy?: string;
      domainList?: string[];
      mode?: string;
      resultCap?: number;
    };
    assert.equal(firstCallOptions.policy, 'prefer_list');
    assert.deepEqual(firstCallOptions.domainList, ['trusted.example']);
    assert.equal(firstCallOptions.mode, 'deep');
    assert.equal(firstCallOptions.resultCap, 2);
  } finally {
    providerRegistry.openai.generateToolFirstTurn = originalFirst;
    providerRegistry.openai.generateToolFollowupTurn = originalFollowup;
    searchProviderRegistry.duckduckgo.search = originalDdgSearch;
    searchProviderRegistry.searxng.search = originalSearxngSearch;
  }
});

test('runAgentToolOrchestration keeps guardrails across deep follow-up tool calls', async () => {
  const originalFirst = providerRegistry.openai.generateToolFirstTurn;
  const originalFollowup = providerRegistry.openai.generateToolFollowupTurn;
  const originalDdgSearch = searchProviderRegistry.duckduckgo.search;

  const capturedPolicies: string[] = [];
  const capturedDomainLists: string[][] = [];

  providerRegistry.openai.generateToolFirstTurn = async () => ({
    outputText: '',
    latencyMs: 1,
    toolCalls: [{
      id: 'call-1',
      name: 'web_search',
      arguments: {
        query: 'first query',
        domain_policy: 'open_web',
        domain_list: ['ignore-first.example'],
      },
    }],
  });

  providerRegistry.openai.generateToolFollowupTurn = async (request) => ({
    outputText: '',
    latencyMs: 1,
    toolCalls: request.toolResults.length === 1
      ? [{
        id: 'call-2',
        name: 'web_search',
        arguments: {
          query: 'second query',
          domain_policy: 'open_web',
          domain_list: ['ignore-second.example'],
          provider: 'searxng',
        },
      }]
      : request.toolResults.length === 2
        ? [{
          id: 'call-3',
          name: 'web_search',
          arguments: {
            query: 'third query',
            domain_policy: 'open_web',
            domain_list: ['ignore-third.example'],
          },
        }]
      : [],
  });

  searchProviderRegistry.duckduckgo.search = async (_query, options) => {
    capturedPolicies.push(options?.policy ?? '');
    capturedDomainLists.push(options?.domainList ?? []);
    return [{
      title: 'Result',
      url: `https://trusted.example/${capturedPolicies.length}`,
      snippet: 'Snippet',
      provider: 'duckduckgo',
    }];
  };

  try {
    await runAgentToolOrchestration({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      inputText: 'Need deep search',
      apiKey: 'test-key',
      settings: { ...baseSettings, mode: 'deep', domain_policy: 'only_list' },
      preferredSources: [{ domain: 'trusted.example', weight: 0.7 }],
    });

    assert.deepEqual(capturedPolicies, ['only_list', 'only_list', 'only_list']);
    assert.deepEqual(capturedDomainLists, [['trusted.example'], ['trusted.example'], ['trusted.example']]);
  } finally {
    providerRegistry.openai.generateToolFirstTurn = originalFirst;
    providerRegistry.openai.generateToolFollowupTurn = originalFollowup;
    searchProviderRegistry.duckduckgo.search = originalDdgSearch;
  }
});

test('runAgentToolOrchestration repairs pseudo-tool plain text into structured web_search call', async () => {
  const originalFirst = providerRegistry.openai.generateToolFirstTurn;
  const originalFollowup = providerRegistry.openai.generateToolFollowupTurn;
  const originalDdgSearch = searchProviderRegistry.duckduckgo.search;
  let firstTurnCount = 0;

  providerRegistry.openai.generateToolFirstTurn = async (request) => {
    firstTurnCount += 1;
    if (firstTurnCount === 1) {
      return {
        outputText: '<tool_code>open_page("https://example.com")</tool_code>',
        latencyMs: 1,
        toolCalls: [],
      };
    }
    assert.match(request.inputText, /Protocol repair/i);
    return {
      outputText: '',
      latencyMs: 1,
      toolCalls: [{ id: 'repair-call-1', name: 'web_search', arguments: { query: 'repaired query' } }],
    };
  };
  providerRegistry.openai.generateToolFollowupTurn = async () => ({ outputText: '', latencyMs: 1, toolCalls: [] });
  searchProviderRegistry.duckduckgo.search = async () => ([{
    title: 'Result',
    url: 'https://trusted.example/repaired',
    snippet: 'Snippet',
    provider: 'duckduckgo',
  }]);

  try {
    const result = await runAgentToolOrchestration({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      inputText: 'Find latest guidance',
      apiKey: 'test-key',
      settings: baseSettings,
      preferredSources: [],
    });
    assert.equal(firstTurnCount, 2);
    assert.equal(result.toolCalls[0]?.arguments.query, 'repaired query');
  } finally {
    providerRegistry.openai.generateToolFirstTurn = originalFirst;
    providerRegistry.openai.generateToolFollowupTurn = originalFollowup;
    searchProviderRegistry.duckduckgo.search = originalDdgSearch;
  }
});

test('runAgentToolOrchestration fails with explicit protocol mismatch when repair cannot recover', async () => {
  const originalFirst = providerRegistry.openai.generateToolFirstTurn;
  providerRegistry.openai.generateToolFirstTurn = async () => ({
    outputText: '<invoke name="fetch_fetch"></invoke>',
    latencyMs: 1,
    toolCalls: [],
  });
  try {
    await assert.rejects(() => runAgentToolOrchestration({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      inputText: 'Find latest guidance',
      apiKey: 'test-key',
      settings: baseSettings,
      preferredSources: [],
    }), /Protocol mismatch: model emitted pseudo-tool content/i);
  } finally {
    providerRegistry.openai.generateToolFirstTurn = originalFirst;
  }
});

test('runAgentToolOrchestration maps structured fetch_fetch alias URL to deterministic web_search query', async () => {
  const originalFirst = providerRegistry.openai.generateToolFirstTurn;
  const originalFollowup = providerRegistry.openai.generateToolFollowupTurn;
  const originalDdgSearch = searchProviderRegistry.duckduckgo.search;
  const seenQueries: string[] = [];

  providerRegistry.openai.generateToolFirstTurn = async () => ({
    outputText: '',
    latencyMs: 1,
    toolCalls: [{ id: 'alias-call-1', name: 'fetch_fetch', arguments: { url: 'https://docs.example.com/path/to/latest-earnings-report' } }],
  });
  providerRegistry.openai.generateToolFollowupTurn = async () => ({ outputText: '', latencyMs: 1, toolCalls: [] });
  searchProviderRegistry.duckduckgo.search = async (query) => {
    seenQueries.push(query);
    return [{
      title: 'Aliased',
      url: 'https://docs.example.com/path/to/latest-earnings-report',
      snippet: 'Snippet',
      provider: 'duckduckgo',
    }];
  };

  try {
    await runAgentToolOrchestration({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      inputText: 'Find latest guidance',
      apiKey: 'test-key',
      settings: baseSettings,
      preferredSources: [],
    });
    assert.equal(seenQueries.length, 1);
    assert.match(seenQueries[0] ?? '', /^site:docs\.example\.com /);
  } finally {
    providerRegistry.openai.generateToolFirstTurn = originalFirst;
    providerRegistry.openai.generateToolFollowupTurn = originalFollowup;
    searchProviderRegistry.duckduckgo.search = originalDdgSearch;
  }
});

test('runAgentToolOrchestration uses one pass for single mode and up to three passes for deep mode', async () => {
  const originalFirst = providerRegistry.openai.generateToolFirstTurn;
  const originalFollowup = providerRegistry.openai.generateToolFollowupTurn;
  const originalDdgSearch = searchProviderRegistry.duckduckgo.search;
  const seenQueries: string[] = [];

  providerRegistry.openai.generateToolFirstTurn = async () => ({
    outputText: '',
    latencyMs: 1,
    toolCalls: [{ id: 'call-1', name: 'web_search', arguments: { query: 'q1' } }],
  });
  providerRegistry.openai.generateToolFollowupTurn = async (request) => ({
    outputText: '',
    latencyMs: 1,
    toolCalls: request.toolResults.length === 1
      ? [{ id: 'call-2', name: 'web_search', arguments: { query: 'q2' } }]
      : request.toolResults.length === 2
        ? [{ id: 'call-3', name: 'web_search', arguments: { query: 'q3' } }]
        : [],
  });
  searchProviderRegistry.duckduckgo.search = async (query) => {
    seenQueries.push(query);
    return [{ title: query, url: `https://example.com/${query}`, snippet: 'Snippet', provider: 'duckduckgo' }];
  };

  try {
    const single = await runAgentToolOrchestration({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      inputText: 'single',
      apiKey: 'test-key',
      settings: { ...baseSettings, mode: 'single' },
      preferredSources: [],
    });
    assert.equal(single.queryCount, 1);

    seenQueries.length = 0;
    const deep = await runAgentToolOrchestration({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      inputText: 'deep',
      apiKey: 'test-key',
      settings: { ...baseSettings, mode: 'deep' },
      preferredSources: [],
    });
    assert.equal(deep.queryCount, 3);
    assert.deepEqual(seenQueries, ['q1', 'q2', 'q3']);
  } finally {
    providerRegistry.openai.generateToolFirstTurn = originalFirst;
    providerRegistry.openai.generateToolFollowupTurn = originalFollowup;
    searchProviderRegistry.duckduckgo.search = originalDdgSearch;
  }
});
