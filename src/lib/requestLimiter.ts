type QueuedTask<T> = {
  run: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

export type RequestLimiter = {
  schedule<T>(task: () => Promise<T>): Promise<T>;
  getPendingCount(): number;
  getActiveCount(): number;
};

export function createRequestLimiter(maxConcurrent: number): RequestLimiter {
  const normalizedMaxConcurrent = Number.isFinite(maxConcurrent) ? Math.max(1, Math.floor(maxConcurrent)) : 1;
  const queue: Array<QueuedTask<unknown>> = [];
  let activeCount = 0;

  const drain = () => {
    while (activeCount < normalizedMaxConcurrent && queue.length > 0) {
      const next = queue.shift();
      if (!next) break;
      activeCount += 1;
      next.run()
        .then(next.resolve)
        .catch(next.reject)
        .finally(() => {
          activeCount = Math.max(0, activeCount - 1);
          drain();
        });
    }
  };

  return {
    schedule<T>(task: () => Promise<T>) {
      return new Promise<T>((resolve, reject) => {
        queue.push({ run: task, resolve, reject });
        drain();
      });
    },
    getPendingCount() {
      return queue.length;
    },
    getActiveCount() {
      return activeCount;
    },
  };
}
