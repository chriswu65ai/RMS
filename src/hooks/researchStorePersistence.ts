export type PersistedGenerateJob = {
  status: 'completed' | 'failed';
  error?: string;
  completedAt?: number;
};

export type PersistedGenerateJobsByFileId = Record<string, PersistedGenerateJob>;

export const GENERATION_INTERRUPTED_MESSAGE = 'Generation interrupted';

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
