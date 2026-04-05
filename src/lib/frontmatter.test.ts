import test from 'node:test';
import assert from 'node:assert/strict';

import type { ResearchNote } from '../types/models.js';
import { fileToNoteModel } from './frontmatter.js';

function makeFile(overrides: Partial<ResearchNote>): ResearchNote {
  return {
    id: 'note-1',
    workspace_id: 'ws-1',
    folder_id: null,
    name: 'default.md',
    path: 'notes/default.md',
    content: 'Body',
    frontmatter_json: null,
    is_template: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('fileToNoteModel strips .md extension when no frontmatter title exists', () => {
  const file = makeFile({ name: 'foo.md', content: 'Plain note body' });

  const note = fileToNoteModel(file);

  assert.equal(note.title, 'foo');
});

test('fileToNoteModel leaves extensionless file names unchanged when no frontmatter title exists', () => {
  const file = makeFile({ name: 'foo', content: 'Plain note body' });

  const note = fileToNoteModel(file);

  assert.equal(note.title, 'foo');
});

test('fileToNoteModel uses trimmed frontmatter title when present', () => {
  const file = makeFile({
    name: 'foo.md',
    content: '---\ntitle: "  Preserved Title  "\n---\nBody',
  });

  const note = fileToNoteModel(file);

  assert.equal(note.title, 'Preserved Title');
});
