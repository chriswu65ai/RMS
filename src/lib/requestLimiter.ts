type QueuedJob = {
  execute: () => void;
};

export type RequestLimiter = {
  schedule<T>(task: () => Promise<T>): Promise<T>;
  getPendingCount(): number;
  getActiveCount(): number;
};

export function createRequestLimiter(maxConcurrent: number): RequestLimiter {
  const normalizedMaxConcurrent = Number.isFinite(maxConcurrent) ? Math.max(1, Math.floor(maxConcurrent)) : 1;
  const queue: Array<QueuedJob> = [];
  let activeCount = 0;

  const drain = () => {
    while (activeCount < normalizedMaxConcurrent && queue.length > 0) {
      const job = queue.shift();
      if (!job) break;
      job.execute();
    }
  };

  return {
    schedule<T>(task: () => Promise<T>) {
      return new Promise<T>((resolve, reject) => {
        queue.push({
          execute: () => {
            activeCount += 1;
            task()
              .then(resolve)
              .catch(reject)
              .finally(() => {
                activeCount = Math.max(0, activeCount - 1);
                drain();
              });
          },
        });
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
