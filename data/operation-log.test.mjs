import assert from "node:assert/strict";
import test from "node:test";
import { createOperationRecorder } from "./operation-log.mjs";

test("operation recorder is bounded and omits source, question, key, and unknown fields", () => {
  const emitted = [];
  const recorder = createOperationRecorder({ capacity: 2, onRecord: (record) => emitted.push(record) });
  for (let index = 0; index < 3; index += 1) {
    const operation = recorder.start("ai.generate", { mode: "question", apiKey: "secret", question: "private question" });
    operation.finish("ok", { cached: false, source: "private source", answer: "private answer", fileCount: 3 });
  }
  assert.equal(recorder.recent().length, 2);
  assert.equal(emitted.length, 3);
  const serialized = JSON.stringify(recorder.recent());
  assert.match(serialized, /ai.generate/);
  assert.match(serialized, /question/);
  assert.doesNotMatch(serialized, /secret|private|apiKey|answer/);
  assert.equal(recorder.recent()[0].fileCount, 3);
  assert.equal(typeof recorder.recent()[0].durationMs, "number");
  const unsafeAction = recorder.start("workspace.mutate", { action: "user supplied content" });
  unsafeAction.finish("error");
  assert.doesNotMatch(JSON.stringify(recorder.recent()), /user supplied content/);
});

test("operation finish is idempotent", () => {
  const recorder = createOperationRecorder();
  const operation = recorder.start("scan");
  operation.finish("ok");
  operation.finish("error");
  assert.equal(recorder.recent().length, 1);
  assert.equal(recorder.recent()[0].status, "ok");
});
