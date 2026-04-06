export type TaskStatusValue = 'ideas' | 'researching' | 'completed';
export type TaskPriorityValue = '' | 'low' | 'medium' | 'high';

export const TASK_REQUIRED_FIELDS = ['ticker'] as const;
export const TASK_OPTIONAL_FIELDS = [
  'title',
  'details',
  'assignee',
  'priority',
  'deadline',
  'status',
  'date_completed',
  'archived',
  'linked_note_file_id',
  'linked_note_path',
  'research_location_folder_id',
  'research_location_path',
] as const;

export const TASK_FIELD_DEFAULTS = {
  title: '',
  details: '',
  ticker: '',
  note_type: '',
  assignee: '',
  priority: '' as TaskPriorityValue,
  deadline: '',
  status: 'ideas' as TaskStatusValue,
  date_completed: '',
  archived: false,
  linked_note_file_id: '',
  linked_note_path: '',
  research_location_folder_id: '',
  research_location_path: '',
};

const VALID_STATUSES: ReadonlySet<TaskStatusValue> = new Set<TaskStatusValue>(['ideas', 'researching', 'completed']);
const VALID_PRIORITIES: ReadonlySet<TaskPriorityValue> = new Set<TaskPriorityValue>(['', 'low', 'medium', 'high']);

export type TaskContractPayload = Partial<Record<keyof typeof TASK_FIELD_DEFAULTS, unknown>>;

export type NormalizedTaskContractPayload = {
  title: string;
  details: string;
  ticker: string;
  note_type: string;
  assignee: string;
  priority: TaskPriorityValue;
  deadline: string;
  status: TaskStatusValue;
  date_completed: string;
  archived: boolean;
  linked_note_file_id: string;
  linked_note_path: string;
  research_location_folder_id: string;
  research_location_path: string;
};

export type TaskContractValidationResult = {
  normalized: NormalizedTaskContractPayload;
  missingRequiredFields: string[];
  invalidFields: string[];
};

export const formatMissingRequiredTaskFieldsMessage = (fields: string[]): string => `Missing required fields: ${fields.join(', ')}.`;
export const formatInvalidTaskNoteTypeMessage = (allowedNoteTypes: string[]): string => `Invalid note_type. Allowed values: ${allowedNoteTypes.join(', ')}.`;

const canonicalizeNoteType = (value: unknown, allowedNoteTypes: string[]): string => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return allowedNoteTypes.find((allowed) => allowed.toLowerCase() === trimmed.toLowerCase()) ?? '';
};

const normalizeStatus = (value: unknown): TaskStatusValue => {
  if (typeof value !== 'string') return TASK_FIELD_DEFAULTS.status;
  const trimmed = value.trim().toLowerCase();
  return VALID_STATUSES.has(trimmed as TaskStatusValue) ? (trimmed as TaskStatusValue) : TASK_FIELD_DEFAULTS.status;
};

const normalizePriority = (value: unknown): TaskPriorityValue => {
  if (typeof value !== 'string') return TASK_FIELD_DEFAULTS.priority;
  const trimmed = value.trim().toLowerCase() as TaskPriorityValue;
  return VALID_PRIORITIES.has(trimmed) ? trimmed : TASK_FIELD_DEFAULTS.priority;
};

const normalizeDateCompleted = (value: unknown, status: TaskStatusValue): string => {
  if (status !== 'completed') return '';
  return typeof value === 'string' ? value.trim() : '';
};

export const validateAndNormalizeTaskContractPayload = (
  payload: TaskContractPayload,
  allowedNoteTypes: string[],
): TaskContractValidationResult => {
  const normalizedStatus = normalizeStatus(payload.status);
  const normalized: NormalizedTaskContractPayload = {
    title: typeof payload.title === 'string' ? payload.title.trim() : TASK_FIELD_DEFAULTS.title,
    details: typeof payload.details === 'string' ? payload.details.trim() : TASK_FIELD_DEFAULTS.details,
    ticker: typeof payload.ticker === 'string' ? payload.ticker.trim().toUpperCase() : TASK_FIELD_DEFAULTS.ticker,
    note_type: canonicalizeNoteType(payload.note_type, allowedNoteTypes),
    assignee: typeof payload.assignee === 'string' ? payload.assignee.trim() : TASK_FIELD_DEFAULTS.assignee,
    priority: normalizePriority(payload.priority),
    deadline: typeof payload.deadline === 'string' ? payload.deadline.trim() : TASK_FIELD_DEFAULTS.deadline,
    status: normalizedStatus,
    date_completed: normalizeDateCompleted(payload.date_completed, normalizedStatus),
    archived: Boolean(payload.archived),
    linked_note_file_id: typeof payload.linked_note_file_id === 'string' ? payload.linked_note_file_id.trim() : TASK_FIELD_DEFAULTS.linked_note_file_id,
    linked_note_path: typeof payload.linked_note_path === 'string' ? payload.linked_note_path.trim() : TASK_FIELD_DEFAULTS.linked_note_path,
    research_location_folder_id: typeof payload.research_location_folder_id === 'string' ? payload.research_location_folder_id.trim() : TASK_FIELD_DEFAULTS.research_location_folder_id,
    research_location_path: typeof payload.research_location_path === 'string' ? payload.research_location_path.trim() : TASK_FIELD_DEFAULTS.research_location_path,
  };

  const missingRequiredFields = TASK_REQUIRED_FIELDS.filter((field) => normalized[field].trim().length === 0);
  const invalidFields = typeof payload.note_type === 'string' && payload.note_type.trim().length > 0 && !normalized.note_type ? ['note_type'] : [];

  return { normalized, missingRequiredFields, invalidFields };
};
