import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { requestChatCompletion } from "./ai-generation.mjs";
import { createWorkspaceStore } from "./workspace-store.mjs";
import { serializeWorkspaceMutation } from "./persistence-limits.mjs";

const context = { baseUrl: "http://127.0.0.1:1234/v1", model: "mock", apiKey: "test-only", mode: "question", conversation: true, question: "hello", entryFileId: "", revision: "r1", sources: [] };
const messages = (id, size) => [
  { id: `u-${id}`, role: "user", content: "hello", references: [], contextFiles: [] },
  { id: `a-${id}`, role: "assistant", content: "x".repeat(size), references: [], contextFiles: [] },
];

for (const mode of ["question", "explanation", "route", "investigation"]) {
  test(`${mode}: complete JSON cannot bypass model response bounds`, async () => {
    const fetcher = async () => Response.json({ choices: [{ message: { content: JSON.stringify({ answer: "x".repeat(1_100_001), references: [] }) } }] });
    await assert.rejects(requestChatCompletion({ ...context, mode }, mode, undefined, false, fetcher, { stream: true }), /限制|上限/);
  });
}

test("UTF-8 response bounds also apply to real streaming content", async () => {
  const content = JSON.stringify({ answer: "中".repeat(350_000), references: [] });
  const fetcher = async () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  await assert.rejects(requestChatCompletion(context, "question", undefined, false, fetcher, { stream: true }), /限制|上限/);
});

test("generated conversation collections remain writable through the existing protocol", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repolens-output-capacity-"));
  try {
    const store = createWorkspaceStore(directory);
    for (let i = 0; i < 2; i++) assert.equal((await store.commitAiChatCompletion("workspace", `c-${i}`, messages(i, 750_001), {})).persisted, true);
    const before = await readFile(path.join(directory, "workspace-v1.json"), "utf8");
    const rejected = await store.commitAiChatCompletion("workspace", "c-2", messages(2, 750_001), {});
    assert.equal(rejected.persisted, false);
    assert.match(rejected.warning, /容量|2 MB/);
    assert.equal(await readFile(path.join(directory, "workspace-v1.json"), "utf8"), before);
    const saved = await createWorkspaceStore(directory).getRepository("workspace");
    assert.equal(saved.conversations.length, 2);
    assert.doesNotThrow(() => serializeWorkspaceMutation({ action: "conversations", repositoryId: "r".repeat(160), workspaceId: "w".repeat(200), persistenceSessionId: "s".repeat(200), conversations: saved.conversations }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("oversized legacy histories remain readable and can be reduced by an explicit deletion", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repolens-legacy-capacity-"));
  try {
    const store = createWorkspaceStore(directory); await store.saveConversations("workspace", []);
    const file = path.join(directory, "workspace-v1.json"), state = JSON.parse(await readFile(file, "utf8"));
    const records = [0, 1, 2].map(i => ({ id: `legacy-${i}`, title: "old", updatedAt: 1, messages: messages(i, 750_001), future: { keep: true } }));
    state.conversations.workspace = records; await writeFile(file, JSON.stringify(state));
    const restored = createWorkspaceStore(directory);
    assert.deepEqual((await restored.getRepository("workspace")).conversations, records);
    await assert.rejects(restored.saveConversations("workspace", [...records, { id: "new", title: "new", updatedAt: 1, messages: [] }]), /容量|2 MB/);
    assert.equal((await restored.saveConversations("workspace", records.slice(1))).persisted, true);
    assert.deepEqual((await createWorkspaceStore(directory).getRepository("workspace")).conversations, records.slice(1));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
