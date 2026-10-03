import test from "node:test";
import assert from "node:assert/strict";
import { aiWorkflowReducer, initialAiWorkflowState } from "./ai-workflow.mjs";

test("AI workflow ignores late preview and generation responses after context invalidation", () => {
  const started = aiWorkflowReducer(initialAiWorkflowState, { type: "start", requestId: 1, stage: "previewing", contextKey: "repo-a:file-a:explanation" });
  const invalidated = aiWorkflowReducer(started, { type: "invalidate", requestId: 2 });
  const late = aiWorkflowReducer(invalidated, { type: "previewReady", requestId: 1, contextKey: started.contextKey, preview: { id: "old" } });
  assert.equal(late, invalidated);
  assert.equal(late.status, "idle");

  const generating = aiWorkflowReducer(invalidated, { type: "start", requestId: 3, stage: "generating", contextKey: "repo-a:file-b:route", preview: { id: "current" } });
  const lateGeneration = aiWorkflowReducer(generating, { type: "failed", requestId: 1, contextKey: "repo-a:file-a:explanation", message: "stale failure" });
  assert.equal(lateGeneration, generating);
  assert.equal(lateGeneration.status, "generating");
  assert.equal(aiWorkflowReducer(generating, { type: "failed", requestId: 3, contextKey: generating.contextKey, message: "cancelled" }).status, "error");
});

test("AI workflow scope selection invalidates prior confirmation and exits busy state", () => {
  const previewing = aiWorkflowReducer(initialAiWorkflowState, { type: "start", requestId: 1, stage: "previewing", contextKey: "repo:file:route" });
  const scoped = aiWorkflowReducer(previewing, { type: "scopeRequired", requestId: 1, contextKey: previewing.contextKey, candidates: [{ fileId: "repo/main.ts", lineCount: 10, oversizedLines: [4] }], selectedFiles: ["repo/main.ts"], ranges: { "repo/main.ts": { startLine: 1, endLine: 10 } }, message: "select range" });
  assert.equal(scoped.status, "ready");
  assert.equal(scoped.preview, null);
  const changed = aiWorkflowReducer(scoped, { type: "scopeChanged", requestId: 2, selectedFiles: [], ranges: {} });
  assert.equal(changed.requestId, 2);
  assert.equal(changed.status, "ready");
  assert.equal(changed.preview, null);
});

test("AI scope remains editable after failed preview and clears only after a valid preview", () => {
  const scope = { fileId: "repo/main.ts", lineCount: 3, oversizedLines: [2] };
  const started = aiWorkflowReducer(initialAiWorkflowState, { type: "start", requestId: 1, stage: "previewing", contextKey: "repo:file:explanation", mode: "explanation" });
  const required = aiWorkflowReducer(started, { type: "scopeRequired", requestId: 1, contextKey: started.contextKey, candidates: [scope], selectedFiles: [scope.fileId], ranges: { [scope.fileId]: { startLine: 1, endLine: 3 } }, message: "limit" });
  const invalidated = aiWorkflowReducer(required, { type: "invalidate", requestId: 2, preserveScope: true });
  const retry = aiWorkflowReducer(invalidated, { type: "start", requestId: 3, stage: "previewing", contextKey: "repo:file:explanation:retry", mode: "explanation", preserveScope: true });
  const failed = aiWorkflowReducer(retry, { type: "failed", requestId: 3, contextKey: retry.contextKey, message: "invalid range" });
  assert.equal(failed.status, "error");
  assert.deepEqual(failed.candidates, [scope]);
  const adjusted = aiWorkflowReducer(failed, { type: "scopeChanged", requestId: 4, selectedFiles: [scope.fileId], ranges: { [scope.fileId]: { startLine: 1, endLine: 1 } } });
  assert.equal(adjusted.status, "ready");
  assert.deepEqual(adjusted.ranges[scope.fileId], { startLine: 1, endLine: 1 });
  const checked = aiWorkflowReducer(adjusted, { type: "start", requestId: 5, stage: "previewing", contextKey: "repo:file:explanation:checked", mode: "explanation", preserveScope: true });
  const success = aiWorkflowReducer(checked, { type: "previewReady", requestId: 5, contextKey: checked.contextKey, preview: { id: "fresh" } });
  assert.deepEqual(success.candidates, []);
  assert.deepEqual(success.selectedFiles, []);
});
