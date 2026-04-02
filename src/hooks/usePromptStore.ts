import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Folder, PromptFile, SettingsList, Workspace } from '../types/models';
import { bootstrapWorkspace } from '../lib/dataApi';
import { splitFrontmatter } from '../lib/frontmatter';

const DEFAULT_SETTINGS: SettingsList = {
  noteTypes: ['Event', 'Earnings', 'Deepdive', 'Summary'],
  assignees: ['Agent', 'Me'],
  sectors: [
    'Energy',
    'Materials',
    'Industrials',
    'Consumer Discretionary',
    'Consumer Staples',
    'Health Care',
    'Financials',
    'Information Technology',
    'Communication Services',
    'Utilities',
    'Real Estate',
  ],
};

const normalizeList = (items: string[]) => {
  const seen = new Set<string>();
  const normalized: string[] = [];
  items.map((item) => item.trim()).filter(Boolean).forEach((item) => {
    const key = item.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    normalized.push(item);
  });
  return normalized;
};

export type AppView = 'home' | 'tasks' | 'research';
export type EditorTab = 'edit' | 'preview' | 'split';

type Store = {
  workspace: Workspace | null;
  folders: Folder[];
  files: PromptFile[];
  selectedFolderId: string | null;
  selectedFileId: string | null;
  selectedTaskId: string | null;
  selectedTicker: string | null;
  selectedTag: string | null;
  search: string;
  noteTypes: string[];
  assignees: string[];
  sectors: string[];
  lastView: AppView;
  stockFoldersCollapsed: boolean;
  metadataPanelCollapsed: boolean;
  editorTab: EditorTab;
  loading: boolean;
  error: string | null;
  setSearch: (search: string) => void;
  setNoteTypes: (types: string[]) => void;
  setAssignees: (assignees: string[]) => void;
  setLastView: (view: AppView) => void;
  setStockFoldersCollapsed: (collapsed: boolean) => void;
  setMetadataPanelCollapsed: (collapsed: boolean) => void;
  setEditorTab: (tab: EditorTab) => void;
  setSectors: (sectors: string[]) => void;
  selectFolder: (id: string | null) => void;
  selectFile: (id: string | null, view?: AppView) => void;
  selectTag: (tag: string | null) => void;
  transitionFromOverviewRow: (fileId: string) => void;
  transitionFromSearchResult: (fileId: string) => void;
  transitionTaskModal: (taskId: string | null) => void;
  transitionTaskToNote: (task: { id: string; linked_note_file_id?: string; ticker: string }, createdFileId?: string) => { ok: boolean; reason?: string };
  bootstrap: () => Promise<void>;
  refresh: () => Promise<void>;
  reset: () => void;
};

const toSelectedTicker = (file: PromptFile | null) => file ? splitFrontmatter(file.content).frontmatter.ticker?.toString().trim().toUpperCase() ?? null : null;

function sanitizeSelection(files: PromptFile[], selectedFileId: string | null) {
  if (!selectedFileId) return { selectedFileId: null, selectedTicker: null };
  const existing = files.find((file) => file.id === selectedFileId) ?? null;
  return { selectedFileId: existing?.id ?? null, selectedTicker: toSelectedTicker(existing) };
}

export const usePromptStore = create<Store>()(
  persist(
    (set, get) => ({
      workspace: null,
      folders: [],
      files: [],
      selectedFolderId: null,
      selectedFileId: null,
      selectedTaskId: null,
      selectedTicker: null,
      selectedTag: null,
      search: '',
      noteTypes: DEFAULT_SETTINGS.noteTypes,
      assignees: DEFAULT_SETTINGS.assignees,
      sectors: DEFAULT_SETTINGS.sectors,
      lastView: 'research',
      stockFoldersCollapsed: false,
      metadataPanelCollapsed: true,
      editorTab: 'split',
      loading: false,
      error: null,
      setSearch: (search) => set({ search }),
      setNoteTypes: (types) => set({ noteTypes: normalizeList(types) }),
      setAssignees: (assignees) => set({ assignees: normalizeList(assignees) }),
      setSectors: (sectors) => set({ sectors: normalizeList(sectors) }),
      setLastView: (view) => set({ lastView: view }),
      setStockFoldersCollapsed: (collapsed) => set({ stockFoldersCollapsed: collapsed }),
      setMetadataPanelCollapsed: (collapsed) => set({ metadataPanelCollapsed: collapsed }),
      setEditorTab: (tab) => set({ editorTab: tab }),
      selectFolder: (id) => set({ selectedFolderId: id, selectedTag: null, selectedFileId: null, selectedTicker: null }),
      selectFile: (id, view = 'research') => {
        const file = get().files.find((item) => item.id === id) ?? null;
        const activeFolderId = get().selectedFolderId;
        const activeTag = get().selectedTag;
        const nextFolderId = activeFolderId === null ? null : (file?.folder_id ?? null);
        set({
          selectedFileId: file?.id ?? null,
          selectedTicker: toSelectedTicker(file),
          selectedFolderId: nextFolderId,
          selectedTag: activeTag,
          lastView: view,
        });
      },
      selectTag: (tag) => set({ selectedTag: tag, selectedFolderId: null, selectedFileId: null, selectedTicker: null }),
      transitionFromOverviewRow: (fileId) => {
        get().selectFile(fileId, 'research');
      },
      transitionFromSearchResult: (fileId) => {
        get().selectFile(fileId, 'research');
        set({ search: '' });
      },
      transitionTaskModal: (taskId) => set({ selectedTaskId: taskId ?? null, lastView: 'tasks' }),
      transitionTaskToNote: (task, createdFileId) => {
        const files = get().files;
        const linkedId = createdFileId ?? task.linked_note_file_id ?? '';
        const file = linkedId ? files.find((item) => item.id === linkedId) : undefined;
        if (!file) {
          set({ selectedTaskId: task.id, selectedTicker: task.ticker.trim().toUpperCase() || null, lastView: 'tasks' });
          return { ok: false, reason: 'Linked note is missing, renamed, or deleted.' };
        }
        get().selectFile(file.id, 'research');
        set({ selectedTaskId: task.id });
        return { ok: true };
      },
      bootstrap: async () => {
        set({ loading: true, error: null });
        try {
          const data = await bootstrapWorkspace();
          set((state) => ({
            workspace: data.workspace,
            folders: data.folders,
            files: data.files,
            ...sanitizeSelection(data.files, state.selectedFileId),
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
            ...sanitizeSelection(data.files, state.selectedFileId),
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
          selectedTaskId: null,
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
        sectors: state.sectors,
        lastView: state.lastView,
        stockFoldersCollapsed: state.stockFoldersCollapsed,
        metadataPanelCollapsed: state.metadataPanelCollapsed,
        editorTab: state.editorTab,
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
  `${date} ${ticker.trim().toUpperCase()}-${type.trim().toLowerCase()}.md`;
