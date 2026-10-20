import test from "node:test";
import assert from "node:assert/strict";
import { AiPreviewResponseSchema, AiQuestionAnswerSchema, AiRouteSchema, createAiGenerationEnvelope } from "./ai-contract.mjs";

const context = { repositoryId: "repo-a", revision: "rev-a", entryFileId: "src/main.ts", mode: "explanation" };

test("cached and generated AI results share one strict response envelope", () => {
  const generated = createAiGenerationEnvelope({ role: "说明", keyPoints: [], references: [] }, context, false);
  const cached = createAiGenerationEnvelope({ role: "说明", keyPoints: [], references: [] }, context, true);
  assert.deepEqual(Object.keys(cached).sort(), Object.keys(generated).sort());
  assert.deepEqual({ cached: generated.cached, repositoryId: generated.repositoryId, revision: generated.revision, entryFileId: generated.entryFileId, mode: generated.mode }, { cached: false, ...context });
  assert.equal(cached.cached, true);
  assert.throws(() => createAiGenerationEnvelope({}, { ...context, repositoryId: "" }, true));
});

test("AI route steps require a relationship and a self-check question", () => {
  const route = { title: "路线", steps: [0, 1, 2].map((index) => ({
    fileId: `src/${index}.ts`, purpose: `阅读第 ${index + 1} 步`,
    relationship: index === 0 ? "入口" : "继续追踪静态依赖",
    question: `第 ${index + 1} 步能解释什么？`,
    references: [{ fileId: `src/${index}.ts`, startLine: 1 }],
  })) };
  assert.equal(AiRouteSchema.safeParse(route).success, true);
  assert.equal(AiRouteSchema.safeParse({ ...route, steps: route.steps.map((step, index) => index === 1 ? Object.fromEntries(Object.entries(step).filter(([key]) => key !== "relationship")) : step) }).success, false);
  assert.equal(AiRouteSchema.safeParse({ ...route, steps: route.steps.map((step, index) => index === 1 ? Object.fromEntries(Object.entries(step).filter(([key]) => key !== "question")) : step) }).success, false);
  assert.equal(AiRouteSchema.safeParse({ ...route, steps: route.steps.map((step, index) => index === 1 ? { ...step, relationship: "  " } : step) }).success, false);
  assert.equal(AiRouteSchema.safeParse({ ...route, steps: route.steps.map((step, index) => index === 1 ? { ...step, question: "  " } : step) }).success, false);
});

test("scope-required preview responses identify oversized lines for every candidate", () => {
  const response = { scopeRequired: true, candidates: [{ fileId: "src/main.ts", characters: 70_000, lineCount: 20, oversizedLines: [4], reasons: ["当前文件", "源码包含问题关键词"], suggestedRange: { startLine: 2, endLine: 9 } }], maxFiles: 12, maxCharacters: 60_000 };
  assert.equal(AiPreviewResponseSchema.safeParse(response).success, true);
  assert.equal(AiPreviewResponseSchema.safeParse({ ...response, candidates: [{ fileId: "", characters: -1, lineCount: 0, oversizedLines: [0] }] }).success, false);
  assert.equal(AiPreviewResponseSchema.safeParse({ ...response, candidates: [{ fileId: "src/main.ts", characters: 1, lineCount: 3, oversizedLines: [4] }] }).success, false);
  assert.equal(AiPreviewResponseSchema.safeParse({ ...response, candidates: [{ ...response.candidates[0], suggestedRange: { startLine: 10, endLine: 21 } }] }).success, false);
  assert.equal(AiPreviewResponseSchema.safeParse({ ...response, unsafe: true }).success, false);
});

test("preview envelopes accept an explicitly approximate token estimate", () => {
  const base = { scopeRequired: false, preview: { id: "preview", repositoryId: "repo", revision: "rev", entryFileId: "src/main.ts", mode: "question", baseUrl: "http://localhost/v1", model: "test", files: [], characters: 20, expiresAt: 2_000_000_000_000 } };
  assert.equal(AiPreviewResponseSchema.safeParse({ ...base, preview: { ...base.preview, tokenEstimate: 8 } }).success, true);
  assert.equal(AiPreviewResponseSchema.safeParse({ ...base, preview: { ...base.preview, tokenEstimate: -1 } }).success, false);
});

test("question claim evidence indices must refer to the returned reference list", () => {
  const answer = { answer: "The state is persisted.", insufficientEvidence: false, references: [{ fileId: "src/store.ts", startLine: 12 }], claims: [{ text: "Writes are serialized.", referenceIndices: [0] }] };
  assert.equal(AiQuestionAnswerSchema.safeParse(answer).success, true);
  assert.equal(AiQuestionAnswerSchema.safeParse({ ...answer, claims: [{ text: "Unsupported claim", referenceIndices: [1] }] }).success, false);
  assert.equal(AiQuestionAnswerSchema.safeParse({ ...answer, insufficientEvidence: true, references: [], claims: answer.claims }).success, false);
});
