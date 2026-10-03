import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

test("local API protects source paths, streams file updates, and gates AI generation behind its request", async (context) => {
  const apiPort = await freePort(); const modelPort = await freePort();
  const origin = `http://127.0.0.1:${apiPort}`;
  const appOrigin = "http://127.0.0.1:5173";
  const apiFetch = (url, init = {}) => fetch(url, { ...init, headers: { Origin: appOrigin, ...init.headers } });
  const commandClientId = `local-server-test-${process.pid}`; let intentSequence = 0;
  const command = () => ({ clientId: commandClientId, intentSequence: ++intentSequence });
  const repoPath = await mkdtemp(path.join(os.tmpdir(), "repolens-api-"));
  await mkdir(path.join(repoPath, "src"));
  await writeFile(path.join(repoPath, "src/main.ts"), 'import { value } from "./dep";\nexport const main = value;');
  await writeFile(path.join(repoPath, "src/dep.ts"), "export const value = 1;");
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
    let result;
    if (responseOverrides.length) result = responseOverrides.shift();
    else if (questionMode) result = { answer: "main 读取了 value。", insufficientEvidence: false, references: [{ fileId: "src/main.ts", startLine: 1, endLine: 2 }] };
    else if (routeMode) result = { title: "示例路线", steps: [
      { fileId: "src/main.ts", purpose: "从入口开始", references: [{ fileId: "src/main.ts", startLine: 1 }] },
      { fileId: "src/dep.ts", purpose: "查看依赖", references: [{ fileId: "src/dep.ts", startLine: 1 }] },
      { fileId: "src/main.ts", purpose: "返回入口", references: [{ fileId: "src/main.ts", startLine: 2 }] },
    ] };
    else if (++explanationAttempts === 1) result = { role: "入口", keyPoints: ["无效引用"], references: [{ fileId: "src/main.ts", startLine: 999 }] };
    else result = { role: "入口", keyPoints: ["读取本地依赖"], references: [{ fileId: "src/main.ts", startLine: 1, endLine: 2 }] };
    const content = routeMode && routeAttempts++ === 0 ? "{ broken json" : JSON.stringify(result);
    const behavior = responseBehaviors.shift();
    if (behavior?.delayMs) await delay(behavior.delayMs);
    if (response.destroyed) return;
    if (behavior?.status) { response.writeHead(behavior.status, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: "mock model error" })); return; }
    response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  modelServer.listen(modelPort, "127.0.0.1"); await once(modelServer, "listening");
  const child = spawn(process.execPath, [path.join(projectRoot, "scripts/local-server.mjs")], { cwd: projectRoot, env: { ...process.env, REPOLENS_PORT: String(apiPort), REPOLENS_AI_TIMEOUT_MS: "300" }, stdio: "ignore" });
  context.after(async () => { child.kill("SIGTERM"); modelServer.close(); await rm(repoPath, { recursive: true, force: true }); });
  await waitForService(origin, child);

  const openResponse = await apiFetch(`${origin}/api/open`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: repoPath, command: command() }) });
  assert.equal(openResponse.status, 200);
  let snapshot = await openResponse.json();
  assert.equal(snapshot.files.length, 2);
  assert.equal("root" in snapshot, false);
  assert.equal("source" in snapshot.files[0], false);
  assert.equal(snapshot.dependencies.length, 1);
  assert.equal(snapshot.sequence, 1);
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

  const questionPreviewResponse = await apiFetch(`${origin}/api/ai/question/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repositoryId: snapshot.id, fileId: "src/main.ts", question: "What does main do?", history: [] }) });
  const questionPreviewBody = await questionPreviewResponse.json();
  assert.equal(questionPreviewResponse.status, 200, questionPreviewBody.error);
  assert.equal(questionPreviewBody.preview.mode, "question");
  assert.equal(questionPreviewBody.preview.question, "What does main do?");
  const callsBeforeQuestionConfirmation = modelCalls.length;
  assert.equal(callsBeforeQuestionConfirmation, 4, "creating a question preview does not call the model");
  const questionResponse = await generate(questionPreviewBody.preview.id);
  const questionBody = await questionResponse.json();
  assert.equal(questionResponse.status, 200, questionBody.error);
  assert.equal(questionBody.mode, "question");
  assert.equal(questionBody.result.references[0].fileId, "src/main.ts");
  assert.equal(modelCalls.length, callsBeforeQuestionConfirmation + 1);
  const followUpText = "Why does the imported value appear here?";
  const followUpPreview = (await (await apiFetch(`${origin}/api/ai/question/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repositoryId: snapshot.id, fileId: "src/main.ts", question: followUpText, history: [{ role: "user", content: "What does main do?" }, { role: "assistant", content: "main 读取了 value。" }] }) })).json()).preview;
  const followUpResponse = await generate(followUpPreview.id);
  assert.equal(followUpResponse.status, 200);
  assert.ok(modelCalls.at(-1).messages.some((item) => item.role === "assistant" && item.content.includes("main 读取了 value")), "the previewed recent conversation reaches the model only after confirmation");
  const callsBeforeCachedQuestion = modelCalls.length;
  const sameQuestionPreview = (await (await apiFetch(`${origin}/api/ai/question/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repositoryId: snapshot.id, fileId: "src/main.ts", question: followUpText, history: [{ role: "user", content: "What does main do?" }, { role: "assistant", content: "main 读取了 value。" }] }) })).json()).preview;
  const sameQuestionCached = await (await generate(sameQuestionPreview.id)).json();
  assert.equal(sameQuestionCached.cached, true);
  assert.equal(modelCalls.length, callsBeforeCachedQuestion, "same question and history reuse a validated cache entry");
  responseOverrides = [{ answer: "错误行号", insufficientEvidence: false, references: [{ fileId: "src/main.ts", startLine: 999 }] }, { answer: "仍错误", insufficientEvidence: false, references: [{ fileId: "src/main.ts", startLine: 999 }] }];
  const uncertainQuestionScope = await (await apiFetch(`${origin}/api/ai/question/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repositoryId: snapshot.id, fileId: "src/main.ts", question: "invalid citation probe", history: [] }) })).json();
  assert.equal(uncertainQuestionScope.scopeRequired, true);
  assert.equal(uncertainQuestionScope.retrievalInsufficient, true, "weak local retrieval asks the user to select source files");
  const invalidQuestionPreview = (await (await apiFetch(`${origin}/api/ai/question/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repositoryId: snapshot.id, fileId: "src/main.ts", question: "invalid citation probe", history: [], fileIds: ["src/main.ts"], ranges: { "src/main.ts": { startLine: 1, endLine: 2 } } }) })).json()).preview;
  const invalidQuestion = await generate(invalidQuestionPreview.id);
  assert.equal(invalidQuestion.status, 400, "question citations outside the confirmed line range are rejected after one repair attempt");

  const beforeInvalidRoute = modelCalls.length;
  const invalidStep = { title: "应拒绝的路线", references: [{ fileId: "src/dep.ts", startLine: 1 }], steps: [1, 2, 3].map((index) => ({ fileId: "src/dep.ts", purpose: `第${index}步`, references: [{ fileId: "src/dep.ts", startLine: 999 }] })) };
  responseOverrides = [invalidStep, invalidStep];
  const invalidRoutePreview = (await (await apiFetch(`${origin}/api/ai/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repositoryId: snapshot.id, fileId: "src/dep.ts", mode: "route" }) })).json()).preview;
  const invalidRouteResponse = await generate(invalidRoutePreview.id);
  assert.equal(invalidRouteResponse.status, 400, "valid top-level references cannot mask invalid per-step citations");
  assert.equal(modelCalls.length, beforeInvalidRoute + 2, "invalid output gets only one repair attempt");

  await writeFile(path.join(repoPath, "src/retry.ts"), "export const retry = true;\n");
  await apiFetch(`${origin}/api/rescan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repositoryId: snapshot.id }) });
  const retryPreview = (await (await apiFetch(`${origin}/api/ai/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repositoryId: snapshot.id, fileId: "src/retry.ts", mode: "explanation" }) })).json()).preview;
  const before429 = modelCalls.length;
  responseOverrides = [{ role: "重试测试", keyPoints: [], references: [{ fileId: "src/retry.ts", startLine: 1 }] }];
  responseBehaviors = [{ status: 429 }];
  const limitedResponse = await generate(retryPreview.id);
  assert.equal(limitedResponse.status, 400);
  assert.match((await limitedResponse.json()).error, /429/);
  assert.equal(modelCalls.length, before429 + 1, "429 responses are not retried");

  const timeoutPreview = (await (await apiFetch(`${origin}/api/ai/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repositoryId: snapshot.id, fileId: "src/retry.ts", mode: "explanation" }) })).json()).preview;
  const beforeTimeout = modelCalls.length;
  responseBehaviors = [{ delayMs: 600 }];
  const timeoutResponse = await generate(timeoutPreview.id);
  assert.equal(timeoutResponse.status, 400);
  assert.match((await timeoutResponse.json()).error, /超时或已取消/);
  assert.equal(modelCalls.length, beforeTimeout + 1, "timeouts are not retried");

  const largeSource = Array.from({ length: 70 }, (_, index) => `export const row${index} = "${"x".repeat(1000)}";`).join("\n");
  await writeFile(path.join(repoPath, "src/large.ts"), largeSource);
  for (let index = 0; index < 13; index++) {
    const next = index < 12 ? `import "./${String(index + 1).padStart(2, "0")}";\n` : "";
    await mkdir(path.join(repoPath, "src/route"), { recursive: true });
    await writeFile(path.join(repoPath, `src/route/${String(index).padStart(2, "0")}.ts`), `${next}export const route${index} = ${index};`);
  }
  await apiFetch(`${origin}/api/rescan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repositoryId: snapshot.id }) });
  const largeScope = await apiFetch(`${origin}/api/ai/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repositoryId: snapshot.id, fileId: "src/large.ts", mode: "explanation" }) });
  assert.equal(largeScope.status, 413, "large source files require explicit range selection");
  const largeCandidates = await largeScope.json();
  assert.equal(largeCandidates.candidates.find((file) => file.fileId === "src/large.ts").lineCount, 70);
  const rangePreviewResponse = await apiFetch(`${origin}/api/ai/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repositoryId: snapshot.id, fileId: "src/large.ts", mode: "explanation", fileIds: ["src/large.ts"], ranges: { "src/large.ts": { startLine: 2, endLine: 3 } } }) });
  const rangePreview = (await rangePreviewResponse.json()).preview;
  assert.equal(rangePreviewResponse.status, 200);
  assert.equal(rangePreview.files[0].startLine, 2);
  assert.equal(rangePreview.files[0].endLine, 3);
  const thirteenFiles = await apiFetch(`${origin}/api/ai/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repositoryId: snapshot.id, fileId: "src/route/00.ts", mode: "route" }) });
  assert.equal(thirteenFiles.status, 413, "route previews report all candidates instead of silently truncating at 12");
  assert.equal((await thirteenFiles.json()).candidates.length, 13);

  const stalePreview = (await (await apiFetch(`${origin}/api/ai/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repositoryId: snapshot.id, fileId: "src/main.ts", mode: "explanation" }) })).json()).preview;
  const callsBeforeStale = modelCalls.length;
  await writeFile(path.join(repoPath, "src/dep.ts"), "export const value = 2;\n");
  const staleGeneration = await generate(stalePreview.id);
  assert.equal(staleGeneration.status, 409, "a confirmed scope expires when source changes before generation");
  assert.equal(modelCalls.length, callsBeforeStale, "stale scopes never reach the configured model");

  const eventBaseline = await (await apiFetch(`${origin}/api/snapshot?repositoryId=${snapshot.id}`)).json();
  const eventResponse = await apiFetch(`${origin}/api/events?repositoryId=${snapshot.id}`);
  const reader = eventResponse.body.getReader();
  const initialEvent = new TextDecoder().decode((await reader.read()).value);
  assert.match(initialEvent, /event: revision/, "SSE connection immediately sends the current revision after reconnect");
  const updateArrived = (async () => {
    let received = "";
    while (true) { const { done, value } = await reader.read(); if (done) return false; received += new TextDecoder().decode(value); if (received.includes("event: revision")) return true; }
  })();
  await delay(100);
  await writeFile(path.join(repoPath, "src/newFile.ts"), "export const added = true;");
  assert.equal(await Promise.race([updateArrived, delay(6500).then(() => false)]), true, "file changes should publish a fresh snapshot revision");
  reader.cancel();
  const fresh = await (await apiFetch(`${origin}/api/snapshot?repositoryId=${snapshot.id}`)).json();
  assert.equal(fresh.id, snapshot.id);
  assert.equal(fresh.sequence, eventBaseline.sequence + 1);
  assert.equal(fresh.files.some((file) => file.path === "src/newFile.ts"), true);
  const closeAfterChanges = await apiFetch(`${origin}/api/close`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: command() }) });
  assert.equal(closeAfterChanges.status, 200);
  assert.equal((await apiFetch(`${origin}/api/snapshot?repositoryId=${snapshot.id}`)).status, 409, "ownership survives watcher updates so the original client can close its repository");
  const reopened = await (await apiFetch(`${origin}/api/open`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: repoPath, command: command() }) })).json();
  assert.equal(reopened.id, snapshot.id, "the same local folder retains its repository identity across close and reopen");
  assert.ok(reopened.sequence >= fresh.sequence, "repository sequence never moves backwards after reopening");
  await apiFetch(`${origin}/api/close`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: command() }) });
  const otherClientId = `local-server-other-client-${process.pid}`;
  const otherCommand = (intentSequence) => ({ clientId: otherClientId, intentSequence });
  const otherOpen = await apiFetch(`${origin}/api/open`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: repoPath, command: otherCommand(1) }) });
  assert.equal(otherOpen.status, 200);
  const ownedByOther = await otherOpen.json();
  const unrelatedClose = await apiFetch(`${origin}/api/close`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: command() }) });
  assert.equal(unrelatedClose.status, 200);
  assert.equal((await apiFetch(`${origin}/api/snapshot?repositoryId=${ownedByOther.id}`)).status, 200, "a close from another client cannot close this client's active repository");
  await apiFetch(`${origin}/api/close`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: otherCommand(2) }) });
});
