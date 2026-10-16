import test from "node:test";
import assert from "node:assert/strict";
import { collectAiCandidates, selectAiContext } from "./ai-context.mjs";

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
