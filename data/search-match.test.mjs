import test from "node:test";
import assert from "node:assert/strict";
import { searchRepositoryContent } from "./repository-search.mjs";
import { buildSearchMatcher, describeSearchMatch, splitSearchHighlight } from "./search-match.mjs";

// Mirrors what the browser does for the built-in sample repository.
function sampleSearch(source, options) {
  const matcher = buildSearchMatcher(options);
  return source.split("\n").flatMap((text, index) => {
    matcher.lastIndex = 0;
    const match = matcher.exec(text);
    return match ? [{ line: index + 1, ...describeSearchMatch(text, match) }] : [];
  });
}

async function serverSearch(source, input) {
  const files = [{ id: "a", path: "a.ts", language: "ts" }];
  const result = await searchRepositoryContent({ files, sourceById: new Map([["a", source]]), input: { revision: "r", ...input } });
  return result.results.map(({ line, text, contextStartColumn, contextEndColumn, lineLength, matchStartColumn, matchEndColumn }) => ({ line, text, contextStartColumn, contextEndColumn, lineLength, matchStartColumn, matchEndColumn }));
}

function highlight(entry) {
  return splitSearchHighlight(entry);
}

test("first-column and last-column matches use 1-based inclusive columns", () => {
  const [first] = sampleSearch("save();", { query: "save" });
  assert.deepEqual([first.matchStartColumn, first.matchEndColumn, first.contextStartColumn], [1, 4, 1]);
  assert.deepEqual(highlight(first), { before: "", match: "save", after: "();" });
  const [last] = sampleSearch("call(done)", { query: "done)" });
  assert.deepEqual([last.matchStartColumn, last.matchEndColumn], [6, 10]);
  assert.deepEqual(highlight(last), { before: "call(", match: "done)", after: "" });
});

test("Chinese text is highlighted without shifting by one character", () => {
  const [hit] = sampleSearch("def 保存数据():", { query: "保存" });
  assert.deepEqual([hit.matchStartColumn, hit.matchEndColumn], [5, 6]);
  assert.deepEqual(highlight(hit), { before: "def ", match: "保存", after: "数据():" });
});

test("astral characters are never split at context boundaries and keep matching columns", () => {
  const line = `${"😀".repeat(300)}needle${"😀".repeat(300)}`;
  const [hit] = sampleSearch(line, { query: "needle" });
  assert.equal(highlight(hit).match, "needle");
  assert.ok(!/^[\udc00-\udfff]/.test(hit.text) && !/[\ud800-\udbff]$/.test(hit.text));
});

test("long lines are truncated around the match and ellipsis conditions are exposed", () => {
  const line = `${"a".repeat(1000)}needle${"b".repeat(1000)}`;
  const [hit] = sampleSearch(line, { query: "needle" });
  assert.equal(hit.text.length, 400);
  assert.ok(hit.contextStartColumn > 1 && hit.contextEndColumn < hit.lineLength);
  assert.equal(highlight(hit).match, "needle");
  assert.equal(hit.matchStartColumn, 1001);
  assert.equal(hit.matchEndColumn, 1006);
});

test("zero-length regular expressions highlight at most one character and never throw", () => {
  const [empty] = sampleSearch("", { query: "x*", regex: true });
  assert.deepEqual([empty.matchStartColumn, empty.matchEndColumn, empty.text], [1, 1, ""]);
  assert.equal(highlight(empty).match, "");
  const [hit] = sampleSearch("abc", { query: "(?=b)", regex: true });
  assert.deepEqual([hit.matchStartColumn, hit.matchEndColumn], [2, 2]);
  assert.equal(highlight(hit).match, "b");
});

test("sample search and the real search worker produce identical positions", async () => {
  const source = [
    "save();",
    "def 保存数据():",
    `${"x".repeat(900)}needle${"y".repeat(900)}`,
    `${"😀".repeat(250)}needle`,
    "call(done)",
    "",
  ].join("\n");
  for (const options of [
    { query: "save" }, { query: "保存" }, { query: "needle" }, { query: "done)" },
    { query: "x*", regex: true }, { query: "NEEDLE", matchCase: true }, { query: "save", wholeWord: true }, { query: "(?=b)|d.ne", regex: true },
  ]) {
    assert.deepEqual(await serverSearch(source, options), sampleSearch(source, options), JSON.stringify(options));
  }
});
