import assert from 'node:assert/strict';
import test from 'node:test';
import { processResponseCitations } from './citation_pipeline';

test('citation mode ON normalizes variants, remaps by appearance, validates indices, and appends lack citation for invalid references', async () => {
  const result = await processResponseCitations({
    outputText: 'Claim one (2). Claim two source 2 and superscript ¹. Bad cite [9].',
    sourceCitationEnabled: true,
    sources: [
      { title: 'Alpha', url: 'https://example.com/a', snippet: '', provider: 'duckduckgo' },
      { title: 'Beta', url: 'https://example.com/b', snippet: '', provider: 'duckduckgo' },
    ],
  });

  assert.match(result.normalizedText, /\[1\]/);
  assert.match(result.normalizedText, /\[2\]\[lack citation\]/);
  assert.match(result.outputText, /Sources/);
  assert.match(result.outputText, /\[2\] \[Beta\]\(https:\/\/example.com\/b\)/);
});

test('citation mode ON performs exactly one retry pass when validation fails', async () => {
  let retryCount = 0;
  const result = await processResponseCitations({
    outputText: 'Unsupported cite [44].',
    sourceCitationEnabled: true,
    sources: [{ title: 'Alpha', url: 'https://example.com/a', snippet: '', provider: 'duckduckgo' }],
    retryCanonicalize: async () => {
      retryCount += 1;
      return 'Retried answer 【1】.';
    },
  });

  assert.equal(retryCount, 1);
  assert.equal(result.retryUsed, true);
  assert.match(result.outputText, /Retried answer \[1\]\./);
  assert.doesNotMatch(result.outputText, /lack citation/);
});

test('citation mode OFF strips rendered source sections and emits no inline source list', async () => {
  const result = await processResponseCitations({
    outputText: 'Body text\n\nSources:\n[1] [Alpha](https://example.com/a)',
    sourceCitationEnabled: false,
    sources: [{ title: 'Alpha', url: 'https://example.com/a', snippet: '', provider: 'duckduckgo' }],
  });

  assert.equal(result.outputText, 'Body text');
  assert.doesNotMatch(result.outputText, /Sources/i);
  assert.deepEqual(result.citationIndices, []);
});
