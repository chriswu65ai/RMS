import type { Folder, PromptFile, Workspace } from '../types/models';

type ApiError = { message: string };
type ApiResult = { error: ApiError | null };

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export async function bootstrapWorkspace() {
  const response = await fetch('/api/bootstrap');
  if (!response.ok) {
    throw new Error(await response.text());
  }

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
      frontmatter: params.frontmatter ?? null,
      isTemplate: !!params.isTemplate,
    }),
  });

  return readJson<ApiResult>(response);
}

export async function updateFile(fileId: string, values: Partial<PromptFile>): Promise<ApiResult> {
  const response = await fetch(`/api/files/${fileId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(values),
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
