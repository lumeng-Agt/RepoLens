import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

test("desktop close acknowledgement waits for draft flush and reports failure", async () => {
  const handlers = new Map(), sent = [];
  let bridge;
  runInNewContext(await readFile(new URL("./preload.cjs", import.meta.url), "utf8"), {
    require: () => ({ contextBridge: { exposeInMainWorld(_name, value) { bridge = value; } }, ipcRenderer: {
      on(name, handler) { handlers.set(name, handler); }, send(...args) { sent.push(args); },
    } }),
  });
  let release;
  const unregister = bridge.onBeforeClose(() => new Promise(resolve => { release = resolve; }));
  const close = handlers.get("desktop:prepare-close")({}, "first");
  assert.equal(sent.length, 0);
  release(); await close;
  assert.equal(sent[0][0], "desktop:prepared-close");
  assert.equal(sent[0][1].id, "first"); assert.equal(sent[0][1].ok, true);
  unregister();
  const remove = bridge.onBeforeClose(async () => { throw Error("save failed"); });
  await handlers.get("desktop:prepare-close")({}, "second");
  assert.equal(sent[1][1].ok, false);
  remove();
  await handlers.get("desktop:prepare-close")({}, "third");
  assert.equal(sent[2][1].ok, true);
});
