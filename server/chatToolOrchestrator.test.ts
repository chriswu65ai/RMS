import test from 'node:test';
import assert from 'node:assert/strict';
import { runChatToolOrchestration } from './chatToolOrchestrator.js';
import type { ChatToolAdapter, TaskRecord } from './chatToolOrchestrator.js';

const sampleTasks: TaskRecord[] = [
  { id: 'task-1', ticker: 'AAPL', title: 'Apple idea', note_type: 'Research', status: 'ideas', archived: false },
  { id: 'task-2', ticker: 'MSFT', title: 'Microsoft deep dive', note_type: 'Research', status: 'researching', archived: false },
  { id: 'task-3', ticker: 'AAPL', title: 'Apple valuation refresh', note_type: 'Research', status: 'completed', archived: true },
];

const makeAdapter = () => {
  const calls = {
    listTasks: 0,
    createTask: [] as Array<Record<string, unknown>>,
    updateTask: [] as Array<{ taskId: string; patch: Record<string, unknown> }>,
    generateNote: [] as Array<Record<string, unknown>>,
    drafts: [] as Array<{ sessionId: string; actionKey: string; draft: Record<string, unknown>; status?: string }>,
  };

  const adapter: ChatToolAdapter = {
    listTasks: async () => {
      calls.listTasks += 1;
      return sampleTasks;
    },
    createTask: async (input) => {
      calls.createTask.push(input as unknown as Record<string, unknown>);
      return { ...sampleTasks[0], ...input, id: 'created-task', archived: false };
    },
    updateTask: async (taskId, patch) => {
      calls.updateTask.push({ taskId, patch });
      const base = sampleTasks.find((task) => task.id === taskId) ?? sampleTasks[0];
      return { ...base, ...patch } as TaskRecord;
    },
    generateNote: async (input) => {
      calls.generateNote.push(input as unknown as Record<string, unknown>);
      return {
        note_id: input.noteId ?? 'note-created',
        action: input.noteId ? 'updated' : 'created',
      };
    },
    savePendingActionDraft: async (sessionId, actionKey, draft, status) => {
      calls.drafts.push({ sessionId, actionKey, draft, status });
    },
  };

  return { adapter, calls };
};

test('chat tool orchestration supports auto-exec create_task and explicit confirm flow for update_task', async () => {
  const { adapter, calls } = makeAdapter();

  const created = await runChatToolOrchestration(adapter, {
    sessionId: 'session-1',
    toolCall: {
      id: 'tool-1',
      name: 'create_task',
      arguments: { ticker: 'nvda', title: 'Earnings prep', note_type: 'Research' },
    },
  });

  assert.equal(created.status, 'executed');
  assert.equal(calls.createTask.length, 1);
  assert.equal(calls.drafts.length, 0);

  const updateNeedsConfirm = await runChatToolOrchestration(adapter, {
    sessionId: 'session-1',
    toolCall: {
      id: 'tool-2',
      name: 'update_task',
      arguments: { task_id: 'task-1', status: 'researching' },
    },
    explicitConfirm: false,
  });

  assert.equal(updateNeedsConfirm.status, 'needs_confirmation');
  assert.equal(calls.updateTask.length, 0);
  assert.equal(calls.drafts.length, 1);
  assert.equal(calls.drafts[0]?.actionKey, 'chat_tool:update_task');

  const updateConfirmed = await runChatToolOrchestration(adapter, {
    sessionId: 'session-1',
    toolCall: {
      id: 'tool-3',
      name: 'update_task',
      arguments: { task_id: 'task-1', status: 'completed' },
    },
    explicitConfirm: true,
  });

  assert.equal(updateConfirmed.status, 'executed');
  assert.equal(calls.updateTask.length, 1);
  assert.deepEqual(calls.updateTask[0], { taskId: 'task-1', patch: { status: 'completed', title: undefined, ticker: undefined, note_type: undefined, details: undefined, assignee: undefined, priority: undefined, deadline: undefined, archived: undefined } });
});

test('chat tool orchestration returns disambiguation prompt for ambiguous task_ref', async () => {
  const { adapter, calls } = makeAdapter();

  const result = await runChatToolOrchestration(adapter, {
    sessionId: 'session-ambiguous',
    toolCall: {
      id: 'tool-ambiguous',
      name: 'archive_task',
      arguments: { task_ref: 'aapl' },
    },
    explicitConfirm: true,
  });

  assert.equal(result.status, 'needs_disambiguation');
  assert.match(result.disambiguation_prompt ?? '', /Reply with the task number/);
  assert.match(result.disambiguation_prompt ?? '', /1\) AAPL — Apple idea/);
  assert.match(result.disambiguation_prompt ?? '', /2\) AAPL — Apple valuation refresh/);
  assert.equal(calls.updateTask.length, 0);
  assert.equal(calls.drafts.length, 1);
});

test('chat tool orchestration enforces archive-only behavior and list-by-status filtering', async () => {
  const { adapter, calls } = makeAdapter();

  const archiveRejected = await runChatToolOrchestration(adapter, {
    sessionId: 'session-archive',
    toolCall: {
      id: 'tool-bad',
      name: 'delete_task',
      arguments: { task_id: 'task-1' },
    },
    explicitConfirm: true,
  });
  assert.equal(archiveRejected.status, 'rejected');
  assert.match(archiveRejected.narration_after, /Unsupported tool: delete_task/);

  const archiveNeedsConfirm = await runChatToolOrchestration(adapter, {
    sessionId: 'session-archive',
    toolCall: {
      id: 'tool-archive',
      name: 'archive_task',
      arguments: { task_id: 'task-2' },
    },
    explicitConfirm: false,
  });
  assert.equal(archiveNeedsConfirm.status, 'needs_confirmation');
  assert.equal(calls.updateTask.length, 0);

  const archiveConfirmed = await runChatToolOrchestration(adapter, {
    sessionId: 'session-archive',
    toolCall: {
      id: 'tool-archive-confirm',
      name: 'archive_task',
      arguments: { task_id: 'task-2' },
    },
    explicitConfirm: true,
  });
  assert.equal(archiveConfirmed.status, 'executed');
  assert.deepEqual(calls.updateTask[0], { taskId: 'task-2', patch: { archived: true } });

  const researching = await runChatToolOrchestration(adapter, {
    sessionId: 'session-list',
    toolCall: { id: 'tool-list-1', name: 'list_tasks_by_status', arguments: { status: 'researching' } },
  });
  assert.equal(researching.status, 'executed');
  assert.deepEqual((researching.result?.tasks as TaskRecord[]).map((task) => task.id), ['task-2']);

  const archived = await runChatToolOrchestration(adapter, {
    sessionId: 'session-list',
    toolCall: { id: 'tool-list-2', name: 'list_tasks_by_status', arguments: { status: 'archived' } },
  });
  assert.equal(archived.status, 'executed');
  assert.deepEqual((archived.result?.tasks as TaskRecord[]).map((task) => task.id), ['task-3']);
});

test('chat tool orchestration supports generate_note create and update modes', async () => {
  const { adapter, calls } = makeAdapter();

  const needsConfirm = await runChatToolOrchestration(adapter, {
    sessionId: 'session-note',
    toolCall: {
      id: 'tool-note-1',
      name: 'generate_note',
      arguments: { instruction: 'Draft memo for Microsoft task', task_ref: 'microsoft' },
    },
    explicitConfirm: false,
  });

  assert.equal(needsConfirm.status, 'needs_confirmation');
  assert.equal(calls.generateNote.length, 0);

  const createMode = await runChatToolOrchestration(adapter, {
    sessionId: 'session-note',
    toolCall: {
      id: 'tool-note-2',
      name: 'generate_note',
      arguments: { instruction: 'Create new overview note', title: 'Overview' },
    },
    explicitConfirm: true,
  });
  assert.equal(createMode.status, 'executed');
  assert.match(createMode.narration_after, /Note created successfully/);

  const updateMode = await runChatToolOrchestration(adapter, {
    sessionId: 'session-note',
    toolCall: {
      id: 'tool-note-3',
      name: 'generate_note',
      arguments: { instruction: 'Refresh numbers', task_id: 'task-2', note_id: 'note-2' },
    },
    explicitConfirm: true,
  });

  assert.equal(updateMode.status, 'executed');
  assert.match(updateMode.narration_after, /Note updated successfully/);
  assert.deepEqual(calls.generateNote, [
    { instruction: 'Create new overview note', taskId: undefined, noteId: undefined, title: 'Overview' },
    { instruction: 'Refresh numbers', taskId: 'task-2', noteId: 'note-2', title: undefined },
  ]);
});

test('chat tool orchestration saves missing fields for create_task and allows explicit disambiguation selection follow-up', async () => {
  const { adapter, calls } = makeAdapter();

  const missingCreateFields = await runChatToolOrchestration(adapter, {
    sessionId: 'session-missing',
    toolCall: {
      id: 'tool-missing',
      name: 'create_task',
      arguments: { ticker: 'amzn', title: 'Amazon refresh' },
    },
    explicitConfirm: true,
  });

  assert.equal(missingCreateFields.status, 'needs_confirmation');
  assert.deepEqual(missingCreateFields.missing_fields, ['note_type']);
  assert.equal(calls.createTask.length, 0);
  assert.equal(calls.drafts.at(-1)?.status, 'pending');
  assert.deepEqual(calls.drafts.at(-1)?.draft.missing_fields, ['note_type']);

  const ambiguousArchive = await runChatToolOrchestration(adapter, {
    sessionId: 'session-disambiguation',
    toolCall: {
      id: 'tool-archive-ambiguous',
      name: 'archive_task',
      arguments: { task_ref: 'aapl' },
    },
    explicitConfirm: true,
  });
  assert.equal(ambiguousArchive.status, 'needs_disambiguation');
  assert.equal(calls.updateTask.length, 0);

  const archiveSelectionConfirmed = await runChatToolOrchestration(adapter, {
    sessionId: 'session-disambiguation',
    toolCall: {
      id: 'tool-archive-selection',
      name: 'archive_task',
      arguments: { task_id: 'task-3' },
    },
    explicitConfirm: true,
  });
  assert.equal(archiveSelectionConfirmed.status, 'executed');
  assert.deepEqual(calls.updateTask.at(-1), { taskId: 'task-3', patch: { archived: true } });
});
