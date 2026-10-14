import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acknowledgeQuestionConversationSave,
  getQuestionConversationOperations,
  getQuestionConversationView,
  recordQuestionConversationChanges,
  restoreQuestionConversations,
} from "./question-recovery.mjs";

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
