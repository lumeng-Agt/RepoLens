import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = path.resolve(process.env.REPOLENS_DESKTOP_EXECUTABLE || path.join(root, "release", "win-unpacked", "RepoLens.exe"));
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "repolens-desktop-smoke-"));
const repositoryPath = path.join(temporaryRoot, "polyglot-demo");
const userDataPath = path.join(temporaryRoot, "user-data");
let children = [];
const modelRequests = [];
const modelServer = createHttpServer(async (request, response) => {
  let text = "";
  try {
    for await (const chunk of request) text += chunk;
    const payload = JSON.parse(text);
    const userText = [...payload.messages].reverse().find((message) => message.role === "user")?.content ?? "";
    const taskMatch = userText.match(/^任务信息：(\{[^\r\n]+\})$/m);
    assert.ok(taskMatch, "desktop smoke model request carries task metadata");
    const task = JSON.parse(taskMatch[1]);
    const ranges = [...userText.matchAll(/^FILE (.+?) LINES (\d+)-(\d+)/gm)];
    const rangeFor = (fileId) => ranges.find((range) => range[1] === fileId);
    let result;
    if (task.mode === "route") {
      const ids = [task.entryFileId, "src/pkg/core.py", task.entryFileId];
      result = { title: "从 Python 入口理解依赖", steps: ids.map((fileId, index) => ({
        fileId,
        purpose: ["从入口读取 answer", "找到 answer 的定义", "回到入口确认输出"][index],
        references: [{ fileId, startLine: Number(rangeFor(fileId)?.[2] ?? 1), endLine: Number(rangeFor(fileId)?.[3] ?? 1) }],
      })) };
    } else if (task.mode === "question") {
      const relevant = ranges.filter((range) => range[1] === "src/main.py" || range[1] === "src/pkg/core.py");
      result = {
        answer: "src/main.py 从 pkg.core 导入 answer 并打印它；answer 在 src/pkg/core.py 中赋值为 42。",
        insufficientEvidence: false,
        references: relevant.map((range) => ({ fileId: range[1], startLine: Number(range[2]), endLine: Number(range[2]) })),
      };
    } else {
      result = {
        role: "桌面模拟讲解",
        keyPoints: ["main.py 从 pkg.core 读取 answer 后打印；core.py 将 answer 设为 42。"],
        references: [{ fileId: task.entryFileId, startLine: Number(rangeFor(task.entryFileId)?.[2] ?? 1), endLine: Number(rangeFor(task.entryFileId)?.[3] ?? 1) }],
      };
    }
    modelRequests.push({ model: payload.model, mode: task.mode, entryFileId: task.entryFileId, userText });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
  } catch (error) {
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: error.message }));
  }
});

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("无法分配桌面调试端口。"));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForDebugPort(port, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`RepoLens 桌面进程提前退出：${child.exitCode}。`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("RepoLens 桌面窗口未在 30 秒内启动。\n" + children.map((item) => item.output.join("")).join("\n"));
}

async function launch({ gitExecutable } = {}) {
  const port = await reservePort();
  const childEnvironment = { ...process.env, REPOLENS_USER_DATA_PATH: userDataPath, REPOLENS_SMOKE_HIDDEN: "1", ELECTRON_DISABLE_GPU: "1" };
  delete childEnvironment.REPOLENS_AI_BASE_URL;
  delete childEnvironment.REPOLENS_AI_MODEL;
  delete childEnvironment.REPOLENS_AI_API_KEY;
  if (gitExecutable) childEnvironment.REPOLENS_GIT_EXECUTABLE = gitExecutable;
  else delete childEnvironment.REPOLENS_GIT_EXECUTABLE;
  const child = spawn(executable, [`--remote-debugging-port=${port}`], {
    cwd: temporaryRoot,
    env: childEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const record = { child, output: [] };
  children.push(record);
  child.stdout.on("data", (chunk) => record.output.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => record.output.push(chunk.toString("utf8")));
  await waitForDebugPort(port, child);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const pageDeadline = Date.now() + 30_000;
  let page;
  while (!page && Date.now() < pageDeadline) {
    page = browser.contexts().flatMap((context) => context.pages())[0];
    if (!page) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!page) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json()).catch(() => []);
    throw new Error(`桌面 Chromium 未公开窗口页面；CDP targets: ${JSON.stringify(targets)}\n${record.output.join("")}`);
  }
  record.browser = browser;
  record.page = page;
  record.workspaceResponses = [];
  record.nodePositionWrites = [];
  page.on("response", async (response) => {
    if (!response.url().includes("/api/workspace") || response.request().method() !== "POST") return;
    const requestBody = response.request().postData() ?? "";
    try {
      const payload = JSON.parse(requestBody);
      if (payload.action === "node-positions") record.nodePositionWrites.push(payload.positions ?? {});
    } catch {}
    if (!requestBody.includes('"action":"conversations"')) return;
    record.workspaceResponses.push({ status: response.status(), body: requestBody.slice(0, 1200), response: await response.text().catch(() => "<response body unavailable>") });
  });
  await page.getByRole("button", { name: "第 1 步：从入口开始" }).waitFor({ state: "visible", timeout: 20_000 });
  return { child, browser, page, workspaceResponses: record.workspaceResponses, nodePositionWrites: record.nodePositionWrites };
}

async function workspaceFor(app, repositoryId) {
  return app.page.evaluate(async (id) => {
    const origin = window.__REPOLENS_RUNTIME__?.apiOrigin;
    return fetch(`${origin}/api/workspace?repositoryId=${encodeURIComponent(id)}`).then((response) => response.json());
  }, repositoryId);
}

async function waitForWorkspace(app, repositoryId, predicate, description) {
  const deadline = Date.now() + 10_000;
  let last;
  while (Date.now() < deadline) {
    last = await workspaceFor(app, repositoryId);
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待桌面保存状态超时：${description}。最后状态：${JSON.stringify(last)}。节点位置写入：${JSON.stringify(app.nodePositionWrites ?? [])}。问答保存请求：${JSON.stringify(app.workspaceResponses ?? [])}。页面反馈：${(await app.page.locator("body").innerText().catch(() => "<unavailable>")).slice(-1800)}`);
}

async function assertDisabled(locator, message) {
  await locator.waitFor({ state: "visible" });
  assert.equal(await locator.isDisabled(), true, message);
}

async function quit(app) {
  await app.page.evaluate(() => window.repoLens?.quit()).catch(() => {});
  let timer;
  const exit = await Promise.race([
    new Promise((resolve) => app.child.once("exit", (code, signal) => resolve({ code, signal }))),
    new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), 25_000); timer.unref?.(); }),
  ]);
  clearTimeout(timer);
  assert.ok(!("timeout" in exit), "desktop completed its bounded service shutdown");
  assert.deepEqual(exit, { code: 0, signal: null }, "desktop and local service exited cleanly");
  await app.browser.close();
}

async function assertSingleInstance(first) {
  const port = await reservePort();
  const environment = { ...process.env, REPOLENS_USER_DATA_PATH: userDataPath, REPOLENS_SMOKE_HIDDEN: "1", ELECTRON_DISABLE_GPU: "1" };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [`--remote-debugging-port=${port}`], { cwd: temporaryRoot, env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const record = { child, output: [] }; children.push(record);
  child.stdout.on("data", (chunk) => record.output.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => record.output.push(chunk.toString("utf8")));
  const result = await Promise.race([
    new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))),
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 15_000)),
  ]);
  assert.deepEqual(result, { code: 0, signal: null }, `a second launch exits after focusing the existing instance: ${record.output.join("")}`);
  await first.page.getByRole("button", { name: "第 1 步：从入口开始" }).waitFor({ state: "visible" });
  assert.equal((await fetch(await first.page.evaluate(() => window.__REPOLENS_RUNTIME__?.apiOrigin) + "/api/health")).ok, true, "the original backend remains the only active service");
}

async function crashBackendAndAssertFailure(app) {
  const apiOrigin = await app.page.evaluate(() => window.__REPOLENS_RUNTIME__?.apiOrigin ?? "");
  const port = new URL(apiOrigin).port;
  const listening = spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8", windowsHide: true }).stdout.split(/\r?\n/)
    .find((line) => line.includes(`127.0.0.1:${port} `) && line.includes("LISTENING"));
  const backendPid = Number(listening?.trim().split(/\s+/).at(-1));
  assert.ok(Number.isInteger(backendPid) && backendPid > 0, "the isolated desktop backend listener is found");
  const killed = spawnSync("taskkill", ["/pid", String(backendPid), "/f"], { encoding: "utf8", windowsHide: true });
  assert.equal(killed.status, 0, `the isolated backend process is terminated: ${killed.stderr}`);
  await app.page.getByRole("alert").filter({ hasText: "本地服务不可用" }).waitFor({ state: "visible", timeout: 10_000 });
  await assertDisabled(app.page.locator("header").getByRole("button", { name: "重新扫描", exact: true }), "repository operations are disabled after backend failure");
  await assertDisabled(app.page.getByRole("button", { name: "生成当前文件讲解" }), "AI preview is disabled after backend failure");
  await app.page.evaluate(() => window.repoLens?.quit()).catch(() => {});
  const exit = await Promise.race([
    new Promise((resolve) => app.child.once("exit", (code, signal) => resolve({ code, signal }))),
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 25_000)),
  ]);
  assert.deepEqual(exit, { code: 1, signal: null }, "an unexpected backend exit cannot be reported as a clean shutdown");
  await app.browser.close();
}

try {
  await access(executable);
  await new Promise((resolve, reject) => {
    modelServer.once("error", reject);
    modelServer.listen(0, "127.0.0.1", resolve);
  });
  const modelAddress = modelServer.address();
  assert.ok(modelAddress && typeof modelAddress !== "string");
  const modelBaseUrl = `http://127.0.0.1:${modelAddress.port}/v1`;
  await mkdir(path.join(repositoryPath, "src", "pkg"), { recursive: true });
  await mkdir(path.join(repositoryPath, "internal", "value"), { recursive: true });
  await mkdir(path.join(repositoryPath, "cmd", "demo"), { recursive: true });
  await writeFile(path.join(repositoryPath, "src", "main.py"), "from pkg.core import answer\nprint(answer)\n", "utf8");
  await writeFile(path.join(repositoryPath, "src", "pkg", "__init__.py"), "", "utf8");
  await writeFile(path.join(repositoryPath, "src", "pkg", "core.py"), "answer = 42\n", "utf8");
  await writeFile(path.join(repositoryPath, "go.mod"), "module example.com/repolens-smoke\n\ngo 1.23\n", "utf8");
  await writeFile(path.join(repositoryPath, "cmd", "demo", "main.go"), 'package main\nimport "example.com/repolens-smoke/internal/value"\nfunc main() { _ = value.Answer }\n', "utf8");
  await writeFile(path.join(repositoryPath, "internal", "value", "value.go"), 'package value\nconst Answer = "ok"\n', "utf8");

  const first = await launch();
  await assertSingleInstance(first);
  await first.page.locator(".graph-file-card").first().waitFor({ state: "visible" });
  await first.page.locator("#repository-path").fill(repositoryPath);
  await first.page.getByRole("button", { name: "打开仓库", exact: true }).click();
  await first.page.getByRole("treeitem", { name: "main.py" }).waitFor({ state: "visible", timeout: 20_000 });
  await first.page.getByRole("treeitem", { name: "main.py" }).click();
  await first.page.getByRole("tab", { name: "讲解", exact: true }).click();
  const currentSnapshot = await first.page.evaluate(async () => {
    const runtime = window.__REPOLENS_RUNTIME__;
    const workspace = await fetch(`${runtime?.apiOrigin}/api/workspace?repositoryId=taskflow-sample`).then((response) => response.json());
    return { runtime, workspace };
  });
  assert.ok(currentSnapshot.runtime?.apiOrigin, "renderer receives its per-launch API origin");
  const opened = await first.page.evaluate(async () => {
    const origin = window.__REPOLENS_RUNTIME__?.apiOrigin;
    const response = await fetch(`${origin}/api/workspace?repositoryId=taskflow-sample`);
    return response.json();
  });
  assert.ok(opened.recentRepositories.some((item) => item.name === "polyglot-demo"));
  const recentEntry = opened.recentRepositories.find((item) => item.name === "polyglot-demo");
  assert.ok(recentEntry?.id);
  const demoSnapshot = await first.page.evaluate(async ({ origin, repositoryId }) => fetch(`${origin}/api/snapshot?repositoryId=${encodeURIComponent(repositoryId)}`).then((response) => response.json()), { origin: currentSnapshot.runtime.apiOrigin, repositoryId: recentEntry.id });
  const pythonEntry = demoSnapshot.files.find((file) => file.id === "src/main.py");
  assert.ok(pythonEntry?.contentHash);
  assert.equal(modelRequests.length, 0, "opening and browsing never call the configured model");
  await first.page.getByLabel("兼容服务地址").fill(modelBaseUrl);
  await first.page.getByLabel("模型名称").fill("desktop-smoke-model");
  const testApiKey = "desktop-smoke-only-secret";
  await first.page.getByLabel("API 密钥").fill(testApiKey);
  await first.page.getByRole("button", { name: "保存本地配置" }).click();
  await first.page.getByText("模型配置已保存在本地服务内存中。", { exact: true }).waitFor({ state: "visible" });

  await first.page.getByRole("button", { name: "生成当前文件讲解" }).click();
  const explanationConsent = first.page.locator(".ai-consent");
  await explanationConsent.getByText("src/main.py", { exact: false }).waitFor({ state: "visible" });
  assert.equal(modelRequests.length, 0, "the explanation preview requires confirmation before a model call");
  await explanationConsent.getByRole("button", { name: "确认发送并生成" }).click();
  await first.page.getByText("桌面模拟讲解", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
  assert.equal(modelRequests.length, 1);
  assert.equal(modelRequests[0].mode, "explanation");
  assert.equal(modelRequests[0].entryFileId, "src/main.py");
  await first.page.locator(".ai-result [aria-label='AI 源码引用'] .reference-row").first().click();
  await first.page.getByRole("tab", { name: "源码", exact: true }).click();
  await first.page.locator("#source-line-1.is-focused").waitFor({ state: "visible" });

  await first.page.getByRole("tab", { name: "讲解", exact: true }).click();
  await first.page.getByRole("button", { name: "生成当前文件讲解" }).click();
  await first.page.locator(".ai-consent").getByRole("button", { name: "确认发送并生成" }).click();
  await first.page.waitForFunction(() => {
    const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "生成当前文件讲解");
    return button && !button.disabled;
  }, null, { timeout: 20_000 });
  assert.equal(modelRequests.length, 1, "a newly confirmed preview reuses the cached explanation for the same source context");

  await first.page.getByRole("button", { name: "生成阅读路线" }).click();
  const routeConsent = first.page.locator(".ai-consent");
  await routeConsent.getByText("src/main.py", { exact: false }).waitFor({ state: "visible" });
  assert.equal(modelRequests.length, 1, "route preview is also zero-call until confirmation");
  await routeConsent.getByRole("button", { name: "确认发送并生成" }).click();
  await first.page.getByRole("button", { name: "第 1 步：main.py" }).waitFor({ state: "visible", timeout: 20_000 });
  assert.equal(modelRequests.length, 2);
  assert.equal(modelRequests[1].mode, "route");
  assert.equal(modelRequests[1].entryFileId, "src/main.py");
  await first.page.getByRole("button", { name: "下一步", exact: true }).click();
  await first.page.getByRole("button", { name: "下一步", exact: true }).click();
  await first.page.getByRole("button", { name: "完成导览" }).click();
  await first.page.getByRole("button", { name: "导览已完成" }).waitFor({ state: "visible" });

  await first.page.getByRole("tab", { name: "问答", exact: true }).click();
  const firstQuestion = "main.py 如何得到并打印 answer？";
  await first.page.locator("#repository-question").fill(firstQuestion);
  await first.page.getByRole("button", { name: "预览发送范围" }).click();
  const firstQuestionConsent = first.page.getByRole("region", { name: "问答发送确认" });
  await firstQuestionConsent.getByText("携带历史 0 条", { exact: false }).waitFor({ state: "visible", timeout: 20_000 });
  assert.equal(modelRequests.length, 2, "question preview does not call the model");
  await firstQuestionConsent.getByRole("button", { name: "确认发送并获取引用回答" }).click();
  await first.page.getByText("src/main.py 从 pkg.core 导入 answer", { exact: false }).waitFor({ state: "visible", timeout: 20_000 });
  assert.equal(modelRequests.length, 3);

  const followUp = "answer 的值在哪里定义？";
  await first.page.locator("#repository-question").fill(followUp);
  await first.page.getByRole("button", { name: "预览发送范围" }).click();
  const followUpConsent = first.page.getByRole("region", { name: "问答发送确认" });
  await followUpConsent.getByText("携带历史 2 条", { exact: false }).waitFor({ state: "visible", timeout: 20_000 });
  assert.equal(modelRequests.length, 3, "follow-up preview does not call the model");
  await followUpConsent.getByRole("button", { name: "确认发送并获取引用回答" }).click();
  await first.page.waitForFunction(() => document.querySelectorAll(".question-message").length >= 4, null, { timeout: 20_000 });
  assert.equal(modelRequests.length, 4);
  assert.deepEqual(modelRequests.map((request) => request.mode), ["explanation", "route", "question", "question"]);
  await first.page.locator(".question-message.is-assistant .question-references button").first().click();
  await first.page.getByRole("tab", { name: "源码", exact: true }).click();
  await first.page.locator("#source-line-1.is-focused").waitFor({ state: "visible" });

  const mainNode = first.page.locator('.react-flow__node[data-id="src/main.py"]');
  await mainNode.waitFor({ state: "visible" });
  const nodeBox = await mainNode.boundingBox();
  assert.ok(nodeBox && nodeBox.width > 0 && nodeBox.height > 0, "the selected repository entry is represented in the dependency graph");
  await first.page.mouse.move(nodeBox.x + nodeBox.width / 2, nodeBox.y + nodeBox.height / 2);
  await first.page.mouse.down();
  await first.page.mouse.move(nodeBox.x + nodeBox.width / 2 + 96, nodeBox.y + nodeBox.height / 2 + 52, { steps: 5 });
  await first.page.mouse.up();
  const persistedRecords = await waitForWorkspace(first, recentEntry.id, (state) => state.aiResults?.["src/main.py"]?.role === "桌面模拟讲解"
    && state.aiRoute?.steps?.length === 3
    && state.conversations?.[0]?.messages?.length === 4
    && Object.keys(state.nodePositions ?? {}).includes("src/main.py"), "讲解、路线、两轮问答、完成进度和拖动位置");
  assert.equal(persistedRecords.aiResults["src/main.py"].keyPoints[0].includes("answer"), true);
  assert.equal(persistedRecords.aiRoute.entryFileId, "src/main.py");
  assert.equal(persistedRecords.conversations[0].messages.length, 4);
  assert.ok(persistedRecords.conversations[0].messages.filter((message) => message.role === "assistant").every((message) => message.references.some((reference) => reference.fileId === "src/main.py")), "question answers cite the relevant Python entry file");
  assert.ok(Object.keys(persistedRecords.progress).length > 0, "tour progress persists through the real interface");
  const expectedNodePosition = persistedRecords.nodePositions["src/main.py"];
  assert.ok(Number.isFinite(expectedNodePosition?.x) && Number.isFinite(expectedNodePosition?.y), "the dragged node has a persisted coordinate pair");

  await first.page.getByRole("button", { name: "返回示例", exact: true }).click();
  const sampleNode = first.page.locator('.react-flow__node[data-id="src/main.tsx"]');
  await sampleNode.waitFor({ state: "visible", timeout: 20_000 });
  const sampleBefore = await sampleNode.evaluate((node) => node.getAttribute("style") ?? "");
  const sampleBox = await sampleNode.boundingBox();
  assert.ok(sampleBox && sampleBox.width > 0 && sampleBox.height > 0, "sample graph node is measured after returning from a local repository");
  await first.page.mouse.move(sampleBox.x + sampleBox.width / 2, sampleBox.y + sampleBox.height / 2);
  await first.page.mouse.down();
  await first.page.mouse.move(sampleBox.x + sampleBox.width / 2 + 88, sampleBox.y + sampleBox.height / 2 + 46, { steps: 6 });
  await first.page.mouse.up();
  await first.page.waitForFunction((previous) => {
    const node = document.querySelector('.react-flow__node[data-id="src/main.tsx"]');
    return node && (node.getAttribute("style") ?? "") !== previous;
  }, sampleBefore, { timeout: 5_000 });
  const sampleWorkspace = await waitForWorkspace(first, "taskflow-sample", (state) => Number.isFinite(state.nodePositions?.["src/main.tsx"]?.x)
    && Number.isFinite(state.nodePositions?.["src/main.tsx"]?.y), "保存返回示例后拖动的节点坐标");
  const expectedSamplePosition = sampleWorkspace.nodePositions["src/main.tsx"];
  assert.ok(Number.isFinite(expectedSamplePosition.x) && Number.isFinite(expectedSamplePosition.y));
  await quit(first);

  const stateText = await readFile(path.join(userDataPath, "workspace-v1.json"), "utf8");
  const diskState = JSON.parse(stateText);
  const diskWorkspaceId = recentEntry.workspaceId ?? recentEntry.id;
  assert.deepEqual(diskState.nodePositions?.[diskWorkspaceId]?.["src/main.py"], expectedNodePosition, "the first desktop session flushes the dragged coordinate before shutdown");
  assert.match(stateText, /polyglot-demo/);
  assert.match(stateText, /桌面模拟讲解/);
  assert.match(stateText, /main\.py 如何得到并打印 answer/);
  assert.doesNotMatch(stateText, new RegExp(testApiKey));
  assert.doesNotMatch(stateText, /apiKey|sourceText|rawSource/);
  assert.doesNotMatch(stateText, /from pkg\.core import answer/);

  await writeFile(path.join(repositoryPath, "src", "main.py"), "from pkg.core import answer\nprint('changed:', answer)\n", "utf8");
  await rm(path.join(repositoryPath, "src", "pkg", "core.py"));

  const second = await launch();
  const restored = await second.page.evaluate(async () => {
    const origin = window.__REPOLENS_RUNTIME__?.apiOrigin;
    return fetch(`${origin}/api/workspace?repositoryId=taskflow-sample`).then((response) => response.json());
  });
  const savedBeforeReopen = await workspaceFor(second, recentEntry.id);
  assert.deepEqual(savedBeforeReopen.nodePositions?.["src/main.py"], expectedNodePosition, "the second service reads the saved coordinate before reopening the repository");
  assert.ok(restored.recentRepositories.some((item) => item.id === recentEntry.id), "recent repositories survive a full desktop restart");
  const restoredSampleWorkspace = await workspaceFor(second, "taskflow-sample");
  assert.deepEqual(restoredSampleWorkspace.nodePositions?.["src/main.tsx"], expectedSamplePosition,
    "sample coordinates saved after returning from a local repository survive a full desktop restart");
  await second.page.waitForFunction((expected) => {
    const node = document.querySelector('.react-flow__node[data-id="src/main.tsx"]');
    const match = (node?.getAttribute("style") ?? "").match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
    return match && Math.abs(Number(match[1]) - expected.x) < 0.5 && Math.abs(Number(match[2]) - expected.y) < 0.5;
  }, expectedSamplePosition, { timeout: 10_000 });
  await second.page.locator(".recent-repository-open").filter({ hasText: "polyglot-demo" }).click();
  await second.page.getByRole("treeitem", { name: "main.py" }).waitFor({ state: "visible", timeout: 20_000 });
  const reopenedIdentity = await second.page.evaluate(async (repositoryId) => {
    const origin = window.__REPOLENS_RUNTIME__?.apiOrigin;
    const snapshot = await fetch(`${origin}/api/snapshot?repositoryId=${encodeURIComponent(repositoryId)}`).then((response) => response.json());
    const saved = await fetch(`${origin}/api/workspace?repositoryId=${encodeURIComponent(repositoryId)}`).then((response) => response.json());
    return { id: snapshot.id, workspaceId: snapshot.workspaceId, persistenceSessionId: snapshot.persistenceSessionId, positions: saved.nodePositions };
  }, recentEntry.id);
  assert.equal(reopenedIdentity.workspaceId, diskWorkspaceId, `reopening a local repository preserves its workspace identity: ${JSON.stringify(reopenedIdentity)}`);
  assert.deepEqual(reopenedIdentity.positions?.["src/main.py"], expectedNodePosition, "opening a local repository does not switch the workspace position record");
  await second.page.getByRole("treeitem", { name: "main.py" }).click();
  const restoredNode = second.page.locator('.react-flow__node[data-id="src/main.py"]');
  await restoredNode.waitFor({ state: "visible" });
  await second.page.waitForFunction((expected) => {
    const node = document.querySelector('.react-flow__node[data-id="src/main.py"]');
    const match = (node?.getAttribute("style") ?? "").match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
    return match && Math.abs(Number(match[1]) - expected.x) < 0.5 && Math.abs(Number(match[2]) - expected.y) < 0.5;
  }, expectedNodePosition, { timeout: 10_000 });
  const renderedPosition = await restoredNode.evaluate((node) => {
    const match = (node.getAttribute("style") ?? "").match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
    return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
  });
  assert.ok(renderedPosition && Math.abs(renderedPosition.x - expectedNodePosition.x) < 0.5 && Math.abs(renderedPosition.y - expectedNodePosition.y) < 0.5,
    `the node itself renders at the persisted coordinate after reopening: ${JSON.stringify({ renderedPosition, expectedNodePosition })}`);
  // The product intentionally debounces coordinate writes for 450ms; cross that real save window before reading state.
  await second.page.waitForTimeout(600);
  const restoredPositions = await waitForWorkspace(second, recentEntry.id, (state) => Object.hasOwn(state.nodePositions ?? {}, "src/main.py"), "the restored graph coordinate remains saved");
  assert.deepEqual(restoredPositions.nodePositions["src/main.py"], expectedNodePosition, "reopening a workspace must not overwrite its restored graph coordinate with an empty or newly laid-out position");
  assert.ok(second.nodePositionWrites.every((positions) => positions["src/main.py"] && positions["src/main.py"].x === expectedNodePosition.x && positions["src/main.py"].y === expectedNodePosition.y),
    `automatic saves after restoration must preserve the saved coordinate: ${JSON.stringify(second.nodePositionWrites)}`);
  const restoredRepository = await second.page.evaluate(async (repositoryId) => {
    const origin = window.__REPOLENS_RUNTIME__?.apiOrigin;
    return fetch(`${origin}/api/snapshot?repositoryId=${encodeURIComponent(repositoryId)}`).then((response) => response.json());
  }, recentEntry.id);
  assert.ok(restoredRepository.files.some((file) => file.kind === "python" && file.id === "src/main.py"));
  assert.ok(restoredRepository.files.some((file) => file.kind === "go" && file.id === "cmd/demo/main.go"));
  assert.ok(restoredRepository.dependencies.some((edge) => edge.fromId === "cmd/demo/main.go" && edge.toId === "internal/value/value.go"));
  await second.page.getByRole("treeitem", { name: "main.py" }).click();
  await second.page.getByRole("tab", { name: "讲解", exact: true }).click();
  await second.page.getByText("引用关联源码已变化，当前结果已过期，不能跳转。", { exact: true }).waitFor({ state: "visible" });
  await assertDisabled(second.page.locator(".ai-result [aria-label='AI 源码引用'] .reference-row").first(), "expired explanation references cannot navigate");
  await assertDisabled(second.page.getByRole("button", { name: "第 1 步：main.py" }), "expired route steps cannot navigate");
  await second.page.getByRole("tab", { name: "问答", exact: true }).click();
  await second.page.locator(".question-message.is-stale").first().waitFor({ state: "visible" });
  await assertDisabled(second.page.locator(".question-message.is-stale .question-references button").first(), "expired question references cannot navigate");
  await second.page.getByRole("button", { name: "导览已完成" }).waitFor({ state: "visible" });

  await second.page.getByRole("button", { name: "重置布局" }).click();
  await waitForWorkspace(second, recentEntry.id, (state) => !Object.keys(state.nodePositions ?? {}).length, "explicit reset clears saved graph coordinates");

  await second.page.getByRole("button", { name: "清除此仓库的保存数据" }).click();
  await second.page.getByText("已清除此仓库的本地保存结果、路线、进度和节点位置。", { exact: true }).waitFor({ state: "visible" });
  const clearedRepository = await waitForWorkspace(second, recentEntry.id, (state) => !state.recentRepositories.some((item) => item.id === recentEntry.id)
    && !state.aiResults?.["src/main.py"] && !state.aiRoute && !state.conversations?.length
    && !Object.keys(state.nodePositions ?? {}).length && !Object.keys(state.progress ?? {}).length, "删除此仓库的保存记录");
  assert.ok(clearedRepository);
  await second.page.getByRole("button", { name: "清除全部本地保存数据" }).click();
  await second.page.getByText("已清除全部 RepoLens 本地保存数据。", { exact: true }).waitFor({ state: "visible" });
  const clearedAll = await second.page.evaluate(async () => fetch(`${window.__REPOLENS_RUNTIME__?.apiOrigin}/api/workspace?repositoryId=taskflow-sample`).then((response) => response.json()));
  assert.equal(clearedAll.recentRepositories.length, 0);
  assert.equal(Object.keys(clearedAll.aiResults).length, 0);
  assert.equal(clearedAll.aiRoute, null);
  assert.equal(clearedAll.conversations.length, 0);
  assert.equal(Object.keys(clearedAll.nodePositions).length, 0);
  assert.equal(Object.keys(clearedAll.progress).length, 0, "clear-all does not immediately recreate progress for the active repository");
  await quit(second);

  await mkdir(userDataPath, { recursive: true });
  await writeFile(path.join(userDataPath, "workspace-v1.json"), "{", "utf8");
  const missingGit = path.join(temporaryRoot, "missing-git.exe");
  const third = await launch({ gitExecutable: missingGit });
  await third.page.getByText("桌面保存数据读取失败", { exact: false }).waitFor({ state: "visible", timeout: 20_000 });
  const quarantined = await readdir(userDataPath);
  assert.ok(quarantined.some((name) => name.startsWith("workspace-v1.json.corrupt-")), "damaged workspace data is quarantined for recovery");
  await third.page.locator("#repository-path").fill(repositoryPath);
  await third.page.getByRole("button", { name: "打开仓库", exact: true }).click();
  await third.page.getByRole("treeitem", { name: "main.py" }).waitFor({ state: "visible", timeout: 20_000 });
  await third.page.getByRole("treeitem", { name: "main.py" }).click();
  await third.page.getByRole("tab", { name: "源码", exact: true }).click();
  await third.page.getByText("changed:", { exact: false }).waitFor({ state: "visible" });
  await third.page.locator("#repository-path").fill("https://github.com/sindresorhus/is");
  await third.page.getByRole("button", { name: "打开仓库", exact: true }).click();
  try {
    await third.page.getByText("无法启动本机 Git。请确认 Git 已安装并可从命令行使用。", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
  } catch {
    throw new Error(`缺少 Git 时未显示预期指引。当前页面：\n${(await third.page.locator("body").innerText()).slice(-4000)}\n服务输出：\n${children.at(-1)?.output.join("") || "(empty)"}`);
  }
  await third.page.getByRole("treeitem", { name: "main.py" }).waitFor({ state: "visible" });
  await quit(third);
  const fourth = await launch();
  await fourth.page.locator("#repository-path").fill(repositoryPath);
  await fourth.page.getByRole("button", { name: "打开仓库", exact: true }).click();
  await fourth.page.getByRole("treeitem", { name: "main.py" }).waitFor({ state: "visible", timeout: 20_000 });
  await crashBackendAndAssertFailure(fourth);
  process.stdout.write("Desktop smoke passed: single-instance launch; backend crash notification and failure exit; real UI AI previews, cached explanation, route and two-turn cited Q&A; persistence and stale-reference checks across restart; Python/Go indexing; damaged-store recovery; missing-Git guidance; data clearing; graceful exit.\n");
} finally {
  for (const record of children) {
    if (record.child.exitCode !== null) continue;
    try { await record.page?.evaluate(() => window.repoLens?.quit()); } catch {}
    await Promise.race([new Promise((resolve) => record.child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 25_000))]);
    if (record.child.exitCode === null) record.child.kill();
    await record.browser?.close().catch(() => {});
  }
  if (modelServer.listening) await new Promise((resolve) => modelServer.close(resolve));
  let cleanupError = null;
  try { await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }); }
  catch (error) { cleanupError = error; }
  try { await access(temporaryRoot); cleanupError ??= new Error("isolated desktop smoke directory still exists after cleanup"); }
  catch (error) { if (error.code !== "ENOENT") cleanupError ??= error; }
  if (cleanupError) {
    process.stderr.write(`Desktop smoke cleanup failed: ${cleanupError.message}\n`);
    process.exitCode = 1;
  }
}
