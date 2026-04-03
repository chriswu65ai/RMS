import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeMetadataListsWithDefaults } from './metadataLists.js';

const defaults = {
  noteTypes: ['Event', 'Earnings', 'Deepdive', 'Summary'],
  assignees: ['Agent', 'Me'],
  sectors: ['Energy', 'Utilities'],
};

test('missing persisted metadata lists keep defaults', () => {
  const merged = mergeMetadataListsWithDefaults(undefined, defaults);

  assert.deepEqual(merged.noteTypes, defaults.noteTypes);
  assert.deepEqual(merged.assignees, defaults.assignees);
  assert.deepEqual(merged.sectors, defaults.sectors);
});

test('persisted empty metadata lists fall back to defaults', () => {
  const merged = mergeMetadataListsWithDefaults({ noteTypes: [], assignees: [], sectors: [] }, defaults);

  assert.deepEqual(merged.noteTypes, defaults.noteTypes);
  assert.deepEqual(merged.assignees, defaults.assignees);
  assert.deepEqual(merged.sectors, defaults.sectors);
});

test('persisted non-empty metadata lists are preserved with normalization', () => {
  const merged = mergeMetadataListsWithDefaults(
    {
      noteTypes: ['  Event ', 'event', ''],
      assignees: [' Me ', 'me', 'Agent'],
      sectors: ['Utilities', ' utilities ', 'Energy'],
    },
    defaults,
  );

  assert.deepEqual(merged.noteTypes, ['Event']);
  assert.deepEqual(merged.assignees, ['Me', 'Agent']);
  assert.deepEqual(merged.sectors, ['Utilities', 'Energy']);
});
