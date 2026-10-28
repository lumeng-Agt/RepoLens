import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createInvestigation } from "./investigation.mjs";
import { rankInvestigationCandidates } from "./question-retrieval.mjs";

test("requirement retrieval uses real matches across JS/TS, Python and Go, with stable explicit reasons", () => {
  for (const extension of ["ts", "py", "go"]) {
    const files = [{ id: `cancel.${extension}`, path: `cancel.${extension}`, symbols: ["cancelTask"], symbolDetails: [{ name: "cancelTask", startLine: 2, endLine: 5 }] }, { id: `cleanup.${extension}`, path: `cleanup.${extension}` }, { id: `unrelated.${extension}`, path: `unrelated.${extension}` }];
    const sourceById = new Map([[files[0].id, "cancelTask cancels timeout 取消 超时"], [files[1].id, "release resource"], [files[2].id, "render unrelated"]]);
    const input = { files, sourceById, dependencies: [{ fromId: files[0].id, toId: files[1].id }], question: "给 cancelTask 增加超时" };
    const start = performance.now(); const first = rankInvestigationCandidates(input); const elapsed = performance.now() - start;
    assert.equal(first.candidates[0].id, files[0].id); assert.equal(first.retrievalInsufficient, false);
    assert.ok(first.candidates.find(item => item.id === files[1].id).reasons.some(reason => reason.includes("静态依赖")));
    assert.ok(!first.candidates.some(item => item.id === files[2].id)); assert.deepEqual(rankInvestigationCandidates(input), first);
    assert.ok(elapsed < 1000, "small deterministic fixture should not block the service");
    assert.equal(rankInvestigationCandidates({ ...input, question: "notPresentAnywhere" }).retrievalInsufficient, true);
  }
});

test("real service prepares investigation without calling model, validates output, persists and clears isolated records", { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-investigation-service-")); const repo = path.join(root, "repo"); await mkdir(repo);
  await writeFile(path.join(repo, "cancel.ts"), "import { cleanup } from './cleanup';\nexport function cancelTask() { cleanup(); }\n");
  await writeFile(path.join(repo, "cleanup.ts"), "export function cleanup() {}\n");
  await mkdir(path.join(repo, "src"));
  await writeFile(path.join(repo, "src/store.ts"), "// 本地保存任务\nexport function saveTasks(tasks: string[]) { localStorage.setItem('tasks', JSON.stringify(tasks)); }\n");
  let modelCalls = 0;
  const model = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); modelCalls++;
    assert.match(body.messages.at(-1).content, /候选/); assert.ok(!body.stream);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: "检查取消入口", items: [{ id: "cancel", title: "取消入口", responsibility: "任务取消", reason: "入口存在 cleanup 调用表达式，超时行为仍待确认。", references: [{ fileId: "cancel.ts", startLine: 2 }] }], questions: [{ question: "需要补读清理实现", suggestedFileId: "cleanup.ts" }] }) } }] }));
  });
  model.listen(0, "127.0.0.1"); await once(model, "listening");
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening"); const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const server = spawn(process.execPath, ["scripts/local-server.mjs"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, REPOLENS_PORT: String(port), REPOLENS_UI_PORT: "5173", REPOLENS_USER_DATA_PATH: path.join(root, "data") } });
  const exited = once(server, "exit"); let logs = ""; server.stdout.on("data", chunk => { logs += chunk; }); server.stderr.on("data", chunk => { logs += chunk; });
  t.after(async () => { if (server.connected) server.send({ type: "shutdown" }); await exited; model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const request = (route, body) => fetch(`http://127.0.0.1:${port}${route}`, { method: body ? "POST" : "GET", signal: AbortSignal.timeout(10000), headers: { Origin: "http://127.0.0.1:5173", "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  for (let i = 0; i < 250; i++) { try { if ((await request("/api/health")).ok) break; } catch {} if (i === 249) throw Error(logs); await new Promise(resolve => setTimeout(resolve, 30)); }
  const opened = await (await request("/api/open", { path: repo, command: { clientId: "investigation", intentSequence: 1 } })).json(); assert.ok(opened.id);
  const session = { repositoryId: opened.id, workspaceId: opened.workspaceId, persistenceSessionId: opened.persistenceSessionId };
  await request("/api/ai/settings", { baseUrl: `http://127.0.0.1:${model.address().port}`, model: "mock-investigation", apiKey: "isolated-key" });
  const chinesePreview = await request("/api/ai/question/preview", { repositoryId: opened.id, fileId: "cleanup.ts", question: "任务是怎么保存到本地的？", history: [] });
  const chineseScope = await chinesePreview.json();
  assert.equal(chinesePreview.status, 200, JSON.stringify(chineseScope));
  assert.ok(chineseScope.preview.files.some(file => file.fileId === "src/store.ts"));
  assert.equal(modelCalls, 0, "Chinese question preview only retrieves local source");
  const previewResponse = await request("/api/ai/preview", { repositoryId: opened.id, fileId: "cleanup.ts", mode: "investigation", question: "给 cancelTask 增加超时", excludedFileIds: ["cleanup.ts"], fileIds: ["cancel.ts"] });
  const value = await previewResponse.json(); assert.equal(previewResponse.status, 200, JSON.stringify(value)); assert.equal(modelCalls, 0);
  assert.deepEqual(value.preview.files.map(file => file.fileId), ["cancel.ts"]); assert.equal(value.preview.mode, "investigation");
  const generated = await (await request("/api/ai/generate", { previewId: value.preview.id, chat: { conversationId: "c", userMessageId: "u", answerMessageId: "a" } })).json();
  assert.equal(generated.mode, "investigation", JSON.stringify(generated)); assert.equal(modelCalls, 1);
  const record = createInvestigation({ repository: opened, result: generated.result, question: value.preview.question, contextFiles: value.preview.files, excludedFileIds: ["cleanup.ts"], id: "saved" });
  assert.equal((await request("/api/workspace", { action: "investigations", ...session, records: [record] })).status, 200);
  const disk = JSON.parse(await readFile(path.join(root, "data", "workspace-v1.json"), "utf8")); assert.equal(disk.investigations[opened.workspaceId][0].question, record.question);
  const saved = await (await request(`/api/workspace?repositoryId=${opened.id}`)).json(); assert.equal(saved.investigations.length, 1); assert.equal(saved.conversations[0].messages[1].investigation.summary, "检查取消入口");
  assert.equal((await request("/api/workspace", { action: "investigations", ...session, persistenceSessionId: "old-session", records: [] })).status, 409);
  assert.equal((await request("/api/ai/generate", { previewId: value.preview.id })).status, 409);
  await request("/api/workspace", { action: "clear-repository", ...session });
  const after = JSON.parse(await readFile(path.join(root, "data", "workspace-v1.json"), "utf8")); assert.equal(after.investigations[opened.workspaceId], undefined); assert.deepEqual(after.conversations[opened.workspaceId], undefined);
});
