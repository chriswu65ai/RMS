import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskStatus, type Folder, type NewResearchTaskInput } from '../../types/models.js';
import { applyTickerChangeToTask, resolveDestinationPreviewForTask } from './destinationLogic.js';

const folder = (id: string, path: string): Folder => ({
  id,
  workspace_id: 'workspace-1',
  parent_id: null,
  name: path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path,
  path,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
});

const task = (overrides: Partial<NewResearchTaskInput> = {}): NewResearchTaskInput => ({
  title: '',
  details: '',
  ticker: '',
  note_type: '',
  assignee: '',
  priority: '',
  deadline: '',
  status: TaskStatus.Ideas,
  date_completed: '',
  archived: false,
  linked_note_file_id: '',
  linked_note_path: '',
  research_location_folder_id: '',
  research_location_path: '',
  ...overrides,
});

test('ticker edit updates auto-derived destination to the new ticker folder', () => {
  const folders = [folder('f-msft', 'MSFT'), folder('f-nvda', 'NVDA')];
  const before = task({ ticker: 'MSFT', research_location_folder_id: 'f-msft', research_location_path: 'MSFT' });

  const updated = applyTickerChangeToTask(before, 'nvda', folders);

  assert.equal(updated.ticker, 'NVDA');
  assert.equal(updated.research_location_folder_id, 'f-nvda');
  assert.equal(updated.research_location_path, 'NVDA');
});

test('ticker edit keeps manual destination when research location is manually selected', () => {
  const folders = [folder('f-msft', 'MSFT'), folder('f-manual', 'Manual/Bucket')];
  const before = task({ ticker: 'MSFT', research_location_folder_id: 'f-manual', research_location_path: 'Manual/Bucket' });

  const updated = applyTickerChangeToTask(before, 'nvda', folders);

  assert.equal(updated.ticker, 'NVDA');
  assert.equal(updated.research_location_folder_id, 'f-manual');
  assert.equal(updated.research_location_path, 'Manual/Bucket');
});

test('destination preview shows real destination path and locked manual state', () => {
  const folders = [folder('f-msft', 'MSFT'), folder('f-manual', 'Manual/Bucket')];
  const preview = resolveDestinationPreviewForTask(
    task({ ticker: 'MSFT', research_location_folder_id: 'f-manual', research_location_path: 'Manual/Bucket' }),
    folders,
  );

  assert.equal(preview.destinationPath, 'Manual/Bucket');
  assert.equal(preview.manualDestinationLocked, true);
  assert.equal(preview.needsFolderCreation, false);
});

test('destination preview falls back to ticker path when no matching folder exists', () => {
  const folders = [folder('f-msft', 'MSFT')];
  const preview = resolveDestinationPreviewForTask(task({ ticker: 'NVDA' }), folders);

  assert.equal(preview.destinationPath, 'NVDA');
  assert.equal(preview.needsFolderCreation, true);
  assert.equal(preview.manualDestinationLocked, false);
});
