import test from 'node:test';
import assert from 'node:assert/strict';
import { providerRegistry } from './agentProviders.js';
import { runAgentToolOrchestration } from './agentToolOrchestrator.js';
import { searchProviderRegistry, type SearchResult } from './searchProviders.js';

const mockSearchResult: SearchResult = {
  title: 'Result',
  url: 'https://example.com/article',
  snippet: 'Snippet',
  provider: 'duckduckgo',
};

test('single mode skips followup turn after successful tool execution', async () => {
  const originalFirstTurn = providerRegistry.openai.generateToolFirstTurn;
  const originalFollowupTurn = providerRegistry.openai.generateToolFollowupTurn;
  const originalSearch = searchProviderRegistry.duckduckgo.search;

  let firstTurnCalls = 0;
  let followupCalls = 0;
  let searchCalls = 0;

  providerRegistry.openai.generateToolFirstTurn = async () => {
    firstTurnCalls += 1;
    return {
      outputText: '',
      toolCalls: [{ id: 'call-1', name: 'web_search', arguments: { query: 'single query' } }],
      latencyMs: 1,
    };
  };
  providerRegistry.openai.generateToolFollowupTurn = async () => {
    followupCalls += 1;
    return {
      outputText: '',
      toolCalls: [],
      latencyMs: 1,
    };
  };
  searchProviderRegistry.duckduckgo.search = async () => {
    searchCalls += 1;
    return [mockSearchResult];
  };

  try {
    const result = await runAgentToolOrchestration({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      inputText: 'Find one source',
      apiKey: 'test-key',
      settings: {
        enabled: true,
        provider: 'duckduckgo',
        mode: 'single',
        max_results: 3,
        timeout_ms: 5_000,
        safe_search: true,
        recency: 'any',
        domain_policy: 'open_web',
        source_citation: true,
      },
      preferredSources: [],
    });

    assert.equal(firstTurnCalls, 1);
    assert.equal(searchCalls, 1);
    assert.equal(followupCalls, 0);
    assert.equal(result.queryCount, 1);
  } finally {
    providerRegistry.openai.generateToolFirstTurn = originalFirstTurn;
    providerRegistry.openai.generateToolFollowupTurn = originalFollowupTurn;
    searchProviderRegistry.duckduckgo.search = originalSearch;
  }
});

test('deep mode only requests followup before the final allowed tool call', async () => {
  const originalFirstTurn = providerRegistry.openai.generateToolFirstTurn;
  const originalFollowupTurn = providerRegistry.openai.generateToolFollowupTurn;
  const originalSearch = searchProviderRegistry.duckduckgo.search;

  let followupCalls = 0;
  let searchCalls = 0;

  providerRegistry.openai.generateToolFirstTurn = async () => ({
    outputText: '',
    toolCalls: [{ id: 'call-1', name: 'web_search', arguments: { query: 'first query' } }],
    latencyMs: 1,
  });
  providerRegistry.openai.generateToolFollowupTurn = async () => {
    followupCalls += 1;
    return {
      outputText: '',
      toolCalls: [{ id: 'call-2', name: 'web_search', arguments: { query: 'second query' } }],
      latencyMs: 1,
    };
  };
  searchProviderRegistry.duckduckgo.search = async () => {
    searchCalls += 1;
    return [{ ...mockSearchResult, url: `https://example.com/article-${searchCalls}` }];
  };

  try {
    const result = await runAgentToolOrchestration({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      inputText: 'Find more depth',
      apiKey: 'test-key',
      settings: {
        enabled: true,
        provider: 'duckduckgo',
        mode: 'deep',
        max_results: 3,
        timeout_ms: 5_000,
        safe_search: true,
        recency: 'any',
        domain_policy: 'open_web',
        source_citation: true,
      },
      preferredSources: [],
    });

    assert.equal(searchCalls, 2);
    assert.equal(followupCalls, 1);
    assert.equal(result.queryCount, 2);
  } finally {
    providerRegistry.openai.generateToolFirstTurn = originalFirstTurn;
    providerRegistry.openai.generateToolFollowupTurn = originalFollowupTurn;
    searchProviderRegistry.duckduckgo.search = originalSearch;
  }
});
