import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { watch } from "node:fs";
import { access, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "repolens-github-browser-"));
const work = path.join(temporaryRoot, "working");
const bare = path.join(temporaryRoot, "remote.git");
const tempWorkspaces = path.join(temporaryRoot, "temp-workspaces");
const aiGateDirectory = path.join(temporaryRoot, "ai-gates");
const demoEvidenceDirectory = process.env.REPOLENS_DEMO_EVIDENCE_DIR;
await mkdir(path.join(work, "src"), { recursive: true });
await mkdir(tempWorkspaces, { recursive: true });
await mkdir(aiGateDirectory, { recursive: true });
if (demoEvidenceDirectory) await mkdir(demoEvidenceDirectory, { recursive: true });

async function waitForMarker(filePath) {
  if (await access(filePath).then(() => true, () => false)) return;
  await new Promise((resolve, reject) => {
    let settled = false;
    let watcher;
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${path.basename(filePath)}.`)), 15_000);
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

async function removeMarkers(...names) {
  await Promise.all(names.map((name) => rm(path.join(aiGateDirectory, name), { force: true })));
}

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function freePort(used) {
  while (true) {
    const server = net.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    if (!used.has(port)) { used.add(port); return port; }
  }
}

async function waitForHealth(url, child) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error("RepoLens local service exited before becoming ready.");
    try { if ((await fetch(url + "/api/health")).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("RepoLens local service did not become ready.");
}

async function waitForTcp(port, child) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error("RepoLens UI exited before becoming ready.");
    const connected = await new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("RepoLens UI did not start listening.");
}

const fixtureSources = {
  "src/index.ts": 'import { summarize } from "@/summary";\nexport const output = summarize([]);\n',
  "src/summary.ts": 'import { countOpen } from "@/status";\nimport type { Task } from "@/task";\nexport function summarize(tasks: Task[]) { return countOpen(tasks); }\n',
  "src/status.ts": 'import type { Task } from "@/task";\nexport function countOpen(tasks: Task[]) { return tasks.length; }\n',
  "src/task.ts": "export type Task = { id: string };\n",
};

let browser;
let browserContext;
let page;
let application;
let modelCalls = 0;
let modelRequestBodies = [];
const modelServer = createServer(async (request, response) => {
  modelCalls += 1;
  let text = "";
  for await (const chunk of request) text += chunk;
  const payload = JSON.parse(text);
  modelRequestBodies.push(payload);
  const prompt = payload.messages.find((message) => message.role === "user")?.content ?? "";
  const taskMatch = prompt.match(/^任务信息：(\{[^\r\n]+\})$/m);
  assert.ok(taskMatch, "the model prompt carries the confirmed task target");
  const task = JSON.parse(taskMatch[1]);
  const sourceRanges = [...prompt.matchAll(/^FILE (.+?) LINES (\d+)-(\d+)/gm)];
  const sourceRange = (fileId) => sourceRanges.find((match) => match[1] === fileId);
  const result = task.mode === "route"
    ? (() => {
      const files = task.entryFileId === "src/index.ts"
        ? ["src/index.ts", "src/summary.ts", "src/status.ts"]
        : [task.entryFileId, ...sourceRanges.map((match) => match[1]).filter((fileId) => fileId !== task.entryFileId)].slice(0, 3);
      while (files.length < 3) files.push(files[files.length - 1] ?? task.entryFileId);
      const purposes = { "src/index.ts": "找到演示入口", "src/summary.ts": "阅读摘要组织", "src/status.ts": "查看状态统计" };
      return { title: "从入口理解数据流", steps: files.map((fileId, index) => ({ fileId, purpose: purposes[fileId] ?? `阅读依赖 ${index + 1}`, references: [{ fileId, startLine: Number(sourceRange(fileId)?.[2] ?? 1), endLine: Number(sourceRange(fileId)?.[3] ?? sourceRange(fileId)?.[2] ?? 1) }] })) };
    })()
    : (() => {
      const source = sourceRange(task.entryFileId);
      assert.ok(source, `the local model prompt includes a source range for ${task.entryFileId}`);
      return { role: "文件职责说明", keyPoints: [`围绕 ${task.entryFileId} 的逻辑`], references: [{ fileId: task.entryFileId, startLine: Number(source[2]), endLine: Number(source[3]) }] };
    })();
  response.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
  response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
});

try {
  for (const [file, source] of Object.entries(fixtureSources)) await writeFile(path.join(work, file), source);
  await writeFile(path.join(work, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }));
  git(work, "init");
  git(work, "config", "user.name", "RepoLens Test");
  git(work, "config", "user.email", "test@example.invalid");
  git(work, "add", ".");
  git(work, "commit", "-m", "fixture");
  git(work, "branch", "-M", "main");
  git(temporaryRoot, "init", "--bare", bare);
  git(work, "remote", "add", "origin", bare);
  git(work, "push", "origin", "main");
  git(temporaryRoot, "--git-dir", bare, "symbolic-ref", "HEAD", "refs/heads/main");

  modelServer.listen(0, "127.0.0.1");
  await once(modelServer, "listening");
  const modelPort = modelServer.address().port;
  const usedPorts = new Set([modelPort]);
  const uiPort = await freePort(usedPorts);
  const apiPort = await freePort(usedPorts);
  const uiOrigin = `http://127.0.0.1:${uiPort}`;
  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  application = spawn(process.execPath, [
    path.join(projectRoot, "scripts/with-local-service.mjs"),
    path.join(projectRoot, "scripts/run-framework.mjs"), "dev", "--port", String(uiPort),
  ], {
    cwd: projectRoot,
    env: {
      ...process.env,
      REPOLENS_PORT: String(apiPort), REPOLENS_UI_PORT: String(uiPort), REPOLENS_TEMP_ROOT: tempWorkspaces,
      NEXT_PUBLIC_REPOLENS_API_ORIGIN: apiOrigin,
      VINEXT_NO_DEV_LOCK: "1",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.${pathToFileURL(bare).href}.insteadOf`,
      GIT_CONFIG_VALUE_0: "https://github.com/repolens-test/ai-fixture.git",
      REPOLENS_AI_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
      REPOLENS_AI_MODEL: "local-fixture-model",
      REPOLENS_AI_API_KEY: "fixture-only-key",
      REPOLENS_TEST_AI_GATE_DIR: aiGateDirectory,
      REPOLENS_TEST_AI_PREFIX: tempWorkspaces,
      REPOLENS_TEST_AI_SUFFIX: path.join("src", "summary.ts"),
      REPOLENS_TEST_AI_READ_ID: "ui-cancel",
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(path.join(projectRoot, "data", "ai-generation-gate.mjs")).href}`.trim(),
    },
    stdio: "ignore", windowsHide: true,
  });
  await waitForHealth(apiOrigin, application);
  await waitForTcp(uiPort, application);
  browser = await chromium.launch({ headless: true });
  browserContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ...(demoEvidenceDirectory ? { recordVideo: { dir: demoEvidenceDirectory, size: { width: 1440, height: 900 } } } : {}),
  });
  page = await browserContext.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.setDefaultTimeout(15_000);

  await page.goto(uiOrigin, { waitUntil: "domcontentloaded" });
  await page.locator(".graph-file-card").first().waitFor({ state: "visible" });
  await page.getByLabel("本地仓库路径或 GitHub 链接").fill("https://github.com/repolens-test/ai-fixture/tree/main/src");
  const openedResponse = page.waitForResponse((response) => response.url() === apiOrigin + "/api/open");
  await page.getByRole("button", { name: "打开仓库" }).click();
  assert.equal((await openedResponse).status(), 200);
  const initialSnapshot = await (await openedResponse).json();
  await page.getByText("GitHub 远端", { exact: true }).waitFor({ state: "visible" });
  await page.getByRole("treeitem", { name: "summary.ts" }).click();
  await page.getByRole("button", { name: "生成当前文件讲解" }).click();
  const explanationConsent = page.locator(".ai-consent");
  await explanationConsent.getByText("发送前确认").waitFor({ state: "visible" });
  const explanationScope = await explanationConsent.innerText();
  assert.match(explanationScope, /src\/summary\.ts/);
  assert.match(explanationScope, /src\/status\.ts/);
  assert.equal(modelCalls, 0, "the real local server must not call the model before confirmation");

  const firstExplanationResponse = page.waitForResponse((response) => response.url() === apiOrigin + "/api/ai/generate");
  await explanationConsent.getByRole("button", { name: "确认发送并生成" }).click();
  const firstExplanation = await firstExplanationResponse;
  assert.equal(firstExplanation.status(), 200);
  const firstExplanationValue = await firstExplanation.json();
  assert.ok(firstExplanationValue.result.references.some((reference) => reference.fileId === "src/summary.ts"), "the generated explanation cites the selected file");
  await page.getByText("文件职责说明", { exact: true }).waitFor({ state: "visible" });
  assert.equal(modelCalls, 1);
  assert.ok(modelRequestBodies[0].messages.some((message) => message.content.includes("FILE src/summary.ts LINES 1-")));
  const explanationTask = modelRequestBodies[0].messages.find((message) => message.role === "user").content.match(/^任务信息：(.+)$/m);
  assert.ok(explanationTask, "the confirmed model request includes task metadata");
  assert.deepEqual(JSON.parse(explanationTask[1]), { promptVersion: "prompt-v3", mode: "explanation", entryFileId: "src/summary.ts" });
  await page.getByRole("tab", { name: "讲解", exact: true }).click();
  await page.locator(".ai-result [aria-label='AI 源码引用'] .reference-row").first().click();
  await page.getByRole("tab", { name: "源码", exact: true }).click();
  await page.locator("#source-line-1.is-focused").waitFor({ state: "visible" });
  if (demoEvidenceDirectory) await page.screenshot({ path: path.join(demoEvidenceDirectory, "mock-ai-source-reference.png") });
  await page.getByRole("tab", { name: "讲解", exact: true }).click();

  await page.getByRole("button", { name: "生成当前文件讲解" }).click();
  const cachedExplanationConsent = page.locator(".ai-consent");
  await cachedExplanationConsent.getByText("发送前确认").waitFor({ state: "visible" });
  assert.equal(modelCalls, 1, "preview does not call the model again");
  const cachedExplanationResponse = page.waitForResponse((response) => response.url() === apiOrigin + "/api/ai/generate");
  await cachedExplanationConsent.getByRole("button", { name: "确认发送并生成" }).click();
  const cachedExplanation = await cachedExplanationResponse;
  const cachedExplanationValue = await cachedExplanation.json();
  assert.equal(cachedExplanationValue.cached, true, JSON.stringify(cachedExplanationValue));
  assert.equal(modelCalls, 1, "the cached explanation avoids a second model call");

  await page.getByRole("treeitem", { name: "index.ts" }).click();
  await page.getByRole("button", { name: "生成阅读路线" }).click();
  const routeConsent = page.locator(".ai-consent");
  await routeConsent.getByText("发送前确认").waitFor({ state: "visible" });
  const routeScope = await routeConsent.innerText();
  for (const file of Object.keys(fixtureSources)) assert.ok(routeScope.includes(file), `route preview should include ${file}`);
  assert.equal(modelCalls, 1, "route preview does not call the model");
  const routeResponsePromise = page.waitForResponse((response) => response.url() === apiOrigin + "/api/ai/generate");
  await routeConsent.getByRole("button", { name: "确认发送并生成" }).click();
  const routeResponse = await routeResponsePromise;
  assert.equal(routeResponse.status(), 200);
  const routeValue = await routeResponse.json();
  assert.equal(routeValue.result.steps[0].fileId, "src/index.ts", "the first route step matches the selected entry");
  const routeTask = modelRequestBodies[1].messages.find((message) => message.role === "user").content.match(/^任务信息：(.+)$/m);
  assert.ok(routeTask, "the confirmed route request includes task metadata");
  assert.deepEqual(JSON.parse(routeTask[1]), { promptVersion: "prompt-v3", mode: "route", entryFileId: "src/index.ts" });
  const routeStep = page.getByRole("button", { name: "第 1 步：index.ts" });
  await routeStep.waitFor({ state: "visible" });
  await page.getByRole("button", { name: "第 2 步：summary.ts" }).click();
  assert.match(await page.locator(".tour-description").innerText(), /阅读摘要组织/);
  assert.equal(modelCalls, 2);
  if (demoEvidenceDirectory) await page.screenshot({ path: path.join(demoEvidenceDirectory, "mock-ai-reading-route.png") });

  await page.getByRole("tab", { name: "讲解", exact: true }).click();
  await page.getByRole("button", { name: "生成当前文件讲解" }).click();
  const cancelledExplanationConsent = page.locator(".ai-consent");
  await cancelledExplanationConsent.getByText("发送前确认").waitFor({ state: "visible" });
  const generateEndpoint = `${apiOrigin}/api/ai/generate`;
  await removeMarkers("read-arm", "read-entered-ui-cancel", "read-finished-ui-cancel", "read-release", "response-closed-ui-cancel", "request-handled-ui-cancel");
  await page.route(generateEndpoint, async (route) => {
    await route.continue({ headers: { ...route.request().headers(), "x-repolens-test-id": "ui-cancel" } });
  });
  await writeFile(path.join(aiGateDirectory, "read-arm"), "hold\n");
  const cancelledRequest = page.waitForEvent("requestfailed", (request) => request.url() === generateEndpoint);
  await cancelledExplanationConsent.getByRole("button", { name: "确认发送并生成" }).click();
  await waitForMarker(path.join(aiGateDirectory, "read-entered-ui-cancel"));
  await page.getByRole("treeitem", { name: "status.ts" }).click();
  await waitForMarker(path.join(aiGateDirectory, "response-closed-ui-cancel"));
  await writeFile(path.join(aiGateDirectory, "read-release"), "release\n");
  await Promise.all([
    waitForMarker(path.join(aiGateDirectory, "read-finished-ui-cancel")),
    waitForMarker(path.join(aiGateDirectory, "request-handled-ui-cancel")),
    cancelledRequest,
  ]);
  assert.equal(modelCalls, 2, "switching files during verification cancels the request before source reaches the model");
  await page.unroute(generateEndpoint);

  await page.getByRole("button", { name: "生成当前文件讲解" }).click();
  const statusConsent = page.locator(".ai-consent");
  await statusConsent.getByText("发送前确认").waitFor({ state: "visible" });
  assert.match(await statusConsent.innerText(), /src\/status\.ts/);
  const statusExplanationPromise = page.waitForResponse((response) => response.url() === generateEndpoint);
  await statusConsent.getByRole("button", { name: "确认发送并生成" }).click();
  assert.equal((await statusExplanationPromise).status(), 200);
  await page.getByText("文件职责说明", { exact: true }).waitFor({ state: "visible" });
  assert.equal(modelCalls, 3, "a new request for the newly selected file still generates normally");
  assert.ok(modelRequestBodies[2].messages.some((message) => message.content.includes("FILE src/status.ts LINES 1-")));
  const statusTask = modelRequestBodies[2].messages.find((message) => message.role === "user").content.match(/^任务信息：(.+)$/m);
  assert.ok(statusTask, "the model request follows the newly selected file");
  assert.equal(JSON.parse(statusTask[1]).entryFileId, "src/status.ts");

  const repositoryResponse = page.waitForResponse((response) => response.url() === apiOrigin + "/api/rescan");
  await page.getByRole("button", { name: "检查远端更新" }).first().click();
  const unchangedSnapshot = await repositoryResponse;
  assert.equal(unchangedSnapshot.status(), 200);
  const unchangedValue = await unchangedSnapshot.json();
  assert.equal(unchangedValue.revision, initialSnapshot.revision);
  assert.equal(unchangedValue.sequence, initialSnapshot.sequence);
  const originalCommit = await page.locator("[aria-label='GitHub 来源信息']").innerText();
  assert.match(originalCommit, /refs\/heads\/main/);
  const parallelRescans = await Promise.all(Array.from({ length: 2 }, () => fetch(`${apiOrigin}/api/rescan`, {
    method: "POST", headers: { Origin: uiOrigin, "Content-Type": "application/json" }, body: JSON.stringify({ repositoryId: initialSnapshot.id }),
  })));
  assert.deepEqual(parallelRescans.map((response) => response.status), [200, 200]);
  const parallelSnapshots = await Promise.all(parallelRescans.map((response) => response.json()));
  assert.ok(parallelSnapshots.every((snapshot) => snapshot.revision === unchangedValue.revision && snapshot.sequence === unchangedValue.sequence));

  await writeFile(path.join(work, "src/index.ts"), `${fixtureSources["src/index.ts"]}export const changed = true;\n`);
  git(work, "add", "src/index.ts");
  git(work, "commit", "-m", "remote update");
  git(work, "push", "origin", "main");
  const updatedResponsePromise = page.waitForResponse((response) => response.url() === apiOrigin + "/api/rescan");
  await page.getByRole("button", { name: "检查远端更新" }).first().click();
  const updatedResponse = await updatedResponsePromise;
  assert.equal(updatedResponse.status(), 200);
  const updatedSnapshot = await updatedResponse.json();
  assert.notEqual(updatedSnapshot.revision, unchangedValue.revision);
  assert.equal(updatedSnapshot.sequence, unchangedValue.sequence + 1);
  await page.getByRole("treeitem", { name: "index.ts" }).click();
  await page.getByRole("tab", { name: "讲解", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('button[aria-label="第 1 步：index.ts"]')?.disabled === true);
  assert.equal(await page.getByRole("button", { name: "第 1 步：index.ts" }).isDisabled(), true);
  assert.match(await page.locator(".tour-description").innerText(), /阅读摘要组织/);
  assert.match(await page.locator(".tour-description").innerText(), /阅读摘要组织/);
  await page.getByRole("tab", { name: "源码", exact: true }).click();
  await page.locator(".source-code").waitFor({ state: "visible" });
  assert.match(await page.locator(".source-code").innerText(), /export const changed = true/);
  assert.deepEqual(pageErrors, []);

  const closeResponse = page.waitForResponse((response) => response.url() === apiOrigin + "/api/close");
  await page.getByRole("button", { name: "返回示例" }).click();
  assert.equal((await closeResponse).status(), 200);
  await page.getByText("示例仓库", { exact: true }).waitFor({ state: "visible" });
  const leftovers = (await readdir(tempWorkspaces)).filter((name) => name.startsWith("repolens-github-"));
  assert.deepEqual(leftovers, [], "returning to the sample removes all temporary remote files");
  process.stdout.write(JSON.stringify({ browserFlow: "passed", modelCalls, cancelledDuringVerification: true, files: Object.keys(fixtureSources).length, cachedExplanation: true, revision: updatedSnapshot.sequence }) + "\n");
} finally {
  const demoVideo = page?.video();
  if (browserContext) await browserContext.close();
  if (demoEvidenceDirectory && demoVideo) {
    try {
      const target = path.join(demoEvidenceDirectory, "mock-ai-confirmation-flow.webm");
      await rm(target, { force: true });
      await demoVideo.saveAs(target);
    }
    catch (error) { process.stderr.write(`Could not finalize demo recording: ${error.message}\n`); }
  }
  if (browser) await browser.close();
  if (application && application.exitCode === null) {
    application.kill("SIGTERM");
    await Promise.race([once(application, "exit"), new Promise((resolve) => setTimeout(resolve, 5000))]);
  }
  await new Promise((resolve) => modelServer.close(resolve));
  if (path.dirname(temporaryRoot) === path.resolve(os.tmpdir()) && path.basename(temporaryRoot).startsWith("repolens-github-browser-")) {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
