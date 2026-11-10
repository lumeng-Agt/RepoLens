import { stopLocalService } from "./stop-local-service.mjs";
import { AI_PROMPT_VERSION } from "../data/ai-generation.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { watch } from "node:fs";
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

const startupEvents = [{ stage: "script-start", at: Date.now() }];
async function waitForHealth(url, child) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error("RepoLens local service exited before becoming ready.");
    try { if ((await fetch(url + "/api/health")).ok) { startupEvents.push({ stage: "backend-ready", at: Date.now() }); return; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("RepoLens local service did not become ready.");
}

async function openRepositoryHome(page) {
  const heading = page.getByRole("heading", { name: "打开仓库，开始阅读" });
  if (!await heading.isVisible().catch(() => false)) {
    const menu = page.locator(".repo-menu");
    const isOpen = await menu.evaluate((element) => element.open);
    if (!isOpen) await menu.locator("summary").click();
    await menu.getByRole("button", { name: "返回首页", exact: true }).click();
  }
  await heading.waitFor({ state: "visible", timeout: 30_000 });
}
async function openSample(page) {
  const menu = page.locator(".repo-menu");
  const isOpen = await menu.evaluate((element) => element.open);
  if (!isOpen) await menu.locator("summary").click();
  await menu.getByRole("button", { name: "打开示例", exact: true }).click();
}
async function setDisclosureOpen(page, selector, open) {
  const disclosure = page.locator(selector);
  const isOpen = await disclosure.evaluate((element) => element.open);
  if (isOpen !== open) await disclosure.locator(":scope > summary").click();
  await page.waitForFunction(({ selector, open }) => document.querySelector(selector)?.open === open, { selector, open });
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
let uiServer;
let shutdown;
let applicationOutput = "";
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
      return { title: "从入口理解数据流", steps: files.map((fileId, index) => ({ fileId, purpose: purposes[fileId] ?? `阅读依赖 ${index + 1}`, relationship: index === 0 ? "选定入口" : "沿静态依赖继续阅读", question: `第 ${index + 1} 步需要确认什么？`, references: [{ fileId, startLine: Number(sourceRange(fileId)?.[2] ?? 1), endLine: Number(sourceRange(fileId)?.[3] ?? sourceRange(fileId)?.[2] ?? 1) }] })) };
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
  const renderer = path.join(projectRoot, 'desktop', 'renderer');
  await access(path.join(renderer, 'index.html')).catch(() => { throw new Error('请先运行 npm run build:desktop，再运行真实服务联动。'); });
  // The full browser suite and startup matrix exercise Vite separately. This
  // integration uses the built UI with a real isolated backend and Git mirror.
  uiServer = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, uiOrigin).pathname);
      const file = path.resolve(renderer, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(renderer + path.sep)) { response.writeHead(403).end(); return; }
      let content = await readFile(file);
      if (file.endsWith('.html')) content = Buffer.from(content.toString().replace('</head>', `<script>globalThis.__REPOLENS_RUNTIME__=${JSON.stringify({ desktop: false, apiOrigin })}</script></head>`));
      const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml' };
      response.setHeader('Content-Type', types[path.extname(file)] ?? 'application/octet-stream');
      response.setHeader('Cache-Control', 'no-store');
      response.end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve, reject) => uiServer.listen(uiPort, '127.0.0.1', resolve).once('error', reject));
  startupEvents.push({ stage: 'ui-listening', at: Date.now(), renderer: 'desktop-build' });
  application = spawn(process.execPath, [path.join(projectRoot, 'scripts/local-server.mjs')], {
    cwd: projectRoot,
    env: {
      ...process.env,
      REPOLENS_PORT: String(apiPort), REPOLENS_UI_PORT: String(uiPort), REPOLENS_TEMP_ROOT: tempWorkspaces, REPOLENS_USER_DATA_PATH: path.join(temporaryRoot, "user-data"),
      VITE_REPOLENS_API_ORIGIN: apiOrigin,
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
    stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
  });
  const captureOutput = chunk => { applicationOutput = (applicationOutput + chunk.toString()).slice(-100000); };
  application.stdout.on("data", captureOutput); application.stderr.on("data", captureOutput);
  await waitForHealth(apiOrigin, application);
  browser = await chromium.launch({ headless: true });
  browserContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ...(demoEvidenceDirectory ? { recordVideo: { dir: demoEvidenceDirectory, size: { width: 1440, height: 900 } } } : {}),
  });
  page = await browserContext.newPage();
  await page.addInitScript(() => localStorage.setItem("repolens:usage-guide:v1", JSON.stringify({ version: 1, welcomeHandled: true, completedTaskIds: [], checklistOpen: false, noticeDismissed: true })));
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.__chatGenerationResults = {};
    window.fetch = async (input, init) => {
      const response = await original(input, init);
      if (String(input).endsWith('/api/ai/generate') && typeof init?.body === 'string') {
        const id = JSON.parse(init.body).previewId;
        void response.clone().text().then(text => {
          if (response.headers.get('content-type')?.includes('text/event-stream')) {
            const events = text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)));
            window.__chatGenerationResults[id] = events.find(event => event.type === 'complete')?.result ?? { error: events.find(event => event.type === 'error')?.error ?? 'missing complete event' };
          } else window.__chatGenerationResults[id] = JSON.parse(text);
        }).catch(() => {});
      }
      return response;
    };
  });
  const pageErrors = [];
  page.on("pageerror", (error) => { pageErrors.push(error.message); process.stderr.write(`Browser page error: ${error.message}\n`); });
  page.on("console", (message) => { if (message.type() === "error") { pageErrors.push(`console: ${message.text()}`); process.stderr.write(`Browser console error: ${message.text()}\n`); } });
  page.setDefaultTimeout(15_000);

  await page.goto(uiOrigin, { waitUntil: "domcontentloaded" });
  await page.locator('[data-app-ready="true"]:visible').waitFor({ state: "visible", timeout: 15_000 });
  await openRepositoryHome(page);
  await page.getByLabel("本地路径或 GitHub 仓库链接").fill("https://github.com/repolens-test/ai-fixture/tree/main/src");
  const openedResponse = page.waitForResponse((response) => response.url() === apiOrigin + "/api/open");
  await page.getByRole("button", { name: "打开仓库" }).click();
  assert.equal((await openedResponse).status(), 200);
  const initialSnapshot = await (await openedResponse).json();
  await page.getByText("GitHub 远端", { exact: true }).waitFor({ state: "visible" });
  await page.getByRole("treeitem", { name: "summary.ts" }).click();
  const composer = page.locator('.copilot-composer');
  const generateEndpoint = `${apiOrigin}/api/ai/generate`;
  const prepareTask = async name => {
    const pending = page.waitForResponse(response => response.url() === apiOrigin + '/api/ai/preview' && response.request().method() === 'POST');
    await page.getByRole('button', { name, exact: true }).click();
    const response = await pending;
    assert.equal(response.status(), 200);
    const value = await response.json();
    assert.equal(value.scopeRequired, false, JSON.stringify(value));
    await composer.getByRole('button', { name: '发送', exact: true }).waitFor({ state: 'visible' });
    return value.preview;
  };
  const sendTask = async () => {
    const pending = page.waitForResponse(response => response.url() === generateEndpoint);
    await composer.getByRole('button', { name: '发送', exact: true }).click();
    const response = await pending;
    assert.equal(response.status(), 200);
    const id = response.request().postDataJSON().previewId;
    const handle = await page.waitForFunction(id => window.__chatGenerationResults[id], id);
    const value = await handle.jsonValue(); await handle.dispose();
    assert.equal(value.error, undefined, JSON.stringify(value));
    await composer.getByRole('button', { name: '停止', exact: true }).waitFor({ state: 'hidden' });
    return value;
  };
  const explanationScope = await prepareTask('生成当前文件讲解');
  assert.ok(explanationScope.files.some(file => file.fileId === 'src/summary.ts'));
  assert.ok(explanationScope.files.some(file => file.fileId === 'src/status.ts'));
  assert.equal(modelCalls, 0, 'preparing the visible scope must not call the model');
  const firstExplanation = await sendTask();
  assert.ok(firstExplanation.result.references.some(reference => reference.fileId === 'src/summary.ts'));
  assert.equal(modelCalls, 1);
  assert.ok(modelRequestBodies[0].messages.some(message => message.content.includes('FILE src/summary.ts LINES 1-')));
  const explanationTask = modelRequestBodies[0].messages.find(message => message.role === 'user').content.match(/^任务信息：(.+)$/m);
  assert.deepEqual(JSON.parse(explanationTask[1]), { promptVersion: AI_PROMPT_VERSION, mode: 'explanation', entryFileId: 'src/summary.ts' });
  await page.locator('.question-message.is-assistant [aria-label="回答引用"] button').first().click();
  await page.getByRole('complementary', { name: '回答证据' }).getByRole('button', { name: '在源码中打开' }).click();
  await page.getByRole('tab', { name: '源码', exact: true }).click();
  await page.locator('#source-line-1.is-focused').waitFor({ state: 'visible' });
  if (demoEvidenceDirectory) await page.screenshot({ path: path.join(demoEvidenceDirectory, 'mock-ai-source-reference.png') });
  await page.getByRole('tab', { name: '讲解', exact: true }).click();
  await prepareTask('生成当前文件讲解');
  assert.equal(modelCalls, 1);
  const cached = await sendTask();
  assert.equal(cached.cached, true, JSON.stringify(cached));
  assert.equal(modelCalls, 1, 'cached explanation does not call the model again');

  await page.getByRole('treeitem', { name: 'index.ts', exact: true }).click();
  const routeScope = await prepareTask('生成阅读路线');
  for (const file of Object.keys(fixtureSources)) assert.ok(routeScope.files.some(item => item.fileId === file), `route scope includes ${file}`);
  assert.equal(modelCalls, 1);
  const route = await sendTask();
  assert.equal(route.result.steps[0].fileId, 'src/index.ts');
  const routeTask = modelRequestBodies[1].messages.find(message => message.role === 'user').content.match(/^任务信息：(.+)$/m);
  assert.deepEqual(JSON.parse(routeTask[1]), { promptVersion: AI_PROMPT_VERSION, mode: 'route', entryFileId: 'src/index.ts' });
  await page.locator('.chat-result-card').last().getByRole('button', { name: '开始阅读', exact: true }).click();
  await setDisclosureOpen(page, '.tour-step-disclosure', true);
  await page.getByRole('button', { name: '第 1 步：src/index.ts' }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: '第 2 步：src/summary.ts' }).click();
  await setDisclosureOpen(page, '.tour-step-description', true);
  assert.match(await page.locator('.tour-step-description > div').innerText(), /阅读摘要组织/);
  assert.equal(modelCalls, 2);
  if (demoEvidenceDirectory) await page.screenshot({ path: path.join(demoEvidenceDirectory, 'mock-ai-reading-route.png') });

  await page.getByRole('tab', { name: '讲解', exact: true }).click();
  await prepareTask('生成当前文件讲解');
  await removeMarkers('read-arm', 'read-entered-ui-cancel', 'read-finished-ui-cancel', 'read-release', 'response-closed-ui-cancel', 'request-handled-ui-cancel');
  await page.route(generateEndpoint, async route => route.continue({ headers: { ...route.request().headers(), 'x-repolens-test-id': 'ui-cancel' } }));
  await writeFile(path.join(aiGateDirectory, 'read-arm'), 'hold\n');
  await composer.getByRole('button', { name: '发送', exact: true }).click();
  await waitForMarker(path.join(aiGateDirectory, 'read-entered-ui-cancel'));
  await page.getByRole('treeitem', { name: 'status.ts', exact: true }).click();
  assert.equal(modelCalls, 2, 'the controlled source verification is still pending');
  assert.equal(await access(path.join(aiGateDirectory, 'response-closed-ui-cancel')).then(() => true, () => false), false, 'source navigation must not cancel an already sent task');
  await composer.getByRole('button', { name: '停止', exact: true }).click();
  await waitForMarker(path.join(aiGateDirectory, 'response-closed-ui-cancel'));
  await writeFile(path.join(aiGateDirectory, 'read-release'), 'release\n');
  await Promise.all([waitForMarker(path.join(aiGateDirectory, 'read-finished-ui-cancel')), waitForMarker(path.join(aiGateDirectory, 'request-handled-ui-cancel'))]);
  assert.equal(modelCalls, 2, 'explicit stop prevents the pending source from reaching the model');
  await page.unroute(generateEndpoint);

  const statusScope = await prepareTask('生成当前文件讲解');
  assert.equal(statusScope.entryFileId, 'src/status.ts');
  await sendTask();
  assert.equal(modelCalls, 3);
  assert.ok(modelRequestBodies[2].messages.some(message => message.content.includes('FILE src/status.ts LINES 1-')));
  const statusTask = modelRequestBodies[2].messages.find(message => message.role === 'user').content.match(/^任务信息：(.+)$/m);
  assert.equal(JSON.parse(statusTask[1]).entryFileId, 'src/status.ts');

  await setDisclosureOpen(page, ".repo-menu", true);
  const repositoryResponse = page.waitForResponse((response) => response.url() === apiOrigin + "/api/rescan");
  await page.getByRole("button", { name: "检查远端更新" }).first().click();
  const unchangedSnapshot = await repositoryResponse;
  assert.equal(unchangedSnapshot.status(), 200);
  const unchangedValue = await unchangedSnapshot.json();
  assert.equal(unchangedValue.revision, initialSnapshot.revision);
  assert.equal(unchangedValue.sequence, initialSnapshot.sequence);
  assert.match(await page.locator(".workspace-context-label").innerText(), /refs\/heads\/main/);
  await setDisclosureOpen(page, ".overview-disclosure", true);
  await page.getByText(`commit · ${initialSnapshot.origin.commit}`).waitFor({ state: "visible" });
  await setDisclosureOpen(page, ".overview-disclosure", false);
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
  await setDisclosureOpen(page, ".repo-menu", true);
  const updatedResponsePromise = page.waitForResponse((response) => response.url() === apiOrigin + "/api/rescan");
  await page.getByRole("button", { name: "检查远端更新" }).first().click();
  const updatedResponse = await updatedResponsePromise;
  assert.equal(updatedResponse.status(), 200);
  const updatedSnapshot = await updatedResponse.json();
  assert.notEqual(updatedSnapshot.revision, unchangedValue.revision);
  assert.equal(updatedSnapshot.sequence, unchangedValue.sequence + 1);
  await page.getByRole("treeitem", { name: "index.ts" }).click();
  await page.getByRole("tab", { name: "讲解", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('button[aria-label="第 1 步：src/index.ts"]')?.disabled === true);
  assert.equal(await page.getByRole("button", { name: "第 1 步：src/index.ts" }).isDisabled(), true);
  await setDisclosureOpen(page, ".tour-step-description", true);
  assert.match(await page.locator(".tour-step-description > div").innerText(), /阅读摘要组织/);
  await page.getByRole("tab", { name: "源码", exact: true }).click();
  await page.locator(".source-code").waitFor({ state: "visible" });
  assert.match(await page.locator(".source-code").innerText(), /export const changed = true/);
  assert.deepEqual(pageErrors, []);

  const closeResponse = page.waitForResponse((response) => response.url() === apiOrigin + "/api/close");
  await openSample(page);
  assert.equal((await closeResponse).status(), 200);
  await page.getByText("示例仓库", { exact: true }).waitFor({ state: "visible" });
  const leftovers = (await readdir(tempWorkspaces)).filter((name) => name.startsWith("repolens-github-"));
  assert.deepEqual(leftovers, [], "returning to the sample removes all temporary remote files");
  process.stdout.write(JSON.stringify({ browserFlow: "passed", modelCalls, cancelledDuringVerification: true, renderer: "desktop-build", files: Object.keys(fixtureSources).length, cachedExplanation: true, revision: updatedSnapshot.sequence }) + "\n");
} catch (error) {
  const directory = path.join(projectRoot, ".artifacts", "github-browser-integration");
  await mkdir(directory, { recursive: true });
  const logPath = path.join(directory, `${Date.now()}-service.log`);
  await writeFile(logPath, `${error.stack ?? error.message}\n${JSON.stringify(startupEvents)}\n\n${applicationOutput}`, "utf8");
  process.stderr.write(`服务联动失败日志：${logPath}\n`);
  throw error;
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
  try {
    if (application) shutdown = await stopLocalService(application);
    assert.deepEqual(shutdown?.remainingPids, [], 'the integration must not leave its backend process running');
  } finally {
    uiServer?.closeAllConnections();
    if (uiServer) await new Promise(resolve => uiServer.close(resolve));
    modelServer.closeAllConnections();
    await new Promise(resolve => modelServer.close(resolve));
  }
  if (path.dirname(temporaryRoot) === path.resolve(os.tmpdir()) && path.basename(temporaryRoot).startsWith("repolens-github-browser-")) {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
