import test from "node:test";
import assert from "node:assert/strict";
import { collectAiCandidates, questionCandidateIds, rankGoalCandidates, selectAiContext } from "./ai-context.mjs";

const snapshot = {
  files: ["main.ts", "view.ts", "store.ts", "types.ts"].map((id) => ({ id })),
  dependencies: [
    { fromId: "main.ts", toId: "view.ts" },
    { fromId: "view.ts", toId: "store.ts" },
    { fromId: "store.ts", toId: "main.ts" },
    { fromId: "types.ts", toId: "main.ts" },
  ],
};

test("explanation candidates are one hop while routes traverse and de-duplicate cycles", () => {
  assert.deepEqual(collectAiCandidates(snapshot, "main.ts", "explanation"), ["main.ts", "view.ts"]);
  assert.deepEqual(collectAiCandidates(snapshot, "main.ts", "route"), ["main.ts", "store.ts", "view.ts"]);
  assert.throws(() => collectAiCandidates(snapshot, "missing.ts", "route"), /目标文件已不存在/);
});

test("selected AI context validates membership and exact one-based line ranges", () => {
  const input = { fileIds: ["view.ts", "main.ts"], candidateIds: ["main.ts", "view.ts"], entryFileId: "main.ts", ranges: { "view.ts": { startLine: 2, endLine: 2 } }, sourceById: new Map([["main.ts", "one\ntwo"], ["view.ts", "alpha\nbeta\ngamma"]]) };
  const context = selectAiContext(input);
  assert.deepEqual(context.sources.map(({ fileId, source, startLine, endLine }) => ({ fileId, source, startLine, endLine })), [
    { fileId: "main.ts", source: "one\ntwo", startLine: 1, endLine: 2 },
    { fileId: "view.ts", source: "beta", startLine: 2, endLine: 2 },
  ]);
  assert.equal(context.characters, 11);
  assert.throws(() => selectAiContext({ ...input, fileIds: ["outside.ts"] }), /范围已变化/);
  assert.throws(() => selectAiContext({ ...input, ranges: { "view.ts": { startLine: 0, endLine: 1 } } }), /行范围无效/);
});

test("reading goals rank route files and select the matching symbol range", () => {
  const goalSnapshot = {
    files: [
      { id: "main.ts", path: "main.ts", symbols: ["main"], symbolDetails: [{ name: "main", startLine: 1, endLine: 4 }] },
      { id: "cache.ts", path: "cache.ts", symbols: ["flushCache"], symbolDetails: [{ name: "flushCache", startLine: 8, endLine: 12 }] },
      { id: "format.ts", path: "format.ts", symbols: ["formatName"], symbolDetails: [{ name: "formatName", startLine: 1, endLine: 3 }] },
      { id: "outside.ts", path: "outside.ts", symbols: ["flushCache"] },
    ],
    dependencies: [{ fromId: "main.ts", toId: "format.ts" }, { fromId: "format.ts", toId: "cache.ts" }],
  };
  const ranked = rankGoalCandidates(goalSnapshot, "main.ts", "flushCache 缓存", new Map([
    ["main.ts", "export function main() { return formatName(); }"],
    ["format.ts", "export function formatName() { return flushCache(); }"],
    ["cache.ts", "export function flushCache() { return true; }"],
  ]));
  assert.equal(ranked.candidates[0].id, "main.ts", "the entry remains first");
  assert.ok(ranked.selectedFileIds.includes("cache.ts"), "the matching dependency is selected by the goal");
  assert.deepEqual(ranked.candidates.find((item) => item.id === "cache.ts").suggestedRange, { startLine: 8, endLine: 12 });
  assert.equal(ranked.candidates.some((item) => item.id === "outside.ts"), false, "goal matches outside the static route graph are excluded");
});

test("a supplementary question preview accepts only known files explicitly selected by the user", () => {
  const result = questionCandidateIds(snapshot, "main.ts", "unmatched question", new Map(), ["types.ts", "outside.ts"]);
  assert.ok(result.candidates.includes("types.ts"), "an explicit file can supplement retrieval candidates");
  assert.equal(result.candidates.includes("outside.ts"), false, "unknown files cannot become context");
  assert.equal(result.retrievalInsufficient, true, "retrieval weakness remains visible after manual expansion");
});
