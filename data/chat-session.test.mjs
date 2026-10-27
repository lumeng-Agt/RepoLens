import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFile = promisify(execFileCallback);
async function freePort() {
  const probe = net.createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const value = probe.address().port; await new Promise((resolve) => probe.close(resolve)); return value;
}
async function waitForService(url, child) {
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error("Local RepoLens service exited before becoming ready.");
    try { if ((await fetch(`${url}/api/health`)).ok) return; } catch {}
    await delay(100);
  }
  throw new Error("Local RepoLens service did not become ready.");
}
async function requestWithHost(port, hostHeader) {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ hostname: "127.0.0.1", port, path: "/api/health", headers: { Host: hostHeader } }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
    outgoing.on("error", reject); outgoing.end();
  });
}

test("unified chat rejects stale source after a same-session rescan", async (context) => {
  const apiPort = await freePort(); const modelPort = await freePort(); const redirectPort = await freePort();
  const origin = `http://127.0.0.1:${apiPort}`;
  const appOrigin = "http://127.0.0.1:5173";
  const apiFetch = (url, init = {}) => fetch(url, { ...init, headers: { Origin: appOrigin, ...init.headers } });
  const commandClientId = `local-server-test-${process.pid}`; let intentSequence = 0;
  const command = () => ({ clientId: commandClientId, intentSequence: ++intentSequence });
  const repoPath = await mkdtemp(path.join(os.tmpdir(), "repolens-api-"));
  await mkdir(path.join(repoPath, "src"));
  await writeFile(path.join(repoPath, "README.md"), "# Local Sample\n\nA safe text overview.");
  await writeFile(path.join(repoPath, "package.json"), JSON.stringify({ name: "local-sample" }));
  await writeFile(path.join(repoPath, "src/main.ts"), 'import { value } from "./dep";\nexport const main = value;\nexport function calculateMainValue() {\n  return value;\n}');
  await writeFile(path.join(repoPath, "src/dep.ts"), "export const value = 1;");
  await execFile("git", ["init", "-q"], { cwd: repoPath });
  await execFile("git", ["config", "user.name", "RepoLens Test"], { cwd: repoPath });
  await execFile("git", ["config", "user.email", "test@example.invalid"], { cwd: repoPath });
  await execFile("git", ["add", "."], { cwd: repoPath });
  await execFile("git", ["commit", "-qm", "initial"], { cwd: repoPath });
  const modelCalls = [];
  let explanationAttempts = 0;
  let routeAttempts = 0;
  let responseOverrides = [];
  let responseBehaviors = [];
  const modelServer = createServer(async (request, response) => {
    let raw = ""; for await (const part of request) raw += part;
    const input = JSON.parse(raw); const user = [...input.messages].reverse().find((item) => item.role === "user")?.content ?? "";
    modelCalls.push({ authorization: request.headers.authorization, content: user, messages: input.messages, url: request.url });
    const routeMode = user.includes("3 到 7 个") || user.includes("阅读路线步骤");
    const questionMode = user.includes("回答用户当前问题");
    const mainRange = user.match(/FILE src\/main\.ts LINES (\d+)-(\d+)/);
    const mainStartLine = Number(mainRange?.[1] ?? 1);
    const mainEndLine = Number(mainRange?.[2] ?? mainStartLine);
    let result;
    if (responseOverrides.length) result = responseOverrides.shift();
    else if (questionMode) result = { answer: "main 读取了 value。", insufficientEvidence: false, references: [{ fileId: "src/main.ts", startLine: mainStartLine, endLine: mainEndLine }] };
    else if (routeMode) result = { title: "示例路线", steps: [
      { fileId: "src/main.ts", purpose: "从入口开始", relationship: "选定入口", question: "入口如何使用依赖？", references: [{ fileId: "src/main.ts", startLine: 1 }] },
      { fileId: "src/dep.ts", purpose: "查看依赖", relationship: "沿导入关系查看依赖", question: "依赖提供了什么？", references: [{ fileId: "src/dep.ts", startLine: 1 }] },
      { fileId: "src/main.ts", purpose: "返回入口", relationship: "回到入口核对结果", question: "入口最终导出了什么？", references: [{ fileId: "src/main.ts", startLine: 2 }] },
    ] };
    else if (++explanationAttempts === 1) result = { role: "入口", keyPoints: ["无效引用"], references: [{ fileId: "src/main.ts", startLine: 999 }] };
    else result = { role: "入口", keyPoints: ["读取本地依赖"], references: [{ fileId: "src/main.ts", startLine: 1, endLine: 2 }] };
    const content = routeMode && routeAttempts++ === 0 ? "{ broken json" : JSON.stringify(result);
    const behavior = responseBehaviors.shift();
    if (behavior?.gate) { behavior.started(); await behavior.gate; }
    if (behavior?.delayMs) await delay(behavior.delayMs);
    if (response.destroyed) return;
    if (behavior?.status) { response.writeHead(behavior.status, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: "mock model error" })); return; }
    response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  modelServer.listen(modelPort, "127.0.0.1"); await once(modelServer, "listening");
  let redirectBehavior = "always";
  const redirectServer = createServer(async (request, response) => {
    let body = ""; for await (const part of request) body += part;

    if (redirectBehavior === "repair" && !body.includes("上一次输出没有满足")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: "{ invalid" } }] }));
      return;
    }
    response.writeHead(307, { Location: `http://127.0.0.1:${modelPort}/v1/chat/completions` });
    response.end();
  });
  redirectServer.listen(redirectPort, "127.0.0.1"); await once(redirectServer, "listening");
  const child = spawn(process.execPath, [path.join(projectRoot, "scripts/local-server.mjs")], { cwd: projectRoot, env: { ...process.env, REPOLENS_PORT: String(apiPort), REPOLENS_AI_TIMEOUT_MS: "10000" }, stdio: "ignore" });
  context.after(async () => {
    child.kill("SIGTERM");
    await Promise.all([modelServer, redirectServer].map((server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); })));
    await rm(repoPath, { recursive: true, force: true });
  });
  await waitForService(origin, child);

  const openResponse = await apiFetch(`${origin}/api/open`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: repoPath, command: command() }) });
  assert.equal(openResponse.status, 200);
  let snapshot = await openResponse.json();
  assert.equal(snapshot.files.length, 2);
  assert.equal("root" in snapshot, false);
  assert.equal("source" in snapshot.files[0], false);
  assert.equal(snapshot.dependencies.length, 1);
  assert.equal(snapshot.sequence, 1);
  const overviewResponse = await apiFetch(`${origin}/api/overview?${new URLSearchParams({ repositoryId: snapshot.id, revision: snapshot.revision })}`);
  assert.equal(overviewResponse.status, 200);
  const overview = await overviewResponse.json();
  assert.equal(overview.readme.path, "README.md");
  assert.match(overview.readme.summary, /A safe text overview/);
  assert.deepEqual(overview.manifests, ["package.json"]);
  const recentTouch = await apiFetch(`${origin}/api/workspace`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "recent-touch", repositoryId: snapshot.id, workspaceId: snapshot.workspaceId ?? snapshot.id, persistenceSessionId: snapshot.persistenceSessionId }) });
  assert.equal(recentTouch.status, 200);
  const recentRemove = await apiFetch(`${origin}/api/workspace`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "recent-remove", targetId: snapshot.workspaceId ?? snapshot.id }) });
  assert.equal(recentRemove.status, 200, "removing a recent repository does not require an active repository session");
  const workspaceAfterRemove = await (await apiFetch(`${origin}/api/workspace?repositoryId=${encodeURIComponent(snapshot.workspaceId ?? snapshot.id)}`)).json();
  assert.equal(workspaceAfterRemove.recentRepositories.some((item) => item.id === (snapshot.workspaceId ?? snapshot.id)), false);
  const searchResponse = await apiFetch(`${origin}/api/search`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repositoryId: snapshot.id, revision: snapshot.revision, query: "calculateMainValue" }) });
  assert.equal(searchResponse.status, 200);
  const search = await searchResponse.json();
  assert.equal(search.results[0].path, "src/main.ts");
  assert.equal(search.results[0].line, 3);
  assert.equal(search.revision, snapshot.revision);
  await writeFile(path.join(repoPath, "src/new-file.ts"), "export const incoming = true;\n");
  snapshot = await (await apiFetch(`${origin}/api/rescan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repositoryId: snapshot.id }) })).json();
  const comparisonResponse = await apiFetch(`${origin}/api/compare`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repositoryId: snapshot.id, revision: snapshot.revision, mode: "working-tree" }) });
  assert.equal(comparisonResponse.status, 200);
  const comparison = await comparisonResponse.json();
  assert.ok(comparison.files.some((file) => file.path === "src/new-file.ts" && file.status === "added"));
  assert.match(comparison.diff, /incoming = true/);
  const staleSearch = await apiFetch(`${origin}/api/search`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repositoryId: snapshot.id, revision: "stale-revision", query: "value" }) });
  assert.equal(staleSearch.status, 409, "search results must be bound to the current snapshot revision");
  const sourceQuery = new URLSearchParams({ repositoryId: snapshot.id, revision: snapshot.revision, file: "src/main.ts" });
  assert.equal((await apiFetch(`${origin}/api/source?${sourceQuery}`)).status, 200);
  assert.equal((await apiFetch(`${origin}/api/source?${new URLSearchParams({ repositoryId: snapshot.id, revision: snapshot.revision, file: "../outside.ts" })}`)).status, 404);
  assert.equal((await apiFetch(`${origin}/api/source?${new URLSearchParams({ repositoryId: snapshot.id, file: "src/main.ts" })}`)).status, 400);
  assert.equal((await apiFetch(`${origin}/api/source?${new URLSearchParams({ repositoryId: "wrong", file: "src/main.ts" })}`)).status, 409);
  assert.equal((await fetch(`${origin}/api/snapshot?repositoryId=${snapshot.id}`)).status, 403, "API requests without an application Origin are rejected");
  assert.equal(await requestWithHost(apiPort, `attacker.example:${apiPort}`), 403, "non-loopback Host headers are rejected");
  assert.equal((await fetch(`${origin}/api/health`, { headers: { Origin: "https://untrusted.example" } })).status, 403);

  const failedOpen = await apiFetch(`${origin}/api/open`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: path.join(repoPath, "missing-directory"), command: command() }) });
  assert.equal(failedOpen.status, 400);
  const retainedEvents = await apiFetch(`${origin}/api/events?repositoryId=${snapshot.id}`);
  const retainedReader = retainedEvents.body.getReader();
  assert.match(new TextDecoder().decode((await retainedReader.read()).value), /event: revision/);
  await writeFile(path.join(repoPath, "src/retained-after-failed-open.ts"), "export const retained = true;\n");
  const retainedUpdate = (async () => {
    let received = "";
    while (true) { const { done, value } = await retainedReader.read(); if (done) return false; received += new TextDecoder().decode(value); if (received.includes("event: revision")) return true; }
  })();
  assert.equal(await Promise.race([retainedUpdate, delay(6500).then(() => false)]), true, "a failed open must leave the previous repository watcher active");
  retainedReader.cancel();
  snapshot = await (await apiFetch(`${origin}/api/snapshot?repositoryId=${snapshot.id}`)).json();
  assert.ok(snapshot.files.some((file) => file.path === "src/retained-after-failed-open.ts"));

  const settingsResponse = await apiFetch(`${origin}/api/ai/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ baseUrl: `http://127.0.0.1:${modelPort}/v1/`, model: "mock-model", apiKey: "secret-test-only" }) });
  assert.equal(settingsResponse.status, 200);
  assert.equal((await (await apiFetch(`${origin}/api/ai/settings`)).json()).apiKey, undefined);
  const previewResponse = await apiFetch(`${origin}/api/ai/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repositoryId: snapshot.id, fileId: "src/main.ts", mode: "explanation" }) });
  const previewBody = await previewResponse.json(); const preview = previewBody.preview;
  assert.equal(preview.files.length, 2);
  assert.equal(JSON.stringify(previewBody).includes("import { value"), false);
  assert.equal(modelCalls.length, 0, "previewing a scope must not transmit source to the model");

  const generate = (previewId) => apiFetch(`${origin}/api/ai/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ previewId }) });
  const changedSettings = await apiFetch(`${origin}/api/ai/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ baseUrl: `http://127.0.0.1:${modelPort}/v1/`, model: "other-model" }) });
  assert.equal((await changedSettings.json()).configured, false, "changing services without a replacement key clears the old key");
  assert.equal((await generate(preview.id)).status, 409, "changing the model invalidates an earlier confirmation");
  assert.equal(modelCalls.length, 0, "an invalidated confirmation never reaches the model");
  await apiFetch(`${origin}/api/ai/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ baseUrl: `http://127.0.0.1:${modelPort}/v1/`, model: "mock-model", apiKey: "secret-test-only" }) });
  const refreshedPreview = (await (await apiFetch(`${origin}/api/ai/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repositoryId: snapshot.id, fileId: "src/main.ts", mode: "explanation" }) })).json()).preview;
  const generated = await generate(refreshedPreview.id);
  const generatedBody = await generated.json();
  assert.equal(generated.status, 200, generatedBody.error);
  assert.deepEqual({ repositoryId: generatedBody.repositoryId, revision: generatedBody.revision, entryFileId: generatedBody.entryFileId, mode: generatedBody.mode }, { repositoryId: snapshot.id, revision: snapshot.revision, entryFileId: "src/main.ts", mode: "explanation" });
  assert.equal(generatedBody.result.references[0].endLine, 2);
  assert.equal(modelCalls.length, 2, "invalid source line receives exactly one repair attempt");
  assert.equal(modelCalls[0].authorization, "Bearer secret-test-only");
  assert.equal(modelCalls[0].url, "/v1/chat/completions", "a trailing slash after /v1 does not duplicate the version path");
  const cachedPreview = (await (await apiFetch(`${origin}/api/ai/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repositoryId: snapshot.id, fileId: "src/main.ts", mode: "explanation" }) })).json()).preview;
  const cachedResponse = await generate(cachedPreview.id);
  const cachedBody = await cachedResponse.json();
  assert.equal(cachedResponse.status, 200);
  assert.equal(cachedBody.cached, true);
  assert.deepEqual({ repositoryId: cachedBody.repositoryId, revision: cachedBody.revision, entryFileId: cachedBody.entryFileId, mode: cachedBody.mode }, { repositoryId: snapshot.id, revision: snapshot.revision, entryFileId: "src/main.ts", mode: "explanation" });
  assert.equal(modelCalls.length, 2, "verified results are cached");
  const routePreview = (await (await apiFetch(`${origin}/api/ai/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repositoryId: snapshot.id, fileId: "src/main.ts", mode: "route" }) })).json()).preview;
  const routeResponse = await generate(routePreview.id);
  const routeBody = await routeResponse.json();
  assert.equal(routeResponse.status, 200, routeBody.error);
  assert.equal(routeBody.result.steps.length, 3);
  assert.equal(modelCalls.length, 4, "malformed JSON gets exactly one format repair retry");

  const questionPreviewResponse = await apiFetch(`${origin}/api/ai/question/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repositoryId: snapshot.id, fileId: "src/main.ts", question: "How does calculateMainValue work?", history: [] }) });
  const questionPreviewBody = await questionPreviewResponse.json();
  assert.equal(questionPreviewResponse.status, 200, questionPreviewBody.error);
  assert.equal(questionPreviewBody.preview.mode, "question");
  assert.equal(questionPreviewBody.preview.question, "How does calculateMainValue work?");
  assert.ok(Number.isInteger(questionPreviewBody.preview.tokenEstimate) && questionPreviewBody.preview.tokenEstimate > 0);
  const entryFilePreview = questionPreviewBody.preview.files.find((file) => file.fileId === questionPreviewBody.preview.entryFileId);
  assert.ok(entryFilePreview.reasons.includes("当前文件"));
  assert.equal(entryFilePreview.startLine, 3, "question context is narrowed to the matched symbol definition by default");
  assert.equal(entryFilePreview.endLine, 5);
  const callsBeforeQuestionConfirmation = modelCalls.length;
  assert.equal(callsBeforeQuestionConfirmation, 4, "creating a question preview does not call the model");
  const questionResponse = await generate(questionPreviewBody.preview.id);
  const questionBody = await questionResponse.json();
  assert.equal(questionResponse.status, 200, questionBody.error);
  assert.equal(questionBody.mode, "question");
  assert.equal(questionBody.result.references[0].fileId, "src/main.ts");
  assert.equal(modelCalls.length, callsBeforeQuestionConfirmation + 1);
  const followUpText = "Why does the imported value appear here?";
  const followUpPreview = (await (await apiFetch(`${origin}/api/ai/question/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repositoryId: snapshot.id, fileId: "src/main.ts", question: followUpText, history: [{ role: "user", content: "How does calculateMainValue work?" }, { role: "assistant", content: "main 读取了 value。" }] }) })).json()).preview;
  const followUpResponse = await generate(followUpPreview.id);
  assert.equal(followUpResponse.status, 200);
  assert.ok(modelCalls.at(-1).messages.some((item) => item.role === "assistant" && item.content.includes("main 读取了 value")), "the previewed recent conversation reaches the model only after confirmation");
  const callsBeforeCachedQuestion = modelCalls.length;
  const sameQuestionPreview = (await (await apiFetch(`${origin}/api/ai/question/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repositoryId: snapshot.id, fileId: "src/main.ts", question: followUpText, history: [{ role: "user", content: "How does calculateMainValue work?" }, { role: "assistant", content: "main 读取了 value。" }] }) })).json()).preview;
  const sameQuestionCached = await (await generate(sameQuestionPreview.id)).json();
  assert.equal(sameQuestionCached.cached, true);
  assert.equal(modelCalls.length, callsBeforeCachedQuestion, "same question and history reuse a validated cache entry");


  let release;let started;
  const gate = new Promise(r=>release=r); const start=new Promise(r=>started=r);
  responseBehaviors.push({gate,started});
  const p=(await(await apiFetch(origin+'/api/ai/question/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({repositoryId:snapshot.id,fileId:'src/main.ts',question:'main value audit',history:[],fileIds:['src/main.ts','src/dep.ts']})})).json()).preview;
  const pending=apiFetch(origin+'/api/ai/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({previewId:p.id,chat:{conversationId:'audit',userMessageId:'u',answerMessageId:'a'}})});
  await start;
  await writeFile(path.join(repoPath,'src/dep.ts'),'export const value = 99;');
  const scan=await apiFetch(origin+'/api/rescan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({repositoryId:snapshot.id})});
  console.log('rescan',scan.status);
  release();
  const answer=await pending;const body=await answer.json();
  console.log('audit generation',answer.status,JSON.stringify(body));
  assert.equal(answer.status,409,'same-session source changes must reject old generation');
});