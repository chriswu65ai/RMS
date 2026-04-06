export type PersistedGenerateJob = {
  status: 'completed' | 'failed';
  error?: string;
  completedAt?: number;
};

export type PersistedGenerateJobsByFileId = Record<string, PersistedGenerateJob>;

export const GENERATION_INTERRUPTED_MESSAGE = 'Generation interrupted';
export const PERSIST_STORAGE_KEY = 'rms-app-state';
export const PERSIST_MAX_SERIALIZED_CHARS = 750_000;
export const PERSIST_THROTTLE_MS = 800;
export const PERSIST_MAX_DRAFTS = 40;
export const PERSIST_MAX_DRAFT_BODY_CHARS = 30_000;
export const PERSIST_MAX_HISTORY_ENTRIES = 30;

const toFiniteNumberOrUndefined = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

export const sanitizePersistedGenerateJobsByFileId = (
  generateJobsByFileId: unknown,
  { keepTerminalStatuses = true }: { keepTerminalStatuses?: boolean } = {},
): PersistedGenerateJobsByFileId => {
  if (!keepTerminalStatuses) return {};
  if (!generateJobsByFileId || typeof generateJobsByFileId !== 'object') return {};

  return Object.entries(generateJobsByFileId as Record<string, { status?: unknown; error?: unknown; completedAt?: unknown }>).reduce<PersistedGenerateJobsByFileId>((acc, [fileId, job]) => {
    if (!job || typeof job !== 'object') return acc;
    const status = job.status;

    if (status === 'completed') {
      acc[fileId] = {
        status: 'completed',
        completedAt: toFiniteNumberOrUndefined(job.completedAt),
      };
      return acc;
    }

    if (status === 'failed') {
      acc[fileId] = {
        status: 'failed',
        error: typeof job.error === 'string' && job.error.trim() ? job.error : undefined,
      };
      return acc;
    }

    if (status === 'running') {
      acc[fileId] = {
        status: 'failed',
        error: GENERATION_INTERRUPTED_MESSAGE,
      };
      return acc;
    }

    return acc;
  }, {});
};

export const trimPersistedDraftByFileId = <TDraft extends { body: string; updatedAt: number }>(
  draftByFileId: Record<string, TDraft>,
): Record<string, TDraft> => Object.entries(draftByFileId)
  .filter(([, draft]) => typeof draft.body === 'string' && draft.body.length <= PERSIST_MAX_DRAFT_BODY_CHARS)
  .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
  .slice(0, PERSIST_MAX_DRAFTS)
  .reduce<Record<string, TDraft>>((acc, [fileId, draft]) => {
    acc[fileId] = draft;
    return acc;
  }, {});

export const trimPersistedHistoryByFileId = <THistory>(historyByFileId: Record<string, THistory>) => Object.entries(historyByFileId)
  .slice(0, PERSIST_MAX_HISTORY_ENTRIES)
  .reduce<Record<string, THistory>>((acc, [fileId, history]) => {
    acc[fileId] = history;
    return acc;
  }, {});

export const createPersistWriteGuard = ({
  maxSerializedChars = PERSIST_MAX_SERIALIZED_CHARS,
  throttleMs = PERSIST_THROTTLE_MS,
  now = () => Date.now(),
}: {
  maxSerializedChars?: number;
  throttleMs?: number;
  now?: () => number;
} = {}) => {
  let lastWriteAt = 0;
  let pendingValue: string | null = null;

  return {
    shouldWriteNow: (value: string) => {
      if (value.length > maxSerializedChars) return { ok: false, reason: 'size' as const };
      const current = now();
      if (current - lastWriteAt < throttleMs) {
        pendingValue = value;
        return { ok: false, reason: 'throttle' as const };
      }
      pendingValue = null;
      lastWriteAt = current;
      return { ok: true as const };
    },
    consumePending: () => {
      if (!pendingValue) return null;
      const candidate = pendingValue;
      pendingValue = null;
      const current = now();
      if (current - lastWriteAt < throttleMs) {
        pendingValue = candidate;
        return null;
      }
      if (candidate.length > maxSerializedChars) return null;
      lastWriteAt = current;
      return candidate;
    },
  };
};
