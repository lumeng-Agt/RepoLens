import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { createWorkspaceStore } from "./workspace-store.mjs";

test("workspace store persists recents, results, route progress, and positions without source snapshots", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repolens-workspace-store-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = createWorkspaceStore(directory);
  await store.touchRecent({ id: "local-project", name: "Project", location: "D:\\project" });
  await store.saveAiResult("local-project", "src/index.py", { answer: "An explanation", references: [{ fileId: "src/index.py", startLine: 3 }], contentHashes: [{ fileId: "src/index.py", hash: "abc" }] });
  await store.saveAiRoute("local-project", { title: "Route", signature: "route-hash", steps: [] });
  const note = { id: "note-1", fileId: "src/index.py", path: "src/index.py", startLine: 3, text: "Check this branch", contentHash: "abc", createdAt: 1, kind: "note" };
  await store.saveReadingNotes("local-project", [note]);
  await store.saveTours("local-project", [{ title: "Route", signature: "route-hash", steps: [] }]);
  const key = "repolens:local-project:route-hash";
  await store.saveProgress("local-project", key, JSON.stringify({ stepIndex: 2, completedSteps: ["one"] }));
  await store.saveNodePositions("local-project", { "src/index.py": { x: 12, y: 34 } });
  const restored = await createWorkspaceStore(directory).getRepository("local-project");
  assert.equal(restored.persistenceReady, true);
  assert.equal(restored.recentRepositories[0].name, "Project");
  assert.equal(restored.aiResults["src/index.py"].answer, "An explanation");
  assert.equal(restored.aiRoute.signature, "route-hash");
  assert.deepEqual(restored.readingNotes, [note]);
  assert.equal(restored.savedTours[0].signature, "route-hash");
  assert.equal(restored.progress[key].includes('"stepIndex":2'), true);
  assert.deepEqual(restored.nodePositions["src/index.py"], { x: 12, y: 34 });
  assert.doesNotMatch(await readFile(path.join(directory, "workspace-v1.json"), "utf8"), /sourceText|rawSource|"source"\s*:/);
});

test("unified chat completion stores the transcript and generated artifacts atomically", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repolens-ai-chat-store-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = createWorkspaceStore(directory);
  const route = { repositoryId: "repo", entryFileId: "a.ts", revision: "r1", title: "Route", signature: "route-1", sourceSteps: [], steps: [] };
  const explanation = { __repositoryId: "repo", __entryFileId: "a.ts", __revision: "r1", __mode: "explanation", __contextFiles: [{ fileId: "a.ts", contentHash: "h" }], role: "Entry" };
  const messages = [
    { id: "user-1", role: "user", content: "Explain a.ts", references: [], contextFiles: [{ fileId: "a.ts", contentHash: "h" }] },
    { id: "answer-1", role: "assistant", content: "A is the entry.", references: [{ fileId: "a.ts", startLine: 1 }], contextFiles: [{ fileId: "a.ts", contentHash: "h" }], route, explanation },
  ];
  const result = await store.commitAiChatCompletion("workspace-a", "conversation-1", messages, { route, explanation });
  assert.equal(result.persisted, true);
  const restored = await createWorkspaceStore(directory).getRepository("workspace-a");
  assert.equal(restored.conversations.length, 1);
  assert.deepEqual(restored.conversations[0].messages.map((message) => message.id), ["user-1", "answer-1"]);
  assert.equal(restored.conversations[0].messages[1].route.signature, "route-1");
  assert.equal(restored.conversations[0].messages[1].explanation.role, "Entry");
  assert.equal(restored.aiResults["a.ts"].role, "Entry");
  assert.equal(restored.savedTours[0].signature, "route-1");
  assert.equal(restored.aiRoute.signature, "route-1");
  await assert.rejects(store.commitAiChatCompletion("workspace-a", "conversation-2", messages, {}, () => false), { name: "AbortError" });
  const afterAbort = await createWorkspaceStore(directory).getRepository("workspace-a");
  assert.equal(afterAbort.conversations.some((conversation) => conversation.id === "conversation-2"), false);
});

test("reading artifacts are workspace-scoped and removed by the existing clear operation", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repolens-reading-artifacts-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = createWorkspaceStore(directory);
  const note = { id: "n", fileId: "a.ts", path: "a.ts", startLine: 1, text: "note", contentHash: "h", createdAt: 1, kind: "bookmark" };
  await store.saveReadingNotes("workspace-a", [note]);
  await store.saveTours("workspace-a", [{ signature: "tour-a", steps: [] }]);
  assert.deepEqual((await store.getRepository("workspace-b")).readingNotes, []);
  assert.equal((await store.clearRepository("workspace-a")).persisted, true);
  const cleared = await createWorkspaceStore(directory).getRepository("workspace-a");
  assert.deepEqual(cleared.readingNotes, []);
  assert.deepEqual(cleared.savedTours, []);
});

test("usage guide preferences are global, survive repository clearing, and are removed by clear-all", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repolens-guide-preferences-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = createWorkspaceStore(directory);
  const preferences = { version: 1, welcomeHandled: true, completedTaskIds: ["source"], checklistOpen: false, noticeDismissed: true };
  await store.saveGuidePreferences(preferences);
  await store.saveReadingNotes("workspace-a", [{ id: "n1", fileId: "a.ts", path: "a.ts", startLine: 1, text: "note", contentHash: "h", createdAt: 1, kind: "note" }]);

  assert.deepEqual((await store.getRepository("workspace-a")).guidePreferences, preferences);
  await store.clearRepository("workspace-a");
  assert.deepEqual((await createWorkspaceStore(directory).getRepository("workspace-a")).guidePreferences, preferences);

  await store.clearAll();
  assert.equal((await createWorkspaceStore(directory).getRepository("workspace-a")).guidePreferences, null);
});

test("workspace layout preferences survive repository changes and are removed by clear-all", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repolens-layout-preferences-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = createWorkspaceStore(directory);
  const preferences = { version: 1, structure: { files: 25, graph: 45, details: 30 }, reading: { files: 35, details: 65 } };
  await store.saveLayoutPreferences(preferences);
  assert.deepEqual((await store.getRepository("workspace-a")).layoutPreferences, preferences);
  await store.clearRepository("workspace-a");
  assert.deepEqual((await createWorkspaceStore(directory).getRepository("workspace-b")).layoutPreferences, preferences);
  await store.clearAll();
  assert.equal((await createWorkspaceStore(directory).getRepository("workspace-a")).layoutPreferences, null);
});

test("workspace store limits recents and quarantines damaged records while staying usable", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repolens-workspace-corrupt-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = createWorkspaceStore(directory);
  for (let index = 0; index < 22; index += 1) await store.touchRecent({ id: `repo-${index}`, name: `Repo ${index}`, location: `D:\\repo-${index}` });
  assert.equal((await store.get()).recentRepositories.length, 20);
  await writeFile(path.join(directory, "workspace-v1.json"), "{invalid", "utf8");
  const damaged = createWorkspaceStore(directory);
  const snapshot = await damaged.get();
  assert.equal(snapshot.persistenceReady, true, "successfully quarantined corruption can recover into a new writable store");
  assert.equal(snapshot.recentRepositories.length, 0);
  assert.match(snapshot.warning, /无法读取本地保存数据/);
  assert.ok((await readdir(directory)).some((name) => name.includes(".corrupt-")));
  await damaged.touchRecent({ id: "recovered", name: "Recovered", location: "D:\\recovered" });
  assert.equal((await damaged.getRepository("recovered")).recentRepositories[0].id, "recovered");
});

test("workspace store keeps distinct open targets while sharing the same ref workspace", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repolens-workspace-targets-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = createWorkspaceStore(directory);
  await store.touchRecent({ id: "ref-main", targetId: "target-src", workspaceId: "ref-main", name: "Repo", location: "https://github.com/example/repo/tree/main/src" });
  await store.touchRecent({ id: "ref-main", targetId: "target-lib", workspaceId: "ref-main", name: "Repo", location: "https://github.com/example/repo/tree/main/lib" });
  await store.touchRecent({ id: "ref-main", targetId: "target-src", workspaceId: "ref-main", name: "Repo", location: "https://github.com/example/repo/tree/main/src" });
  const restored = await createWorkspaceStore(directory).getRepository("ref-main");
  assert.equal(restored.recentRepositories.length, 2);
  assert.deepEqual(new Set(restored.recentRepositories.map((item) => item.id)), new Set(["target-src", "target-lib"]));
  await store.removeRecent("target-src");
  assert.deepEqual((await store.get()).recentRepositories.map((item) => item.id), ["target-lib"]);
});

test("failed workspace clear leaves the confirmed state intact for later unrelated writes", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repolens-workspace-clear-failure-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = createWorkspaceStore(directory);
  const original = [{ id: "saved", title: "Keep me", messages: [], updatedAt: 1 }];
  await store.saveConversations("repo", original);

  const file = path.join(directory, "workspace-v1.json");
  const backup = `${file}.backup`;
  await rename(file, backup);
  await mkdir(file);

  const failedClear = await store.clearRepository("repo");
  assert.equal(failedClear.persisted, false, "the simulated replacement failure must be reported");
  assert.deepEqual((await store.getRepository("repo")).conversations, original, "failed clear must not change the confirmed in-memory view");

  await rm(file, { recursive: true });
  await rename(backup, file);
  const unrelatedWrite = await store.saveNodePositions("other-repo", { "src/main.ts": { x: 1, y: 2 } });
  assert.equal(unrelatedWrite.persisted, true);
  const persisted = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(persisted.conversations.repo, original, "an unrelated successful write must not flush a failed clear");
});

test("a transient initial read failure retries before any write can replace the saved workspace", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repolens-workspace-read-retry-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "workspace-v1.json");
  const original = [{ id: "saved", title: "Keep me", messages: [], updatedAt: 1 }];
  const seed = createWorkspaceStore(directory);
  assert.equal((await seed.saveConversations("repo", original)).persisted, true);

  const actualReadFile = fsPromises.readFile;
  const actualRename = fsPromises.rename;
  let denyRead = true;
  fsPromises.readFile = async (fileName, ...args) => {
    if (denyRead && fileName === file) throw Object.assign(new Error("controlled transient read denial"), { code: "EACCES" });
    return actualReadFile(fileName, ...args);
  };
  fsPromises.rename = async (from, to) => {
    if (from === file && denyRead) throw Object.assign(new Error("controlled quarantine denial"), { code: "EACCES" });
    return actualRename(from, to);
  };
  syncBuiltinESMExports();
  try {
    const store = createWorkspaceStore(directory);
    const failedRead = await store.getRepository("repo");
    assert.equal(failedRead.persistenceReady, false, "an unconfirmed read must remain non-writable");
    assert.match(failedRead.warning, /无法读取本地保存数据/);

    denyRead = false;
    const restored = await store.getRepository("repo");
    assert.equal(restored.persistenceReady, true);
    assert.deepEqual(restored.conversations, original, "a later read must reload the intact file");
    assert.equal((await store.saveNodePositions("other-repo", { "src/main.ts": { x: 1, y: 2 } })).persisted, true);
    assert.deepEqual(JSON.parse(await actualReadFile(file, "utf8")).conversations.repo, original);
    assert.deepEqual((await createWorkspaceStore(directory).getRepository("repo")).conversations, original);
  } finally {
    fsPromises.readFile = actualReadFile;
    fsPromises.rename = actualRename;
    syncBuiltinESMExports();
  }
});

test("clear-all removes failed write copies and clear fails when an owned copy cannot be removed", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repolens-workspace-clear-copies-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = createWorkspaceStore(directory);
  const original = [{ id: "private-answer", title: "Sensitive saved answer", messages: [], updatedAt: 1 }];
  assert.equal((await store.saveConversations("repo", original)).persisted, true);

  const file = path.join(directory, "workspace-v1.json");
  const backup = `${file}.backup`;
  await rename(file, backup);
  await mkdir(file);
  assert.equal((await store.saveNodePositions("other-repo", { "src/main.ts": { x: 1, y: 2 } })).persisted, false);
  await rm(file, { recursive: true, force: true });
  await rename(backup, file);

  const clear = await store.clearAll();
  assert.equal(clear.persisted, true);
  const remainingFiles = await readdir(directory);
  assert.deepEqual(remainingFiles, ["workspace-v1.json"], "successful clear-all leaves no store-owned copies");
  for (const name of remainingFiles) assert.doesNotMatch(await readFile(path.join(directory, name), "utf8"), /private-answer|Sensitive saved answer/);

  assert.equal((await store.saveConversations("repo", original)).persisted, true);
  const residue = path.join(directory, "workspace-v1.json.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.tmp.failed");
  const scrubTemporary = `${residue}.dddddddd-dddd-4ddd-8ddd-dddddddddddd.scrub.tmp`;
  await writeFile(residue, JSON.stringify(original), "utf8");
  await writeFile(scrubTemporary, JSON.stringify(original), "utf8");
  const actualUnlink = fsPromises.unlink;
  let denyResidueDelete = true;
  fsPromises.unlink = async (fileName) => {
    if (denyResidueDelete && fileName === residue) throw Object.assign(new Error("controlled residue lock"), { code: "EPERM" });
    return actualUnlink(fileName);
  };
  syncBuiltinESMExports();
  try {
    const failedClear = await store.clearAll();
    assert.equal(failedClear.persisted, false, "clear-all must report a failed owned-copy cleanup");
    assert.match(failedClear.warning, /无法清理|clear/i);
    denyResidueDelete = false;
    const retriedClear = await store.clearAll();
    assert.equal(retriedClear.persisted, true, "a later clear-all can retry the remaining owned copy");
    assert.deepEqual(await readdir(directory), ["workspace-v1.json"]);
  } finally {
    fsPromises.unlink = actualUnlink;
    syncBuiltinESMExports();
  }
});

test("an unsupported store version stays intact and rejects writes until it can be read", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repolens-workspace-version-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "workspace-v1.json");
  const futureState = { version: 99, conversations: { repo: [{ id: "future-record" }] } };
  await writeFile(file, JSON.stringify(futureState), "utf8");

  const store = createWorkspaceStore(directory);
  const read = await store.getRepository("repo");
  assert.match(read.warning, /版本不受支持/);
  assert.equal((await store.saveNodePositions("other", { x: { x: 1, y: 2 } })).persisted, false);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), futureState);
  assert.deepEqual(await readdir(directory), ["workspace-v1.json"]);
});

test("clear-current scrubs only its workspace from owned copies and preserves other workspace data", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repolens-workspace-clear-current-copies-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = createWorkspaceStore(directory);
  const target = [{ id: "target-answer", title: "Target", messages: [], updatedAt: 1 }];
  const other = [{ id: "other-answer", title: "Other", messages: [], updatedAt: 2 }];
  await store.saveConversations("target", target);
  await store.saveConversations("other", other);
  const canonical = JSON.parse(await readFile(path.join(directory, "workspace-v1.json"), "utf8"));
  const copyPath = path.join(directory, "workspace-v1.json.bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.tmp.failed");
  await writeFile(copyPath, JSON.stringify(canonical), "utf8");

  const result = await store.clearRepository("target");
  assert.equal(result.persisted, true);
  const canonicalAfter = JSON.parse(await readFile(path.join(directory, "workspace-v1.json"), "utf8"));
  const copyAfter = JSON.parse(await readFile(copyPath, "utf8"));
  for (const saved of [canonicalAfter, copyAfter]) {
    assert.equal(saved.conversations.target, undefined);
    assert.deepEqual(saved.conversations.other, other);
  }
  assert.deepEqual((await createWorkspaceStore(directory).getRepository("other")).conversations, other);
});
