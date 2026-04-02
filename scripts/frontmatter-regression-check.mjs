import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = await mkdtemp(join(tmpdir(), 'frontmatter-check-'));
const outfile = join(tempDir, 'frontmatter.bundle.cjs');
const require = createRequire(import.meta.url);

try {
  await build({
    entryPoints: ['src/lib/frontmatter.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    logLevel: 'silent',
  });

  const { splitFrontmatter, composeMarkdown } = require(outfile);

  const markdown = [
    '---',
    'title: "  ACME Research  "',
    'ticker: " msft "',
    'type: " Research "',
    'date: " 2026-03-31 "',
    'recommendation: "  BUY  "',
    'template: "TrUe"',
    'starred: "fAlSe"',
    'customKey: "  custom value  "',
    '---',
    '# Body',
    '',
  ].join('\r\n');

  const parsed = splitFrontmatter(markdown);
  const stringValues = Object.values(parsed.frontmatter).filter((value) => typeof value === 'string');

  assert.equal(stringValues.every((value) => !String(value).includes('\r')), true);
  assert.equal(parsed.frontmatter.title, 'ACME Research');
  assert.equal(parsed.frontmatter.ticker, 'MSFT');
  assert.equal(parsed.frontmatter.type, 'Research');
  assert.equal(parsed.frontmatter.date, '2026-03-31');
  assert.equal(parsed.frontmatter.recommendation, 'buy');
  assert.equal(parsed.frontmatter.template, true);
  assert.equal(typeof parsed.frontmatter.template, 'boolean');
  assert.equal(parsed.frontmatter.starred, false);
  assert.equal(typeof parsed.frontmatter.starred, 'boolean');
  assert.equal(parsed.frontmatter.customKey, 'custom value');

  const composed = composeMarkdown(
    {
      date: '2026-03-31',
      title: 'ACME Research',
      ticker: 'MSFT',
      sectors: ['software'],
      recommendation: 'buy',
      type: 'Research',
    },
    '# Body\n',
  );
  const frontmatterBlock = composed.split('---\n')[1] ?? '';
  const lines = frontmatterBlock.trim().split('\n');
  assert.deepEqual(lines.slice(0, 6), [
    'date: 2026-03-31',
    'title: ACME Research',
    'ticker: MSFT',
    'sectors: software',
    'recommendation: buy',
    'type: Research',
  ]);

  console.log('frontmatter regression check passed');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
