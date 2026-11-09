import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { waitForRendererDrafts } from "./renderer-close.mjs";

function fixture(crashed = false) {
  const ipc = new EventEmitter(), contents = new EventEmitter();
  Object.assign(contents, { isDestroyed: () => false, isCrashed: () => crashed, send() {} });
  const window = { isDestroyed: () => false, webContents: contents };
  const options = { window, ipc, uiOrigin: "http://127.0.0.1:12345", requestId: "owned", isTrustedSender: event => event.trusted === true };
  return { ipc, contents, options };
}
test("already crashed renderers do not wait for an impossible draft acknowledgement", async () => {
  const f = fixture(true);
  await assert.rejects(waitForRendererDrafts(f.options), { code: "RENDERER_UNAVAILABLE" });
  assert.equal(f.ipc.listenerCount("desktop:prepared-close"), 0);
});
test("destroyed windows are rejected without touching their unavailable contents", async () => {
  const f = fixture();
  const window = { isDestroyed: () => true, get webContents() { throw Error("must not read destroyed window"); } };
  await assert.rejects(waitForRendererDrafts({ ...f.options, window }), { code: "RENDERER_UNAVAILABLE" });
});
test("a renderer crash during the handshake releases its timer and listeners", async () => {
  const f = fixture(), pending = waitForRendererDrafts(f.options);
  f.contents.emit("render-process-gone");
  await assert.rejects(pending, { code: "RENDERER_UNAVAILABLE" });
  assert.equal(f.ipc.listenerCount("desktop:prepared-close"), 0);
  assert.equal(f.contents.listenerCount("destroyed"), 0);
});
test("only the trusted current request can acknowledge healthy draft saving", async () => {
  const f = fixture(); let finished = false;
  const pending = waitForRendererDrafts(f.options).then(() => { finished = true; });
  f.ipc.emit("desktop:prepared-close", { trusted: false }, { id: "owned", ok: true });
  f.ipc.emit("desktop:prepared-close", { trusted: true }, { id: "old", ok: true });
  await Promise.resolve(); assert.equal(finished, false);
  f.ipc.emit("desktop:prepared-close", { trusted: true }, { id: "owned", ok: true });
  await pending; assert.equal(finished, true);
  assert.equal(f.contents.listenerCount("render-process-gone"), 0);
});
test("ordinary draft failures and timeout remain recoverable and are not renderer crashes", async () => {
  const f = fixture(), pending = waitForRendererDrafts(f.options);
  f.ipc.emit("desktop:prepared-close", { trusted: true }, { id: "owned", ok: false });
  await assert.rejects(pending, error => !error.code && /草稿/.test(error.message));
  await assert.rejects(waitForRendererDrafts({ ...f.options, timeoutMs: 1 }), error => !error.code && /未能确认/.test(error.message));
  assert.equal(f.ipc.listenerCount("desktop:prepared-close"), 0);
});
