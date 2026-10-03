import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { access, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error("git " + args.join(" ") + " failed: " + result.stderr);
  return result.stdout.trim();
}
async function freePort() {
  const server = net.createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port;
}
async function waitForService(url, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error("GitHub test service exited before becoming ready.");
    try { if ((await fetch(url + "/api/health")).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("GitHub test service did not become ready.");
}

async function waitForFile(filePath, timeoutMs = 10_000) {
  const exists = async () => { try { await access(filePath); return true; } catch { return false; } };
  if (await exists()) return;
  await new Promise((resolve, reject) => {
    let finished = false;
    const watcher = watch(path.dirname(filePath), { persistent: false }, () => { void exists().then((found) => { if (found) finish(); }); });
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${path.basename(filePath)}.`)), timeoutMs);
    function finish(error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      watcher.close();
      if (error) reject(error); else resolve();
    }
    watcher.once("error", finish);
    void exists().then((found) => { if (found) finish(); });
  });
}

test("local service opens GitHub URLs, retains failed-open sessions, and refreshes the remote only on rescan", async (context) => {
  const testRoot = await mkdtemp(path.join(os.tmpdir(), "repolens-github-api-test-"));
  const working = path.join(testRoot, "working"); const remote = path.join(testRoot, "remote.git");
  await mkdir(working);
  git(working, "init"); git(working, "config", "user.name", "RepoLens Test"); git(working, "config", "user.email", "test@example.invalid");
  await mkdir(path.join(working, "src"));
  await writeFile(path.join(working, "src", "main.ts"), "export const greeting = 'hello';\n");
  git(working, "add", "."); git(working, "commit", "-m", "first"); git(working, "branch", "-M", "main");
  git(testRoot, "init", "--bare", remote); git(working, "remote", "add", "origin", remote); git(working, "push", "origin", "main");
  git(testRoot, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");

  const apiPort = await freePort(); const origin = "http://127.0.0.1:" + apiPort; const appOrigin = "http://127.0.0.1:5173";
  let intentSequence = 0; const clientId = "github-api-test-" + process.pid;
  const command = () => ({ clientId, intentSequence: ++intentSequence });
  const api = (route, init = {}) => fetch(origin + route, { ...init, headers: { Origin: appOrigin, ...(init.headers ?? {}) } });
  const cloneUrl = "https://github.com/repolens-test/demo.git";
  const child = spawn(process.execPath, [path.join(projectRoot, "scripts/local-server.mjs")], {
    cwd: projectRoot,
    env: {
      ...process.env,
      REPOLENS_PORT: String(apiPort),
      REPOLENS_UI_PORT: "5173",
      REPOLENS_TEMP_ROOT: testRoot,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "url." + pathToFileURL(remote).href + ".insteadOf",
      GIT_CONFIG_VALUE_0: cloneUrl,
    },
    stdio: "ignore",
    windowsHide: true,
  });
  context.after(async () => {
    if (child.exitCode === null) { child.kill(); await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]); }
    await rm(testRoot, { recursive: true, force: true });
  });
  await waitForService(origin, child);
  const open = await api("/api/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "https://github.com/repolens-test/demo/tree/main/src", command: command() }) });
  assert.equal(open.status, 200);
  let snapshot = await open.json();
  assert.match(snapshot.id, /^github-/);
  assert.equal(snapshot.origin.kind, "github");
  assert.equal(snapshot.origin.url, "https://github.com/repolens-test/demo");
  assert.equal(snapshot.origin.resolvedRef, "refs/heads/main");
  assert.equal(snapshot.origin.commit, git(working, "rev-parse", "HEAD"));
  assert.equal(snapshot.origin.subdirectory, "src");
  const stableRepositoryId = snapshot.id;
  const sourceQuery = new URLSearchParams({ repositoryId: snapshot.id, revision: snapshot.revision, file: "src/main.ts" });
  const source = (await (await api("/api/source?" + sourceQuery)).json()).source;
  assert.match(source, /hello/);

  const failedOpen = await api("/api/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "https://not-github.example/repolens/demo", command: command() }) });
  assert.equal(failedOpen.status, 400);
  assert.equal((await (await api("/api/snapshot?repositoryId=" + snapshot.id)).json()).id, snapshot.id, "a failed remote open retains the active repository");

  await writeFile(path.join(working, "src", "main.ts"), "export const greeting = 'updated';\n");
  git(working, "add", "src/main.ts"); git(working, "commit", "-m", "remote update"); git(working, "push", "origin", "main");
  const rescan = await api("/api/rescan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repositoryId: snapshot.id }) });
  assert.equal(rescan.status, 200);
  snapshot = await rescan.json();
  assert.equal(snapshot.id, stableRepositoryId, "a remote update must preserve the repository identity");
  assert.match(snapshot.origin.commit, /^[0-9a-f]{40}$/);
  assert.match(snapshot.revision, /^[0-9a-f]{64}$/);
  assert.equal(snapshot.sequence, 2);
  const updatedQuery = new URLSearchParams({ repositoryId: snapshot.id, revision: snapshot.revision, file: "src/main.ts" });
  const updatedSource = (await (await api("/api/source?" + updatedQuery)).json()).source;
  assert.match(updatedSource, /updated/);

  const closed = await api("/api/close", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: command() }) });
  assert.equal(closed.status, 200);
  const tempsAfterClose = (await readdir(testRoot)).filter((name) => name.startsWith("repolens-github-"));
  assert.deepEqual(tempsAfterClose, [], "the service removes its remote temp workspace on close");
});

test("the preview wrapper cleans remote workspaces after UI exits and explicit shutdown", async (context) => {
  for (const scenario of [{ uiExitCode: 0, stopWithMessage: false }, { uiExitCode: 7, stopWithMessage: false }, { uiExitCode: 0, stopWithMessage: true }]) {
  const { uiExitCode, stopWithMessage } = scenario;
  const testRoot = await mkdtemp(path.join(os.tmpdir(), "repolens-github-wrapper-exit-"));
  const working = path.join(testRoot, "working"); const remote = path.join(testRoot, "remote.git");
  await mkdir(working);
  await writeFile(path.join(working, "index.ts"), "export const value = 1;\n");
  git(working, "init"); git(working, "config", "user.name", "RepoLens Test"); git(working, "config", "user.email", "test@example.invalid");
  git(working, "add", "."); git(working, "commit", "-m", "fixture"); git(working, "branch", "-M", "main");
  git(testRoot, "init", "--bare", remote); git(working, "remote", "add", "origin", remote); git(working, "push", "origin", "main");
  git(testRoot, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");

  const apiPort = await freePort(); const origin = "http://127.0.0.1:" + apiPort;
  const wrapper = path.join(projectRoot, "scripts", "with-local-service.mjs");
  const child = spawn(process.execPath, [wrapper, "-e", `process.stdin.once('data', () => process.exit(${uiExitCode})); setInterval(() => {}, 1000);`], {
    cwd: projectRoot,
    env: {
      ...process.env,
      REPOLENS_PORT: String(apiPort), REPOLENS_UI_PORT: "5173", REPOLENS_TEMP_ROOT: testRoot,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "url." + pathToFileURL(remote).href + ".insteadOf",
      GIT_CONFIG_VALUE_0: "https://github.com/repolens-test/wrapper-exit.git",
    },
    stdio: ["pipe", "ignore", "pipe", "ipc"],
    windowsHide: true,
  });
  context.after(async () => {
    if (child.exitCode === null) {
      if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      else child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 5000))]);
    }
    await rm(testRoot, { recursive: true, force: true });
  });
  let wrapperErrors = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { wrapperErrors += chunk; });
  await waitForService(origin, child);
  const opened = await fetch(origin + "/api/open", {
    method: "POST",
    headers: { Origin: "http://127.0.0.1:5173", "Content-Type": "application/json" },
    body: JSON.stringify({ path: "https://github.com/repolens-test/wrapper-exit", command: { clientId: "wrapper-exit-test-" + uiExitCode, intentSequence: 1 } }),
  });
  assert.equal(opened.status, 200);
  assert.equal((await readdir(testRoot)).filter((name) => name.startsWith("repolens-github-")).length, 1);

  const exited = once(child, "exit");
  if (stopWithMessage) {
    const accepted = new Promise(resolve => {
      const onMessage = message => {
        if (message?.type === "shutdownAccepted") { child.off("message", onMessage); resolve(message); }
      };
      child.on("message", onMessage);
    });
    await new Promise((resolve, reject) => child.send({ type: "shutdown" }, (error) => error ? reject(error) : resolve()));
    assert.deepEqual(await accepted, { type: "shutdownAccepted" }, "the wrapper received the internal shutdown command");
    child.stdin.end();
  }
  else child.stdin.write("exit\n");
  let exitTimer;
  let exitResult;
  try {
    exitResult = await Promise.race([exited, new Promise((_, reject) => { exitTimer = setTimeout(() => reject(new Error(`preview wrapper did not exit: ${wrapperErrors}`)), 5_000); exitTimer.unref?.(); })]);
  } finally { clearTimeout(exitTimer); }
  const [code, signalName] = exitResult;
  assert.equal(signalName, null);
  assert.equal(code, uiExitCode, "the wrapper preserves its UI exit code or completes an explicit graceful shutdown");
  assert.deepEqual((await readdir(testRoot)).filter((name) => name.startsWith("repolens-github-")), [], "the UI exit must wait for backend workspace cleanup");
  }
});

test("the local service waits for a delayed Git close event before cleaning on close and shutdown", async (context) => {
  const testRoot = await mkdtemp(path.join(os.tmpdir(), "repolens-github-service-close-gate-"));
  const working = path.join(testRoot, "working");
  const remote = path.join(testRoot, "remote.git");
  const local = path.join(testRoot, "local");
  await mkdir(working);
  await mkdir(local);
  await writeFile(path.join(working, "index.ts"), "export const value = 1;\n");
  await writeFile(path.join(local, "local.ts"), "export const local = true;\n");
  git(working, "init");
  git(working, "config", "user.name", "RepoLens Test");
  git(working, "config", "user.email", "test@example.invalid");
  git(working, "add", ".");
  git(working, "commit", "-m", "fixture");
  git(working, "branch", "-M", "main");
  git(testRoot, "init", "--bare", remote);
  git(working, "remote", "add", "origin", remote);
  git(working, "push", "origin", "main");
  git(testRoot, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");

  const apiPort = await freePort();
  const origin = `http://127.0.0.1:${apiPort}`;
  const appOrigin = "http://127.0.0.1:5173";
  const gateArm = path.join(testRoot, "git-close-arm");
  const gateEntered = path.join(testRoot, "git-close-entered");
  const gateRelease = path.join(testRoot, "git-close-release");
  const preload = path.join(projectRoot, "data", "github-git-close-gate.mjs");
  const cloneUrl = "https://github.com/repolens-test/close-gate.git";
  const child = spawn(process.execPath, [path.join(projectRoot, "scripts/local-server.mjs")], {
    cwd: projectRoot,
    env: {
      ...process.env,
      REPOLENS_PORT: String(apiPort),
      REPOLENS_UI_PORT: "5173",
      REPOLENS_TEMP_ROOT: testRoot,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.${pathToFileURL(remote).href}.insteadOf`,
      GIT_CONFIG_VALUE_0: cloneUrl,
      REPOLENS_TEST_GIT_CLOSE_ARM: gateArm,
      REPOLENS_TEST_GIT_CLOSE_ENTERED: gateEntered,
      REPOLENS_TEST_GIT_CLOSE_RELEASE: gateRelease,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}`.trim(),
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  let intentSequence = 0;
  const clientId = "github-close-gate-" + process.pid;
  const command = () => ({ clientId, intentSequence: ++intentSequence });
  const api = async (route, input) => {
    const response = await fetch(origin + route, {
      signal: AbortSignal.timeout(20_000),
      method: input === undefined ? "GET" : "POST",
      headers: { Origin: appOrigin, ...(input === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    return { status: response.status, value: await response.json() };
  };
  const tempDirectories = () => readdir(testRoot).then((names) => names.filter((name) => name.startsWith("repolens-github-")));
  context.after(async () => {
    await writeFile(gateRelease, "release\n").catch(() => {});
    if (child.exitCode === null) {
      if (child.connected) child.send({ type: "shutdown" });
      await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 15_000))]);
      if (child.exitCode === null) {
        if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
        else child.kill("SIGKILL");
      }
    }
    await rm(testRoot, { recursive: true, force: true });
  });
  await waitForService(origin, child);
  const open = await api("/api/open", { path: cloneUrl, command: command() });
  assert.equal(open.status, 200, open.value.error);

  const startHeldRescan = async (repositoryId) => {
    await Promise.all([gateArm, gateEntered, gateRelease].map((filePath) => rm(filePath, { force: true })));
    await writeFile(gateArm, "hold next Git child close\n");
    const request = api("/api/rescan", { repositoryId }).catch((error) => error);
    await waitForFile(gateEntered);
    return {
      request,
      release: () => writeFile(gateRelease, "release\n"),
    };
  };
  const firstGate = await startHeldRescan(open.value.id);
  assert.equal((await tempDirectories()).length, 1);
  let closeSettled = false;
  const closeRequest = api("/api/close", { command: command() }).then((result) => { closeSettled = true; return result; });
  let closeApplied = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const snapshot = await api(`/api/snapshot?repositoryId=${open.value.id}`);
    if (snapshot.status === 409) { closeApplied = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(closeApplied, true, "the close command becomes active while its Git cleanup is still held");
  assert.equal(closeSettled, false, "close must wait for the Git child close event");
  assert.equal((await tempDirectories()).length, 1, "the workspace is retained until the delayed Git operation settles");
  await firstGate.release();
  assert.equal((await closeRequest).status, 200);
  const canceled = await firstGate.request;
  assert.notEqual(canceled.status, 200, "the canceled rescan cannot publish a successful snapshot");
  assert.deepEqual(await tempDirectories(), []);

  const reopened = await api("/api/open", { path: cloneUrl, command: command() });
  assert.equal(reopened.status, 200);
  const switchGate = await startHeldRescan(reopened.value.id);
  const switchCommand = command();
  const switchRequestA = api("/api/open", { path: local, command: switchCommand }).catch((error) => error);
  const switchRequestB = api("/api/open", { path: local, command: switchCommand }).catch((error) => error);
  const duplicateRequest = await Promise.race([switchRequestA, switchRequestB]);
  assert.equal(duplicateRequest.status, 409, "the duplicate response proves the repository switch intent has reached the service");
  assert.equal((await tempDirectories()).length, 1, "the old remote remains available until its delayed Git operation settles");
  await switchGate.release();
  const switchResults = await Promise.all([switchRequestA, switchRequestB]);
  assert.deepEqual(switchResults.map((result) => result.status).sort(), [200, 409]);
  const switched = switchResults.find((result) => result.status === 200);
  assert.equal(switched.value.source, "local");
  assert.notEqual((await api(`/api/snapshot?repositoryId=${reopened.value.id}`)).status, 200, "the completed switch replaces the remote snapshot");
  assert.notEqual((await switchGate.request).status, 200, "the old remote rescan cannot commit after the switch");
  assert.deepEqual(await tempDirectories(), [], "the old remote workspace is cleaned after the switch completes");

  const remoteAgain = await api("/api/open", { path: cloneUrl, command: command() });
  assert.equal(remoteAgain.status, 200);
  const finalGate = await startHeldRescan(remoteAgain.value.id);
  assert.equal((await tempDirectories()).length, 1);
  const serviceExited = once(child, "exit");
  await new Promise((resolve, reject) => child.send({ type: "shutdown" }, (error) => error ? reject(error) : resolve()));
  let stoppedAccepting = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try { await fetch(origin + "/api/health", { signal: AbortSignal.timeout(100) }); }
    catch { stoppedAccepting = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(stoppedAccepting, true, "service shutdown closes its listener while waiting for the Git child");
  assert.equal(child.exitCode, null, "service shutdown must not exit before the held Git operation finishes");
  assert.equal((await tempDirectories()).length, 1, "service shutdown retains the remote workspace while the Git child is held");
  await finalGate.release();
  const [exitCode, signalName] = await Promise.race([serviceExited, new Promise((_, reject) => setTimeout(() => reject(new Error(`local service cleanup did not finish: ${stderr}`)), 15_000))]);
  assert.equal(exitCode, 0, stderr);
  assert.equal(signalName, null);
  await finalGate.request;
  assert.deepEqual(await tempDirectories(), [], "service exit removes its workspace after the delayed Git operation settles");
});

test("GitHub AI verification preserves remote identity, revision, cache, and workspace cleanup", async (context) => {
  const testRoot = await mkdtemp(path.join(os.tmpdir(), "repolens-github-ai-api-test-"));
  const working = path.join(testRoot, "working");
  const remote = path.join(testRoot, "remote.git");
  await mkdir(path.join(working, "src"), { recursive: true });
  const files = {
    "src/index.ts": 'import { summarize } from "@/summary";\nexport const output = summarize([]);\n',
    "src/summary.ts": 'import { countOpen } from "@/status";\nimport type { Task } from "@/task";\nexport function summarize(tasks: Task[]) { return countOpen(tasks); }\n',
    "src/status.ts": 'import type { Task } from "@/task";\nexport function countOpen(tasks: Task[]) { return tasks.length; }\n',
    "src/task.ts": 'export type Task = { id: string };\n',
  };
  for (const [file, source] of Object.entries(files)) await writeFile(path.join(working, file), source);
  await writeFile(path.join(working, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }));
  git(working, "init"); git(working, "config", "user.name", "RepoLens Test"); git(working, "config", "user.email", "test@example.invalid");
  git(working, "add", "."); git(working, "commit", "-m", "fixture"); git(working, "branch", "-M", "main");
  git(testRoot, "init", "--bare", remote); git(working, "remote", "add", "origin", remote); git(working, "push", "origin", "main");
  git(testRoot, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");

  let modelCalls = 0;
  const model = createServer(async (request, response) => {
    modelCalls += 1;
    let bodyText = "";
    for await (const chunk of request) bodyText += chunk;
    const payload = JSON.parse(bodyText);
    const userPrompt = payload.messages.find((message) => message.role === "user")?.content ?? "";
    const taskMatch = userPrompt.match(/^任务信息：(.+)$/m);
    assert.ok(taskMatch, "the model request includes the previewed task target");
    const task = JSON.parse(taskMatch[1]);
    const sourceRanges = [...userPrompt.matchAll(/^FILE (.+?) LINES (\d+)-(\d+)/gm)];
    const sourceRange = (fileId) => sourceRanges.find((match) => match[1] === fileId);
    const result = task.mode === "route"
      ? { title: "从入口理解数据流", steps: [task.entryFileId, "src/summary.ts", "src/status.ts"].map((fileId, index) => ({
        fileId,
        purpose: ["找到演示入口", "阅读摘要组织", "查看状态统计"][index],
        references: [{ fileId, startLine: Number(sourceRange(fileId)?.[2] ?? 1), endLine: Number(sourceRange(fileId)?.[3] ?? sourceRange(fileId)?.[2] ?? 1) }],
      })) }
      : { role: `${task.entryFileId} 文件职责`, keyPoints: ["依据所选入口生成"], references: [{ fileId: task.entryFileId, startLine: Number(sourceRange(task.entryFileId)?.[2] ?? 1), endLine: Number(sourceRange(task.entryFileId)?.[3] ?? sourceRange(task.entryFileId)?.[2] ?? 1) }] };
    response.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
  });
  model.listen(0, "127.0.0.1");
  await once(model, "listening");
  const modelPort = model.address().port;

  const apiPort = await freePort(); const origin = "http://127.0.0.1:" + apiPort; const appOrigin = "http://127.0.0.1:5173";
  let intentSequence = 0; const clientId = "github-ai-api-test-" + process.pid;
  const command = () => ({ clientId, intentSequence: ++intentSequence });
  const api = async (route, input) => {
    const response = await fetch(origin + route, {
      method: input === undefined ? "GET" : "POST",
      headers: { Origin: appOrigin, ...(input === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    return { status: response.status, value: await response.json() };
  };
  const cloneUrl = "https://github.com/repolens-test/ai-fixture.git";
  const child = spawn(process.execPath, [path.join(projectRoot, "scripts/local-server.mjs")], {
    cwd: projectRoot,
    env: {
      ...process.env,
      REPOLENS_PORT: String(apiPort), REPOLENS_UI_PORT: "5173", REPOLENS_TEMP_ROOT: testRoot,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "url." + pathToFileURL(remote).href + ".insteadOf",
      GIT_CONFIG_VALUE_0: cloneUrl,
      REPOLENS_AI_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
      REPOLENS_AI_MODEL: "local-fixture-model",
      REPOLENS_AI_API_KEY: "fixture-only-key",
    },
    stdio: "ignore", windowsHide: true,
  });
  context.after(async () => {
    if (child.exitCode === null) { child.kill(); await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]); }
    await new Promise((resolve) => model.close(resolve));
    await rm(testRoot, { recursive: true, force: true });
  });
  await waitForService(origin, child);

  const opened = await api("/api/open", { path: cloneUrl.replace(/\.git$/, ""), command: command() });
  assert.equal(opened.status, 200);
  let snapshot = opened.value;
  assert.equal(snapshot.origin.kind, "github");
  assert.ok(snapshot.dependencies.length >= 4, "the inherited alias config resolves the fixture graph");

  const previewInput = (fileId, mode) => ({ repositoryId: snapshot.id, fileId, mode });
  const explanationPreview = await api("/api/ai/preview", previewInput("src/summary.ts", "explanation"));
  assert.equal(explanationPreview.status, 200);
  assert.equal(modelCalls, 0, "preview must not call the model");
  const explanation = await api("/api/ai/generate", { previewId: explanationPreview.value.preview.id });
  assert.equal(explanation.status, 200);
  assert.equal(explanation.value.result.references[0].fileId, "src/summary.ts");
  assert.equal(modelCalls, 1);
  assert.equal((await api(`/api/snapshot?repositoryId=${snapshot.id}`)).value.origin.kind, "github");

  const cachedPreview = await api("/api/ai/preview", previewInput("src/summary.ts", "explanation"));
  const cachedExplanation = await api("/api/ai/generate", { previewId: cachedPreview.value.preview.id });
  assert.equal(cachedExplanation.status, 200);
  assert.equal(cachedExplanation.value.cached, true);
  assert.equal(modelCalls, 1, "validated cache hits do not call the model again");

  const routePreview = await api("/api/ai/preview", previewInput("src/index.ts", "route"));
  assert.equal(routePreview.status, 200);
  const routeResult = await api("/api/ai/generate", { previewId: routePreview.value.preview.id });
  assert.equal(routeResult.status, 200);
  assert.equal(routeResult.value.result.steps.length, 3);
  assert.ok(routeResult.value.result.steps.every((step) => step.references.some((reference) => reference.fileId === step.fileId)));
  assert.equal(modelCalls, 2);

  const pendingPreview = await api("/api/ai/preview", previewInput("src/summary.ts", "explanation"));
  assert.equal(pendingPreview.status, 200);
  const unchanged = await api("/api/rescan", { repositoryId: snapshot.id });
  assert.equal(unchanged.status, 200);
  assert.equal(unchanged.value.revision, snapshot.revision, "an unchanged remote commit keeps its revision");
  assert.equal(unchanged.value.sequence, snapshot.sequence, "an unchanged remote commit keeps its sequence");
  assert.equal(unchanged.value.origin.commit, snapshot.origin.commit);
  assert.equal(unchanged.value.origin.kind, "github");
  snapshot = unchanged.value;
  const pendingResult = await api("/api/ai/generate", { previewId: pendingPreview.value.preview.id });
  assert.equal(pendingResult.status, 200, "an unchanged rescan keeps the confirmed scope usable");
  assert.equal(pendingResult.value.cached, true);
  assert.equal(modelCalls, 2);

  const stalePreview = await api("/api/ai/preview", previewInput("src/index.ts", "explanation"));
  await writeFile(path.join(working, "src/index.ts"), `${files["src/index.ts"]}export const changed = true;\n`);
  git(working, "add", "src/index.ts"); git(working, "commit", "-m", "remote update"); git(working, "push", "origin", "main");
  const updated = await api("/api/rescan", { repositoryId: snapshot.id });
  assert.equal(updated.status, 200);
  assert.notEqual(updated.value.revision, snapshot.revision);
  assert.equal(updated.value.sequence, snapshot.sequence + 1);
  assert.equal(updated.value.origin.kind, "github");
  const staleGenerate = await api("/api/ai/generate", { previewId: stalePreview.value.preview.id });
  assert.equal(staleGenerate.status, 409);
  assert.equal(modelCalls, 2, "a stale preview cannot reach the model");

  const closed = await api("/api/close", { command: command() });
  assert.equal(closed.status, 200);
  const remaining = (await readdir(testRoot)).filter((name) => name.startsWith("repolens-github-"));
  assert.deepEqual(remaining, [], "closing after local AI verification removes the full remote workspace");
});
