import test from "node:test";
import assert from "node:assert/strict";
import { AiPreviewResponseSchema, createAiGenerationEnvelope } from "./ai-contract.mjs";

const context = { repositoryId: "repo-a", revision: "rev-a", entryFileId: "src/main.ts", mode: "explanation" };

test("cached and generated AI results share one strict response envelope", () => {
  const generated = createAiGenerationEnvelope({ role: "说明", keyPoints: [], references: [] }, context, false);
  const cached = createAiGenerationEnvelope({ role: "说明", keyPoints: [], references: [] }, context, true);
  assert.deepEqual(Object.keys(cached).sort(), Object.keys(generated).sort());
  assert.deepEqual({ cached: generated.cached, repositoryId: generated.repositoryId, revision: generated.revision, entryFileId: generated.entryFileId, mode: generated.mode }, { cached: false, ...context });
  assert.equal(cached.cached, true);
  assert.throws(() => createAiGenerationEnvelope({}, { ...context, repositoryId: "" }, true));
});

test("scope-required preview responses identify oversized lines for every candidate", () => {
  const response = { scopeRequired: true, candidates: [{ fileId: "src/main.ts", characters: 70_000, lineCount: 20, oversizedLines: [4] }], maxFiles: 12, maxCharacters: 60_000 };
  assert.equal(AiPreviewResponseSchema.safeParse(response).success, true);
  assert.equal(AiPreviewResponseSchema.safeParse({ ...response, candidates: [{ fileId: "", characters: -1, lineCount: 0, oversizedLines: [0] }] }).success, false);
  assert.equal(AiPreviewResponseSchema.safeParse({ ...response, candidates: [{ fileId: "src/main.ts", characters: 1, lineCount: 3, oversizedLines: [4] }] }).success, false);
  assert.equal(AiPreviewResponseSchema.safeParse({ ...response, unsafe: true }).success, false);
});
