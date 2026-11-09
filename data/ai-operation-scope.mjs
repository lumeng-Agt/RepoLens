/** Own confirmed generations and their cache independently of the current tab/session. */
export function createAiOperationScope({ maxCacheEntries = 50 } = {}) {
  let globalGeneration = 0;
  const generations = new Map();
  const active = new Set();
  const cache = new Map();
  return {
    begin(workspaceId, controller) {
      const global = globalGeneration;
      const generation = generations.get(workspaceId) ?? 0;
      let finish;
      let finished = false;
      const done = new Promise(resolve => { finish = resolve; });
      const operation = { workspaceId, controller, done };
      active.add(operation);
      const isActive = () => !finished && !controller.signal.aborted && global === globalGeneration && generation === (generations.get(workspaceId) ?? 0);
      const cacheKey = key => `${workspaceId}\0${key}`;
      return {
        workspaceId, isActive,
        getCached(key) { return isActive() ? cache.get(cacheKey(key))?.result : undefined; },
        cache(key, result) {
          if (!isActive()) return false;
          cache.set(cacheKey(key), { workspaceId, result });
          if (cache.size > maxCacheEntries) cache.delete(cache.keys().next().value);
          return true;
        },
        finish() { finished = true; active.delete(operation); finish(); },
      };
    },
    clear(workspaceId) {
      if (workspaceId === undefined) globalGeneration++;
      else generations.set(workspaceId, (generations.get(workspaceId) ?? 0) + 1);
      for (const [key, entry] of cache) if (workspaceId === undefined || entry.workspaceId === workspaceId) cache.delete(key);
      const pending = [...active].filter(operation => workspaceId === undefined || operation.workspaceId === workspaceId);
      for (const operation of pending) operation.controller.abort();
      // The caller's clear barrier waits until no old job can publish or persist.
      return Promise.all(pending.map(operation => operation.done));
    },
    clearCache() { cache.clear(); },
  };
}
