import test from 'node:test';
import assert from 'node:assert/strict';
import { decideWebSearchRouting, shouldRenderCitationsForChatPrompt } from './chatRoutingHeuristics.js';

test('decideWebSearchRouting auto-triggers for recency/factual/listing prompts', () => {
  const prompts = [
    'What are the latest developments in fusion energy?',
    'Give me current facts about US CPI and unemployment.',
    'Top stories in AI this week',
    'List of top 10 cybersecurity breaches this year',
  ];

  prompts.forEach((prompt) => {
    const decision = decideWebSearchRouting(prompt);
    assert.equal(decision.shouldSearch, true);
  });
});

test('decideWebSearchRouting skips conceptual/opinion/brainstorm prompts', () => {
  const prompts = [
    'Brainstorm startup ideas for climate adaptation.',
    'What is your opinion on remote work culture?',
    'Explain the concept of opportunity cost in simple terms.',
  ];

  prompts.forEach((prompt) => {
    const decision = decideWebSearchRouting(prompt);
    assert.equal(decision.shouldSearch, false);
    assert.match(decision.reason, /conceptual|default_off/);
  });
});

test('decideWebSearchRouting respects explicit no-web instruction', () => {
  const decision = decideWebSearchRouting('Give me the latest market updates but do not search the web.');
  assert.equal(decision.shouldSearch, false);
  assert.equal(decision.reason, 'explicit_no_web');
});

test('shouldRenderCitationsForChatPrompt only enables citations on explicit request', () => {
  assert.equal(shouldRenderCitationsForChatPrompt('Summarize this for me.'), false);
  assert.equal(shouldRenderCitationsForChatPrompt('Summarize this with citations.'), true);
  assert.equal(shouldRenderCitationsForChatPrompt('Please cite sources and include references.'), true);
});
