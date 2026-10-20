import assert from "node:assert/strict";
import test from "node:test";
import { createSerialTaskQueue } from "./serial-task-queue.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("serial task queue preserves order and proceeds after a failed task", async () => {
  const queue = createSerialTaskQueue();
  const gate = deferred();
  const events = [];
  const first = queue.enqueue(async () => { events.push("first-start"); await gate.promise; events.push("first-end"); return 1; });
  const second = queue.enqueue(async () => { events.push("second"); throw new Error("expected failure"); });
  const third = queue.enqueue(async () => { events.push("third"); return 3; });
  assert.equal(queue.pendingCount, 3);
  gate.resolve();
  assert.equal(await first, 1);
  await assert.rejects(second, /expected failure/);
  assert.equal(await third, 3);
  await queue.whenIdle();
  assert.deepEqual(events, ["first-start", "first-end", "second", "third"]);
  assert.equal(queue.pendingCount, 0);
});
