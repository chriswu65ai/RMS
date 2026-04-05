export type UiAsyncRunnerOptions<T> = {
  isCancelled?: () => boolean;
  onSuccess?: (result: T) => void | Promise<void>;
  onError?: (message: string) => void | Promise<void>;
  fallbackMessage: string;
};

export type UiAsyncGuard = {
  cancel: () => void;
  isCancelled: () => boolean;
  ifActive: (callback: () => void) => void;
};

export function createUiAsyncGuard(): UiAsyncGuard {
  let cancelled = false;
  return {
    cancel: () => {
      cancelled = true;
    },
    isCancelled: () => cancelled,
    ifActive: (callback: () => void) => {
      if (!cancelled) callback();
    },
  };
}

export function getUiErrorMessage(error: unknown, fallbackMessage: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallbackMessage;
}

export async function runUiAsync<T>(action: () => Promise<T>, options: UiAsyncRunnerOptions<T>): Promise<T | undefined> {
  try {
    const result = await action();
    if (!options.isCancelled?.()) await options.onSuccess?.(result);
    return result;
  } catch (error) {
    if (!options.isCancelled?.()) await options.onError?.(getUiErrorMessage(error, options.fallbackMessage));
    return undefined;
  }
}
