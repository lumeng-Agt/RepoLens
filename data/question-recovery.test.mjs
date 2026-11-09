import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acknowledgeQuestionConversationSave,
  getQuestionConversationOperations,
  getQuestionConversationView,
  getQuestionConversationReadVersion,
  recordQuestionConversationChanges,
  restoreQuestionConversations,
} from "./question-recovery.mjs";

test("confirmed conversation changes invalidate older reads without confirming pending edits", () => {
  const workspaceId = `read-version-${crypto.randomUUID()}`;
  const before = getQuestionConversationReadVersion(workspaceId);
  const saved = [{ id: "saved", title: "Saved", messages: [], updatedAt: 1 }];
  restoreQuestionConversations(workspaceId, saved);
  assert.ok(getQuestionConversationReadVersion(workspaceId) > before);
  const readVersion = getQuestionConversationReadVersion(workspaceId);
  const edited = [{ ...saved[0], title: "Edited" }];
  recordQuestionConversationChanges(workspaceId, edited);
  assert.equal(getQuestionConversationReadVersion(workspaceId), readVersion, "local operations merge into a pending read");
  const checkpoint = getQuestionConversationOperations(workspaceId).at(-1).sequence;
  recordQuestionConversationChanges(workspaceId, []);
  acknowledgeQuestionConversationSave(workspaceId, edited, checkpoint);
  assert.ok(getQuestionConversationReadVersion(workspaceId) > readVersion, "a completed save makes an older GET stale");
  assert.deepEqual(getQuestionConversationView(workspaceId), [], "a newer deletion stays pending");
  assert.equal(getQuestionConversationOperations(workspaceId).length, 1);
});

test("question recovery applies ordered conversation upserts and tombstones after rereading storage", () => {
  const workspaceId = `question-recovery-${crypto.randomUUID()}`;
  const saved = [{ id: "delete", title: "Delete", messages: [], updatedAt: 2 }, { id: "keep", title: "Keep", messages: [], updatedAt: 1 }];
  assert.deepEqual(restoreQuestionConversations(workspaceId, saved), saved);

  const edited = [
    { ...saved[1], messages: [{ id: "message-1", role: "user", content: "question" }], updatedAt: 3 },
    { id: "new", title: "New", messages: [], updatedAt: 4 },
  ];
  recordQuestionConversationChanges(workspaceId, edited);
  assert.deepEqual(getQuestionConversationView(workspaceId).map(({ id }) => id), ["keep", "new"]);

  const reread = restoreQuestionConversations(workspaceId, saved);
  assert.deepEqual(reread.map(({ id }) => id), ["new", "keep"]);
  assert.deepEqual(reread.find(({ id }) => id === "keep").messages.map(({ id }) => id), ["message-1"]);
  assert.equal(reread.find(({ id }) => id === "keep").messages[0].content, "question", "message text survives the reread merge");

  const operations = getQuestionConversationOperations(workspaceId);
  const throughSequence = operations.at(-1).sequence;
  recordQuestionConversationChanges(workspaceId, []);
  acknowledgeQuestionConversationSave(workspaceId, reread, throughSequence);
  assert.deepEqual(getQuestionConversationView(workspaceId), [], "a later deletion remains pending after an older save completes");
  assert.equal(getQuestionConversationOperations(workspaceId).some((operation) => operation.kind === "delete" && operation.conversationId === "new"), true);
});


test("recovery preserves both a full saved history and unsaved conversations without implicit deletion", () => {
  const workspaceId = `full-recovery-${crypto.randomUUID()}`;
  const unsaved = { id: "unsaved", title: "In memory", messages: [{ id: "m", content: "Keep local answer" }], updatedAt: 200 };
  recordQuestionConversationChanges(workspaceId, [unsaved]);
  const saved = Array.from({ length: 100 }, (_, i) => ({ id: `saved-${i}`, title: `Saved ${i}`, messages: [], updatedAt: i }));
  const restored = restoreQuestionConversations(workspaceId, saved);
  assert.equal(restored.length, 101);
  for (const record of [...saved, unsaved]) assert.ok(restored.some(item => item.id === record.id));
  assert.equal(getQuestionConversationOperations(workspaceId).some(item => item.kind === "delete"), false);
});
