import assert from "node:assert/strict";
import { test } from "node:test";
import { clearWorkspacePersistence, enqueueWorkspacePersistence, getKnownWorkspacePersistenceIds } from "./workspace-persistence.mjs";

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
