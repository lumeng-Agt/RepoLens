import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readSseData } from "./ai-stream.mjs";
import { AiStreamEventSchema } from "./ai-contract.mjs";

test("real local service streams before completion and persists only a validated final answer", { timeout: 30000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-stream-integration-"));
  const repo = path.join(root, "repo"); await mkdir(repo);
  await writeFile(path.join(repo, "main.ts"), "export const answer = 42;\n");
  let release; let modelCalls = 0; let requestMode = "normal"; let repairCalls = 0;
  const model = createServer(async (request, response) => {
    let body = ""; for await (const part of request) body += part;
    const input = JSON.parse(body); assert.equal(input.stream, true); modelCalls++;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const delta = (content) => response.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
    if (requestMode === "broken") { delta('{"answer":"未完成'); response.end(); return; }
    if (requestMode === "repair") {
      repairCalls++;
      delta(JSON.stringify({ answer: repairCalls === 1 ? "待校验" : "修正后的回答", insufficientEvidence: false, references: [{ fileId: repairCalls === 1 ? "not-sent.ts" : "main.ts", startLine: 1 }] }));
      response.end("data: [DONE]\n\n"); return;
    }
    delta('{"answer":"值为 42');
    release = () => { delta('。","insufficientEvidence":false,"references":[{"fileId":"main.ts","startLine":1}]}'); response.end("data: [DONE]\n\n"); };
  });
  model.listen(0, "127.0.0.1"); await once(model, "listening");
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const server = spawn(process.execPath, ["scripts/local-server.mjs"], { cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, REPOLENS_PORT: String(port), REPOLENS_UI_PORT: "5173", REPOLENS_USER_DATA_PATH: path.join(root, "data") } });
  const exited = once(server, "exit"); let logs = ""; server.stdout.on("data", chunk => { logs += chunk; }); server.stderr.on("data", chunk => { logs += chunk; });
  t.after(async () => { release?.(); if (server.connected) server.send({ type: "shutdown" }); await exited; model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); assert.ok(root.startsWith(os.tmpdir())); await rm(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${port}`;
  const request = async (route, body) => fetch(origin + route, { method: body ? "POST" : "GET", signal: AbortSignal.timeout(10000), headers: { Origin: "http://127.0.0.1:5173", "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  // The service imports TypeScript on startup; a 3 s window fails under load.
  for (let i = 0; i < 250; i++) { try { if ((await request("/api/health")).ok) break; } catch {} if (i === 249) throw Error(logs || "本地服务未在 7.5 秒内就绪。"); await new Promise(resolve => setTimeout(resolve, 30)); }
  const opened = await (await request("/api/open", { path: repo, command: { clientId: "stream-test", intentSequence: 1 } })).json();
  assert.ok(opened.id, JSON.stringify(opened));
  await request("/api/ai/settings", { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, model: "stream-model", apiKey: "test-key" });
  const preview = async (question) => (await (await request("/api/ai/question/preview", { repositoryId: opened.id, fileId: "main.ts", fileIds: ["main.ts"], question })).json()).preview;
  const first = await preview("answer 的值是什么？"); assert.equal(modelCalls, 0);
  const response = await fetch(origin + "/api/ai/generate", { method: "POST", signal: AbortSignal.timeout(10000), headers: { Origin: "http://127.0.0.1:5173", "Content-Type": "application/json", Accept: "text/event-stream" }, body: JSON.stringify({ previewId: first.id, chat: { conversationId: "c", userMessageId: "u", answerMessageId: "a" } }) });
  const iterator = readSseData(response.body)[Symbol.asyncIterator]();
  const next = async () => AiStreamEventSchema.parse(JSON.parse((await iterator.next()).value));
  assert.equal((await next()).type, "status");
  const text = await next(); assert.equal(text.type, "text"); assert.equal(text.text, "值为 42");
  const before = await (await request(`/api/workspace?repositoryId=${opened.id}`)).json();
  assert.deepEqual(before.conversations, [], "partial content is not persisted");
  release(); let final;
  for await (const data of { [Symbol.asyncIterator]: () => iterator }) { const event = AiStreamEventSchema.parse(JSON.parse(data)); if (event.type === "complete") final = event.result; }
  assert.equal(final.result.answer, "值为 42。"); assert.equal(final.chatPersisted, true);
  const saved = await (await request(`/api/workspace?repositoryId=${opened.id}`)).json();
  assert.equal(saved.conversations[0].messages.length, 2); assert.equal(saved.conversations[0].messages[1].content, "值为 42。");
  assert.equal((await request("/api/ai/generate", { previewId: first.id })).status, 409);
  requestMode = "broken";
  const second = await preview("另一个问题");
  const broken = await fetch(origin + "/api/ai/generate", { method: "POST", signal: AbortSignal.timeout(10000), headers: { Origin: "http://127.0.0.1:5173", "Content-Type": "application/json", Accept: "text/event-stream" }, body: JSON.stringify({ previewId: second.id, chat: { conversationId: "c", userMessageId: "u2", answerMessageId: "a2" } }) });
  const events = []; for await (const data of readSseData(broken.body)) events.push(JSON.parse(data));
  assert.equal(events.at(-1).type, "error"); assert.match(events.at(-1).error, /中断/);
  const after = await (await request(`/api/workspace?repositoryId=${opened.id}`)).json();
  assert.equal(after.conversations[0].messages.length, 2); assert.equal(modelCalls, 2);
  requestMode = "repair";
  const third = await preview("需要校验的问题");
  const repair = await fetch(origin + "/api/ai/generate", { method: "POST", signal: AbortSignal.timeout(10000), headers: { Origin: "http://127.0.0.1:5173", "Content-Type": "application/json", Accept: "text/event-stream" }, body: JSON.stringify({ previewId: third.id, chat: { conversationId: "c", userMessageId: "u3", answerMessageId: "a3" } }) });
  const repaired = []; for await (const data of readSseData(repair.body)) repaired.push(JSON.parse(data));
  assert.equal(repaired.filter(event => event.type === "replace" && event.text === "").length, 1);
  assert.ok(repaired.some(event => event.status === "repairing"));
  assert.equal(repaired.at(-1).result.result.answer, "修正后的回答"); assert.equal(repairCalls, 2);
  const finalState = await (await request(`/api/workspace?repositoryId=${opened.id}`)).json();
  assert.equal(finalState.conversations[0].messages.length, 4);
  assert.equal(finalState.conversations[0].messages.some(message => message.content === "待校验"), false);
});
