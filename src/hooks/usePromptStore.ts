import { create } from 'zustand';
import type { Folder, PromptFile, Workspace } from '../types/models';
import { bootstrapWorkspace } from '../lib/dataApi';

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
    try {
      const data = await bootstrapWorkspace();
      set({ workspace: data.workspace, folders: data.folders, files: data.files, loading: false });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : 'Failed loading workspace' });
    }
  },
  refresh: async () => {
    if (!get().workspace) return;
    set({ loading: true, error: null });
    try {
      const data = await bootstrapWorkspace();
      set({ workspace: data.workspace, folders: data.folders, files: data.files, loading: false });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : 'Failed loading data' });
    }
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
