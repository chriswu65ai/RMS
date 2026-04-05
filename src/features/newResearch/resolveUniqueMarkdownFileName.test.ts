import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveUniqueMarkdownFileName } from './resolveUniqueMarkdownFileName.js';

test('returns canonical markdown filename when there is no collision', () => {
  const resolved = resolveUniqueMarkdownFileName('2026-04-05 AAPL Research', [], 'folder-1');

  assert.equal(resolved, '2026-04-05 AAPL Research.md');
});

test('adds [1] suffix when canonical filename already exists in destination folder', () => {
  const resolved = resolveUniqueMarkdownFileName(
    '2026-04-05 AAPL Research',
    [{ name: '2026-04-05 AAPL Research.md', folder_id: 'folder-1' }],
    'folder-1',
  );

  assert.equal(resolved, '2026-04-05 AAPL Research [1].md');
});

test('increments suffix until it finds a free markdown filename', () => {
  const resolved = resolveUniqueMarkdownFileName(
    '2026-04-05 AAPL Research',
    [
      { name: '2026-04-05 AAPL Research.md', folder_id: 'folder-1' },
      { name: '2026-04-05 AAPL Research [1].md', folder_id: 'folder-1' },
      { name: '2026-04-05 AAPL Research [2].md', folder_id: 'folder-1' },
    ],
    'folder-1',
  );

  assert.equal(resolved, '2026-04-05 AAPL Research [3].md');
});

test('handles base names that already include bracketed suffix-like text', () => {
  const resolved = resolveUniqueMarkdownFileName(
    '2026-04-05 AAPL Research [1]',
    [{ name: '2026-04-05 AAPL Research [1].md', folder_id: 'folder-1' }],
    'folder-1',
  );

  assert.equal(resolved, '2026-04-05 AAPL Research [1] [1].md');
});

test('checks collisions only within the destination folder', () => {
  const resolved = resolveUniqueMarkdownFileName(
    '2026-04-05 AAPL Research',
    [{ name: '2026-04-05 AAPL Research.md', folder_id: 'folder-2' }],
    'folder-1',
  );

  assert.equal(resolved, '2026-04-05 AAPL Research.md');
});
