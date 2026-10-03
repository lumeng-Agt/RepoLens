import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  const key = "repolens:local-project:route-hash";
  await store.saveProgress("local-project", key, JSON.stringify({ stepIndex: 2, completedSteps: ["one"] }));
  await store.saveNodePositions("local-project", { "src/index.py": { x: 12, y: 34 } });
  const restored = await createWorkspaceStore(directory).getRepository("local-project");
  assert.equal(restored.recentRepositories[0].name, "Project");
  assert.equal(restored.aiResults["src/index.py"].answer, "An explanation");
  assert.equal(restored.aiRoute.signature, "route-hash");
  assert.equal(restored.progress[key].includes('"stepIndex":2'), true);
  assert.deepEqual(restored.nodePositions["src/index.py"], { x: 12, y: 34 });
  assert.doesNotMatch(await readFile(path.join(directory, "workspace-v1.json"), "utf8"), /sourceText|rawSource|"source"\s*:/);
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
  assert.equal(snapshot.recentRepositories.length, 0);
  assert.match(snapshot.warning, /无法读取本地保存数据/);
  assert.ok((await readdir(directory)).some((name) => name.includes(".corrupt-")));
  await damaged.touchRecent({ id: "recovered", name: "Recovered", location: "D:\\recovered" });
  assert.equal((await damaged.getRepository("recovered")).recentRepositories[0].id, "recovered");
});
