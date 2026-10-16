import test from "node:test";
import assert from "node:assert/strict";
import { rankQuestionCandidates } from "./question-retrieval.mjs";

const files = [
  { id: "src/main.ts", path: "src/main.ts", role: "Application entry", symbols: ["startApp"] },
  { id: "src/store.ts", path: "src/store.ts", role: "Task state", symbols: ["TaskStore"] },
  { id: "src/view.tsx", path: "src/view.tsx", role: "Task view", symbols: ["TaskList"] },
];

test("question retrieval ranks relevant files and exposes why each was selected", () => {
  const result = rankQuestionCandidates({
    files,
    dependencies: [{ fromId: "src/main.ts", toId: "src/view.tsx" }, { fromId: "src/store.ts", toId: "src/main.ts" }],
    sourceById: new Map([["src/store.ts", "export function completeTask() {}"]]),
    entryFileId: "src/main.ts",
    question: "completeTask task state",
  });

  assert.equal(result.retrievalInsufficient, false);
  assert.equal(result.candidates[0].id, "src/store.ts");
  assert.ok(result.candidates.find((item) => item.id === "src/main.ts").reasons.includes("当前文件"));
  assert.ok(result.candidates.find((item) => item.id === "src/view.tsx").reasons.includes("当前文件的直接依赖"));
  assert.ok(result.candidates.find((item) => item.id === "src/store.ts").reasons.includes("源码包含问题关键词"));
  assert.ok(result.candidates.find((item) => item.id === "src/view.tsx").reasons.length > 0);
});

test("question retrieval marks weak evidence and returns deterministic ties", () => {
  const result = rankQuestionCandidates({ files, dependencies: [], sourceById: new Map(), entryFileId: "src/main.ts", question: "unrelated phrase" });
  assert.equal(result.retrievalInsufficient, true);
  assert.deepEqual(result.candidates.map((item) => item.id), ["src/main.ts", "src/store.ts", "src/view.tsx"]);
  assert.ok(result.candidates.find((item) => item.id === "src/store.ts").reasons.includes("未发现直接匹配，可手动确认"));
});
