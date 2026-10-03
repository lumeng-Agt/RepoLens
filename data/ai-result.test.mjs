import test from "node:test";
import assert from "node:assert/strict";
import { aiResultIsStale, aiRouteStepsFromResult } from "./ai-result.mjs";
import { aiRouteSignature, createAiRouteRecord } from "./ai-route.mjs";

const result = {
  __repositoryId: "repo-a", __entryFileId: "src/main.ts", __revision: "r1", __mode: "route",
  __contextFiles: [{ fileId: "src/main.ts", contentHash: "main-v1" }, { fileId: "src/lib.ts", contentHash: "lib-v1" }],
  __routeSteps: [{ id: "step-a", title: "入口", focusFileId: "src/main.ts", description: "从入口读起", reference: { fileId: "src/main.ts", line: 1 } }],
};

test("AI route survives unrelated revisions but expires on changed or removed context files", () => {
  assert.equal(aiResultIsStale(result, { id: "repo-a", revision: "r2", files: [{ id: "src/main.ts", contentHash: "main-v1" }, { id: "src/lib.ts", contentHash: "lib-v1" }, { id: "src/other.ts", contentHash: "other-v1" }] }), false);
  assert.equal(aiResultIsStale(result, { id: "repo-a", revision: "r3", files: [{ id: "src/main.ts", contentHash: "main-v1" }, { id: "src/lib.ts", contentHash: "lib-v2" }] }), true);
  assert.equal(aiResultIsStale(result, { id: "repo-a", revision: "r4", files: [{ id: "src/main.ts", contentHash: "main-v1" }] }), true);
  assert.equal(aiResultIsStale(result, { id: "repo-b", revision: "r4", files: [] }), false);
});

test("AI route steps remain an independent navigable source after server snapshots", () => {
  assert.deepEqual(aiRouteStepsFromResult(result, "repo-a"), result.__routeSteps);
  assert.equal(aiRouteStepsFromResult(result, "repo-b"), null);
});

test("AI route identity is canonical, independent of request ids, and includes every source reference", () => {
  const steps = [
    { fileId: "src/main.ts", purpose: "入口", references: [{ fileId: "src/main.ts", startLine: 1 }, { fileId: "src/lib.ts", startLine: 4, endLine: 6 }] },
    { fileId: "src/lib.ts", purpose: "依赖", references: [{ fileId: "src/lib.ts", startLine: 4 }] },
    { fileId: "src/main.ts", purpose: "回顾", references: [{ fileId: "src/main.ts", startLine: 8 }] },
  ];
  const first = createAiRouteRecord({ repositoryId: "repo", entryFileId: "src/main.ts", revision: "r1", title: "路线", steps, contextFiles: [] }, (id) => id.split("/").at(-1));
  const second = createAiRouteRecord({ repositoryId: "repo", entryFileId: "src/main.ts", revision: "r2", title: "路线", steps: structuredClone(steps), contextFiles: [] }, (id) => id.split("/").at(-1));
  assert.equal(first.signature, second.signature);
  assert.deepEqual(first.steps.map((step) => step.id), second.steps.map((step) => step.id));
  assert.equal(first.sourceSteps[0].references.length, 2);
  assert.notEqual(aiRouteSignature("路线", steps), aiRouteSignature("路线", steps.map((step, index) => index ? step : { ...step, references: [...step.references, { fileId: "src/main.ts", startLine: 12 }] })));
});
