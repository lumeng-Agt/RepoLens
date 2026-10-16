import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acknowledgeQuestionConversationSave,
  clearAllQuestionConversations,
  clearQuestionConversationWorkspace,
  enqueueQuestionConversationSave,
  getQuestionConversationOperations,
  getQuestionConversationView,
  recordQuestionConversationChanges,
  restoreQuestionConversations,
} from "./question-recovery.mjs";
import { enqueueWorkspacePersistence } from "./workspace-persistence.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("clearing a workspace waits for in-flight saves and skips queued stale saves", async () => {
  const workspaceId = `clear-order-${crypto.randomUUID()}`;
  const saved = [{ id: "old", title: "旧问答", messages: [], updatedAt: 1 }];
  restoreQuestionConversations(workspaceId, saved);
  recordQuestionConversationChanges(workspaceId, [...saved, { id: "new", title: "新问答", messages: [], updatedAt: 2 }]);
  const started = deferred();
  const release = deferred();
  const writes = [];
  const firstSave = enqueueQuestionConversationSave(workspaceId, async () => {
    started.resolve();
    await release.promise;
    writes.push("in-flight-save");
  });
  await started.promise;
  const staleSave = enqueueQuestionConversationSave(workspaceId, async () => writes.push("queued-stale-save"));
  let clearStarted = false;
  const clear = clearQuestionConversationWorkspace(workspaceId, async () => {
    clearStarted = true;
    writes.push("clear");
  });

  assert.equal(clearStarted, false, "clear must wait for the in-flight write");
  release.resolve();
  await Promise.all([firstSave, staleSave, clear]);
  assert.deepEqual(writes, ["in-flight-save", "clear"]);
  assert.deepEqual(getQuestionConversationView(workspaceId), []);
  assert.deepEqual(getQuestionConversationOperations(workspaceId), []);
});

test("failed clear keeps the in-memory conversation and pending operation", async () => {
  const workspaceId = `clear-failure-${crypto.randomUUID()}`;
  const saved = [{ id: "saved", title: "已保存", messages: [], updatedAt: 1 }];
  restoreQuestionConversations(workspaceId, saved);
  const edited = [{ ...saved[0], title: "仍待保存", updatedAt: 2 }];
  recordQuestionConversationChanges(workspaceId, edited);
  const beforeOperations = getQuestionConversationOperations(workspaceId);

  await assert.rejects(clearQuestionConversationWorkspace(workspaceId, async () => { throw new Error("clear failed"); }), /clear failed/);
  assert.deepEqual(getQuestionConversationView(workspaceId), edited);
  assert.deepEqual(getQuestionConversationOperations(workspaceId), beforeOperations);
});

test("successful clear allows a later conversation to be saved normally", async () => {
  const workspaceId = `clear-new-${crypto.randomUUID()}`;
  restoreQuestionConversations(workspaceId, [{ id: "old", title: "旧问答", messages: [], updatedAt: 1 }]);
  await clearQuestionConversationWorkspace(workspaceId, async () => {});
  const created = [{ id: "fresh", title: "新问答", messages: [], updatedAt: 3 }];
  recordQuestionConversationChanges(workspaceId, created);
  const operations = getQuestionConversationOperations(workspaceId);
  const throughSequence = operations.at(-1).sequence;
  let persisted;
  await enqueueQuestionConversationSave(workspaceId, async () => {
    persisted = structuredClone(created);
    acknowledgeQuestionConversationSave(workspaceId, persisted, throughSequence);
  });
  assert.deepEqual(persisted, created);
  assert.deepEqual(getQuestionConversationOperations(workspaceId), []);
});

test("clear-all includes an active workspace that has no question recovery state yet", async () => {
  const workspaceId = `clear-active-workspace-${crypto.randomUUID()}`;
  const started = deferred();
  const release = deferred();
  const events = [];
  const write = enqueueWorkspacePersistence(workspaceId, async () => {
    started.resolve();
    await release.promise;
    events.push("progress-write");
  });
  await started.promise;
  const clear = clearAllQuestionConversations(async () => { events.push("clear-all"); }, [workspaceId]);
  assert.deepEqual(events, [], "clear-all must wait for the active workspace even before question state exists");
  release.resolve();
  await Promise.all([write, clear]);
  assert.deepEqual(events, ["progress-write", "clear-all"]);
});
