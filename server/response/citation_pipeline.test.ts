import assert from 'node:assert/strict';
import test from 'node:test';
import { processResponseCitations } from './citation_pipeline';

test('citation mode ON normalizes citation variants and remaps numbering by first appearance', async () => {
  const result = await processResponseCitations({
    outputText: 'Claim one source 2. Claim two (1) and superscript ².',
    sourceCitationEnabled: true,
    sources: [
      { kind: 'web', title: 'Alpha', url: 'https://example.com/a', snippet: '', provider: 'duckduckgo' },
      { kind: 'web', title: 'Beta', url: 'https://example.com/b', snippet: '', provider: 'duckduckgo' },
    ],
  });

  assert.match(result.normalizedText, /Claim one \[1\]/);
  assert.match(result.normalizedText, /Claim two \[2\]/);
  assert.deepEqual(result.citationIndices, [1, 2]);
  assert.equal(result.citationEvents.some((event) => event.event_type === 'normalization_applied'), true);
});

test('citation mode ON output includes inline [n] markers and source list for referenced citations', async () => {
  const result = await processResponseCitations({
    outputText: 'Answer with cite 【1】.',
    sourceCitationEnabled: true,
    sources: [{ kind: 'web', title: 'Alpha', url: 'https://example.com/a', snippet: '', provider: 'duckduckgo' }],
  });

  assert.match(result.outputText, /Answer with cite \[1\]\./);
  assert.match(result.outputText, /Sources/);
  assert.match(result.outputText, /\[1\] \[Alpha\]\(https:\/\/example.com\/a\)/);
});

test('citation mode ON performs one retry then marks unsupported spans with [lack citation] without blocking output', async () => {
  let retryCount = 0;
  const result = await processResponseCitations({
    outputText: 'Unsupported cite [44].',
    sourceCitationEnabled: true,
    sources: [{ kind: 'web', title: 'Alpha', url: 'https://example.com/a', snippet: '', provider: 'duckduckgo' }],
    retryCanonicalize: async () => {
      retryCount += 1;
      return 'Retried answer [44].';
    },
  });

  assert.equal(retryCount, 1);
  assert.equal(result.retryUsed, true);
  assert.match(result.outputText, /Retried answer \[1\]\[lack citation\]\./);
  assert.equal(result.citationEvents.some((event) => event.event_type === 'retry_invoked'), true);
  assert.equal(result.citationEvents.some((event) => event.event_type === 'unsupported_span_marked_lack_citation'), true);
});

test('citation mode OFF excludes inline [n] and source list from output', async () => {
  const result = await processResponseCitations({
    outputText: 'Body text [1]\n\nSources:\n[1] [Alpha](https://example.com/a)',
    sourceCitationEnabled: false,
    sources: [{ kind: 'web', title: 'Alpha', url: 'https://example.com/a', snippet: '', provider: 'duckduckgo' }],
  });

  assert.equal(result.outputText, 'Body text');
  assert.doesNotMatch(result.outputText, /Sources/i);
  assert.doesNotMatch(result.outputText, /\[\d+\]/);
  assert.deepEqual(result.citationIndices, []);
  assert.equal(result.citationEvents.some((event) => event.event_type === 'citation_off_rewrite_invoked'), true);
});

test('citation mode OFF removes citation table columns cleanly', async () => {
  const result = await processResponseCitations({
    outputText: [
      'Findings [1] show improved latency [2].',
      '',
      '| Claim | Evidence | References |',
      '| --- | --- | --- |',
      '| Faster startup | Benchmarks | [1][2] |',
      '| Better throughput | Load test | [3] |',
      '',
      'References',
      '[1] Alpha',
      '[2] Beta',
      '[3] Gamma',
    ].join('\n'),
    sourceCitationEnabled: false,
    sources: [],
  });

  assert.doesNotMatch(result.outputText, /\[\d+\]/);
  assert.doesNotMatch(result.outputText, /References/i);
  assert.match(result.outputText, /Faster startup/);
  assert.doesNotMatch(result.outputText, /Benchmarks \|\s*\[1\]/);
  assert.equal(result.citationEvents.some((event) => event.event_type === 'citation_leakage_prevented'), true);
});

test('citation mode OFF skips rewrite when detector does not fire', async () => {
  const input = 'Use array index [0] for the first item and [1] for the second item.';
  const result = await processResponseCitations({
    outputText: input,
    sourceCitationEnabled: false,
    sources: [],
  });

  assert.equal(result.outputText, input);
  assert.deepEqual(result.citationEvents, []);
});

test('citation mode ON marks unresolved non-canonical citations with [lack citation]', async () => {
  const result = await processResponseCitations({
    outputText: 'Unknown marker source 77.',
    sourceCitationEnabled: true,
    sources: [{ kind: 'web', title: 'Alpha', url: 'https://example.com/a', snippet: '', provider: 'duckduckgo' }],
  });

  assert.match(result.normalizedText, /\[1\]\[lack citation\]/);
});

test('citation mode ON supports mixed web numeric and attachment alpha citations with appendix rendering', async () => {
  const result = await processResponseCitations({
    outputText: 'Web claim [2]. Attachment evidence [attachment:doc-123].',
    sourceCitationEnabled: true,
    sources: [
      { kind: 'web', title: 'Alpha', url: 'https://example.com/a', snippet: '', provider: 'duckduckgo' },
      { kind: 'web', title: 'Beta', url: 'https://example.com/b', snippet: '', provider: 'duckduckgo' },
      { kind: 'attachment', attachment_id: 'doc-123', label: 'filename.pdf' },
    ],
  });

  assert.match(result.normalizedText, /Web claim \[1\]\./);
  assert.match(result.normalizedText, /Attachment evidence \[a\]\./);
  assert.match(result.outputText, /\[1\] \[Beta\]\(https:\/\/example\.com\/b\)/);
  assert.match(result.outputText, /\[a\] filename\.pdf/);
});

test('citation mode ON remaps attachment letters by first appearance and marks invalid attachment tokens', async () => {
  const result = await processResponseCitations({
    outputText: 'Attachment two first [b]. Unknown attachment [c]. Extra token [d].',
    sourceCitationEnabled: true,
    sources: [
      { kind: 'attachment', attachment_id: 'doc-1', label: 'one.pdf' },
      { kind: 'attachment', attachment_id: 'doc-2', label: 'two.pdf' },
    ],
  });

  assert.match(result.normalizedText, /Attachment two first \[a\]\./);
  assert.match(result.normalizedText, /Unknown attachment \[b\]\./);
  assert.match(result.normalizedText, /Extra token \[c\]\[lack citation\]\./);
  assert.match(result.outputText, /\[a\] one\.pdf/);
  assert.match(result.outputText, /\[b\] two\.pdf/);
  assert.doesNotMatch(result.outputText, /\n\[c\]\s/);
});

test('citation mode ON keeps inline web citation and appendix entry index aligned when first seen citation is out of order', async () => {
  const result = await processResponseCitations({
    outputText: 'Out of order citation [3].',
    sourceCitationEnabled: true,
    sources: [
      { kind: 'web', title: 'Alpha', url: 'https://example.com/a', snippet: '', provider: 'duckduckgo' },
      { kind: 'web', title: 'Beta', url: 'https://example.com/b', snippet: '', provider: 'duckduckgo' },
      { kind: 'web', title: 'Gamma', url: 'https://example.com/c', snippet: '', provider: 'duckduckgo' },
    ],
  });

  assert.match(result.normalizedText, /Out of order citation \[1\]\./);
  assert.match(result.outputText, /\[1\] \[Gamma\]\(https:\/\/example\.com\/c\)/);
  assert.doesNotMatch(result.outputText, /\[3\] \[Gamma\]/);
});

test('citation mode ON does not leave valid inline citation without matching appendix entry', async () => {
  const result = await processResponseCitations({
    outputText: 'Single citation [2].',
    sourceCitationEnabled: true,
    sources: [
      { kind: 'web', title: 'Alpha', url: 'https://example.com/a', snippet: '', provider: 'duckduckgo' },
      { kind: 'web', title: 'Beta', url: 'https://example.com/b', snippet: '', provider: 'duckduckgo' },
    ],
  });

  assert.match(result.normalizedText, /Single citation \[1\]\./);
  assert.match(result.outputText, /Sources\n\[1\] \[Beta\]\(https:\/\/example\.com\/b\)/);
  assert.doesNotMatch(result.outputText, /\[2\] \[Beta\]/);
});

test('citation mode ON only appends cited attachments when mixed web and attachment sources are present', async () => {
  const result = await processResponseCitations({
    outputText: 'Web [1] and attachment [attachment:doc-2].',
    sourceCitationEnabled: true,
    sources: [
      { kind: 'web', title: 'Alpha', url: 'https://example.com/a', snippet: '', provider: 'duckduckgo' },
      { kind: 'attachment', attachment_id: 'doc-1', label: 'one.pdf' },
      { kind: 'attachment', attachment_id: 'doc-2', label: 'two.pdf' },
    ],
  });

  assert.match(result.outputText, /\[1\] \[Alpha\]\(https:\/\/example\.com\/a\)/);
  assert.match(result.outputText, /\[a\] two\.pdf/);
  assert.doesNotMatch(result.outputText, /\[b\] one\.pdf/);
});
