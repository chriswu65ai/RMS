import test from 'node:test';
import assert from 'node:assert/strict';

import { EMPTY_NOTE_TYPE_PLACEHOLDER, getCreateNoteType, getInitialTaskNoteType, getNoteTypeSelectOptions } from './noteTypeOptions.js';

test('uses empty note type for new task initialization when metadata note types are empty', () => {
  assert.equal(getInitialTaskNoteType([]), '');
  assert.equal(getInitialTaskNoteType(['Idea']), 'Idea');
});

test('provides placeholder option for empty note-type metadata lists', () => {
  const options = getNoteTypeSelectOptions([]);

  assert.deepEqual(options, ['']);
  assert.equal(EMPTY_NOTE_TYPE_PLACEHOLDER, '—');
});

test('create-note behavior keeps legacy fallback only at note creation', () => {
  assert.equal(getCreateNoteType('', []), 'Research');
  assert.equal(getCreateNoteType('', ['Catalyst']), 'Catalyst');
  assert.equal(getCreateNoteType('  Thesis ', []), 'Thesis');
});
