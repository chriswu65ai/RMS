import test from 'node:test';
import assert from 'node:assert/strict';
import type { ResearchNote } from '../../types/models.js';
import { buildGlobalSearchIndex, queryGlobalSearchIndex } from './globalSearch.js';

const makeFile = (index: number): ResearchNote => ({
  id: `file-${index}`,
  workspace_id: 'workspace-1',
  folder_id: null,
  name: `2026-04-01 TCK${index}-research.md`,
  path: `2026-04-01 TCK${index}-research.md`,
  content: `---\ntitle: Research ${index}\nticker: TCK${index}\n---\nBody ${index}`,
  frontmatter_json: null,
  is_template: false,
  created_at: '2026-04-01T00:00:00.000Z',
  updated_at: '2026-04-01T00:00:00.000Z',
});

test('global search builds index once and returns scored results from large file arrays', () => {
  const files = Array.from({ length: 800 }, (_, index) => makeFile(index));
  files[777] = { ...files[777], content: '---\ntitle: Alpha Signal\nticker: ALPHA\n---\nalpha catalyst coverage' };
  const index = buildGlobalSearchIndex(files);

  assert.equal(index.length, 800);
  const results = queryGlobalSearchIndex(index, 'alpha');
  assert.equal(results[0]?.id, 'file-777');
});

test('global search ignores template files and empty query', () => {
  const index = buildGlobalSearchIndex([
    makeFile(1),
    { ...makeFile(2), id: 'template-1', is_template: true },
  ]);

  assert.equal(index.length, 1);
  assert.deepEqual(queryGlobalSearchIndex(index, '   '), []);
});
