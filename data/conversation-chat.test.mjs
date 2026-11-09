import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateAiResult, buildChatCompletionRequest } from "./ai-generation.mjs";

test("conversation answers can discuss general topics without invented citations while source QA stays strict", () => {
  const context = { mode: "question", conversation: true, entryFileId: "main.ts", sources: [] };
  const answer = { answer: "可以一起讨论设计，也可以解释代码。", references: [], insufficientEvidence: false };
  assert.deepEqual(validateAiResult(answer, context), answer);
  assert.throws(() => validateAiResult(answer, { ...context, conversation: false }), /格式|引用/);
  assert.throws(() => validateAiResult({ ...answer, references: [{ fileId: "secret.ts", startLine: 1 }] }, context), /引用/);
  const request = buildChatCompletionRequest({ ...context, question: "你好，你能做什么？", model: "user-configured-model", baseUrl: "https://model.example/v1", revision: "r1", history: [] }, "question");
  assert.match(request.body.messages[0].content, /正常交流/);
  assert.doesNotMatch(request.body.messages[0].content, /只依据提供的源码/);
});

async function fixture(t, { empty = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repolens-conversation-"));
  const repo = path.join(directory, "repo"); await mkdir(repo);
  if (!empty) {
    await writeFile(path.join(repo, "entry.ts"), 'export const unrelated = "not sent for greetings";\n');
    await writeFile(path.join(repo, "store.ts"), "export function persistTask(task: string) {\n  return localStorage.setItem('task', task);\n}\n");
  } else await writeFile(path.join(repo, 'README.md'), '# README-only repository');
  const requests = [];
  let invalidCitation = false;
  const model = createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) text += chunk;
    const payload = JSON.parse(text); requests.push(payload);
    const prompt = payload.messages.at(-1).content;
    const file = [...prompt.matchAll(/^FILE (.+?) LINES (\d+)-(\d+)/gm)][0];
    const result = { answer: file ? "persistTask 将任务保存到 localStorage。" : "你好，可以直接聊天，也可以一起看代码。", insufficientEvidence: false, references: invalidCitation ? [{ fileId: "outside.ts", startLine: 1 }] : file ? [{ fileId: file[1], startLine: Number(file[2]) }] : [] };
    response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
  });
  await new Promise(resolve => model.listen(0, "127.0.0.1", resolve));
  const child = fork("scripts/local-server.mjs", [], { env: { ...process.env, REPOLENS_PORT: "0", REPOLENS_USER_DATA_PATH: path.join(directory, "data") }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  t.after(async () => {
    if (child.exitCode === null) { const exited = once(child, "exit"); child.send({ type: "shutdown" }); await exited; }
    model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(directory, { recursive: true, force: true });
  });
  const [ready] = await once(child, "message", { signal: AbortSignal.timeout(15000) });
  const api = async (endpoint, input) => {
    const response = await fetch(`http://127.0.0.1:${ready.port}${endpoint}`, { method: "POST", headers: { Origin: "http://127.0.0.1:5173", "Content-Type": "application/json" }, body: JSON.stringify(input), signal: AbortSignal.timeout(15000) });
    return { status: response.status, body: await response.json() };
  };
  const opened = await api("/api/open", { path: repo, command: { clientId: "conversation-tests", intentSequence: 1 } }); assert.equal(opened.status, 200);
  assert.equal((await api("/api/ai/settings", { baseUrl: `http://127.0.0.1:${model.address().port}`, model: "local-mock", apiKey: "test-only" })).status, 200);
  const preview = input => api("/api/ai/question/preview", { repositoryId: opened.body.id, fileId: "entry.ts", conversation: true, ...input });
  return { api, preview, requests, invalidReferences() { invalidCitation = true; } };
}

test('a README-only repository supports source-free chat without a synthetic file', async t => {
  const f = await fixture(t, { empty: true });
  const value = await f.preview({ fileId: '', question: '你好', fileIds: [] });
  assert.equal(value.status, 200, JSON.stringify(value.body));
  assert.equal(value.body.preview.entryFileId, '');
  assert.deepEqual(value.body.preview.files, []);
  assert.equal(f.requests.length, 0);
  const generated = await f.api('/api/ai/generate', { previewId: value.body.preview.id, chat: { conversationId: 'empty-hello', userMessageId: 'u', answerMessageId: 'a' } });
  assert.equal(generated.status, 200, JSON.stringify(generated.body));
  assert.equal(generated.body.chatPersisted, true);
  assert.equal(f.requests.length, 1);
  assert.equal((await f.preview({ fileId: '', question: '继续', history: [{ role: 'user', content: '你好' }] })).status, 200);
  assert.equal((await f.preview({ fileId: '', question: '你好', conversation: false })).status, 400);
  assert.equal((await f.preview({ fileId: '', question: '你好', fileIds: ['outside.ts'] })).status, 400);
  assert.equal((await f.preview({ fileId: '', question: '你好', history: Array.from({length:6},()=>({role:'user',content:'x'.repeat(12000)})) })).status, 413);
});

test("normal chat prepares no source for a greeting and only calls a model after send", async t => {
  const f = await fixture(t);
  const value = await f.preview({ question: "你好" });
  assert.equal(value.status, 200); assert.deepEqual(value.body.preview.files, []); assert.equal(value.body.preview.conversation, true);
  assert.equal(f.requests.length, 0);
  const generated = await f.api("/api/ai/generate", { previewId: value.body.preview.id, chat: { conversationId: "hello", userMessageId: "u", answerMessageId: "a" } });
  assert.equal(generated.status, 200); assert.equal(generated.body.chatPersisted, true); assert.equal(f.requests.length, 1);
  assert.equal(generated.body.result.insufficientEvidence, false);
  assert.doesNotMatch(JSON.stringify(f.requests[0]), /not sent for greetings|localStorage\.setItem/);
  assert.equal((await f.api("/api/ai/generate", { previewId: value.body.preview.id })).status, 409);
});

test("automatic code context and short followups work without file selection, and opting out stays source-free", async t => {
  const f = await fixture(t);
  const code = await f.preview({ question: "persistTask 是怎么保存任务的？" });
  assert.equal(code.status, 200); assert.ok(code.body.preview.files.some(file => file.fileId === "store.ts"));
  const followup = await f.preview({ question: "继续解释", history: [{ role: "user", content: "persistTask 是怎么保存任务的？" }, { role: "assistant", content: "它将任务写入 localStorage。" }] });
  assert.equal(followup.status, 200); assert.ok(followup.body.preview.files.some(file => file.fileId === "store.ts"));
  const longAnswer = await f.preview({ question: "继续解释", fileIds: [], history: [{ role: "assistant", content: "x".repeat(15000) }] });
  assert.equal(longAnswer.status, 200); assert.equal(longAnswer.body.preview.history[0].content.length, 15000);
  const plain = await f.preview({ question: "persistTask 的设计还能如何改善？", fileIds: [] });
  assert.equal(plain.status, 200); assert.deepEqual(plain.body.preview.files, []);
  assert.equal(f.requests.length, 0);
});

test("free conversation still enforces historical budgets and rejects fabricated source references", async t => {
  const f = await fixture(t);
  const overBudget = await f.preview({ question: "你好", fileIds: [], history: Array.from({ length: 6 }, () => ({ role: "user", content: "x".repeat(12000) })) });
  assert.equal(overBudget.status, 413); assert.ok(overBudget.body.blockers.includes("character_limit")); assert.equal(f.requests.length, 0);
  const value = await f.preview({ question: "你好" }); assert.equal(value.status, 200);
  f.invalidReferences();
  const rejected = await f.api("/api/ai/generate", { previewId: value.body.preview.id });
  assert.notEqual(rejected.status, 200); assert.match(rejected.body.error, /引用/); assert.equal(f.requests.length, 2);
});

test("a request about this code uses the visible file without requiring its name", async t => {
  const f = await fixture(t);
  const current = await f.preview({ question: "帮我解释一下这段代码" });
  assert.equal(current.status, 200);
  assert.deepEqual(current.body.preview.files.map(file => file.fileId), ["entry.ts"]);
  const withoutSource = await f.preview({ question: "帮我解释一下这段代码", fileIds: [] });
  assert.equal(withoutSource.status, 200); assert.deepEqual(withoutSource.body.preview.files, []);
  assert.equal(f.requests.length, 0);
});
