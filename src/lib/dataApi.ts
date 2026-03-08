import { supabase } from './supabase';
import type { Folder, PromptFile } from '../types/models';

const nowIso = () => new Date().toISOString();

export async function createFolder(workspaceId: string, name: string, parent: Folder | null) {
  const path = parent ? `${parent.path}/${name}` : name;
  return supabase.from('folders').insert({
    workspace_id: workspaceId,
    parent_id: parent?.id ?? null,
    name,
    path,
    created_at: nowIso(),
    updated_at: nowIso(),
  });
}

export async function createFile(params: {
  workspaceId: string;
  folderId: string | null;
  folderPath: string | null;
  name: string;
  content: string;
  isTemplate?: boolean;
  frontmatter?: Record<string, unknown> | null;
}) {
  const path = params.folderPath ? `${params.folderPath}/${params.name}` : params.name;
  return supabase.from('prompt_files').insert({
    workspace_id: params.workspaceId,
    folder_id: params.folderId,
    name: params.name,
    path,
    content: params.content,
    frontmatter_json: params.frontmatter ?? null,
    is_template: !!params.isTemplate,
    created_at: nowIso(),
    updated_at: nowIso(),
  });
}

export async function updateFile(fileId: string, values: Partial<PromptFile>) {
  return supabase.from('prompt_files').update({ ...values, updated_at: nowIso() }).eq('id', fileId);
}

export async function deleteFile(fileId: string) {
  return supabase.from('prompt_files').delete().eq('id', fileId);
}

export async function deleteFolder(folderId: string) {
  return supabase.from('folders').delete().eq('id', folderId);
}
