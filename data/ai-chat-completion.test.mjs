import test from "node:test";
import assert from "node:assert/strict";
import { buildAiChatCompletion } from "./ai-chat-completion.mjs";

const chat = { conversationId: "conversation-1", userMessageId: "user-1", answerMessageId: "answer-1" };
const context = {
  mode: "question",
  repositoryId: "repo-1",
  revision: "revision-1",
  entryFileId: "src/main.ts",
  question: "How does main work?",
  goal: null,
  sources: [{ fileId: "src/main.ts", contentHash: "hash-main", startLine: 1, endLine: 3, source: "export const main = 1;" }],
};

test("a question chat keeps the confirmed prompt, answer, and validated references", () => {
  const result = { answer: "main exports one.", insufficientEvidence: false, references: [{ fileId: "src/main.ts", startLine: 1 }] };
  const completion = buildAiChatCompletion(context, result, chat);
  assert.deepEqual(completion.messages.map((message) => [message.id, message.role]), [[chat.userMessageId, "user"], [chat.answerMessageId, "assistant"]]);
  assert.equal(completion.messages[0].content, "How does main work?");
  assert.equal(completion.messages[1].content, "main exports one.");
  assert.deepEqual(completion.messages[1].references, result.references);
  assert.deepEqual(completion.messages[1].contextFiles, [{ fileId: "src/main.ts", contentHash: "hash-main", startLine: 1, endLine: 3 }]);
  assert.equal(completion.artifacts.route, null);
  assert.equal(completion.artifacts.explanation, null);
});

test("a route chat persists the generated route as an artifact without losing its citations", () => {
  const steps = [
    { fileId: "src/main.ts", purpose: "Start here", relationship: "entry", question: "What is exported?", references: [{ fileId: "src/main.ts", startLine: 1 }] },
    { fileId: "src/main.ts", purpose: "Check the value", relationship: "continue", question: "Where is it used?", references: [{ fileId: "src/main.ts", startLine: 2 }] },
    { fileId: "src/main.ts", purpose: "Finish", relationship: "return", question: "What changed?", references: [{ fileId: "src/main.ts", startLine: 3 }] },
  ];
  const result = { title: "A route", steps };
  const completion = buildAiChatCompletion({ ...context, mode: "route", goal: "understand main" }, result, chat);
  assert.equal(completion.messages[0].content, "生成阅读路线：understand main");
  assert.equal(completion.messages[1].content, "A route");
  assert.equal(completion.messages[1].route.title, "A route");
  assert.equal(completion.messages[1].route.steps.length, 3);
  assert.deepEqual(completion.messages[1].references, steps.flatMap((step) => step.references));
  assert.equal(completion.artifacts.explanation, null);
});

test("an explanation chat keeps its metadata and source context", () => {
  const result = { role: "Entry module", keyPoints: ["Exports main"], references: [{ fileId: "src/main.ts", startLine: 1 }] };
  const completion = buildAiChatCompletion({ ...context, mode: "explanation" }, result, chat);
  assert.equal(completion.messages[0].content, "讲解文件：src/main.ts");
  assert.match(completion.messages[1].content, /Entry module/);
  assert.equal(completion.messages[1].explanation.__repositoryId, "repo-1");
  assert.equal(completion.messages[1].explanation.__revision, "revision-1");
  assert.deepEqual(completion.artifacts.explanation.__contextFiles, [{ fileId: "src/main.ts", contentHash: "hash-main", startLine: 1, endLine: 3 }]);
});
