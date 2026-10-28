import { enqueueWorkspacePersistence, isWorkspacePersistenceClearing } from "./workspace-persistence.mjs";

const states = new Map();
const listeners = new Map();
const empty = Object.freeze({ records: [], loaded: false, pending: 0, error: "", saving: false });
function stateFor(id) {
  if (!states.has(id)) states.set(id, { baseline: [], operations: [], sequence: 0, epoch: 0, snapshot: empty });
  return states.get(id);
}
function apply(state) {
  const records = new Map(state.baseline.map(record => [record.id, record]));
  for (const op of state.operations) if (op.kind === "delete") records.delete(op.id); else records.set(op.record.id, op.record);
  return [...records.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}
function publish(id, patch = {}) {
  const state = stateFor(id);
  state.snapshot = { ...state.snapshot, ...patch, records: apply(state), pending: state.operations.length };
  for (const listener of listeners.get(id) ?? []) listener();
  return state.snapshot;
}
export function getInvestigationState(id) { return stateFor(id).snapshot; }
export function registerInvestigationSession(id, sessionId) {
  const state = stateFor(id);
  if (state.sessionId === sessionId) return;
  state.sessionId = sessionId; state.epoch++;
  publish(id, { loaded: false, saving: false });
}
export function subscribeInvestigations(id, callback) {
  if (!listeners.has(id)) listeners.set(id, new Set());
  listeners.get(id).add(callback);
  return () => listeners.get(id)?.delete(callback);
}
export function restoreInvestigations(id, records) {
  const state = stateFor(id); state.baseline = structuredClone(records);
  return publish(id, { loaded: true, error: "" });
}
export function failInvestigationRead(id, message) { return publish(id, { loaded: false, error: message }); }
export function changeInvestigation(id, record) {
  if (isWorkspacePersistenceClearing(id)) return false;
  const state = stateFor(id);
  state.operations.push({ sequence: ++state.sequence, kind: "upsert", record: structuredClone(record) }); publish(id); return true;
}
export function deleteInvestigation(id, recordId) {
  if (isWorkspacePersistenceClearing(id)) return false;
  const state = stateFor(id); state.operations.push({ sequence: ++state.sequence, kind: "delete", id: recordId }); publish(id); return true;
}
export async function persistInvestigations(id, write) {
  const state = stateFor(id);
  if (!state.snapshot.loaded || !state.operations.length || isWorkspacePersistenceClearing(id)) return false;
  const epoch = state.epoch;
  // Capture the prefix inside the shared queue, so concurrent saves never write an older full list last.
  const result = await enqueueWorkspacePersistence(id, async () => {
    if (state.epoch !== epoch || !state.snapshot.loaded) return { skipped: true };
    const sequence = state.sequence; const records = structuredClone(apply(state));
    publish(id, { saving: true });
    try {
      await write(records);
      if (state.epoch !== epoch) return { skipped: true };
      state.baseline = records;
      state.operations = state.operations.filter(op => op.sequence > sequence);
      publish(id, { saving: false, error: "" });
      return { ok: true };
    } catch (error) { if (state.epoch === epoch) publish(id, { saving: false, error: error.message || "调查尚未保存。" }); throw error; }
  }, { key: "investigations" });
  return !result?.skipped;
}
export function invalidateInvestigationTasks(id) { stateFor(id).epoch++; }
export function getInvestigationEpoch(id) { return stateFor(id).epoch; }
export function clearInvestigationMemory(id) {
  const state = stateFor(id); state.epoch++; state.baseline = []; state.operations = [];
  publish(id, { loaded: true, saving: false, error: "" });
}
export function knownInvestigationWorkspaces() { return [...states.keys()]; }
