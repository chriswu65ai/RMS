import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Folder, ResearchNote, SettingsList, Workspace } from '../types/models';
import { bootstrapWorkspace } from '../lib/dataApi';
import { splitFrontmatter } from '../lib/frontmatter';
import { mergeMetadataListsWithDefaults, normalizeList, normalizeListWithFallback } from './metadataLists';

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

const LG_BREAKPOINT_PX = 1024;

const normalizeMetadataPanelCollapsed = (value: unknown) => {
  if (typeof value !== 'boolean') return false;
  if (typeof window !== 'undefined' && window.innerWidth < LG_BREAKPOINT_PX) return false;
  return value;
};

const mergeMetadataValues = (base: string[], incoming: string[]) => {
  const merged = [...normalizeList(base)];
  const known = new Map(merged.map((value) => [value.toLowerCase(), value] as const));
  incoming.map((value) => value.trim()).filter(Boolean).forEach((value) => {
    const key = value.toLowerCase();
    if (known.has(key)) return;
    known.set(key, value);
    merged.push(value);
  });
  return merged;
};

const deriveMetadataFromFiles = (files: ResearchNote[], noteTypes: string[], sectors: string[]) => {
  const discoveredNoteTypes: string[] = [];
  const discoveredSectors: string[] = [];

  files.forEach((file) => {
    const { frontmatter } = splitFrontmatter(file.content, { knownSectors: sectors, knownNoteTypes: noteTypes });
    if (typeof frontmatter.type === 'string' && frontmatter.type.trim()) discoveredNoteTypes.push(frontmatter.type);
    if (typeof frontmatter.sector === 'string' && frontmatter.sector.trim()) discoveredSectors.push(frontmatter.sector);
  });

  return {
    noteTypes: mergeMetadataValues(noteTypes, discoveredNoteTypes),
    sectors: mergeMetadataValues(sectors, discoveredSectors),
  };
};

export type AppView = 'home' | 'tasks' | 'research';
export type EditorTab = 'edit' | 'preview' | 'split';

type Store = {
  workspace: Workspace | null;
  folders: Folder[];
  files: ResearchNote[];
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

const toSelectedTicker = (file: ResearchNote | null) => file ? splitFrontmatter(file.content).frontmatter.ticker?.toString().trim().toUpperCase() ?? null : null;

function sanitizeSelection(files: ResearchNote[], selectedFileId: string | null) {
  if (!selectedFileId) return { selectedFileId: null, selectedTicker: null };
  const existing = files.find((file) => file.id === selectedFileId) ?? null;
  return { selectedFileId: existing?.id ?? null, selectedTicker: toSelectedTicker(existing) };
}

const mergePersistedResearchState = (persistedState: unknown, currentState: Store) => {
  const merged = { ...currentState, ...(persistedState as Partial<Store> | undefined) };
  const metadata = mergeMetadataListsWithDefaults(merged, DEFAULT_SETTINGS);
  return {
    ...merged,
    ...metadata,
    metadataPanelCollapsed: normalizeMetadataPanelCollapsed(merged.metadataPanelCollapsed),
  };
};

export const useResearchStore = create<Store>()(
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
      metadataPanelCollapsed: false,
      editorTab: 'split',
      loading: false,
      error: null,
      setSearch: (search) => set({ search }),
      setNoteTypes: (types) => set({ noteTypes: normalizeListWithFallback(types, DEFAULT_SETTINGS.noteTypes) }),
      setAssignees: (assignees) => set({ assignees: normalizeListWithFallback(assignees, DEFAULT_SETTINGS.assignees) }),
      setSectors: (sectors) => set({ sectors: normalizeListWithFallback(sectors, DEFAULT_SETTINGS.sectors) }),
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
        const file = get().files.find((item) => item.id === fileId) ?? null;
        set({
          selectedFileId: file?.id ?? null,
          selectedTicker: toSelectedTicker(file),
          selectedFolderId: file?.folder_id ?? null,
          selectedTag: null,
          search: '',
          lastView: 'research',
        });
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
        set({ selectedTaskId: null });
        return { ok: true };
      },
      bootstrap: async () => {
        set({ loading: true, error: null });
        try {
          const data = await bootstrapWorkspace();
          set((state) => ({
            ...deriveMetadataFromFiles(data.files, state.noteTypes, state.sectors),
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
            ...deriveMetadataFromFiles(data.files, state.noteTypes, state.sectors),
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
      merge: (persistedState, currentState) => mergePersistedResearchState(persistedState, currentState as Store),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const normalized = normalizeMetadataPanelCollapsed(state.metadataPanelCollapsed);
        if (normalized !== state.metadataPanelCollapsed) {
          state.setMetadataPanelCollapsed(normalized);
        }
      },
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
