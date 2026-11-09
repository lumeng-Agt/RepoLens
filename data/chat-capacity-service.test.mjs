import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("real service keeps over-capacity answers visible but unsaved, uncached and non-destructive", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repolens-chat-capacity-api-"));
  const repo = path.join(directory, "repo"), data = path.join(directory, "data");
  let size = 750_001, calls = 0, child;
  const model = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    calls++;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: "x".repeat(size), references: [], insufficientEvidence: false }) } }] }));
  });
  try {
    await mkdir(repo); await writeFile(path.join(repo, "main.ts"), "export const x=1;");
    await new Promise(resolve => model.listen(0, "127.0.0.1", resolve));
    child = fork("scripts/local-server.mjs", [], { env: { ...process.env, REPOLENS_PORT: "0", REPOLENS_USER_DATA_PATH: data }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const [ready] = await once(child, "message", { signal: AbortSignal.timeout(15000) });
    const api = async (url, input, headers = {}) => {
      const response = await fetch(`http://127.0.0.1:${ready.port}${url}`, { method: input ? "POST" : "GET", headers: { Origin: "http://127.0.0.1:5173", "Content-Type": "application/json", ...headers }, ...(input ? { body: JSON.stringify(input) } : {}), signal: AbortSignal.timeout(15000) });
      const text = await response.text();
      return { status: response.status, value: response.headers.get("content-type")?.includes("event-stream") ? text.split("\n\n").filter(Boolean).map(line => JSON.parse(line.replace(/^data: /, ""))) : JSON.parse(text) };
    };
    const snapshot = (await api("/api/open", { path: repo, command: { clientId: "capacity-test", intentSequence: 1 } })).value;
    const session = { repositoryId: snapshot.id, workspaceId: snapshot.workspaceId ?? snapshot.id, persistenceSessionId: snapshot.persistenceSessionId };
    await api("/api/ai/settings", { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, model: "test", authMode: "none", apiKey: "" });
    const seeded = [0, 1].map(i => ({ id: `c-${i}`, title: "original", updatedAt: 1, messages: [{ id: `a-${i}`, role: "assistant", content: "x".repeat(size), references: [], contextFiles: [] }], future: { keep: true } }));
    assert.equal((await api("/api/workspace", { action: "conversations", ...session, conversations: seeded })).value.ok, true);
    const file = path.join(data, "workspace-v1.json"), baseline = await readFile(file, "utf8");
    const preview = async question => (await api("/api/ai/question/preview", { repositoryId: snapshot.id, fileId: "", conversation: true, question, fileIds: [] })).value.preview.id;
    const generate = (previewId, headers = {}) => api("/api/ai/generate", { previewId, chat: { conversationId: "third", userMessageId: "u-third", answerMessageId: "a-third" } }, headers);
    for (let attempt = 1; attempt <= 2; attempt++) {
      const result = await generate(await preview("same confirmed question"));
      assert.equal(result.status, 200); assert.equal(result.value.result.answer.length, size);
      assert.equal(result.value.chatPersisted, false); assert.equal(result.value.cached, false);
      assert.match(result.value.warning, /容量/); assert.equal(calls, attempt, "unsaved over-capacity answers must not create new cache entries");
      assert.equal(await readFile(file, "utf8"), baseline);
    }
    size = 1_100_001;
    for (const headers of [{}, { Accept: "text/event-stream" }]) {
      const before = calls, token = await preview("response byte limit");
      const result = await generate(token, headers);
      if (headers.Accept) {
        assert.equal(result.value.some(event => event.type === "complete"), false);
        assert.equal(result.value.find(event => event.type === "error")?.code, "MODEL_RESPONSE_TOO_LARGE");
      } else { assert.equal(result.status, 502); assert.match(result.value.error, /上限/); }
      assert.equal(calls, before + 1, "transport limits must not start a format-repair request");
      assert.equal((await generate(token)).status, 409);
      assert.equal(await readFile(file, "utf8"), baseline);
    }
    assert.equal((await api("/api/workspace", { action: "conversations", ...session, conversations: seeded.slice(1) })).value.ok, true);
    size = 750_001;
    const recovered = await generate(await preview("after explicit deletion"));
    assert.equal(recovered.value.chatPersisted, true);
    const restored = (await api("/api/workspace?repositoryId=" + session.workspaceId)).value;
    assert.equal(restored.conversations.length, 2);
    assert.deepEqual(restored.conversations.find(item => item.id === "c-1"), seeded[1]);
  } finally {
    if (child?.exitCode === null) { const exited = once(child, "exit"); child.send({ type: "shutdown" }); await exited; }
    model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
