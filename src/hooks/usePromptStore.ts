import { create } from 'zustand';
import type { Folder, PromptFile, Workspace } from '../types/models';
import { supabase } from '../lib/supabase';

type Store = {
  workspace: Workspace | null;
  folders: Folder[];
  files: PromptFile[];
  selectedFolderId: string | null;
  selectedFileId: string | null;
  search: string;
  loading: boolean;
  error: string | null;
  setSearch: (search: string) => void;
  selectFolder: (id: string | null) => void;
  selectFile: (id: string | null) => void;
  bootstrap: () => Promise<void>;
  refresh: () => Promise<void>;
};

export const usePromptStore = create<Store>((set, get) => ({
  workspace: null,
  folders: [],
  files: [],
  selectedFolderId: null,
  selectedFileId: null,
  search: '',
  loading: false,
  error: null,
  setSearch: (search) => set({ search }),
  selectFolder: (id) => set({ selectedFolderId: id, selectedFileId: null }),
  selectFile: (id) => set({ selectedFileId: id }),
  bootstrap: async () => {
    set({ loading: true, error: null });
    const { data: ws, error } = await supabase.from('workspaces').select('*').limit(1).maybeSingle();
    if (error) return set({ loading: false, error: error.message });
    if (!ws) {
      const { data: created, error: createError } = await supabase
        .from('workspaces')
        .insert({ name: 'My Workspace' })
        .select('*')
        .single();
      if (createError) return set({ loading: false, error: createError.message });
      set({ workspace: created as Workspace, loading: false });
      await get().refresh();
      return;
    }
    set({ workspace: ws as Workspace, loading: false });
    await get().refresh();
  },
  refresh: async () => {
    const workspace = get().workspace;
    if (!workspace) return;
    set({ loading: true, error: null });
    const [{ data: folders, error: folderError }, { data: files, error: fileError }] = await Promise.all([
      supabase.from('folders').select('*').eq('workspace_id', workspace.id).order('path'),
      supabase.from('prompt_files').select('*').eq('workspace_id', workspace.id).order('path'),
    ]);
    if (folderError || fileError) {
      set({ loading: false, error: folderError?.message ?? fileError?.message ?? 'Failed loading data' });
      return;
    }
    set({ folders: (folders ?? []) as Folder[], files: (files ?? []) as PromptFile[], loading: false });
  },
}));
