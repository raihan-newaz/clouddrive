/**
 * Keeps upload work within a predictable CPU and network budget.
 *
 * Encryption is synchronous and every in-flight provider upload retains a
 * chunk buffer, so accepting unlimited multipart requests can exhaust a small
 * VPS.  This queue applies a global ceiling and a per-user ceiling, while
 * keeping the limits configurable without changing client behaviour.
 */
class UploadQueueFullError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UploadQueueFullError';
    this.code = 'UPLOAD_QUEUE_FULL';
  }
}

class UploadQueue {
  constructor({ maxActive = 1, maxPerUser = 1, maxQueued = 16 } = {}) {
    this.maxActive = Math.max(1, Number(maxActive) || 1);
    this.maxPerUser = Math.max(1, Number(maxPerUser) || 1);
    this.maxQueued = Math.max(this.maxActive, Number(maxQueued) || 16);
    this.active = 0;
    this.activeByUser = new Map();
    this.pending = [];
  }

  run(userId, task) {
    if (this.pending.length >= this.maxQueued) {
      return Promise.reject(new UploadQueueFullError('Upload queue is busy. Please retry shortly.'));
    }

    return new Promise((resolve, reject) => {
      this.pending.push({ userId: String(userId), task, resolve, reject });
      this.drain();
    });
  }

  drain() {
    while (this.active < this.maxActive) {
      const nextIndex = this.pending.findIndex(job =>
        (this.activeByUser.get(job.userId) || 0) < this.maxPerUser
      );
      if (nextIndex === -1) return;

      const job = this.pending.splice(nextIndex, 1)[0];
      this.active += 1;
      this.activeByUser.set(job.userId, (this.activeByUser.get(job.userId) || 0) + 1);

      // Yield once before synchronous encryption so normal API requests stay responsive.
      setImmediate(() => Promise.resolve()
        .then(job.task)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active -= 1;
          const remaining = (this.activeByUser.get(job.userId) || 1) - 1;
          if (remaining > 0) this.activeByUser.set(job.userId, remaining);
          else this.activeByUser.delete(job.userId);
          this.drain();
        })
      );
    }
  }
}

module.exports = {
  UploadQueue,
  UploadQueueFullError
};
