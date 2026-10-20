/** A single-consumer FIFO queue that continues after an individual task rejects. */
export function createSerialTaskQueue() {
  let tail = Promise.resolve();
  let pending = 0;
  return {
    enqueue(task) {
      pending += 1;
      const result = tail.catch(() => {}).then(task);
      tail = result.catch(() => {}).finally(() => { pending = Math.max(0, pending - 1); });
      return result;
    },
    whenIdle() { return tail; },
    get pendingCount() { return pending; },
  };
}
