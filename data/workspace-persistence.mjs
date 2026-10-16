const queueByWorkspace = new Map();
const stateByWorkspace = new Map();
const clearTaskByWorkspace = new Map();

function stateFor(workspaceId) {
  let state = stateByWorkspace.get(workspaceId);
  if (!state) {
    state = { generation: 0, clearCount: 0, clearing: false };
    stateByWorkspace.set(workspaceId, state);
  }
  return state;
}

/** Serialize a persistence mutation and invalidate queued work when a clear starts. */
export function enqueueWorkspacePersistence(workspaceId, operation) {
  const state = stateFor(workspaceId);
  if (state.clearing) return Promise.resolve({ skipped: true });
  const generation = state.generation;
  const previous = queueByWorkspace.get(workspaceId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => {
    if (state.clearing || state.generation !== generation) return { skipped: true };
    return operation();
  });
  queueByWorkspace.set(workspaceId, next);
  void next.finally(() => {
    if (queueByWorkspace.get(workspaceId) === next) queueByWorkspace.delete(workspaceId);
  }).catch(() => {});
  return next;
}

/** Run a clear after all writes for its workspaces finish; stale queued writes are skipped. */
export function clearWorkspacePersistence(workspaceIds, operation) {
  const ids = [...new Set(workspaceIds.filter((id) => typeof id === "string" && id))];
  const existingClears = [...new Set(ids.map((id) => clearTaskByWorkspace.get(id)).filter(Boolean))];

  for (const id of ids) {
    const state = stateFor(id);
    state.generation += 1;
    state.clearCount += 1;
    state.clearing = true;
  }

  const previousWrites = [...new Set(ids.map((id) => queueByWorkspace.get(id)).filter(Boolean))];
  const task = Promise.all([...previousWrites, ...existingClears].map((pending) => pending.catch(() => {})))
    .then(operation)
    .finally(() => {
      for (const id of ids) {
        const state = stateFor(id);
        state.clearCount = Math.max(0, state.clearCount - 1);
        state.clearing = state.clearCount > 0;
        if (clearTaskByWorkspace.get(id) === task) clearTaskByWorkspace.delete(id);
        if (queueByWorkspace.get(id) === task) queueByWorkspace.delete(id);
      }
    });

  for (const id of ids) {
    clearTaskByWorkspace.set(id, task);
    queueByWorkspace.set(id, task);
  }
  return task;
}

export function getKnownWorkspacePersistenceIds() {
  return [...stateByWorkspace.keys()];
}

export function isWorkspacePersistenceClearing(workspaceId) {
  return stateFor(workspaceId).clearing;
}
