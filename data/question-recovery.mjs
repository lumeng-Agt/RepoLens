const recoveryByWorkspace = new Map();
const saveQueues = new Map();

function clone(value) {
  return structuredClone(value);
}

function stateFor(workspaceId) {
  let state = recoveryByWorkspace.get(workspaceId);
  if (!state) {
    state = { loaded: false, baseline: [], view: [], operations: [], nextSequence: 1, readError: "", saveError: "" };
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
  const previous = saveQueues.get(workspaceId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  saveQueues.set(workspaceId, next);
  void next.finally(() => { if (saveQueues.get(workspaceId) === next) saveQueues.delete(workspaceId); }).catch(() => {});
  return next;
}
