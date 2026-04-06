import type { AgentToolCall, AgentToolDefinition } from './agentProviders';
import { formatNoteTypeSuggestions, resolveCanonicalNoteType } from './noteTypeResolver';
import {
  TASK_REQUIRED_FIELDS,
  formatInvalidTaskNoteTypeMessage,
  formatMissingRequiredTaskFieldsMessage,
  validateAndNormalizeTaskContractPayload,
} from '../shared/taskValidation';

export type TaskStatus = 'ideas' | 'researching' | 'completed';
export type TaskListStatus = TaskStatus | 'archived';

export type TaskRecord = {
  id: string;
  title: string;
  ticker: string;
  note_type: string;
  status: TaskStatus;
  archived: boolean;
  linked_note_file_id?: string;
  linked_note_path?: string;
};

export type PendingActionStatus = 'pending' | 'confirmed' | 'cancelled';

export type ChatToolAdapter = {
  listTasks: () => Promise<TaskRecord[]>;
  resolveAllowedNoteTypes: () => Promise<string[]>;
  createTask: (input: {
    ticker: string;
    title: string;
    note_type: string;
    details?: string;
    assignee?: string;
    priority?: string;
    deadline?: string;
    status?: TaskStatus;
  }) => Promise<TaskRecord>;
  updateTask: (taskId: string, patch: Record<string, unknown>) => Promise<TaskRecord>;
  generateNote: (input: {
    instruction: string;
    taskId?: string;
    noteId?: string;
    title?: string;
    note_type?: string;
  }) => Promise<{ note_id: string; note_path?: string; task_id?: string; action: 'created' | 'updated'; template_path?: string | null; note_type?: string }>;
  savePendingActionDraft: (
    sessionId: string,
    actionKey: string,
    draft: Record<string, unknown>,
    status?: PendingActionStatus,
  ) => Promise<void>;
};

export type ChatToolOutcome = {
  status: 'executed' | 'needs_confirmation' | 'needs_disambiguation' | 'rejected';
  narration_before: string;
  narration_after: string;
  result?: Record<string, unknown>;
  disambiguation_prompt?: string;
  missing_fields?: string[];
};

type CreateTaskArgs = {
  ticker: string;
  title: string;
  note_type: string;
  details?: string;
  assignee?: string;
  priority?: string;
  deadline?: string;
  status?: TaskStatus;
};

type UpdateTaskArgs = {
  task_id?: string;
  task_ref?: string;
  title?: string;
  ticker?: string;
  note_type?: string;
  details?: string;
  assignee?: string;
  priority?: string;
  deadline?: string;
  status?: TaskStatus;
  archived?: boolean;
};

type ArchiveTaskArgs = {
  task_id?: string;
  task_ref?: string;
};

type ListByStatusArgs = {
  status: TaskListStatus;
};

type GenerateNoteArgs = {
  instruction: string;
  task_id?: string;
  task_ref?: string;
  note_id?: string;
  title?: string;
  note_type?: string;
};

type SupportedArgs = CreateTaskArgs | UpdateTaskArgs | ArchiveTaskArgs | ListByStatusArgs | GenerateNoteArgs;
type RiskTier = 'A' | 'B' | 'C';

type PendingConfirmRequirement = {
  tier: RiskTier;
  action?: 'archive' | 'overwrite';
  target_id?: string;
  plain_confirm_allowed: boolean;
  examples: string[];
};

type SlotPhase = 'required' | 'optional' | 'confirm';

const CREATE_TASK_SCHEMA: AgentToolDefinition = {
  name: 'create_task',
  description: 'Create a research task. Required field: ticker.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ticker: { type: 'string', minLength: 1 },
      title: { type: 'string', minLength: 1 },
      note_type: { type: 'string', minLength: 1 },
      details: { type: 'string' },
      assignee: { type: 'string' },
      priority: { type: 'string' },
      deadline: { type: 'string' },
      status: { type: 'string', enum: ['ideas', 'researching', 'completed'] },
    },
    required: ['ticker'],
  },
};

const UPDATE_TASK_SCHEMA: AgentToolDefinition = {
  name: 'update_task',
  description: 'Update an existing task by task_id or task_ref (ticker or title text).',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      task_id: { type: 'string' },
      task_ref: { type: 'string' },
      ticker: { type: 'string' },
      title: { type: 'string' },
      note_type: { type: 'string' },
      details: { type: 'string' },
      assignee: { type: 'string' },
      priority: { type: 'string' },
      deadline: { type: 'string' },
      status: { type: 'string', enum: ['ideas', 'researching', 'completed'] },
      archived: { type: 'boolean' },
    },
    anyOf: [{ required: ['task_id'] }, { required: ['task_ref'] }],
  },
};

const ARCHIVE_TASK_SCHEMA: AgentToolDefinition = {
  name: 'archive_task',
  description: 'Archive a task (never delete) by task_id or task_ref.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      task_id: { type: 'string' },
      task_ref: { type: 'string' },
    },
    anyOf: [{ required: ['task_id'] }, { required: ['task_ref'] }],
  },
};

const LIST_TASKS_BY_STATUS_SCHEMA: AgentToolDefinition = {
  name: 'list_tasks_by_status',
  description: 'List tasks by status.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { type: 'string', enum: ['ideas', 'researching', 'completed', 'archived'] },
    },
    required: ['status'],
  },
};

const GENERATE_NOTE_SCHEMA: AgentToolDefinition = {
  name: 'generate_note',
  description: 'Generate a note from instruction; create or update based on instruction context.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      instruction: { type: 'string', minLength: 1 },
      task_id: { type: 'string' },
      task_ref: { type: 'string' },
      note_id: { type: 'string' },
      title: { type: 'string' },
      note_type: { type: 'string' },
    },
    required: ['instruction'],
  },
};

export const CHAT_TOOLS: AgentToolDefinition[] = [CREATE_TASK_SCHEMA, UPDATE_TASK_SCHEMA, ARCHIVE_TASK_SCHEMA, LIST_TASKS_BY_STATUS_SCHEMA, GENERATE_NOTE_SCHEMA];

const trimString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const toUpperTicker = (value: unknown): string => trimString(value).toUpperCase();
const isFilledValue = (value: unknown): boolean => {
  if (typeof value === 'string') return value.trim().length > 0;
  return value !== undefined && value !== null;
};

const CREATE_TASK_REQUIRED_FIELDS: Array<keyof CreateTaskArgs> = [...TASK_REQUIRED_FIELDS];
const CREATE_TASK_OPTIONAL_FIELDS: Array<keyof CreateTaskArgs> = ['details', 'assignee', 'priority', 'deadline', 'status'];

const buildCreateTaskPendingDraft = (argumentsRecord: CreateTaskArgs): Record<string, unknown> => {
  const collectedValues = Object.fromEntries(
    [...CREATE_TASK_REQUIRED_FIELDS, ...CREATE_TASK_OPTIONAL_FIELDS]
      .filter((field) => isFilledValue(argumentsRecord[field]))
      .map((field) => [field, argumentsRecord[field] as unknown]),
  );
  const missingRequired = CREATE_TASK_REQUIRED_FIELDS.filter((field) => !isFilledValue(argumentsRecord[field]));
  const remainingOptional = CREATE_TASK_OPTIONAL_FIELDS.filter((field) => !isFilledValue(argumentsRecord[field]));
  const currentField = missingRequired[0] ?? remainingOptional[0] ?? null;
  const slotPhase: SlotPhase = missingRequired.length > 0 ? 'required' : (remainingOptional.length > 0 ? 'optional' : 'confirm');
  return {
    arguments: argumentsRecord,
    required_fields: CREATE_TASK_REQUIRED_FIELDS,
    optional_fields: CREATE_TASK_OPTIONAL_FIELDS,
    current_field: currentField,
    collected_values: collectedValues,
    slot_phase: slotPhase,
    missing_fields: missingRequired,
  };
};

const actionKeyFor = (toolName: string): string => `chat_tool:${toolName}`;

const findTaskMatches = (tasks: TaskRecord[], taskId?: string, taskRef?: string): TaskRecord[] => {
  const id = trimString(taskId);
  if (id) return tasks.filter((task) => task.id === id);
  const ref = trimString(taskRef).toLowerCase();
  if (!ref) return [];
  const exactTicker = tasks.filter((task) => task.ticker.toLowerCase() === ref);
  if (exactTicker.length > 0) return exactTicker;
  return tasks.filter((task) => task.title.toLowerCase().includes(ref));
};

const buildChoicePrompt = (verb: string, matches: TaskRecord[]): string => [
  `I found multiple tasks for ${verb}. Reply with the task number to continue:`,
  ...matches.map((task, index) => `${index + 1}) ${task.ticker} — ${task.title} (${task.archived ? 'archived' : task.status})`),
].join('\n');

const saveDraftAndRequireConfirm = async (
  adapter: ChatToolAdapter,
  sessionId: string,
  toolName: string,
  draft: Record<string, unknown>,
  confirmRequirement: PendingConfirmRequirement = { tier: 'B', plain_confirm_allowed: true, examples: ['/confirm', 'confirm'] },
): Promise<void> => {
  await adapter.savePendingActionDraft(sessionId, actionKeyFor(toolName), {
    tool_name: toolName,
    ...draft,
    requires_explicit_confirm: true,
    confirm_requirement: confirmRequirement,
  }, 'pending');
};

export const runChatToolOrchestration = async (
  adapter: ChatToolAdapter,
  input: { sessionId: string; toolCall: AgentToolCall; explicitConfirm?: boolean; askWhenInfoMissing?: boolean },
): Promise<ChatToolOutcome> => {
  const { toolCall, sessionId } = input;
  const explicitConfirm = Boolean(input.explicitConfirm);
  const askWhenInfoMissing = input.askWhenInfoMissing !== false;
  const args = (toolCall.arguments ?? {}) as Record<string, unknown>;
  const allowedNoteTypes = await adapter.resolveAllowedNoteTypes();
  const suggestions = formatNoteTypeSuggestions(allowedNoteTypes);

  if (toolCall.name === 'create_task') {
    const preNormalized: CreateTaskArgs = {
      ticker: toUpperTicker(args.ticker),
      title: trimString(args.title),
      note_type: trimString(args.note_type),
      details: trimString(args.details) || undefined,
      assignee: trimString(args.assignee) || undefined,
      priority: trimString(args.priority) || undefined,
      deadline: trimString(args.deadline) || undefined,
      status: args.status === 'ideas' || args.status === 'researching' || args.status === 'completed' ? args.status : undefined,
    };
    const contractValidation = validateAndNormalizeTaskContractPayload(preNormalized, allowedNoteTypes);
    const normalized: CreateTaskArgs = {
      ...preNormalized,
      ...contractValidation.normalized,
      details: contractValidation.normalized.details || undefined,
      assignee: contractValidation.normalized.assignee || undefined,
      priority: contractValidation.normalized.priority || undefined,
      deadline: contractValidation.normalized.deadline || undefined,
    };
    const missing = [...contractValidation.missingRequiredFields];
    if (missing.length > 0) {
      if (!askWhenInfoMissing) {
        return {
          status: 'rejected',
          narration_before: 'I cannot execute create_task because required fields are missing.',
          narration_after: `${formatMissingRequiredTaskFieldsMessage(missing)} Allowed note types: ${suggestions}.`,
          missing_fields: missing,
        };
      }
      await saveDraftAndRequireConfirm(adapter, sessionId, toolCall.name, buildCreateTaskPendingDraft(normalized));
      const currentField = missing[0];
      return {
        status: 'needs_confirmation',
        narration_before: 'I prepared a create_task draft and entered required-field collection.',
        narration_after: `Please provide ${currentField} first. I will collect required fields one at a time before optional fields and final confirmation.`,
        missing_fields: missing,
      };
    }
    if (contractValidation.invalidFields.includes('note_type')) {
      return {
        status: 'rejected',
        narration_before: 'I cannot execute create_task because one field is invalid.',
        narration_after: formatInvalidTaskNoteTypeMessage(allowedNoteTypes),
        missing_fields: ['note_type'],
      };
    }
    if (!explicitConfirm) {
      const pendingDraft = buildCreateTaskPendingDraft(normalized);
      await saveDraftAndRequireConfirm(adapter, sessionId, toolCall.name, pendingDraft);
      const currentField = typeof pendingDraft.current_field === 'string' ? pendingDraft.current_field : null;
      return {
        status: 'needs_confirmation',
        narration_before: 'I prepared a create_task draft.',
        narration_after: currentField
          ? `Required fields are complete. Entering optional-field phase. Next optional field: ${currentField}. Reply with a value or say "skip".`
          : 'All fields are populated. Review the summary and explicitly confirm to execute create_task.',
      };
    }
    const narrationBefore = `I will create task ${normalized.ticker} — ${normalized.title}.`;
    const created = await adapter.createTask(normalized);
    return { status: 'executed', narration_before: narrationBefore, narration_after: `Task created successfully: ${created.ticker} — ${created.title}.`, result: created as unknown as Record<string, unknown> };
  }

  if (toolCall.name === 'update_task' || toolCall.name === 'archive_task' || toolCall.name === 'generate_note') {
    const tasks = await adapter.listTasks();
    const taskId = trimString(args.task_id);
    const taskRef = trimString(args.task_ref);
    const matches = findTaskMatches(tasks, taskId, taskRef);

    if (!taskId && !taskRef && toolCall.name !== 'generate_note') {
      if (!askWhenInfoMissing) {
        return { status: 'rejected', narration_before: `I cannot execute ${toolCall.name} because task reference is missing.`, narration_after: 'Provide task_id or task_ref.', missing_fields: ['task_id|task_ref'] };
      }
      await saveDraftAndRequireConfirm(adapter, sessionId, toolCall.name, { arguments: args, missing_fields: ['task_id|task_ref'] });
      return { status: 'needs_confirmation', narration_before: `I prepared a ${toolCall.name} draft but task reference is missing.`, narration_after: 'Draft saved. Provide task_id or task_ref and explicitly confirm to execute.', missing_fields: ['task_id|task_ref'] };
    }

    if (matches.length > 1) {
      const prompt = buildChoicePrompt(toolCall.name.replace('_', ' '), matches);
      await saveDraftAndRequireConfirm(adapter, sessionId, toolCall.name, { arguments: args, ambiguous_matches: matches.map((task) => ({ id: task.id, ticker: task.ticker, title: task.title })) });
      return { status: 'needs_disambiguation', narration_before: 'I found multiple matching tasks, so I will not auto-pick.', narration_after: 'Please pick one numbered option, then explicitly confirm.', disambiguation_prompt: prompt };
    }

    if ((taskId || taskRef) && matches.length === 0 && toolCall.name !== 'generate_note') {
      return { status: 'rejected', narration_before: 'I tried to resolve the task reference.', narration_after: 'No matching task was found. Please provide a valid task_id or clearer task_ref.' };
    }

    const resolvedTask = matches[0];

    if (toolCall.name === 'update_task') {
      const patch: UpdateTaskArgs = {
        title: trimString(args.title) || undefined,
        ticker: toUpperTicker(args.ticker) || undefined,
        note_type: trimString(args.note_type) || undefined,
        details: trimString(args.details) || undefined,
        assignee: trimString(args.assignee) || undefined,
        priority: trimString(args.priority) || undefined,
        deadline: trimString(args.deadline) || undefined,
        status: args.status === 'ideas' || args.status === 'researching' || args.status === 'completed' ? args.status : undefined,
        archived: typeof args.archived === 'boolean' ? args.archived : undefined,
      };
      if (patch.note_type) {
        const canonical = resolveCanonicalNoteType(patch.note_type, allowedNoteTypes);
        if (!canonical) {
          await saveDraftAndRequireConfirm(adapter, sessionId, toolCall.name, { task_id: resolvedTask?.id, patch, missing_fields: ['note_type'] });
          return { status: 'needs_confirmation', narration_before: 'I prepared an update_task draft but note_type is invalid.', narration_after: `Allowed note types: ${suggestions}.`, missing_fields: ['note_type'] };
        }
        patch.note_type = canonical;
      }
      const hasPatchFields = Object.values(patch).some((value) => value !== undefined && value !== '');
      if (!resolvedTask || !hasPatchFields) {
        const missing: string[] = [];
        if (!resolvedTask) missing.push('task_id|task_ref');
        if (!hasPatchFields) missing.push('at least one update field');
        await saveDraftAndRequireConfirm(adapter, sessionId, toolCall.name, { arguments: args, missing_fields: missing });
        return { status: 'needs_confirmation', narration_before: 'I prepared an update_task draft but it is incomplete.', narration_after: `Draft saved. Missing: ${missing.join(', ')}. Explicit confirm is required after completion.`, missing_fields: missing };
      }
      if (!explicitConfirm) {
        await saveDraftAndRequireConfirm(adapter, sessionId, toolCall.name, { task_id: resolvedTask.id, patch });
        return { status: 'needs_confirmation', narration_before: `I resolved task ${resolvedTask.ticker} — ${resolvedTask.title}.`, narration_after: 'Draft saved. Please explicitly confirm before I apply updates.' };
      }
      const narrationBefore = `I will update task ${resolvedTask.ticker} — ${resolvedTask.title}.`;
      const updated = await adapter.updateTask(resolvedTask.id, patch as Record<string, unknown>);
      return { status: 'executed', narration_before: narrationBefore, narration_after: `Task updated successfully: ${updated.ticker} — ${updated.title}.`, result: updated as unknown as Record<string, unknown> };
    }

    if (toolCall.name === 'archive_task') {
      if (!resolvedTask) {
        await saveDraftAndRequireConfirm(adapter, sessionId, toolCall.name, { arguments: args, missing_fields: ['task_id|task_ref'] });
        return { status: 'needs_confirmation', narration_before: 'I prepared an archive_task draft but task reference is missing.', narration_after: 'Draft saved. Provide task_id or task_ref and explicitly confirm.', missing_fields: ['task_id|task_ref'] };
      }
      if (!explicitConfirm) {
        await saveDraftAndRequireConfirm(adapter, sessionId, toolCall.name, { task_id: resolvedTask.id, archived: true }, { tier: 'C', action: 'archive', target_id: resolvedTask.id, plain_confirm_allowed: false, examples: [`/confirm archive ${resolvedTask.id}`] });
        return { status: 'needs_confirmation', narration_before: `I resolved task ${resolvedTask.ticker} — ${resolvedTask.title}.`, narration_after: `Draft saved. To continue, reply: /confirm archive ${resolvedTask.id}.` };
      }
      const narrationBefore = `I will archive task ${resolvedTask.ticker} — ${resolvedTask.title}.`;
      const updated = await adapter.updateTask(resolvedTask.id, { archived: true });
      return { status: 'executed', narration_before: narrationBefore, narration_after: `Task archived successfully: ${updated.ticker} — ${updated.title}.`, result: updated as unknown as Record<string, unknown> };
    }

    const normalizedGenerate: GenerateNoteArgs = {
      instruction: trimString(args.instruction),
      task_id: resolvedTask?.id,
      task_ref: taskRef || undefined,
      note_id: trimString(args.note_id) || undefined,
      title: trimString(args.title) || undefined,
      note_type: trimString(args.note_type) || undefined,
    };
    const missingGenerate: string[] = [];
    if (!normalizedGenerate.instruction) missingGenerate.push('instruction');
    const requiresCreateNoteType = !normalizedGenerate.note_id;
    const canonicalGenerateType = resolveCanonicalNoteType(normalizedGenerate.note_type ?? resolvedTask?.note_type ?? '', allowedNoteTypes);
    if (requiresCreateNoteType && !canonicalGenerateType) missingGenerate.push('note_type');
    if (missingGenerate.length > 0) {
      await saveDraftAndRequireConfirm(adapter, sessionId, toolCall.name, {
        arguments: { ...normalizedGenerate, note_type: canonicalGenerateType ?? normalizedGenerate.note_type },
        missing_fields: missingGenerate,
        slots: {
          required: ['instruction', ...(requiresCreateNoteType ? ['note_type'] : [])],
          optional: ['title', 'task_id|task_ref', 'note_id'],
          suggestions: { note_type: allowedNoteTypes },
        },
      });
      return {
        status: 'needs_confirmation',
        narration_before: 'I prepared a generate_note draft but required fields are missing.',
        narration_after: `Please provide required fields first (${missingGenerate.join(', ')}). Allowed note types: ${suggestions}. Then provide optional fields or say "skip" for each optional field.`,
        missing_fields: missingGenerate,
      };
    }
    normalizedGenerate.note_type = canonicalGenerateType ?? undefined;

    if (!explicitConfirm && (!normalizedGenerate.task_id || matches.length > 0)) {
      const isOverwrite = Boolean(normalizedGenerate.note_id);
      const confirmRequirement: PendingConfirmRequirement = isOverwrite
        ? { tier: 'C', action: 'overwrite', target_id: normalizedGenerate.note_id, plain_confirm_allowed: false, examples: [`/confirm overwrite ${normalizedGenerate.note_id}`] }
        : { tier: 'B', plain_confirm_allowed: true, examples: ['/confirm', 'confirm'] };
      const templateSummary = normalizedGenerate.note_id ? 'existing note update' : `template routing by note_type=${normalizedGenerate.note_type}`;
      await saveDraftAndRequireConfirm(adapter, sessionId, toolCall.name, { ...normalizedGenerate, confirmation_summary: { note_type: normalizedGenerate.note_type ?? null, template_mapping: templateSummary } } as unknown as Record<string, unknown>, confirmRequirement);
      return {
        status: 'needs_confirmation',
        narration_before: 'I prepared a generate_note draft.',
        narration_after: isOverwrite
          ? `Draft saved. To continue, reply: /confirm overwrite ${normalizedGenerate.note_id}.`
          : `Draft saved. Confirmation summary: note type ${normalizedGenerate.note_type}; ${templateSummary}. Reply /confirm (or confirm) when ready.`,
      };
    }
    const narrationBefore = normalizedGenerate.task_id
      ? `I will generate/update the note for ${resolvedTask?.ticker} — ${resolvedTask?.title} (note type: ${normalizedGenerate.note_type ?? resolvedTask?.note_type ?? 'n/a'}).`
      : `I will generate a note based on your instruction (note type: ${normalizedGenerate.note_type}).`;
    const noteResult = await adapter.generateNote({
      instruction: normalizedGenerate.instruction,
      taskId: normalizedGenerate.task_id,
      noteId: normalizedGenerate.note_id,
      title: normalizedGenerate.title,
      note_type: normalizedGenerate.note_type,
    });
    return {
      status: 'executed',
      narration_before: narrationBefore,
      narration_after: `Note ${noteResult.action} successfully (note_id: ${noteResult.note_id}, note_type: ${noteResult.note_type ?? normalizedGenerate.note_type ?? 'n/a'}, template: ${noteResult.template_path ?? 'none'}).`,
      result: noteResult as unknown as Record<string, unknown>,
    };
  }

  if (toolCall.name === 'list_tasks_by_status') {
    const status = args.status;
    if (status !== 'ideas' && status !== 'researching' && status !== 'completed' && status !== 'archived') {
      return { status: 'rejected', narration_before: 'I attempted to list tasks by status.', narration_after: 'Invalid status. Use one of ideas, researching, completed, archived.' };
    }
    const all = await adapter.listTasks();
    const filtered = status === 'archived' ? all.filter((task) => task.archived) : all.filter((task) => !task.archived && task.status === status);
    return { status: 'executed', narration_before: `I will list tasks in ${status}.`, narration_after: `Found ${filtered.length} task(s) in ${status}.`, result: { status, tasks: filtered } };
  }

  return { status: 'rejected', narration_before: 'I received a tool call.', narration_after: `Unsupported tool: ${toolCall.name}.` };
};

export const chatToolSchemas = {
  create_task: CREATE_TASK_SCHEMA,
  update_task: UPDATE_TASK_SCHEMA,
  archive_task: ARCHIVE_TASK_SCHEMA,
  list_tasks_by_status: LIST_TASKS_BY_STATUS_SCHEMA,
  generate_note: GENERATE_NOTE_SCHEMA,
} as const;

export const isSupportedChatTool = (name: string): name is keyof typeof chatToolSchemas => name in chatToolSchemas;
export const parseToolArgs = <T extends SupportedArgs>(toolCall: AgentToolCall): T => (toolCall.arguments ?? {}) as T;
