import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { watch } from "node:fs";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appOrigin = "http://127.0.0.1:5173";

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForFile(filePath) {
  if (await access(filePath).then(() => true, () => false)) return;
  await new Promise((resolve, reject) => {
    let settled = false;
    let watcher;
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${path.basename(filePath)}.`)), 10_000);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher?.close();
      if (error) reject(error); else resolve();
    }
    const check = () => { void access(filePath).then(() => finish(), () => {}); };
    watcher = watch(path.dirname(filePath), { persistent: false }, check);
    watcher.once("error", finish);
    check();
  });
}

async function createFixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-ai-generation-life-"));
  const repository = path.join(root, "repository");
  const gates = path.join(root, "gates");
  await mkdir(repository);
  await mkdir(gates);
  const sourcePath = path.join(repository, "index.ts");
  await writeFile(sourcePath, "export const first = 1;\nexport const second = 2;\nexport const third = 3;\n");
  await writeFile(path.join(repository, "a.ts"), 'import { b } from "./b";\nexport const a = () => b;\n');
  await writeFile(path.join(repository, "b.ts"), 'import { a } from "./a";\nexport const b = () => a;\n');

  const modelCalls = [];
  const queuedModelResults = [];
  const modelServer = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const payload = JSON.parse(text);
    const prompt = payload.messages.find((message) => message.role === "user")?.content ?? "";
    modelCalls.push(payload);
    const taskMatch = prompt.match(/^任务信息：(\{[^\r\n]+\})$/m);
    const task = taskMatch ? JSON.parse(taskMatch[1]) : null;
    const sourceRanges = [...prompt.matchAll(/^FILE (.+?) LINES (\d+)-(\d+)/gm)];
    const entryFileId = task?.entryFileId ?? sourceRanges[0]?.[1] ?? "index.ts";
    const sourceRange = sourceRanges.find((match) => match[1] === entryFileId);
    const defaultResult = task?.mode === "route" || (!task && prompt.includes("3 到 7 个"))
      ? { title: "模拟路线", steps: [entryFileId, entryFileId, entryFileId].map((fileId, index) => ({ fileId, purpose: `步骤 ${index + 1}`, references: [{ fileId, startLine: Number(sourceRanges.find((match) => match[1] === fileId)?.[2] ?? 1) }] })) }
      : { role: `模拟讲解 ${entryFileId}`, keyPoints: ["可定位结果"], references: [{ fileId: entryFileId, startLine: Number(sourceRange?.[2] ?? 1), endLine: Number(sourceRange?.[3] ?? 3) }] };
    const result = queuedModelResults.length ? queuedModelResults.shift() : defaultResult;
    response.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
  });
  modelServer.listen(0, "127.0.0.1");
  await once(modelServer, "listening");

  const apiPort = await freePort();
  const wrapper = path.join(projectRoot, "scripts", "with-local-service.mjs");
  const gate = path.join(projectRoot, "data", "ai-generation-gate.mjs");
  const child = spawn(process.execPath, [wrapper, "-e", "setInterval(() => {}, 1000)"], {
    cwd: projectRoot,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: {
      ...process.env,
      REPOLENS_PORT: String(apiPort),
      REPOLENS_UI_PORT: "5173",
      REPOLENS_AI_TIMEOUT_MS: "5000",
      REPOLENS_TEST_AI_GATE_DIR: gates,
      REPOLENS_TEST_AI_TARGET: sourcePath,
      REPOLENS_TEST_AI_READ_ID: "cancel-check",
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(gate).href}`.trim(),
    },
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const exited = once(child, "exit");
  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  const inFlight = new Set();
  const probeHeaders = (probeId) => probeId ? { "x-repolens-test-id": probeId } : {};
  const request = (route, body, { probeId, signal } = {}) => {
    const pending = (async () => {
    const response = await fetch(`${apiOrigin}${route}`, {
      method: body === undefined ? "GET" : "POST",
      signal: signal ?? AbortSignal.timeout(15_000),
      headers: { Origin: appOrigin, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...probeHeaders(probeId) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, value: await response.json() };
    })();
    inFlight.add(pending);
    void pending.then(() => inFlight.delete(pending), () => inFlight.delete(pending));
    return pending;
  };
  const intents = new Map();
  const command = (clientId = "ai-generation-lifecycle") => {
    const intentSequence = (intents.get(clientId) ?? 0) + 1;
    intents.set(clientId, intentSequence);
    return { clientId, intentSequence };
  };

  context.after(async () => {
    await writeFile(path.join(gates, "read-release"), "release\n");
    await Promise.allSettled([...inFlight]);
    if (child.exitCode === null) {
      await request("/api/close", { command: command() }).catch(() => {});
    }
    if (child.exitCode === null && child.connected) {
      child.send({ type: "shutdown" });
      let timer;
      await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(resolve, 25_000); })]);
      clearTimeout(timer);
    }
    if (child.exitCode === null) {
      if (process.platform === "win32") {
        const { spawnSync } = await import("node:child_process");
        spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      } else child.kill("SIGKILL");
      await exited;
    }
    await new Promise((resolve) => modelServer.close(resolve));
    assert.equal(child.exitCode, 0, stderr);
    assert.ok(root.startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(root, { recursive: true, force: true });
  });

  for (let index = 0; index < 100; index += 1) {
    try {
      if ((await request("/api/health")).status === 200) break;
    } catch {
      if (index === 99) throw new Error(`local service did not start: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const opened = await request("/api/open", { path: repository, command: command() });
  assert.equal(opened.status, 200, opened.value.error);
  assert.equal(await access(path.join(gates, "gate-loaded")).then(() => true, () => false), true, `the test gate should load in the local service: ${stderr}`);
  const configured = await request("/api/ai/settings", { baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`, model: "lifecycle-model", apiKey: "test-only-key" });
  assert.equal(configured.status, 200);

  return {
    root, gates, modelCalls, request, command, repositoryId: opened.value.id,
    queueModelResult: (result) => queuedModelResults.push(result),
    preview: async (mode, fileId = "index.ts") => {
      const response = await request("/api/ai/preview", { repositoryId: opened.value.id, fileId, mode });
      assert.equal(response.status, 200, response.value.error);
      return response.value.preview;
    },
    resetGate: async () => {
      for (const name of ["read-arm", "read-entered-cancel-check", "read-entered-first", "read-finished-cancel-check", "read-finished-first", "read-release", "request-body-second", "response-closed-cancel-check", "request-handled-cancel-check", "request-handled-first", "request-handled-second"]) {
        await rm(path.join(gates, name), { force: true });
      }
    },
    armRead: () => writeFile(path.join(gates, "read-arm"), "hold\n"),
    waitForGate: (name) => waitForFile(path.join(gates, name)),
    releaseRead: () => writeFile(path.join(gates, "read-release"), "release\n"),
    sourcePath,
  };
}

test("canceling an explanation or route during source verification never calls the model", async (context) => {
  const fixture = await createFixture(context);
  for (const mode of ["explanation", "route"]) {
    await fixture.resetGate();
    const preview = await fixture.preview(mode);
    await fixture.armRead();
    const controller = new AbortController();
    const probeId = "cancel-check";
    const pending = fixture.request("/api/ai/generate", { previewId: preview.id }, { probeId, signal: controller.signal })
      .catch((error) => ({ clientError: error.name }));
    await fixture.waitForGate("read-entered-cancel-check");
    controller.abort();
    await fixture.waitForGate("response-closed-cancel-check");
    await fixture.releaseRead();
    await fixture.waitForGate("read-finished-cancel-check");
    await fixture.waitForGate("request-handled-cancel-check");
    assert.equal((await pending).clientError, "AbortError");
    assert.equal(fixture.modelCalls.length, 0, `${mode} canceled before the model request must not send source`);
  }
});

test("a generation preview is consumed once even when confirmation requests arrive concurrently", async (context) => {
  const fixture = await createFixture(context);
  for (const mode of ["explanation", "route"]) {
    await fixture.resetGate();
    const preview = await fixture.preview(mode);
    await fixture.armRead();
    const first = fixture.request("/api/ai/generate", { previewId: preview.id }, { probeId: "first" });
    await fixture.waitForGate("read-entered-cancel-check");
    const duplicate = fixture.request("/api/ai/generate", { previewId: preview.id }, { probeId: "second" });
    await fixture.waitForGate("request-body-second");
    await fixture.releaseRead();
    await fixture.waitForGate("read-finished-cancel-check");
    const [generated, duplicateResponse] = await Promise.all([first, duplicate]);
    assert.equal(duplicateResponse.status, 409, "the same preview cannot authorize a second in-flight request");
    assert.equal(generated.status, 200, generated.value.error);
    await fixture.waitForGate("request-handled-first");
    assert.equal(fixture.modelCalls.length, mode === "route" ? 2 : 1, "one confirmed preview produces one model request");

    const replay = await fixture.request("/api/ai/generate", { previewId: preview.id });
    assert.equal(replay.status, 409, "a completed confirmation cannot be replayed");
    const cachePreview = await fixture.preview(mode);
    const cached = await fixture.request("/api/ai/generate", { previewId: cachePreview.id });
    assert.equal(cached.status, 200, cached.value.error);
    assert.equal(cached.value.cached, true, "a fresh preview of the same verified context can use the cache");
    assert.equal(fixture.modelCalls.length, mode === "route" ? 2 : 1);
  }
});

async function assertAiTargetMode(context, mode) {
  const fixture = await createFixture(context);
  const responses = [];
  for (const fileId of ["b.ts", "a.ts"]) {
    const preview = await fixture.preview(mode, fileId);
    const generated = await fixture.request("/api/ai/generate", { previewId: preview.id });
    assert.equal(generated.status, 200, generated.value.error);
    responses.push({ fileId, preview, generated: generated.value, prompt: fixture.modelCalls.at(-1).messages.find((message) => message.role === "user").content });
  }
  const scopeOf = (preview) => preview.files.map(({ fileId, startLine, endLine }) => [fileId, startLine, endLine]).sort();
  assert.deepEqual(scopeOf(responses[0].preview), scopeOf(responses[1].preview), "the cyclic entry files expose the same candidate source set");
  assert.notEqual(responses[0].prompt, responses[1].prompt, "different entries must produce different model instructions");
  for (const response of responses) {
    assert.match(response.prompt, new RegExp(`"entryFileId":"${response.fileId}"`));
    if (mode === "route") assert.equal(response.generated.result.steps[0].fileId, response.fileId);
    else assert.ok(response.generated.result.references.some((reference) => reference.fileId === response.fileId));
  }

  const callsBeforeCache = fixture.modelCalls.length;
  for (const fileId of ["b.ts", "a.ts"]) {
    const preview = await fixture.preview(mode, fileId);
    const cached = await fixture.request("/api/ai/generate", { previewId: preview.id });
    assert.equal(cached.status, 200, cached.value.error);
    assert.equal(cached.value.cached, true, "the same entry may reuse its own valid result");
    if (mode === "route") assert.equal(cached.value.result.steps[0].fileId, fileId);
    else assert.ok(cached.value.result.references.some((reference) => reference.fileId === fileId));
  }
  assert.equal(fixture.modelCalls.length, callsBeforeCache, "cached results do not call the model");
}

test("AI explanation prompts and results follow the selected entry", async (context) => {
  await assertAiTargetMode(context, "explanation");
});

test("AI route prompts and results follow the selected entry", async (context) => {
  await assertAiTargetMode(context, "route");
});

test("wrong explanation and route entries get one repair attempt and invalid results are not cached", async (context) => {
  const fixture = await createFixture(context);
  const wrongExplanation = { role: "错把 a 当作入口", keyPoints: ["错误目标"], references: [{ fileId: "a.ts", startLine: 1, endLine: 2 }] };
  const wrongRoute = { title: "错误起点", steps: ["a.ts", "b.ts", "a.ts"].map((fileId, index) => ({ fileId, purpose: `错误步骤 ${index + 1}`, references: [{ fileId, startLine: 1 }] })) };
  const wrongExplanationForA = { role: "错把 b 当作入口", keyPoints: ["错误目标"], references: [{ fileId: "b.ts", startLine: 1, endLine: 2 }] };
  const wrongRouteForA = { title: "错误起点", steps: ["b.ts", "a.ts", "b.ts"].map((fileId, index) => ({ fileId, purpose: `错误步骤 ${index + 1}`, references: [{ fileId, startLine: 1 }] })) };

  for (const mode of ["explanation", "route"]) {
    const wrongResult = mode === "route" ? wrongRoute : wrongExplanation;
    const wrongResultForA = mode === "route" ? wrongRouteForA : wrongExplanationForA;
    const correctTarget = mode === "route"
      ? { title: "从 b 开始", steps: ["b.ts", "a.ts", "b.ts"].map((fileId, index) => ({ fileId, purpose: `步骤 ${index + 1}`, references: [{ fileId, startLine: 1 }] })) }
      : { role: "b.ts 的职责", keyPoints: ["正确入口"], references: [{ fileId: "b.ts", startLine: 1, endLine: 2 }] };
    let before = fixture.modelCalls.length;
    fixture.queueModelResult(wrongResult);
    fixture.queueModelResult(wrongResult);
    let preview = await fixture.preview(mode, "b.ts");
    let generated = await fixture.request("/api/ai/generate", { previewId: preview.id });
    assert.equal(generated.status, 400, "a second invalid entry result is rejected");
    assert.match(generated.value.error, /入口|引用|源码/);
    assert.equal(fixture.modelCalls.length, before + 2);

    fixture.queueModelResult(correctTarget);
    preview = await fixture.preview(mode, "b.ts");
    generated = await fixture.request("/api/ai/generate", { previewId: preview.id });
    assert.equal(generated.status, 200, generated.value.error);
    assert.equal(generated.value.cached, false, "a rejected result must not have entered the cache");
    assert.deepEqual(generated.value.result, correctTarget);

    before = fixture.modelCalls.length;
    fixture.queueModelResult(wrongResultForA);
    preview = await fixture.preview(mode, "a.ts");
    generated = await fixture.request("/api/ai/generate", { previewId: preview.id });
    assert.equal(generated.status, 200, generated.value.error);
    assert.equal(fixture.modelCalls.length, before + 2, "a wrong first response is repaired exactly once");
    if (mode === "route") assert.equal(generated.value.result.steps[0].fileId, "a.ts");
    else assert.ok(generated.value.result.references.some((reference) => reference.fileId === "a.ts"));
  }
});
