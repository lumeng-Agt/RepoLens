import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorkspaceStore } from "./workspace-store.mjs";
import { copyChatText, formatChatTimestamp } from "./chat-display.mjs";
import { registerChatPreferenceFlush, flushChatPreferences, retryChatPreferences } from "./chat-preference-lifecycle.mjs";

test("invalid finite dates remain readable without crashing chat history", () => {
  for (const value of [1e100, -1e100, NaN, Infinity, undefined]) assert.equal(formatChatTimestamp(value), "时间未记录");
  assert.notEqual(formatChatTimestamp(Date.now()), "时间未记录");
});

test("clipboard unavailable, synchronous errors and rejected writes are reported", async () => {
  assert.equal(await copyChatText("x", () => undefined), false);
  assert.equal(await copyChatText("x", () => { throw Error("denied"); }), false);
  assert.equal(await copyChatText("x", () => ({ writeText() { throw Error("denied"); } })), false);
  assert.equal(await copyChatText("x", () => ({ async writeText() { throw Error("denied"); } })), false);
  const clipboard = { value: "", async writeText(value) { this.value = value; } };
  assert.equal(await copyChatText("中文", () => clipboard), true);
  assert.equal(clipboard.value, "中文");
});

test("chat preferences survive store restart and clear only their workspace", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repolens-chat-prefs-"));
  try {
    const store = createWorkspaceStore(directory);
    const preferences = { version: 1, draft: "未发送草稿", activeId: "conversation", scrollTop: 120, future: { keep: true } };
    assert.equal((await store.saveChatPreferences("a", preferences)).persisted, true);
    await store.saveChatPreferences("b", preferences);
    const restarted = createWorkspaceStore(directory);
    assert.deepEqual((await restarted.getRepository("a")).chatPreferences, preferences);
    await restarted.clearRepository("a");
    assert.equal((await restarted.getRepository("a")).chatPreferences, null);
    assert.deepEqual((await restarted.getRepository("b")).chatPreferences, preferences);
    await restarted.clearAll();
    assert.deepEqual((await restarted.get()).chatPreferences, {});
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("new invalid dates are rejected; unchanged legacy dates and fields round-trip", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repolens-chat-date-"));
  try {
    const store = createWorkspaceStore(directory);
    const legacy = { id: "legacy", title: "保留", messages: [], updatedAt: 1e100, future: { keep: true } };
    await store.saveConversations("a", []);
    const file = path.join(directory, "workspace-v1.json");
    const state = JSON.parse(await readFile(file, "utf8"));
    state.conversations.a = [legacy];
    await writeFile(file, JSON.stringify(state));
    const restarted = createWorkspaceStore(directory);
    const valid = { id: "new", title: "新记录", messages: [], updatedAt: Date.now() };
    await restarted.saveConversations("a", [legacy, valid]);
    await assert.rejects(restarted.saveConversations("a", [legacy, { ...valid, updatedAt: 1e100 }]), /时间/);
    assert.deepEqual((await restarted.getRepository("a")).conversations, [legacy, valid]);
    assert.deepEqual((await createWorkspaceStore(directory).getRepository("a")).conversations, [legacy, valid]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("workspace transitions wait for registered draft saves and surface failures", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let complete = false;
  const unregister = registerChatPreferenceFlush(() => gate);
  try {
    const pending = flushChatPreferences().then(() => { complete = true; });
    await Promise.resolve(); assert.equal(complete, false);
    release(); await pending; assert.equal(complete, true);
  } finally { unregister(); }
  const remove = registerChatPreferenceFlush(async () => { throw Error("草稿未保存"); });
  try { await assert.rejects(flushChatPreferences(), /草稿未保存/); } finally { remove(); }
});

test("cancelling a workspace transition does not wait for an outstanding draft write", async () => {
  let release;
  const unregister = registerChatPreferenceFlush(() => new Promise(resolve => { release = resolve; }));
  const controller = new AbortController();
  try {
    const pending = flushChatPreferences(controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
  } finally { release(); unregister(); }
});

test("explicit retry can restore preferences without making ordinary close reread storage", async () => {
  const calls = [];
  const remove = registerChatPreferenceFlush(async () => { calls.push("flush"); }, async () => { calls.push("retry-read-and-flush"); });
  try {
    await flushChatPreferences(); await retryChatPreferences();
    assert.deepEqual(calls, ["flush", "retry-read-and-flush"]);
  } finally { remove(); }
});
