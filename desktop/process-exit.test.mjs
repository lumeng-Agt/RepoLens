import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { waitForChildExit } from "./process-exit.mjs";

test("waitForChildExit observes the exit event before it fires", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;

  const exited = waitForChildExit(child);
  child.exitCode = 0;
  child.emit("exit", 0, null);

  assert.deepEqual(await exited, { code: 0, signal: null });
});

test("waitForChildExit returns immediately when the child already exited", async () => {
  const child = new EventEmitter();
  child.exitCode = 1;
  child.signalCode = null;

  assert.deepEqual(await waitForChildExit(child), { code: 1, signal: null });
});

test("waitForChildExit preserves signal exits", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;

  const exited = waitForChildExit(child);
  child.signalCode = "SIGTERM";
  child.emit("exit", null, "SIGTERM");

  assert.deepEqual(await exited, { code: null, signal: "SIGTERM" });
});
