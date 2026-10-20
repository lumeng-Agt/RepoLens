import test from "node:test";
import assert from "node:assert/strict";
import { searchRepositoryContent, validateSearchRequest } from "./repository-search.mjs";

const files = [
  { id: "src/a.ts", path: "src/a.ts", language: "ts" },
  { id: "src/b.test.ts", path: "src/b.test.ts", language: "ts" },
  { id: "docs/说明.py", path: "docs/说明.py", language: "python" },
];
const sources = new Map([
  ["src/a.ts", "export function SaveTask() {\n  return saveTask();\n}\nconst x = saveTaskExtra();"],
  ["src/b.test.ts", "test('saveTask', () => saveTask());"],
  ["docs/说明.py", "def 保存数据():\n    return True"],
]);

test("repository search finds source lines with stable file and line metadata", async () => {
  const result = await searchRepositoryContent({ files, sourceById: sources, input: { query: "saveTask", revision: "rev-1" } });
  assert.equal(result.revision, "rev-1");
  assert.equal(result.total, 4);
  assert.deepEqual(result.results.map((item) => [item.fileId, item.line]), [["src/a.ts", 1], ["src/a.ts", 2], ["src/a.ts", 4], ["src/b.test.ts", 1]]);
});

test("repository search supports case, whole-word, path, language and test filters", async () => {
  const whole = await searchRepositoryContent({ files, sourceById: sources, input: { query: "SaveTask", matchCase: true, wholeWord: true, pathPrefix: "src", excludeTests: true, revision: "r" } });
  assert.deepEqual(whole.results.map((item) => item.line), [1]);
  const chinese = await searchRepositoryContent({ files, sourceById: sources, input: { query: "保存", language: "python", revision: "r" } });
  assert.equal(chinese.results[0].path, "docs/说明.py");
});

test("repository search supports regex and paged stable results", async () => {
  const manyFiles = Array.from({ length: 105 }, (_, index) => ({ id: `f/${String(index).padStart(3, "0")}.ts`, path: `f/${String(index).padStart(3, "0")}.ts`, language: "ts" }));
  const manySources = new Map(manyFiles.map((file) => [file.id, "const saveTask = true;\n"]));
  const first = await searchRepositoryContent({ files: manyFiles, sourceById: manySources, input: { query: "saveTask\\s*=", regex: true, revision: "r" } });
  assert.equal(first.total, 105);
  assert.equal(first.results.length, 100);
  assert.equal(first.hasMore, true);
  const next = await searchRepositoryContent({ files: manyFiles, sourceById: manySources, input: { query: "saveTask", offset: 100, revision: "r" } });
  assert.equal(next.results.length, 5);
  assert.equal(next.results[0].path, "f/100.ts");
});

test("repository search returns matching context and columns when the hit is far into a long line", async () => {
  const line = `${"prefix ".repeat(90)}IMPORTANT_MATCH${" suffix".repeat(90)}`;
  const result = await searchRepositoryContent({
    files: [{ id: "long.ts", path: "long.ts", language: "ts" }],
    sourceById: new Map([["long.ts", line]]),
    input: { query: "IMPORTANT_MATCH", revision: "r" },
  });
  const hit = result.results[0];
  assert.ok(hit.text.includes("IMPORTANT_MATCH"));
  assert.ok(hit.contextStartColumn > 1);
  assert.equal(hit.matchStartColumn, line.indexOf("IMPORTANT_MATCH") + 1);
  assert.equal(hit.matchEndColumn, line.indexOf("IMPORTANT_MATCH") + "IMPORTANT_MATCH".length);
});

test("repository search rejects traversal prefixes and malformed regular expressions", async () => {
  assert.throws(() => validateSearchRequest({ query: "x", pathPrefix: "src/../private" }));
  await assert.rejects(searchRepositoryContent({ files, sourceById: sources, input: { query: "[", regex: true, revision: "r" } }), /正则表达式无效/);
});

test("repository search cancellation and pathological regex timeout terminate the worker", async () => {
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(searchRepositoryContent({ files, sourceById: sources, input: { query: "x", revision: "r" }, signal: cancelled.signal }), { name: "AbortError" });
  const pathological = new Map([["large.ts", `${"a".repeat(200_000)}!`]]);
  await assert.rejects(searchRepositoryContent({ files: [{ id: "large.ts", path: "large.ts", language: "ts" }], sourceById: pathological, input: { query: "(a+)+$", regex: true, revision: "r" }, timeoutMs: 200 }), /搜索耗时过长/);
});
