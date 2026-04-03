import test from 'node:test';
import assert from 'node:assert/strict';

import type { DraftEntry } from '../../hooks/useResearchStore.js';
import type { Folder, ResearchNote } from '../../types/models.js';
import { deriveFoldersWithUnsavedFiles } from '../folders/unsavedFolders.js';
import { deriveUnsavedFileIds, getFileTitleIndicators } from './unsavedIndicators.js';

const makeFile = (overrides: Partial<ResearchNote> = {}): ResearchNote => ({
  id: 'file-1',
  workspace_id: 'workspace-1',
  folder_id: null,
  name: '2026-04-01 ABC-research.md',
  path: '2026-04-01 ABC-research.md',
  content: 'saved body',
  frontmatter_json: null,
  is_template: false,
  created_at: '2026-04-01T00:00:00.000Z',
  updated_at: '2026-04-01T00:00:00.000Z',
  ...overrides,
});

const makeDraft = (overrides: Partial<DraftEntry> = {}): DraftEntry => ({
  body: 'edited body',
  frontmatter: { title: 'ABC Research' },
  source: 'manual',
  updatedAt: Date.now(),
  ...overrides,
});

test('unsaved indicator appears on unstarred note', () => {
  const indicators = getFileTitleIndicators({ isStarred: false, isUnsaved: true });

  assert.deepEqual(indicators, ['unsaved']);
});

test('unsaved indicator is rendered after starred indicator', () => {
  const indicators = getFileTitleIndicators({ isStarred: true, isUnsaved: true });

  assert.deepEqual(indicators, ['starred', 'unsaved']);
});

test('folder propagation marks parent folder as unsaved when child note is unsaved', () => {
  const folders: Folder[] = [
    {
      id: 'folder-parent',
      workspace_id: 'workspace-1',
      parent_id: null,
      name: 'Parent',
      path: 'Parent',
      created_at: '2026-04-01T00:00:00.000Z',
      updated_at: '2026-04-01T00:00:00.000Z',
    },
    {
      id: 'folder-child',
      workspace_id: 'workspace-1',
      parent_id: 'folder-parent',
      name: 'Child',
      path: 'Parent/Child',
      created_at: '2026-04-01T00:00:00.000Z',
      updated_at: '2026-04-01T00:00:00.000Z',
    },
  ];

  const files = [makeFile({ id: 'file-unsaved', folder_id: 'folder-child' })];

  const foldersWithUnsaved = deriveFoldersWithUnsavedFiles(folders, files, ['file-unsaved']);

  assert.equal(foldersWithUnsaved.has('folder-child'), true);
  assert.equal(foldersWithUnsaved.has('folder-parent'), true);
});

test('unsaved indicator is removed after successful save', () => {
  const draft = makeDraft({ frontmatter: {}, body: 'saved body' });
  const files = [makeFile({ id: 'file-1', content: 'saved body' })];

  const unsavedFileIds = deriveUnsavedFileIds(files, { 'file-1': draft });

  assert.deepEqual(unsavedFileIds, []);
});
