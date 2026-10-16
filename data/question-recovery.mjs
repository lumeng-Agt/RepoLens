import { clearWorkspacePersistence, enqueueWorkspacePersistence, getKnownWorkspacePersistenceIds } from "./workspace-persistence.mjs";

const recoveryByWorkspace = new Map();
const clearTasks = new Map();

function clone(value) {
  return structuredClone(value);
}

function stateFor(workspaceId) {
  let state = recoveryByWorkspace.get(workspaceId);
  if (!state) {
    state = { loaded: false, baseline: [], view: [], operations: [], nextSequence: 1, generation: 0, clearing: false, readError: "", saveError: "" };
    recoveryByWorkspace.set(workspaceId, state);
  }
  return state;
}

function mergeMessages(saved, changed) {
  const messages = new Map((saved?.messages ?? []).map((message) => [message.id, message]));
  for (const message of changed.messages) messages.set(message.id, message);
  return { ...saved, ...changed, messages: [...messages.values()], updatedAt: Math.max(saved?.updatedAt ?? 0, changed.updatedAt) };
}

function applyOperations(baseline, operations) {
  const conversations = new Map(baseline.map((conversation) => [conversation.id, clone(conversation)]));
  for (const operation of operations) {
    if (operation.kind === "delete") conversations.delete(operation.conversationId);
    else conversations.set(operation.conversation.id, mergeMessages(conversations.get(operation.conversation.id), operation.conversation));
  }
  return [...conversations.values()].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 100);
}

/**
 * Reconcile a successful read with the ordered operations kept in page memory.
 * @param {string} workspaceId
 * @param {Array<{id:string,title:string,messages:Array<{id:string}>,updatedAt:number}>} saved
 */
export function restoreQuestionConversations(workspaceId, saved) {
  const state = stateFor(workspaceId);
  state.loaded = true;
  state.baseline = clone(saved);
  state.readError = "";
  state.view = applyOperations(state.baseline, state.operations);
  return clone(state.view);
}

/** @param {string} workspaceId @param {string} message */
export function failQuestionConversationRead(workspaceId, message) {
  const state = stateFor(workspaceId);
  state.readError = message;
  return clone(state.view);
}

/** @param {string} workspaceId */
export function getQuestionConversationView(workspaceId) {
  return clone(stateFor(workspaceId).view);
}

/** @param {string} workspaceId */
export function getQuestionConversationReadError(workspaceId) {
  return stateFor(workspaceId).readError;
}

/** @param {string} workspaceId */
export function getQuestionConversationSaveError(workspaceId) {
  return stateFor(workspaceId).saveError;
}

/**
 * Record ordered upserts and tombstones by comparing the current visible list.
 * @param {string} workspaceId
 * @param {Array<{id:string,title:string,messages:Array<{id:string}>,updatedAt:number}>} value
 */
export function recordQuestionConversationChanges(workspaceId, value) {
  const state = stateFor(workspaceId);
  if (state.clearing) return clone(state.view);
  const next = clone(value);
  const previousById = new Map(state.view.map((conversation) => [conversation.id, conversation]));
  const nextById = new Map(next.map((conversation) => [conversation.id, conversation]));
  for (const conversation of state.view) {
    if (!nextById.has(conversation.id)) state.operations.push({ sequence: state.nextSequence++, kind: "delete", conversationId: conversation.id });
  }
  for (const conversation of next) {
    const previous = previousById.get(conversation.id);
    if (!previous || JSON.stringify(previous) !== JSON.stringify(conversation)) {
      state.operations.push({ sequence: state.nextSequence++, kind: "upsert", conversation: clone(conversation) });
    }
  }
  state.view = next;
  return clone(state.view);
}

/** @param {string} workspaceId */
export function getQuestionConversationOperations(workspaceId) {
  return clone(stateFor(workspaceId).operations);
}

/**
 * Acknowledge only the operation prefix included in a successful write.
 * @param {string} workspaceId
 * @param {Array<{id:string,title:string,messages:Array<{id:string}>,updatedAt:number}>} persisted
 * @param {number} throughSequence
 */
export function acknowledgeQuestionConversationSave(workspaceId, persisted, throughSequence) {
  const state = stateFor(workspaceId);
  state.loaded = true;
  state.baseline = clone(persisted);
  state.operations = state.operations.filter((operation) => operation.sequence > throughSequence);
  state.view = applyOperations(state.baseline, state.operations);
  state.readError = "";
  state.saveError = "";
  return clone(state.view);
}

/** @param {string} workspaceId @param {string} message */
export function setQuestionConversationSaveError(workspaceId, message) {
  stateFor(workspaceId).saveError = message;
}

/** @param {string} workspaceId */
export function clearQuestionConversationSaveError(workspaceId) {
  stateFor(workspaceId).saveError = "";
}

/** Serialize writes across component unmounts for one workspace. @param {string} workspaceId */
export function enqueueQuestionConversationSave(workspaceId, operation) {
  const state = stateFor(workspaceId);
  if (state.clearing) return Promise.resolve({ skipped: true });
  const generation = state.generation;
  return enqueueWorkspacePersistence(workspaceId, () => {
    if (state.generation !== generation || state.clearing) return { skipped: true };
    return operation();
  });
}

function resetStateAfterClear(state) {
  state.loaded = true;
  state.baseline = [];
  state.view = [];
  state.operations = [];
  state.readError = "";
  state.saveError = "";
}

function restoreStateAfterFailedClear(state, snapshot, message) {
  state.loaded = snapshot.loaded;
  state.baseline = snapshot.baseline;
  state.view = snapshot.view;
  state.operations = snapshot.operations;
  state.nextSequence = snapshot.nextSequence;
  state.readError = snapshot.readError;
  state.saveError = message;
}

function enqueueClear(workspaceIds, operation) {
  const ids = [...new Set(workspaceIds.filter((id) => typeof id === "string" && id))];
  const priorTasks = [...new Set(ids.map((id) => clearTasks.get(id)).filter(Boolean))];
  if (priorTasks.length) {
    return Promise.all(priorTasks.map((task) => task.catch(() => {})))
      .then(() => enqueueClear(ids, operation));
  }
  const states = new Map();
  for (const id of ids) {
    const state = stateFor(id);
    states.set(id, {
      state,
      snapshot: clone({
        loaded: state.loaded,
        baseline: state.baseline,
        view: state.view,
        operations: state.operations,
        nextSequence: state.nextSequence,
        readError: state.readError,
        saveError: state.saveError,
      }),
    });
    state.generation += 1;
    state.clearing = true;
  }

  const task = clearWorkspacePersistence(ids, operation)
    .then((result) => {
      for (const { state } of states.values()) resetStateAfterClear(state);
      return result;
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      for (const { state, snapshot } of states.values()) restoreStateAfterFailedClear(state, snapshot, message);
      throw error;
    })
    .finally(() => {
      for (const [id, { state }] of states) {
        state.clearing = false;
        if (clearTasks.get(id) === task) clearTasks.delete(id);
      }
    });

  for (const id of ids) clearTasks.set(id, task);
  return task;
}

/** Wait for a workspace's in-flight writes, invalidate queued writes, then clear storage. */
export function clearQuestionConversationWorkspace(workspaceId, operation) {
  return enqueueClear([workspaceId], operation);
}

/** Clear every workspace known to this page after all their writes have settled. */
export function clearAllQuestionConversations(operation, additionalWorkspaceIds = []) {
  const workspaceIds = new Set([...recoveryByWorkspace.keys(), ...getKnownWorkspacePersistenceIds(), ...additionalWorkspaceIds]);
  return enqueueClear([...workspaceIds], operation);
}

/** @param {string} workspaceId */
export function isQuestionConversationClearPending(workspaceId) {
  return stateFor(workspaceId).clearing;
}

/** @param {string} workspaceId */
export function getQuestionConversationGeneration(workspaceId) {
  return stateFor(workspaceId).generation;
}
