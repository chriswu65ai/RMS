import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Folder, PromptFile, Workspace } from '../types/models';
import { bootstrapWorkspace } from '../lib/dataApi';
import { splitFrontmatter } from '../lib/frontmatter';

const DEFAULT_RESEARCH_TYPES = ['Research', 'Earnings', 'Valuation', 'Catalyst'];
const DEFAULT_ASSIGNEES = ['me', 'agent'];

const normalizeList = (items: string[]) => {
  const seen = new Set<string>();
  const normalized: string[] = [];
  items
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach((item) => {
      const key = item.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      normalized.push(item);
    });
  return normalized;
};

type AppView = 'overview' | 'new-research' | 'stock-research';

type Store = {
  workspace: Workspace | null;
  folders: Folder[];
  files: PromptFile[];
  selectedFolderId: string | null;
  selectedFileId: string | null;
  selectedTicker: string | null;
  selectedTag: string | null;
  search: string;
  noteTypes: string[];
  assignees: string[];
  lastView: AppView;
  loading: boolean;
  error: string | null;
  setSearch: (search: string) => void;
  setNoteTypes: (types: string[]) => void;
  setAssignees: (assignees: string[]) => void;
  setLastView: (view: AppView) => void;
  selectFolder: (id: string | null) => void;
  selectFile: (id: string | null) => void;
  selectTag: (tag: string | null) => void;
  bootstrap: () => Promise<void>;
  refresh: () => Promise<void>;
  reset: () => void;
};

export const usePromptStore = create<Store>()(
  persist(
    (set, get) => ({
      workspace: null,
      folders: [],
      files: [],
      selectedFolderId: null,
      selectedFileId: null,
      selectedTicker: null,
      selectedTag: null,
      search: '',
      noteTypes: DEFAULT_RESEARCH_TYPES,
      assignees: DEFAULT_ASSIGNEES,
      lastView: 'stock-research',
      loading: false,
      error: null,
      setSearch: (search) => set({ search }),
      setNoteTypes: (types) => set({ noteTypes: normalizeList(types) }),
      setAssignees: (assignees) => set({ assignees: normalizeList(assignees) }),
      setLastView: (view) => set({ lastView: view }),
      selectFolder: (id) => set({ selectedFolderId: id, selectedTag: null, selectedFileId: null }),
      selectFile: (id) => {
        const file = get().files.find((item) => item.id === id) ?? null;
        const ticker = file ? splitFrontmatter(file.content).frontmatter.ticker?.toString().trim().toUpperCase() ?? null : null;
        set({ selectedFileId: id, selectedTicker: ticker || null });
      },
      selectTag: (tag) => set({ selectedTag: tag, selectedFolderId: null, selectedFileId: null }),
      bootstrap: async () => {
        set({ loading: true, error: null });
        try {
          const data = await bootstrapWorkspace();
          set((state) => ({
            workspace: data.workspace,
            folders: data.folders,
            files: data.files,
            selectedFileId: state.selectedFileId && data.files.some((file) => file.id === state.selectedFileId) ? state.selectedFileId : null,
            loading: false,
          }));
        } catch (error) {
          set({ loading: false, error: error instanceof Error ? error.message : 'Failed loading workspace' });
        }
      },
      refresh: async () => {
        if (!get().workspace) return;
        set({ loading: true, error: null });
        try {
          const data = await bootstrapWorkspace();
          set((state) => ({
            workspace: data.workspace,
            folders: data.folders,
            files: data.files,
            selectedFileId: state.selectedFileId && data.files.some((file) => file.id === state.selectedFileId) ? state.selectedFileId : null,
            loading: false,
          }));
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
          selectedTicker: null,
          selectedTag: null,
          search: '',
          loading: false,
          error: null,
        });
      },
    }),
    {
      name: 'rms-app-state',
      partialize: (state) => ({
        noteTypes: state.noteTypes,
        assignees: state.assignees,
        lastView: state.lastView,
        selectedTicker: state.selectedTicker,
      }),
    },
  ),
);

export const toLocalDateInputValue = (date = new Date()) => {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
};

export const buildCanonicalStockFileName = (date: string, ticker: string, type: string) =>
  `${date} ${ticker.trim().toUpperCase()}-${type.trim().toUpperCase()}.md`;
