import test from "node:test";
import assert from "node:assert/strict";
import { estimateTokens } from "./token-estimate.mjs";

test("token estimate is deterministic for English source and punctuation", () => {
  assert.equal(estimateTokens("function readFile() { return true; }"), 12);
});

test("token estimate counts CJK code points without claiming model precision", () => {
  assert.equal(estimateTokens("读取源码 RepoLens"), 6);
  assert.equal(estimateTokens("  \n\t"), 0);
});
