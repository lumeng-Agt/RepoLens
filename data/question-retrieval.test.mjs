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

test("question retrieval suggests the matching symbol definition and includes its exact lines", () => {
  const detailedFiles = [
    { ...files[0], symbolDetails: [{ name: "formatTask", kind: "function", startLine: 2, endLine: 6 }] },
    { id: "src/other.ts", path: "src/other.ts", symbols: ["formatTask"], symbolDetails: [{ name: "formatTask", kind: "function", startLine: 10, endLine: 12 }] },
  ];
  const result = rankQuestionCandidates({ files: detailedFiles, dependencies: [], sourceById: new Map(), entryFileId: "src/main.ts", question: "How does formatTask work?" });
  const match = result.candidates.find((candidate) => candidate.id === "src/main.ts");
  assert.deepEqual(match.suggestedRange, { startLine: 2, endLine: 6 });
  assert.ok(match.reasons.some((reason) => reason.includes("命中符号定义：formatTask")));
  assert.deepEqual(result.candidates.find((candidate) => candidate.id === "src/other.ts").suggestedRange, { startLine: 10, endLine: 12 });
});

test("a natural Chinese question still finds the file that implements it", () => {
  const chineseFiles = [
    { id: "src/main.ts", path: "src/main.ts", role: "应用入口", symbols: ["bootstrap"] },
    { id: "src/store.ts", path: "src/store.ts", role: "任务状态存储", symbols: ["saveTasks"] },
    { id: "src/view.tsx", path: "src/view.tsx", role: "任务视图", symbols: ["TaskList"] },
  ];
  const result = rankQuestionCandidates({
    files: chineseFiles,
    dependencies: [{ fromId: "src/main.ts", toId: "src/view.tsx" }],
    sourceById: new Map([["src/store.ts", "// 本地保存任务\nfunction saveTasks(tasks) { return tasks; }\n"]]),
    entryFileId: "src/main.ts",
    question: "任务是怎么保存到本地的？",
  });
  assert.equal(result.retrievalInsufficient, false);
  assert.equal(result.candidates[0].id, "src/store.ts");
  assert.ok(result.candidates[0].reasons.includes("源码包含问题关键词"));
});

test("Chinese function words alone do not count as evidence", () => {
  const result = rankQuestionCandidates({
    files: [{ id: "src/main.ts", path: "src/main.ts", role: "应用入口", symbols: ["bootstrap"] }],
    dependencies: [],
    sourceById: new Map([["src/main.ts", "export const value = 1;\n"]]),
    entryFileId: "src/main.ts",
    question: "这个是怎么的呢？",
  });
  assert.equal(result.retrievalInsufficient, true);
});

test("Chinese exact phrases remain stronger than separated matching words", () => {
  const candidates = ["exact.ts", "words.ts"].map(id => ({ id, path: id, symbols: [] }));
  const ranked = rankQuestionCandidates({ files: candidates, dependencies: [], entryFileId: "", question: "任务保存机制",
    sourceById: new Map([["exact.ts", "// 任务保存机制"], ["words.ts", "// 任务\n// 保存\n// 机制"]]) });
  assert.equal(ranked.retrievalInsufficient, false);
  assert.equal(ranked.candidates[0].id, "exact.ts");
  assert.ok(ranked.candidates[0].score > ranked.candidates[1].score);
});

 test("identifier splitting, low-weight expansions and separate ranges retain explainable evidence", async () => {
  const { splitIdentifier, rankInvestigationCandidates } = await import("./question-retrieval.mjs");
  assert.deepEqual(splitIdentifier("HTTPClient request_timeout cancelTask"), ["http", "client", "request", "timeout", "cancel", "task"]);
  const files = [{ id: "a", path: "a.ts", symbols: ["abortTask", "disposeTask"], symbolDetails: [{ name: "abortTask", startLine: 1, endLine: 3 }, { name: "disposeTask", startLine: 90, endLine: 95 }] }, { id: "b", path: "b.ts" }];
  const sourceById = new Map([["a", "function abortTask() { /* cancel */ }"], ["b", "unrelated"]]);
  const ranked = rankInvestigationCandidates({ files, dependencies: [{ id: "edge", fromId: "a", toId: "b" }], sourceById, question: "取消 abortTask" });
  assert.equal(ranked.candidates[0].id, "a");
  assert.deepEqual(ranked.candidates[0].suggestedRange, { startLine: 1, endLine: 3 });
  assert.ok(ranked.candidates[0].reasons.some(r => r.includes("相关术语匹配")));
  assert.equal(rankInvestigationCandidates({ files, dependencies: [{ fromId: "a", toId: "b" }], sourceById, question: "abortTask", excludedFileIds: ["b"] }).candidates.some(c => c.id === "b"), false);
});
