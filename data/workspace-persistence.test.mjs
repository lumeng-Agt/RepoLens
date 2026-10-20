import assert from "node:assert/strict";
import { test } from "node:test";
import { clearWorkspacePersistence, enqueueWorkspacePersistence, getKnownWorkspacePersistenceIds, getWorkspacePersistenceStatus, subscribeWorkspacePersistence } from "./workspace-persistence.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("workspace clear waits for an active write and prevents queued stale writes from running afterward", async () => {
  const workspaceId = `persistence-order-${crypto.randomUUID()}`;
  const started = deferred();
  const release = deferred();
  const events = [];
  const inFlight = enqueueWorkspacePersistence(workspaceId, async () => {
    started.resolve();
    await release.promise;
    events.push("write");
  });
  await started.promise;
  const queued = enqueueWorkspacePersistence(workspaceId, async () => events.push("stale-write"));
  let clearStarted = false;
  const clear = clearWorkspacePersistence([workspaceId], async () => {
    clearStarted = true;
    events.push("clear");
  });
  assert.equal(clearStarted, false);
  assert.equal((await enqueueWorkspacePersistence(workspaceId, async () => events.push("during-clear"))).skipped, true);
  release.resolve();
  await Promise.all([inFlight, queued, clear]);
  assert.deepEqual(events, ["write", "clear"]);
  assert.ok(getKnownWorkspacePersistenceIds().includes(workspaceId));
});

test("clear-all can wait across every workspace known to the page", async () => {
  const first = `persistence-all-a-${crypto.randomUUID()}`;
  const second = `persistence-all-b-${crypto.randomUUID()}`;
  const started = deferred();
  const release = deferred();
  let cleared = false;
  const write = enqueueWorkspacePersistence(second, async () => {
    started.resolve();
    await release.promise;
  });
  await started.promise;
  const ids = [...new Set([...getKnownWorkspacePersistenceIds(), first, second])];
  const clear = clearWorkspacePersistence(ids, () => { cleared = true; });
  assert.equal(cleared, false);
  release.resolve();
  await Promise.all([write, clear]);
  assert.equal(cleared, true);
});

test("overlapping workspace and clear-all operations are serialized without reopening writes between them", async () => {
  const first = `persistence-overlap-a-${crypto.randomUUID()}`;
  const second = `persistence-overlap-b-${crypto.randomUUID()}`;
  const started = deferred();
  const release = deferred();
  const events = [];
  const write = enqueueWorkspacePersistence(first, async () => {
    started.resolve();
    await release.promise;
    events.push("write");
  });
  await started.promise;
  const currentClear = clearWorkspacePersistence([first], async () => { events.push("clear-current"); });
  const allClear = clearWorkspacePersistence([first, second], async () => { events.push("clear-all"); });
  assert.equal((await enqueueWorkspacePersistence(first, async () => events.push("interleaved-write"))).skipped, true);
  release.resolve();
  await Promise.all([write, currentClear, allClear]);
  assert.deepEqual(events, ["write", "clear-current", "clear-all"]);
});

test("workspace persistence status distinguishes writing, durable saves, and memory-only failures", async () => {
  const workspaceId = `persistence-status-${crypto.randomUUID()}`;
  const started = deferred();
  const release = deferred();
  let notifications = 0;
  const unsubscribe = subscribeWorkspacePersistence(workspaceId, () => { notifications += 1; });
  const write = enqueueWorkspacePersistence(workspaceId, async () => {
    started.resolve();
    await release.promise;
    return { ok: true };
  });
  await started.promise;
  assert.deepEqual(getWorkspacePersistenceStatus(workspaceId), { phase: "saving", pending: 1, error: "" });
  release.resolve();
  await write;
  assert.deepEqual(getWorkspacePersistenceStatus(workspaceId), { phase: "saved", pending: 0, error: "" });
  assert.deepEqual(await enqueueWorkspacePersistence(workspaceId, async () => ({ skipped: true })), { skipped: true });
  assert.deepEqual(getWorkspacePersistenceStatus(workspaceId), { phase: "saved", pending: 0, error: "" });

  await assert.rejects(enqueueWorkspacePersistence(workspaceId, async () => ({ ok: false, warning: "disk unavailable" })), /disk unavailable/);
  assert.deepEqual(getWorkspacePersistenceStatus(workspaceId), { phase: "memory", pending: 0, error: "disk unavailable" });
  assert.ok(notifications >= 5);
  unsubscribe();
});

test("a successful write in one category cannot clear another category's failed save", async () => {
  const workspaceId = `persistence-independent-failures-${crypto.randomUUID()}`;
  await assert.rejects(enqueueWorkspacePersistence(workspaceId, async () => ({ ok: false, warning: "笔记写入失败" }), { key: "reading-notes" }), /笔记写入失败/);
  await enqueueWorkspacePersistence(workspaceId, async () => ({ ok: true }), { key: "saved-tours" });
  assert.deepEqual(getWorkspacePersistenceStatus(workspaceId), { phase: "memory", pending: 0, error: "笔记写入失败" });
  await enqueueWorkspacePersistence(workspaceId, async () => ({ ok: true }), { key: "reading-notes" });
  assert.deepEqual(getWorkspacePersistenceStatus(workspaceId), { phase: "saved", pending: 0, error: "" });
});

test("clear success removes category failure markers after its write barrier", async () => {
  const workspaceId = `persistence-clear-failures-${crypto.randomUUID()}`;
  await assert.rejects(enqueueWorkspacePersistence(workspaceId, async () => { throw new Error("note failed"); }, { key: "reading-notes" }), /note failed/);
  await clearWorkspacePersistence([workspaceId], async () => ({ ok: true }));
  assert.deepEqual(getWorkspacePersistenceStatus(workspaceId), { phase: "saved", pending: 0, error: "" });
});

test("a skipped write does not leave the save indicator stuck in progress", async () => {
  const workspaceId = `persistence-skipped-${crypto.randomUUID()}`;
  await enqueueWorkspacePersistence(workspaceId, async () => ({ skipped: true }));
  assert.deepEqual(getWorkspacePersistenceStatus(workspaceId), { phase: "idle", pending: 0, error: "" });
});
