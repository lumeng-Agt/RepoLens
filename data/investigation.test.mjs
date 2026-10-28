import test from "node:test";
import assert from "node:assert/strict";
import { validateAiResult, buildChatCompletionRequest } from "./ai-generation.mjs";
import { createInvestigation, exportInvestigations, parseInvestigationImport, mergeInvestigationImport, investigationItemIsStale, appendInvestigationResult, InvestigationSchema } from "./investigation.mjs";
import { changeInvestigation, deleteInvestigation, restoreInvestigations, failInvestigationRead, persistInvestigations, getInvestigationState, clearInvestigationMemory } from "./investigation-state.mjs";
import { clearWorkspacePersistence } from "./workspace-persistence.mjs";
import { suggestChangeChecks } from "./change-investigation.mjs";

const result = { summary: "检查取消链路", items: [{ id: "cancel", title: "取消入口", responsibility: "请求中断", reason: "调用 AbortController，需核对超时清理", references: [{ fileId: "task.ts", startLine: 2 }] }], questions: [{ question: "超时后资源如何清理？", suggestedFileId: "cleanup.ts" }] };
const repository = { id: "repo", name: "tasks", files: [{ id: "task.ts", path: "task.ts", contentHash: "hash" }], dependencies: [] };
const record = () => createInvestigation({ result, question: "取消加超时", repository, contextFiles: [{ fileId: "task.ts", contentHash: "hash", startLine: 1, endLine: 5 }], id: "investigation", now: 1 });

test("investigation model citations are restricted to immutable sent ranges; no-evidence response is supported", () => {
  const preview = { mode: "investigation", sources: [{ fileId: "task.ts", startLine: 1, endLine: 5 }] };
  assert.deepEqual(validateAiResult(result, preview), result);
  assert.throws(() => validateAiResult({ ...result, items: [{ ...result.items[0], references: [{ fileId: "cleanup.ts", startLine: 1 }] }] }, preview), /发送范围/);
  assert.deepEqual(validateAiResult({ ...result, items: [] }, preview).items, []);
  const request = buildChatCompletionRequest({ ...preview, baseUrl: "http://localhost:1234", question: "取消加超时" }, "investigation");
  assert.match(request.body.messages.at(-1).content, /不把静态导入称为实际调用/);
});

test("investigation export/import preserves records, unknown fields, conflicts and stale evidence", () => {
  const value = { ...record(), future: { field: true } };
  const imported = parseInvestigationImport(exportInvestigations([value], "json"));
  assert.deepEqual(imported, [value]);
  assert.equal(mergeInvestigationImport([value], imported, "repo").skipped, 1);
  const merge = mergeInvestigationImport([value], [{ ...value, summary: "新增发现" }], "repo", () => "copy");
  assert.equal(merge.conflicts, 1); assert.equal(merge.records[0].summary, value.summary); assert.equal(merge.records[1].id, "copy");
  assert.match(exportInvestigations([value], "markdown"), /task.ts:2/);
  assert.equal(investigationItemIsStale(value.items[0], value, repository.files), false);
  assert.equal(investigationItemIsStale({ ...value.items[0], references: [{ fileId: "task.ts", startLine: 3, endLine: 2 }] }, value, repository.files), true, "inverted imported ranges cannot navigate");
  assert.equal(investigationItemIsStale(value.items[0], value, [{ ...repository.files[0], contentHash: "changed" }]), true);
});

test("failed investigation reads forbid full writes, then merge additions and deletion intent", async () => {
  const id = crypto.randomUUID(); let disk = [record()]; let writes = 0;
  failInvestigationRead(id, "读取失败");
  changeInvestigation(id, { ...record(), id: "new" });
  assert.equal(await persistInvestigations(id, async value => { writes++; disk = value; }), false);
  assert.equal(writes, 0); assert.equal(disk.length, 1);
  restoreInvestigations(id, disk); deleteInvestigation(id, "investigation");
  await assert.rejects(persistInvestigations(id, async () => { throw Error("写入失败"); }));
  restoreInvestigations(id, disk);
  assert.deepEqual(getInvestigationState(id).records.map(item => item.id), ["new"]);
  await persistInvestigations(id, async value => { disk = value; });
  assert.deepEqual(disk.map(item => item.id), ["new"]); assert.equal(getInvestigationState(id).pending, 0);
});

test("in-flight save acknowledges only its prefix and clear waits for sent investigation writes", async () => {
  const id = crypto.randomUUID(); restoreInvestigations(id, []); changeInvestigation(id, record());
  let release; let started; const gate = new Promise(resolve => { release = resolve; }); const ready = new Promise(resolve => { started = resolve; }); let disk;
  const first = persistInvestigations(id, async value => { started(); await gate; disk = value; }); await ready;
  changeInvestigation(id, { ...record(), summary: "新的修改", updatedAt: 2 }); release(); await first;
  assert.equal(getInvestigationState(id).pending, 1); assert.notEqual(disk[0].summary, "新的修改");
  await persistInvestigations(id, async value => { disk = value; }); assert.equal(disk[0].summary, "新的修改");
  await clearWorkspacePersistence([id], async () => { disk = []; }); clearInvestigationMemory(id);
  assert.equal(getInvestigationState(id).records.length, 0);
});

test("change checks explain file dependency paths and test naming without claiming calls or coverage", () => {
  const snapshot = { files: [{ id: "a", name: "cancel.ts", path: "cancel.ts", symbols: ["cancelTask"] }, { id: "b", name: "ui.ts", path: "ui.ts" }, { id: "test", name: "cancel.test.ts", path: "cancel.test.ts" }], dependencies: [{ id: "ba", fromId: "b", toId: "a" }, { id: "tb", fromId: "test", toId: "b" }], unresolved: [] };
  const checks = suggestChangeChecks(snapshot, [{ path: "cancel.ts", status: "modified" }, { path: "gone.ts", status: "deleted" }]);
  assert.deepEqual(checks.candidates.find(item => item.fileId === "test").dependencyPath, ["test", "b", "a"]);
  assert.equal(checks.candidates.find(item => item.fileId === "test").kind, "test");
  assert.match(checks.limitations.join(" "), /无法列全旧版本使用方/);
});

test("continued investigation preserves concurrent exclusions, questions and old evidence hashes", () => {
  const latest = { ...record(), excludedFileIds: ["user-excluded.ts"], verifiedItemIds: ["cancel"], questions: [{ question: "用户刚补充的问题" }] };
  const next = appendInvestigationResult(latest, result, [{ fileId: "task.ts", contentHash: "new-hash", startLine: 1, endLine: 5 }], ["old-excluded.ts"], {}, () => "new-cancel");
  assert.deepEqual(next.excludedFileIds, ["user-excluded.ts", "old-excluded.ts"]);
  assert.equal(next.items[0].id, "cancel"); assert.equal(next.items[1].id, "new-cancel");
  const currentFiles = [{ ...repository.files[0], contentHash: "new-hash" }];
  assert.equal(investigationItemIsStale(next.items[0], next, currentFiles), true);
  assert.equal(investigationItemIsStale(next.items[1], next, currentFiles), false);
  assert.ok(next.questions.some(item => item.question === "用户刚补充的问题"));
  assert.deepEqual(next.verifiedItemIds, ["cancel"]);
});

test("fixed-seed investigation edits, read failures and write failures retain the last confirmed disk state", async () => {
  let seed = 63721; const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const id = crypto.randomUUID(); let disk = []; let expected = []; restoreInvestigations(id, disk);
  for (let index = 0; index < 40; index++) {
    const key = `record-${random() % 5}`;
    if (random() % 3 === 0) { deleteInvestigation(id, key); expected = expected.filter(item => item.id !== key); }
    else { const value = { ...record(), id: key, updatedAt: index + 2 }; changeInvestigation(id, value); expected = [...expected.filter(item => item.id !== key), value]; }
    if (random() % 4 === 0) { failInvestigationRead(id, "临时读取失败"); await persistInvestigations(id, async () => assert.fail("failed reads must prevent writes")); restoreInvestigations(id, disk); }
    if (random() % 3 === 0) await assert.rejects(persistInvestigations(id, async () => { throw Error("临时写入失败"); }));
    else await persistInvestigations(id, async value => { disk = value; });
    assert.deepEqual(getInvestigationState(id).records.map(item => item.id).sort(), expected.map(item => item.id).sort());
  }
  await persistInvestigations(id, async value => { disk = value; });
  assert.deepEqual(disk.map(item => item.id).sort(), expected.map(item => item.id).sort());
});

test("import rejects a small but deeply nested payload before it reaches component state", () => {
  const base = JSON.stringify(record());
  const depth = 2000;
  const deep = `{"nested":`.repeat(depth) + `{"marker":true}` + `}`.repeat(depth);
  const text = `{"version":1,"kind":"repolens-investigations","records":[${base.slice(0, -1)},"future":${deep}}]}`;
  assert.ok(text.length < 100_000, "payload stays far below the 2 MB byte cap");
  assert.throws(() => parseInvestigationImport(text), /嵌套超过 64 层/);
  const shallow = JSON.stringify({ version: 1, kind: "repolens-investigations", records: [{ ...record(), future: { field: true } }] });
  assert.equal(parseInvestigationImport(shallow).length, 1, "unknown fields still round-trip");
});

test("a deep repository path can be used as a change-check item id", () => {
  const longPath = `packages/${Array.from({ length: 14 }, (_, index) => `feature-${index}`).join("/")}/src/components/deep/File.tsx`;
  assert.ok(longPath.length > 160);
  const parsed = InvestigationSchema.safeParse({ ...record(), items: [{ id: longPath, title: longPath, responsibility: "使用方候选", reason: "静态引用", references: [{ fileId: longPath, startLine: 1 }] }] });
  assert.equal(parsed.success, true, parsed.success ? "" : parsed.error.issues.map((issue) => issue.message).join("；"));
});
