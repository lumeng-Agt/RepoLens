const queueByWorkspace = new Map();
const stateByWorkspace = new Map();
const clearTaskByWorkspace = new Map();
const listenersByWorkspace = new Map();
const idleStatus = Object.freeze({ phase: "idle", pending: 0, error: "" });

function publish(workspaceId, state, phase = state.status.phase, error = state.status.error) {
  if (phase !== "clearing") {
    if (state.failures.size) {
      phase = "memory";
      error = [...state.failures.values()].join("；");
    } else if (state.pending > 0) {
      phase = "saving";
      error = "";
    } else {
      phase = state.stablePhase;
      error = "";
    }
  }
  state.status = Object.freeze({ phase, pending: state.pending, error });
  for (const listener of listenersByWorkspace.get(workspaceId) ?? []) listener();
}

function stateFor(workspaceId) {
  let state = stateByWorkspace.get(workspaceId);
  if (!state) {
    state = { generation: 0, clearCount: 0, clearing: false, pending: 0, stablePhase: "idle", failures: new Map(), status: idleStatus };
    stateByWorkspace.set(workspaceId, state);
  }
  return state;
}

export function getWorkspacePersistenceStatus(workspaceId) {
  return stateByWorkspace.get(workspaceId)?.status ?? idleStatus;
}

export function markWorkspacePersistencePending(workspaceId, key, message) {
  const state = stateFor(workspaceId);
  state.failures.set(key, message);
  publish(workspaceId, state);
}

export function subscribeWorkspacePersistence(workspaceId, listener) {
  let listeners = listenersByWorkspace.get(workspaceId);
  if (!listeners) { listeners = new Set(); listenersByWorkspace.set(workspaceId, listeners); }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) listenersByWorkspace.delete(workspaceId);
  };
}

function failedResult(result) {
  return result && (result.ok === false || result.persisted === false)
    ? new Error(result.warning || "本地保存未能写入磁盘。")
    : null;
}

/** Serialize a persistence mutation and invalidate queued work when a clear starts. */
export function enqueueWorkspacePersistence(workspaceId, operation, { key = "default" } = {}) {
  const state = stateFor(workspaceId);
  if (state.clearing) return Promise.resolve({ skipped: true });
  const generation = state.generation;
  const previous = queueByWorkspace.get(workspaceId) ?? Promise.resolve();
  state.pending += 1;
  publish(workspaceId, state, "saving", "");
  const next = previous.catch(() => {}).then(async () => {
    if (state.clearing || state.generation !== generation) return { skipped: true };
    publish(workspaceId, state, "saving", "");
    try {
      const result = await operation();
      const failure = failedResult(result);
      if (failure) state.failures.set(key, failure.message);
      else if (!result?.skipped) {
        state.failures.delete(key);
        state.stablePhase = "saved";
      }
      publish(workspaceId, state);
      if (failure) throw failure;
      return result;
    } catch (error) {
      state.failures.set(key, error instanceof Error ? error.message : String(error));
      publish(workspaceId, state);
      throw error;
    }
  });
  queueByWorkspace.set(workspaceId, next);
  void next.finally(() => {
    state.pending = Math.max(0, state.pending - 1);
    publish(workspaceId, state);
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
    publish(id, state, "clearing", "");
  }

  const previousWrites = [...new Set(ids.map((id) => queueByWorkspace.get(id)).filter(Boolean))];
  const task = Promise.all([...previousWrites, ...existingClears].map((pending) => pending.catch(() => {})))
    .then(async () => {
      const result = await operation();
      const failure = failedResult(result);
      if (failure) throw failure;
      for (const id of ids) { const state = stateFor(id); state.failures.clear(); state.stablePhase = "saved"; publish(id, state, "saved", ""); }
      return result;
    })
    .catch((error) => {
      for (const id of ids) { const state = stateFor(id); state.failures.set("clear", error instanceof Error ? error.message : String(error)); publish(id, state, "memory", error instanceof Error ? error.message : String(error)); }
      throw error;
    })
    .finally(() => {
      for (const id of ids) {
        const state = stateFor(id);
        state.clearCount = Math.max(0, state.clearCount - 1);
        state.clearing = state.clearCount > 0;
        if (state.clearing) publish(id, state, "clearing", "");
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
