import { validateAndNormalizeTaskContractPayload } from '../../shared/taskValidation';
import { normalizeFrontmatter } from './frontmatter';
import { trackAttachmentEndpoint } from './attachmentTelemetry';
import { createRequestLimiter } from './requestLimiter';
import {
  Priority,
  TaskStatus,
  type Attachment,
  type AttachmentLinkType,
  type AttachmentStorageSettings,
  type Folder,
  type NewResearchTask,
  type NewResearchTaskInput,
  type ResearchNote,
  type TaskActivityEvent,
  type Workspace,
} from '../types/models';

type ApiError = { message: string };
type ApiResult = { error: ApiError | null };
type SystemLogEntry = {
  timestamp: string;
  level: string;
  area?: string;
  message: string;
  details?: unknown;
  request_id?: string;
};
type SystemLogQuery = {
  level?: string;
  from?: string;
  to?: string;
  q?: string;
  limit?: number;
  cursor?: string | null;
};
type SystemLogListResponse = {
  entries: SystemLogEntry[];
  page?: {
    limit: number;
    returned: number;
    has_more: boolean;
    next_cursor: string | null;
  };
};

type TaskApiRow = Omit<NewResearchTask, 'archived'> & { archived: boolean | number | string };

const VALID_STATUS = new Set<TaskStatus>(Object.values(TaskStatus));
const VALID_PRIORITY = new Set<Priority>(Object.values(Priority));
const attachmentRequestLimiter = createRequestLimiter(4);

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function runAttachmentRequest<T>(endpoint: string, request: () => Promise<Response>): Promise<T> {
  const startedAt = Date.now();
  try {
    const response = await attachmentRequestLimiter.schedule(request);
    if (!response.ok) throw new Error(await response.text());
    return await readJson<T>(response);
  } finally {
    trackAttachmentEndpoint(endpoint, Date.now() - startedAt);
  }
}

export function normalizeFrontmatterForApi(frontmatter: Record<string, unknown> | null | undefined) {
  if (!frontmatter) return null;
  return normalizeFrontmatter(frontmatter);
}

export function normalizeTaskInput(values: NewResearchTaskInput): NewResearchTaskInput {
  // Client-side pre-normalization only; the API remains authoritative and re-normalizes.
  const normalized = validateAndNormalizeTaskContractPayload(values, values.note_type ? [values.note_type] : []).normalized;
  const status = VALID_STATUS.has(normalized.status as TaskStatus) ? (normalized.status as TaskStatus) : TaskStatus.Ideas;
  const priority = normalized.priority && VALID_PRIORITY.has(normalized.priority as Priority)
    ? (normalized.priority as Priority)
    : '';

  return {
    ...values,
    ...normalized,
    note_type: values.note_type.trim(),
    status,
    priority,
  };
}

export function mapTaskRowToModel(row: TaskApiRow): NewResearchTask {
  const normalizedStatus = VALID_STATUS.has(row.status) ? row.status : TaskStatus.Ideas;
  const normalizedPriority = row.priority && VALID_PRIORITY.has(row.priority as Priority) ? (row.priority as Priority) : '';

  return {
    ...row,
    ticker: row.ticker.trim().toUpperCase(),
    note_type: row.note_type.trim(),
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
  return readJson<{ workspace: Workspace; folders: Folder[]; files: ResearchNote[] }>(response);
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

export async function updateFile(fileId: string, values: Partial<ResearchNote>): Promise<ApiResult> {
  const payload: Partial<ResearchNote> = { ...values };
  if (values.frontmatter_json !== undefined) {
    payload.frontmatter_json = normalizeFrontmatterForApi(values.frontmatter_json as Record<string, unknown> | null) as ResearchNote['frontmatter_json'];
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

export async function uploadAttachment(params: {
  workspaceId: string;
  linkType: AttachmentLinkType;
  linkId: string;
  file: File;
}): Promise<Attachment> {
  const formData = new FormData();
  formData.append('workspace_id', params.workspaceId);
  formData.append('link_type', params.linkType);
  formData.append('link_id', params.linkId);
  formData.append('original_name', params.file.name);
  formData.append('mime_type', params.file.type || 'application/octet-stream');
  formData.append('file', params.file, params.file.name);
  return runAttachmentRequest<Attachment>('upload', () => fetch('/api/attachments/upload', {
    method: 'POST',
    body: formData,
  }));
}

export async function listAttachments(linkType: AttachmentLinkType, linkId: string): Promise<Attachment[]> {
  return runAttachmentRequest<Attachment[]>('list', () => fetch(`/api/attachments?linkType=${encodeURIComponent(linkType)}&linkId=${encodeURIComponent(linkId)}`));
}

export async function listAttachmentCounts(
  linkType: AttachmentLinkType,
  ids: string[],
  options?: { signal?: AbortSignal },
): Promise<Record<string, number>> {
  const normalizedIds = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
  if (normalizedIds.length === 0) return {};
  const params = new URLSearchParams({
    linkType,
    ids: normalizedIds.join(','),
  });
  const rows = await runAttachmentRequest<Array<{ link_id: string; count: number }>>(
    'counts',
    () => fetch(`/api/attachments/counts?${params.toString()}`, { signal: options?.signal }),
  );
  const counts: Record<string, number> = {};
  rows.forEach((row) => {
    counts[row.link_id] = Number(row.count) || 0;
  });
  return counts;
}

export async function unlinkAttachment(attachmentId: string, linkType: AttachmentLinkType, linkId: string): Promise<ApiResult> {
  return runAttachmentRequest<ApiResult>('unlink', () => fetch(`/api/attachments/${attachmentId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ link_type: linkType, link_id: linkId }),
  }));
}

export async function deleteAttachmentFromWorkspace(attachmentId: string): Promise<ApiResult> {
  return runAttachmentRequest<ApiResult>('hard_delete', () => fetch(`/api/attachments/${attachmentId}/hard`, {
    method: 'DELETE',
  }));
}

export async function linkAttachment(attachmentId: string, linkType: AttachmentLinkType, linkId: string): Promise<ApiResult> {
  return runAttachmentRequest<ApiResult>('link', () => fetch(`/api/attachments/${attachmentId}/link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ link_type: linkType, link_id: linkId }),
  }));
}

export const getAttachmentOpenUrl = (attachmentId: string) => `/api/attachments/${encodeURIComponent(attachmentId)}/file`;

export const getAttachmentDownloadUrl = (attachmentId: string) => `/api/attachments/${encodeURIComponent(attachmentId)}/file?download=1`;

export async function getAttachmentSettings(): Promise<AttachmentStorageSettings> {
  const response = await fetch('/api/attachments/settings');
  if (!response.ok) throw new Error(await response.text());
  return readJson<AttachmentStorageSettings>(response);
}

export async function saveAttachmentSettings(input: Pick<AttachmentStorageSettings, 'quota_mb' | 'retention_days'>): Promise<AttachmentStorageSettings> {
  const response = await fetch('/api/attachments/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await response.text());
  return readJson<AttachmentStorageSettings>(response);
}

export async function runAttachmentCleanupNow(): Promise<{ removed_files: number; purged_attachments: number }> {
  const response = await fetch('/api/attachments/cleanup', { method: 'POST' });
  if (!response.ok) throw new Error(await response.text());
  return readJson<{ removed_files: number; purged_attachments: number }>(response);
}

export async function listSystemLog(query: SystemLogQuery = {}): Promise<SystemLogListResponse> {
  const params = new URLSearchParams();
  if (query.level) params.set('level', query.level);
  if (query.from) params.set('from', query.from);
  if (query.to) params.set('to', query.to);
  if (query.q) params.set('q', query.q);
  if (query.cursor) params.set('cursor', query.cursor);
  params.set('limit', String(query.limit ?? 50));
  const response = await fetch(`/api/system-log?${params.toString()}`);
  if (!response.ok) throw new Error(await response.text());
  const payload = await readJson<SystemLogListResponse>(response);
  return {
    entries: Array.isArray(payload.entries) ? payload.entries : [],
    page: payload.page,
  };
}

export async function clearSystemLog(): Promise<ApiResult> {
  const response = await fetch('/api/system-log', { method: 'DELETE' });
  if (!response.ok) throw new Error(await response.text());
  return readJson<ApiResult>(response);
}
