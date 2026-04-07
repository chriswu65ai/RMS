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
    resolveAllowedNoteTypes: 0,
    updateTask: [] as Array<{ taskId: string; patch: Record<string, unknown> }>,
    generateNote: [] as Array<Record<string, unknown>>,
    drafts: [] as Array<{ sessionId: string; actionKey: string; draft: Record<string, unknown>; status?: string }>,
  };

  const adapter: ChatToolAdapter = {
    listTasks: async () => {
      calls.listTasks += 1;
      return sampleTasks;
    },
    resolveAllowedNoteTypes: async () => {
      calls.resolveAllowedNoteTypes += 1;
      return ['Research', 'Event', 'Earnings'];
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
  assert.match(archiveNeedsConfirm.narration_after, /\/confirm archive task-2/);
  assert.equal(calls.updateTask.length, 0);
  assert.deepEqual(calls.drafts.at(-1)?.draft.confirm_requirement, {
    tier: 'C',
    action: 'archive',
    target_id: 'task-2',
    plain_confirm_allowed: false,
    examples: ['/confirm archive task-2'],
  });

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
      arguments: { instruction: 'Create new overview note', title: 'Overview', note_type: 'research' },
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
    { instruction: 'Create new overview note', taskId: undefined, noteId: undefined, title: 'Overview', note_type: 'Research' },
    { instruction: 'Refresh numbers', taskId: 'task-2', noteId: 'note-2', title: undefined },
  ]);
});

test('chat tool orchestration marks note overwrite drafts as Tier C confirmation', async () => {
  const { adapter, calls } = makeAdapter();

  const needsConfirm = await runChatToolOrchestration(adapter, {
    sessionId: 'session-note-overwrite',
    toolCall: {
      id: 'tool-note-overwrite',
      name: 'generate_note',
      arguments: { instruction: 'Rewrite with latest numbers', note_id: 'note-77', title: 'Q2 note' },
    },
    explicitConfirm: false,
  });

  assert.equal(needsConfirm.status, 'needs_confirmation');
  assert.match(needsConfirm.narration_after, /\/confirm overwrite note-77/);
  assert.equal(calls.generateNote.length, 0);
  assert.deepEqual(calls.drafts.at(-1)?.draft.confirm_requirement, {
    tier: 'C',
    action: 'overwrite',
    target_id: 'note-77',
    plain_confirm_allowed: false,
    examples: ['/confirm overwrite note-77'],
  });
});

test('chat tool orchestration saves missing fields for create_task and allows explicit disambiguation selection follow-up', async () => {
  const { adapter, calls } = makeAdapter();

  const missingCreateFields = await runChatToolOrchestration(adapter, {
    sessionId: 'session-missing',
    toolCall: {
      id: 'tool-missing',
      name: 'create_task',
      arguments: { title: 'Amazon refresh' },
    },
    explicitConfirm: true,
  });

  assert.equal(missingCreateFields.status, 'needs_confirmation');
  assert.deepEqual(missingCreateFields.missing_fields, ['ticker']);
  assert.equal(calls.createTask.length, 0);
  assert.equal(calls.drafts.at(-1)?.status, 'pending');
  assert.deepEqual(calls.drafts.at(-1)?.draft.missing_fields, ['ticker']);

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

test('chat tool orchestration rejects missing required fields when askWhenInfoMissing is disabled', async () => {
  const { adapter, calls } = makeAdapter();

  const missingCreateFields = await runChatToolOrchestration(adapter, {
    sessionId: 'session-missing-reject',
    toolCall: {
      id: 'tool-missing-reject',
      name: 'create_task',
      arguments: { title: 'No ticker' },
    },
    explicitConfirm: true,
    askWhenInfoMissing: false,
  });

  assert.equal(missingCreateFields.status, 'rejected');
  assert.deepEqual(missingCreateFields.missing_fields, ['ticker']);
  assert.equal(calls.drafts.length, 0);
});


test('create_task with invalid note_type is rejected with allowed options', async () => {
  const { adapter } = makeAdapter();

  const invalid = await runChatToolOrchestration(adapter, {
    sessionId: 'session-note-invalid',
    toolCall: { id: 'tool-invalid-note-type', name: 'create_task', arguments: { ticker: 'AAPL', title: 'Bad type', note_type: 'unknown' } },
    explicitConfirm: true,
    askWhenInfoMissing: false,
  });
  assert.equal(invalid.status, 'rejected');
  assert.match(invalid.narration_after, /Invalid note_type\. Allowed values: Research, Event, Earnings\./);
});

test('create_task accepts note_type discovered from note frontmatter via adapter allowed list', async () => {
  const { adapter, calls } = makeAdapter();
  adapter.resolveAllowedNoteTypes = async () => ['Research', 'Event', 'FrontmatterOnly'];

  const created = await runChatToolOrchestration(adapter, {
    sessionId: 'session-frontmatter-type',
    toolCall: { id: 'tool-frontmatter-type', name: 'create_task', arguments: { ticker: 'AAPL', title: 'Discovered type', note_type: 'frontmatteronly' } },
    explicitConfirm: true,
  });

  assert.equal(created.status, 'executed');
  assert.equal(calls.createTask.length, 1);
  assert.equal(calls.createTask[0]?.note_type, 'FrontmatterOnly');
});

test('generate_note create flow is blocked until valid note_type is provided', async () => {
  const { adapter, calls } = makeAdapter();
  const blocked = await runChatToolOrchestration(adapter, {
    sessionId: 'session-generate-blocked',
    toolCall: { id: 'tool-generate-blocked', name: 'generate_note', arguments: { instruction: 'Draft now', title: 'Draft' } },
    explicitConfirm: true,
  });
  assert.equal(blocked.status, 'needs_confirmation');
  assert.deepEqual(blocked.missing_fields, ['note_type']);
  assert.equal(calls.generateNote.length, 0);

  const corrected = await runChatToolOrchestration(adapter, {
    sessionId: 'session-generate-corrected',
    toolCall: { id: 'tool-generate-corrected', name: 'generate_note', arguments: { instruction: 'Draft now', title: 'Draft', note_type: 'event' } },
    explicitConfirm: true,
  });
  assert.equal(corrected.status, 'executed');
  assert.equal(calls.generateNote.at(-1)?.note_type, 'Event');
  assert.match(corrected.narration_after, /note_type: Event/);
});


test('chat create_task acceptance and rejection mirror API contract wording for equivalent payloads', async () => {
  const { adapter } = makeAdapter();

  const accepted = await runChatToolOrchestration(adapter, {
    sessionId: 'session-contract-accept',
    toolCall: {
      id: 'tool-contract-accept',
      name: 'create_task',
      arguments: { ticker: 'nvda', note_type: 'research', title: 'Contract check' },
    },
    explicitConfirm: true,
  });
  assert.equal(accepted.status, 'executed');

  const missingTicker = await runChatToolOrchestration(adapter, {
    sessionId: 'session-contract-missing',
    toolCall: {
      id: 'tool-contract-missing',
      name: 'create_task',
      arguments: { note_type: 'Research' },
    },
    explicitConfirm: true,
    askWhenInfoMissing: false,
  });
  assert.equal(missingTicker.status, 'rejected');
  assert.equal(missingTicker.narration_after.includes('Missing required fields: ticker.'), true);

  const invalidNoteType = await runChatToolOrchestration(adapter, {
    sessionId: 'session-contract-invalid',
    toolCall: {
      id: 'tool-contract-invalid',
      name: 'create_task',
      arguments: { ticker: 'NVDA', note_type: 'NotAType' },
    },
    explicitConfirm: true,
  });
  assert.equal(invalidNoteType.status, 'rejected');
  assert.equal(invalidNoteType.narration_after.includes('Invalid note_type. Allowed values:'), true);
});
