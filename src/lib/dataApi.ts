import { normalizeFrontmatter } from './frontmatter';
import { Priority, TaskStatus, type Folder, type NewResearchTask, type NewResearchTaskInput, type PromptFile, type TaskActivityEvent, type Workspace } from '../types/models';

type ApiError = { message: string };
type ApiResult = { error: ApiError | null };

type TaskApiRow = Omit<NewResearchTask, 'archived'> & { archived: boolean | number | string };

const VALID_STATUS = new Set<TaskStatus>(Object.values(TaskStatus));
const VALID_PRIORITY = new Set<Priority>(Object.values(Priority));

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export function normalizeFrontmatterForApi(frontmatter: Record<string, unknown> | null | undefined) {
  if (!frontmatter) return null;
  return normalizeFrontmatter(frontmatter);
}

export function normalizeTaskInput(values: NewResearchTaskInput): NewResearchTaskInput {
  const status = VALID_STATUS.has(values.status) ? values.status : TaskStatus.Ideas;
  const priority = values.priority && VALID_PRIORITY.has(values.priority) ? values.priority : '';
  const completedAt = status === TaskStatus.Completed ? values.date_completed.trim() : '';

  return {
    ...values,
    topic: values.topic.trim(),
    details: values.details.trim(),
    ticker: values.ticker.trim().toUpperCase(),
    note_type: values.note_type.trim() || 'Research',
    assignee: values.assignee.trim(),
    priority,
    deadline: values.deadline.trim(),
    status,
    date_completed: completedAt,
    archived: Boolean(values.archived),
    linked_note_file_id: values.linked_note_file_id?.trim() ?? '',
    linked_note_path: values.linked_note_path?.trim() ?? '',
    research_location_folder_id: values.research_location_folder_id?.trim() ?? '',
    research_location_path: values.research_location_path?.trim() ?? '',
  };
}

export function mapTaskRowToModel(row: TaskApiRow): NewResearchTask {
  const normalizedStatus = VALID_STATUS.has(row.status) ? row.status : TaskStatus.Ideas;
  const normalizedPriority = row.priority && VALID_PRIORITY.has(row.priority as Priority) ? (row.priority as Priority) : '';

  return {
    ...row,
    ticker: row.ticker.trim().toUpperCase(),
    note_type: row.note_type.trim() || 'Research',
    status: normalizedStatus,
    priority: normalizedPriority,
    date_completed: normalizedStatus === TaskStatus.Completed ? row.date_completed : '',
    archived: row.archived === true || row.archived === 1 || row.archived === '1',
    linked_note_file_id: row.linked_note_file_id || '',
    linked_note_path: row.linked_note_path || '',
    research_location_folder_id: row.research_location_folder_id || '',
    research_location_path: row.research_location_path || '',
  };
}

export async function bootstrapWorkspace() {
  const response = await fetch('/api/bootstrap');
  if (!response.ok) throw new Error(await response.text());
  return readJson<{ workspace: Workspace; folders: Folder[]; files: PromptFile[] }>(response);
}

export async function createFolder(workspaceId: string, name: string, parent: Folder | null): Promise<ApiResult> {
  const path = parent ? `${parent.path}/${name}` : name;
  const response = await fetch('/api/folders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId, parentId: parent?.id ?? null, name, path }),
  });

  return readJson<ApiResult>(response);
}

export async function renameFolder(folderId: string, name: string, path: string): Promise<ApiResult> {
  const response = await fetch(`/api/folders/${folderId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, path }),
  });

  return readJson<ApiResult>(response);
}

export async function createFile(params: {
  workspaceId: string;
  folderId: string | null;
  folderPath: string | null;
  name: string;
  content: string;
  isTemplate?: boolean;
  frontmatter?: Record<string, unknown> | null;
}): Promise<ApiResult> {
  const path = params.folderPath ? `${params.folderPath}/${params.name}` : params.name;
  const response = await fetch('/api/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspaceId: params.workspaceId,
      folderId: params.folderId,
      name: params.name,
      path,
      content: params.content,
      frontmatter: normalizeFrontmatterForApi(params.frontmatter ?? null),
      isTemplate: !!params.isTemplate,
    }),
  });

  return readJson<ApiResult>(response);
}

export async function updateFile(fileId: string, values: Partial<PromptFile>): Promise<ApiResult> {
  const payload: Partial<PromptFile> = { ...values };
  if (values.frontmatter_json !== undefined) {
    payload.frontmatter_json = normalizeFrontmatterForApi(values.frontmatter_json as Record<string, unknown> | null) as PromptFile['frontmatter_json'];
  }
  const response = await fetch(`/api/files/${fileId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  return readJson<ApiResult>(response);
}

export async function deleteFile(fileId: string): Promise<ApiResult> {
  const response = await fetch(`/api/files/${fileId}`, { method: 'DELETE' });
  return readJson<ApiResult>(response);
}

export async function deleteFolder(folderId: string): Promise<ApiResult> {
  const response = await fetch(`/api/folders/${folderId}`, { method: 'DELETE' });
  return readJson<ApiResult>(response);
}

export async function listNewResearchTasks(): Promise<NewResearchTask[]> {
  const response = await fetch('/api/research-tasks');
  if (!response.ok) throw new Error(await response.text());
  const rows = await readJson<TaskApiRow[]>(response);
  return rows.map(mapTaskRowToModel);
}

export async function createNewResearchTask(values: NewResearchTaskInput): Promise<NewResearchTask> {
  const response = await fetch('/api/research-tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(normalizeTaskInput(values)),
  });
  if (!response.ok) throw new Error(await response.text());
  const row = await readJson<TaskApiRow>(response);
  return mapTaskRowToModel(row);
}

export async function updateNewResearchTask(taskId: string, values: NewResearchTaskInput): Promise<NewResearchTask> {
  const response = await fetch(`/api/research-tasks/${taskId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(normalizeTaskInput(values)),
  });
  if (!response.ok) throw new Error(await response.text());
  const row = await readJson<TaskApiRow>(response);
  return mapTaskRowToModel(row);
}

export async function deleteNewResearchTask(taskId: string): Promise<ApiResult> {
  const response = await fetch(`/api/research-tasks/${taskId}`, { method: 'DELETE' });
  if (!response.ok) throw new Error(await response.text());
  return readJson<ApiResult>(response);
}

export async function listTaskActivity(taskId: string): Promise<TaskActivityEvent[]> {
  const response = await fetch(`/api/research-tasks/${taskId}/activity`);
  if (!response.ok) throw new Error(await response.text());
  return readJson<TaskActivityEvent[]>(response);
}
