import { create } from 'zustand';
import type { Folder, PromptFile, Workspace } from '../types/models';
import { supabase } from '../lib/supabase';
import { initializeStarterWorkspace } from '../lib/dataApi';
import { toUserFacingBootstrapError } from '../lib/schemaHealth';

type Store = {
  workspace: Workspace | null;
  folders: Folder[];
  files: PromptFile[];
  selectedFolderId: string | null;
  selectedFileId: string | null;
  selectedTag: string | null;
  search: string;
  loading: boolean;
  error: string | null;
  setSearch: (search: string) => void;
  selectFolder: (id: string | null) => void;
  selectFile: (id: string | null) => void;
  selectTag: (tag: string | null) => void;
  bootstrap: () => Promise<void>;
  refresh: () => Promise<void>;
  reset: () => void;
};

export const usePromptStore = create<Store>((set, get) => ({
  workspace: null,
  folders: [],
  files: [],
  selectedFolderId: null,
  selectedFileId: null,
  selectedTag: null,
  search: '',
  loading: false,
  error: null,
  setSearch: (search) => set({ search }),
  selectFolder: (id) => set({ selectedFolderId: id, selectedTag: null, selectedFileId: null }),
  selectFile: (id) => set({ selectedFileId: id }),
  selectTag: (tag) => set({ selectedTag: tag, selectedFolderId: null, selectedFileId: null }),
  bootstrap: async () => {
    set({ loading: true, error: null });
    const { data: ws, error } = await supabase.from('workspaces').select('*').limit(1).maybeSingle();
    if (error) return set({ loading: false, error: toUserFacingBootstrapError(error.message) });
    if (!ws) {
      const { data: starterWorkspaceId, error: createError } = await initializeStarterWorkspace();
      if (createError) return set({ loading: false, error: toUserFacingBootstrapError(createError.message) });
      const { data: created, error: fetchError } = await supabase
        .from('workspaces')
        .select('*')
        .eq('id', starterWorkspaceId)
        .single();
      if (fetchError) return set({ loading: false, error: toUserFacingBootstrapError(fetchError.message) });
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
  reset: () => {
    set({
      workspace: null,
      folders: [],
      files: [],
      selectedFolderId: null,
      selectedFileId: null,
      selectedTag: null,
      search: '',
      loading: false,
      error: null,
    });
  },
}));
