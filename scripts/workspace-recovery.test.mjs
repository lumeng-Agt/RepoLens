import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { chromium } from "@playwright/test";
import { createWorkspaceStore } from "../data/workspace-store.mjs";
import { createAiRouteRecord } from "../data/ai-route.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directories = [];
const servers = [];
const browsers = [];

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function openDesktopPage({ localTour = [] } = {}) {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "repolens-recovery-regression-"));
  directories.push(temporaryDirectory);
  const store = createWorkspaceStore(temporaryDirectory);
  await store.saveGuidePreferences({ version: 1, welcomeHandled: true, completedTaskIds: [], checklistOpen: false, noticeDismissed: true });
  const workspaceWrites = [];
  const heldProgressWrites = [];
  const heldSourceReads = [];
  const workspaceReads = [];
  const heldWorkspaceReads = [];
  const workspaceReadWaiters = [];
  let failWorkspaceReads = true;
  let workspaceReadWarning = "";
  let failWorkspaceWrites = false;
  let aiConfigured = false;
  const generationControls = [];
  let generationCalls = 0;
  const api = createHttpServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (request.method === "OPTIONS") { response.writeHead(204).end(); return; }
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/api/workspace" && request.method === "GET") {
      const repositoryId = url.searchParams.get("repositoryId");
      workspaceReads.push(repositoryId);
      for (let index = workspaceReadWaiters.length - 1; index >= 0; index -= 1) {
        const waiter = workspaceReadWaiters[index];
        if (waiter.repositoryId === repositoryId && workspaceReads.filter((id) => id === repositoryId).length >= waiter.count) {
          workspaceReadWaiters.splice(index, 1);
          waiter.resolve();
        }
      }
      if (failWorkspaceReads) {
        response.writeHead(503, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "simulated workspace read failure" }));
      } else {
        const saved = await store.getRepository(repositoryId);
        const heldIndex = heldWorkspaceReads.findIndex((item) => item.repositoryId === repositoryId);
        const held = heldIndex >= 0 ? heldWorkspaceReads.splice(heldIndex, 1)[0] : null;
        if (held) {
          held.started.resolve();
          await held.release.promise;
          held.settled.resolve();
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ...saved, ...(workspaceReadWarning ? { warning: workspaceReadWarning } : {}) }));
      }
      return;
    }
    if (url.pathname === "/api/workspace" && request.method === "POST") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      workspaceWrites.push(payload);
      const heldProgressIndex = payload.action === "progress"
        ? heldProgressWrites.findIndex((item) => JSON.parse(payload.value).stepIndex === item.stepIndex)
        : -1;
      const heldProgress = heldProgressIndex >= 0 ? heldProgressWrites.splice(heldProgressIndex, 1)[0] : null;
      if (heldProgress) {
        heldProgress.started.resolve();
        await heldProgress.release.promise;
        heldProgress.settled.resolve();
      }
      if (failWorkspaceWrites) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: false, warning: "simulated workspace write failure" }));
        return;
      }
      if (payload.action === "progress") await store.saveProgress(payload.workspaceId, payload.key, payload.value);
      if (payload.action === "node-positions") await store.saveNodePositions(payload.workspaceId, payload.positions);
      if (payload.action === "conversations") await store.saveConversations(payload.workspaceId, payload.conversations);
      if (payload.action === "reading-notes") await store.saveReadingNotes(payload.workspaceId, payload.notes);
      if (payload.action === "saved-tours") await store.saveTours(payload.workspaceId, payload.tours);
      if (payload.action === "guide-preferences") await store.saveGuidePreferences(payload.preferences);
      if (payload.action === "ai-route") await store.saveAiRoute(payload.workspaceId, payload.record);
      if (payload.action === "clear-repository") await store.clearRepository(payload.workspaceId);
      if (payload.action === "clear-all") await store.clearAll();
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === "/api/ai/settings") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ configured: aiConfigured, baseUrl: aiConfigured ? "https://model.example/v1" : "", model: aiConfigured ? "mock-model" : "" }));
      return;
    }
    if (url.pathname === "/api/ai/question/preview" && request.method === "POST") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ scopeRequired: false, preview: {
        id: `question-preview-${generationCalls + 1}`, repositoryId: "recovery-local", revision: "r1", entryFileId: "main.ts", mode: "question",
        baseUrl: "https://model.example/v1", model: "mock-model", files: [{ fileId: "main.ts", startLine: 1, endLine: 1, contentHash: "h1" }],
        characters: 24, expiresAt: Date.now() + 600_000, question: payload.question, history: [],
      } }));
      return;
    }
    if (url.pathname === "/api/ai/generate" && request.method === "POST") {
      generationCalls += 1;
      const control = generationControls.shift();
      if (!control) {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "unexpected unheld generation" }));
        return;
      }
      response.once("close", () => { if (!response.writableEnded) control.aborted.resolve(); });
      control.started.resolve();
      await control.release.promise;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ result: { answer: "迟到回答", references: [{ fileId: "main.ts", startLine: 1 }] }, cached: false, revision: "r1", repositoryId: "recovery-local", entryFileId: "main.ts", mode: "question" }));
      control.settled.resolve();
      return;
    }
    if (url.pathname === "/api/open") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        id: "recovery-local", workspaceId: "recovery-local", persistenceSessionId: "session-1", version: "1",
        name: "Recovery fixture", description: "", source: "local", revision: "r1", sequence: 1,
        files: [{ id: "main.ts", path: "main.ts", name: "main.ts", kind: "typescript", language: "ts", role: "入口", summary: "", imports: [], contentHash: "h1" }],
        dependencies: [], tour: localTour, diagnostics: [], unresolved: [],
      }));
      return;
    }
    if (url.pathname === "/api/events") { response.writeHead(204).end(); return; }
    if (url.pathname === "/api/source" && request.method === "GET") {
      const held = heldSourceReads.shift();
      if (held) {
        held.started.resolve();
        await held.release.promise;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ source: "export const value = 1;" }));
      held?.settled.resolve();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(url.pathname.endsWith("/source") ? { source: "export const value = 1;" } : { configured: false, baseUrl: "", model: "" }));
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  servers.push(api);
  const apiOrigin = `http://127.0.0.1:${api.address().port}`;
  const vite = await createViteServer({ configFile: path.join(root, "desktop.vite.config.mjs"), cacheDir: path.join(temporaryDirectory, "vite-cache"), server: { host: "127.0.0.1", port: 0, strictPort: false }, logLevel: "error" });
  await vite.listen();
  servers.push(vite);
  const browser = await chromium.launch();
  browsers.push(browser);
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem("repolens:usage-guide:v1", JSON.stringify({ version: 1, welcomeHandled: true, completedTaskIds: [], checklistOpen: false, noticeDismissed: true })));
  page.setDefaultTimeout(8000);
  page.setDefaultNavigationTimeout(12000);
  await page.addInitScript((origin) => { window.__REPOLENS_RUNTIME__ = { desktop: true, apiOrigin: origin }; }, apiOrigin);
  return {
    page, store, workspaceReads, workspaceWrites,
    setWorkspaceReadsAvailable: () => { failWorkspaceReads = false; },
    setWorkspaceReadWarning: (warning) => { failWorkspaceReads = false; workspaceReadWarning = warning; },
    setWorkspaceWritesAvailable: () => { failWorkspaceWrites = false; },
    setWorkspaceWritesUnavailable: () => { failWorkspaceWrites = true; },
    setAiConfigured: () => { aiConfigured = true; },
    holdNextGeneration: () => {
      const started = deferred(); const aborted = deferred(); const release = deferred(); const settled = deferred();
      const control = { started, aborted, release, settled };
      generationControls.push(control);
      return control;
    },
    holdWorkspaceRead: (repositoryId) => {
      const started = deferred(); const release = deferred(); const settled = deferred();
      const control = { repositoryId, started, release, settled };
      heldWorkspaceReads.push(control);
      return control;
    },
    holdNextProgressWrite: (stepIndex) => {
      const started = deferred(); const release = deferred(); const settled = deferred();
      const control = { stepIndex, started, release, settled };
      heldProgressWrites.push(control);
      return control;
    },
    holdNextSourceRead: () => {
      const started = deferred(); const release = deferred(); const settled = deferred();
      const control = { started, release, settled };
      heldSourceReads.push(control);
      return control;
    },
    waitForWorkspaceRead: (repositoryId, count) => {
      if (workspaceReads.filter((id) => id === repositoryId).length >= count) return Promise.resolve();
      return new Promise((resolve) => workspaceReadWaiters.push({ repositoryId, count, resolve }));
    },
    get generationCalls() { return generationCalls; },
    origin: `http://127.0.0.1:${vite.httpServer.address().port}`,
  };
}

async function dismissWelcomeAfterClear(page) {
  const welcome = page.getByRole("heading", { name: "打开仓库，开始阅读" });
  await welcome.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
  if (await welcome.isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "打开示例", exact: true }).click();
    const guide = page.getByRole("dialog", { name: "使用指南" });
    await guide.waitFor({ state: "visible", timeout: 5_000 });
    await guide.getByRole("button", { name: "关闭使用指南" }).click();
    await page.locator(".app-shell").waitFor({ state: "visible", timeout: 5_000 });
  }
}

async function openAppPage(app) {
  const initialWorkspace = app.page.waitForResponse((response) =>
    response.url().includes("/api/workspace?") && response.request().method() === "GET",
    { timeout: 12_000 },
  );
  await app.page.goto(app.origin);
  await initialWorkspace;
  await app.page.locator(".app-shell, .repository-home").first().waitFor({ state: "visible" });
  await dismissWelcomeAfterClear(app.page);
}

async function returnToRepositoryHome(page) {
  const heading = page.getByRole("heading", { name: "打开仓库，开始阅读" });
  if (!await heading.isVisible().catch(() => false)) {
    await page.waitForFunction(() => Boolean(document.querySelector(".repository-home") || document.querySelector(".repo-menu")));
    if (!await heading.isVisible().catch(() => false)) {
      const menu = page.locator(".repo-menu");
      if (!await menu.evaluate((element) => element.open)) await menu.locator("summary").click();
      await menu.getByRole("button", { name: "返回首页", exact: true }).click();
    }
  }
  await page.locator("#repository-path").waitFor({ state: "visible", timeout: 8_000 });
}

async function clickRepositoryMenuAction(page, name) {
  const menu = page.locator(".repo-menu");
  if (!await menu.evaluate((element) => element.open)) await menu.locator("summary").click();
  await menu.getByRole("button", { name, exact: true }).click();
}

async function assertChatHistory(page, title, present = true) {
  await page.getByRole("button", { name: "聊天历史", exact: true }).click();
  await page.getByLabel("搜索聊天历史", { exact: true }).waitFor({ state: "visible" });
  const item = page.locator(".chat-history-list").getByRole("button").filter({ has: page.getByText(title, { exact: true }) });
  if (present) await item.waitFor({ state: "visible" });
  else assert.equal(await item.count(), 0, title + " must not be restored in history");
  await page.keyboard.press("Escape");
}

async function chooseTourStep(page, index, title) {
  const disclosure = page.locator(".tour-step-disclosure");
  if (!await disclosure.evaluate((element) => element.open)) await disclosure.locator("summary").click();
  await page.getByRole("button", { name: `第 ${index + 1} 步：${title}`, exact: true }).click();
}

async function openRecoveryLocal(app) {
  await returnToRepositoryHome(app.page);
  await app.page.locator("#repository-path").fill("recovery-fixture");
  const opened = app.page.waitForResponse((response) => response.url().includes("/api/open"), { timeout: 5_000 });
  await app.page.getByRole("button", { name: "打开仓库", exact: true }).click();
  assert.equal((await opened).status(), 200);
  await app.page.locator(".repo-context .sample-badge").filter({ hasText: "本地仓库" }).waitFor({ state: "visible", timeout: 5_000 });
}

after(async () => {
  await Promise.all(browsers.map((browser) => browser.close().catch(() => {})));
  await Promise.all(servers.map((server) => server.httpServer
    ? server.close().catch(() => {})
    : new Promise((resolve) => server.close(() => resolve()))));
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("failed desktop restore never replaces saved sample node positions with an empty map", async () => {
  const app = await openDesktopPage();
  const original = { "src/main.tsx": { x: 777, y: 888 } };
  const originalProgress = JSON.stringify({ stepIndex: 2, completedSteps: [0, 1] });
  await app.store.saveNodePositions("taskflow-sample", original);
  await app.store.saveProgress("taskflow-sample", "repolens:taskflow-sample:1.2", originalProgress);
  await openAppPage(app);
  await app.page.getByText("保存数据读取失败", { exact: false }).waitFor({ state: "visible" });
  await app.page.waitForTimeout(900);
  assert.ok(app.workspaceReads.includes("taskflow-sample"));
  assert.equal(app.workspaceWrites.some((write) => write.action === "node-positions"), false, `positions must not be written before restore succeeds: ${JSON.stringify(app.workspaceWrites)}`);
  assert.equal(app.workspaceWrites.some((write) => write.action === "progress"), false, "failed restore must not replace saved progress with the initial step");
  const saved = await app.store.getRepository("taskflow-sample");
  assert.deepEqual(saved.nodePositions, original);
  assert.equal(saved.progress["repolens:taskflow-sample:1.2"], originalProgress);
});

test("failed local workspace restore never replaces saved conversations with an empty list", async () => {
  const app = await openDesktopPage();
  const original = [{ id: "saved-conversation", title: "Saved", messages: [], updatedAt: 10 }];
  await app.store.saveConversations("recovery-local", original);
  await openAppPage(app);
  await returnToRepositoryHome(app.page);
  await app.page.locator("#repository-path").fill("recovery-fixture");
  const openResponse = app.page.waitForResponse((response) => response.url().includes("/api/open"), { timeout: 5000 });
  await app.page.getByRole("button", { name: "打开仓库", exact: true }).click();
  assert.equal((await openResponse).status(), 200, `open request should succeed: ${(await app.page.locator("body").innerText()).slice(-1200)}`);
  await app.page.locator(".repo-context .sample-badge").filter({ hasText: "本地仓库" }).waitFor({ state: "visible", timeout: 5000 });
  await app.page.getByRole("tab", { name: "问答", exact: true }).click();
  await app.page.getByRole("alert").filter({ hasText: "无法读取已保存的问答记录" }).waitFor({ state: "visible" });
  await app.page.waitForTimeout(600);
  assert.ok(app.workspaceReads.includes("recovery-local"));
  assert.equal(app.workspaceWrites.some((write) => write.action === "conversations"), false, `conversations must not be written before restore succeeds: ${JSON.stringify(app.workspaceWrites)}`);
  assert.deepEqual((await app.store.getRepository("recovery-local")).conversations, original);
  await app.page.getByRole("button", { name: "新对话", exact: true }).click();
  assert.equal(app.workspaceWrites.some((write) => write.action === "conversations"), false, "changes made while storage is unavailable remain in memory");
  app.setWorkspaceReadsAvailable();
  await app.page.getByRole("button", { name: "重试读取问答记录" }).evaluate((button) => button.click());
  await app.page.waitForFunction(async ({ apiOrigin }) => {
    const response = await fetch(`${apiOrigin}/api/workspace?repositoryId=recovery-local`);
    return (await response.json()).conversations?.length === 2;
  }, { apiOrigin: await app.page.evaluate(() => window.__REPOLENS_RUNTIME__?.apiOrigin) }, { timeout: 5000 });
  const recovered = await app.store.getRepository("recovery-local");
  assert.equal(recovered.conversations.length, 2);
  assert.ok(recovered.conversations.some((conversation) => conversation.id === "saved-conversation"), "retry preserves the original conversation");
  assert.ok(recovered.conversations.some((conversation) => conversation.id !== "saved-conversation" && conversation.title === "新对话"), "retry merges the conversation created during the outage");
});

test("reading notes and routes edited during a failed restore merge with the saved records", async () => {
  const app = await openDesktopPage();
  const originalNote = { id: "saved-note", fileId: "main.ts", path: "main.ts", startLine: 1, text: "原有笔记", contentHash: "h1", createdAt: 10, kind: "note" };
  const originalRoute = createAiRouteRecord({ repositoryId: "recovery-local", entryFileId: "main.ts", revision: "r1", title: "原有路线", steps: [{ fileId: "main.ts", purpose: "原有步骤", relationship: "入口", question: "原有问题", references: [{ fileId: "main.ts", startLine: 1 }] }], contextFiles: [{ fileId: "main.ts", contentHash: "h1" }] });
  await app.store.saveReadingNotes("recovery-local", [originalNote]);
  await app.store.saveTours("recovery-local", [originalRoute]);
  await openAppPage(app);
  await returnToRepositoryHome(app.page);
  await app.page.locator("#repository-path").fill("recovery-fixture");
  await app.page.getByRole("button", { name: "打开仓库", exact: true }).click();
  await app.page.locator(".detail-file-title strong").getByText("main.ts", { exact: true }).waitFor({ state: "visible" });
  await app.page.getByRole("tab", { name: "讲解", exact: true }).click();
  await app.page.getByRole("button", { name: "重试恢复", exact: true }).waitFor({ state: "visible" });

  await app.page.getByLabel("阅读笔记内容").fill("离线期间新增笔记");
  await app.page.getByRole("button", { name: "保存记录", exact: true }).click();
  await app.page.locator(".manual-tour-builder summary").click();
  await app.page.locator(".manual-tour-builder input[type=checkbox]").check();
  await app.page.getByRole("button", { name: "创建并开始路线", exact: true }).click();
  assert.equal(app.workspaceWrites.some((write) => write.action === "reading-notes" || write.action === "saved-tours"), false, "unknown disk records must not be replaced while restoration is failing");
  assert.deepEqual((await app.store.getRepository("recovery-local")).readingNotes, [originalNote]);
  assert.deepEqual((await app.store.getRepository("recovery-local")).savedTours, [originalRoute]);

  app.setWorkspaceReadsAvailable();
  await app.page.getByRole("button", { name: "重试恢复", exact: true }).click();
  await app.page.getByRole("tab", { name: "讲解", exact: true }).click();
  await app.page.getByText("原有笔记", { exact: true }).waitFor({ state: "visible" });
  await app.page.getByText("离线期间新增笔记", { exact: true }).waitFor({ state: "visible" });
  await app.page.waitForFunction(async ({ apiOrigin, signature }) => {
    const response = await fetch(`${apiOrigin}/api/workspace?repositoryId=recovery-local`);
    const saved = await response.json();
    return saved.readingNotes?.some((item) => item.id === "saved-note") && saved.readingNotes?.some((item) => item.text === "离线期间新增笔记") && saved.savedTours?.some((item) => item.signature === signature) && saved.savedTours?.some((item) => item.title === "手动阅读路线");
  }, { apiOrigin: await app.page.evaluate(() => window.__REPOLENS_RUNTIME__?.apiOrigin), signature: originalRoute.signature }, { timeout: 8000 });
  const recovered = await app.store.getRepository("recovery-local");
  assert.equal(recovered.readingNotes.length, 2);
  assert.ok(recovered.savedTours.some((item) => item.signature === originalRoute.signature), "the route from disk survives the offline edit");
  assert.ok(recovered.savedTours.some((item) => item.title === "手动阅读路线"), "the route created during the outage is saved after merge");
});

test("pending conversations survive tab unmount and merge after a later successful restore", async () => {
  const app = await openDesktopPage();
  const original = [{ id: "saved-conversation", title: "Saved", messages: [], updatedAt: 10 }];
  await app.store.saveConversations("recovery-local", original);
  await openAppPage(app);
  await returnToRepositoryHome(app.page);
  await app.page.locator("#repository-path").fill("recovery-fixture");
  await app.page.getByRole("button", { name: "打开仓库", exact: true }).click();
  await app.page.getByRole("tab", { name: "问答", exact: true }).click();
  await app.page.getByRole("alert").filter({ hasText: "无法读取已保存的问答记录" }).waitFor({ state: "visible" });
  await app.page.getByRole("button", { name: "新对话", exact: true }).click();
  await app.page.getByRole("tab", { name: "源码", exact: true }).click();
  await app.page.getByRole("tab", { name: "问答", exact: true }).click();
  await app.page.getByRole("alert").filter({ hasText: "无法读取已保存的问答记录" }).waitFor({ state: "visible" });

  app.setWorkspaceReadsAvailable();
  await app.page.getByRole("button", { name: "重试读取问答记录" }).evaluate((button) => button.click());
  await assertChatHistory(app.page, "Saved");
  await assertChatHistory(app.page, "新对话");
  await app.page.waitForFunction(async ({ apiOrigin }) => {
    const response = await fetch(`${apiOrigin}/api/workspace?repositoryId=recovery-local`);
    const records = (await response.json()).conversations ?? [];
    return records.length === 2 && records.some((record) => record.id === "saved-conversation") && records.some((record) => record.title === "新对话");
  }, { apiOrigin: await app.page.evaluate(() => window.__REPOLENS_RUNTIME__?.apiOrigin) }, { timeout: 5000 });
  assert.equal(await app.page.getByRole("button", { name: "重试读取问答记录" }).count(), 0, "successful restore clears the read-failure prompt");
});

test("conversation deletion intent survives a failed save and a workspace reread", async () => {
  const app = await openDesktopPage();
  const original = [{ id: "saved-conversation", title: "Saved", messages: [], updatedAt: 10 }];
  await app.store.saveConversations("recovery-local", original);
  await openAppPage(app);
  await returnToRepositoryHome(app.page);
  await app.page.locator("#repository-path").fill("recovery-fixture");
  await app.page.getByRole("button", { name: "打开仓库", exact: true }).click();
  await app.page.getByRole("tab", { name: "问答", exact: true }).click();
  await app.page.getByRole("alert").filter({ hasText: "无法读取已保存的问答记录" }).waitFor({ state: "visible" });
  app.setWorkspaceReadsAvailable();
  await app.page.getByRole("button", { name: "重试读取问答记录" }).click();
  await assertChatHistory(app.page, "Saved");
  await app.page.getByRole("alert").filter({ hasText: "无法读取已保存的问答记录" }).waitFor({ state: "detached" });
  app.setWorkspaceWritesUnavailable();
  await app.page.getByRole("button", { name: "聊天历史", exact: true }).click();
  await app.page.getByRole("button", { name: "会话菜单", exact: true }).click();
  await app.page.getByRole("menuitem", { name: "删除对话", exact: true }).click();
  await app.page.getByText("simulated workspace write failure", { exact: false }).waitFor({ state: "visible" });
  assert.equal((await app.store.getRepository("recovery-local")).conversations.some((item) => item.id === "saved-conversation"), true, "failed save leaves durable record untouched until retry");
  app.setWorkspaceWritesAvailable();
  await app.page.getByRole("complementary", { name: "AI 聊天" }).getByRole("button", { name: "重试保存", exact: true }).click();
  await assertChatHistory(app.page, "Saved", false);
  await app.page.waitForFunction(async ({ apiOrigin }) => {
    const response = await fetch(`${apiOrigin}/api/workspace?repositoryId=recovery-local`);
    return (await response.json()).conversations?.length === 0;
  }, { apiOrigin: await app.page.evaluate(() => window.__REPOLENS_RUNTIME__?.apiOrigin) }, { timeout: 5000 });
  assert.deepEqual((await app.store.getRepository("recovery-local")).conversations, [], "explicitly deleted conversations are not resurrected by rereading storage");
  assert.equal(await app.page.getByRole("button", { name: "重试读取问答记录" }).count(), 0, "successful reread clears the read-failure prompt");
});

test("a warning on a successful workspace response still blocks question autosave", async () => {
  const app = await openDesktopPage();
  const original = [{ id: "saved-conversation", title: "Saved", messages: [], updatedAt: 10 }];
  await app.store.saveConversations("recovery-local", original);
  app.setWorkspaceReadWarning("storage read is incomplete");
  await openAppPage(app);
  await returnToRepositoryHome(app.page);
  await app.page.locator("#repository-path").fill("recovery-fixture");
  await app.page.getByRole("button", { name: "打开仓库", exact: true }).click();
  await app.page.getByRole("tab", { name: "问答", exact: true }).click();
  await app.page.getByText("storage read is incomplete", { exact: false }).waitFor({ state: "visible" });
  await app.page.waitForTimeout(400);
  assert.equal(app.workspaceWrites.some((write) => write.action === "conversations"), false, "a warning does not count as a complete restore");
  assert.deepEqual((await app.store.getRepository("recovery-local")).conversations, original);
});

test("clearing the current workspace removes its in-memory question state without affecting another workspace", async () => {
  const app = await openDesktopPage();
  app.setWorkspaceReadsAvailable();
  const original = [{ id: "saved-conversation", title: "Saved", messages: [], updatedAt: 10 }];
  await app.store.saveConversations("recovery-local", original);
  await app.store.saveConversations("other-workspace", [{ id: "other", title: "Other", messages: [], updatedAt: 11 }]);
  await openAppPage(app);
  await returnToRepositoryHome(app.page);
  await app.page.locator("#repository-path").fill("recovery-fixture");
  await app.page.getByRole("button", { name: "打开仓库", exact: true }).click();
  await app.page.getByRole("tab", { name: "问答", exact: true }).click();
  await assertChatHistory(app.page, "Saved");

  await clickRepositoryMenuAction(app.page, "清除此仓库的阅读记录");
  await assertChatHistory(app.page, "Saved", false);
  assert.deepEqual((await app.store.getRepository("recovery-local")).conversations, []);
  assert.equal((await app.store.getRepository("other-workspace")).conversations[0]?.id, "other");

  await app.page.getByRole("button", { name: "新对话", exact: true }).click();
  await app.page.waitForFunction(async ({ apiOrigin }) => {
    const response = await fetch(`${apiOrigin}/api/workspace?repositoryId=recovery-local`);
    const records = (await response.json()).conversations ?? [];
    return records.length === 1 && records[0].title === "新对话";
  }, { apiOrigin: await app.page.evaluate(() => window.__REPOLENS_RUNTIME__?.apiOrigin) }, { timeout: 5000 });
  assert.equal((await app.store.getRepository("recovery-local")).conversations.some((item) => item.id === "saved-conversation"), false, "a cleared conversation must not be written back by creating a new one");
});

test("clear-all removes the active question view and later edits do not resurrect old conversations", async () => {
  const app = await openDesktopPage();
  app.setWorkspaceReadsAvailable();
  await app.store.saveConversations("recovery-local", [{ id: "saved-conversation", title: "Saved", messages: [], updatedAt: 10 }]);
  await app.store.saveConversations("other-workspace", [{ id: "other", title: "Other", messages: [], updatedAt: 11 }]);
  await openAppPage(app);
  await returnToRepositoryHome(app.page);
  await app.page.locator("#repository-path").fill("recovery-fixture");
  await app.page.getByRole("button", { name: "打开仓库", exact: true }).click();
  await app.page.getByRole("tab", { name: "问答", exact: true }).click();
  await assertChatHistory(app.page, "Saved");

  const clearResponse = app.page.waitForResponse((response) => response.url().includes("/api/workspace") && response.request().method() === "POST" && response.request().postData()?.includes("clear-all"));
  await clickRepositoryMenuAction(app.page, "清除全部 RepoLens 保存数据");
  assert.equal((await clearResponse).status(), 200);
  await openRecoveryLocal(app);
  await app.page.getByRole("tab", { name: "问答", exact: true }).click();
  await assertChatHistory(app.page, "Saved", false);
  assert.deepEqual((await app.store.getRepository("recovery-local")).conversations, []);
  assert.deepEqual((await app.store.getRepository("other-workspace")).conversations, []);
  await app.page.getByRole("button", { name: "新对话", exact: true }).click();
  await app.page.waitForFunction(async ({ apiOrigin }) => {
    const response = await fetch(`${apiOrigin}/api/workspace?repositoryId=recovery-local`);
    const records = (await response.json()).conversations ?? [];
    return records.length === 1 && records[0].title === "新对话";
  }, { apiOrigin: await app.page.evaluate(() => window.__REPOLENS_RUNTIME__?.apiOrigin) }, { timeout: 5000 });
  const saved = await app.store.getRepository("recovery-local");
  assert.equal(saved.conversations.some((item) => item.id === "saved-conversation"), false);
});

test("clear-all invalidates an import paused while validating source references", async () => {
  const app = await openDesktopPage();
  app.setWorkspaceReadsAvailable();
  await openAppPage(app);
  await returnToRepositoryHome(app.page);
  await app.page.locator("#repository-path").fill("recovery-fixture");
  await app.page.getByRole("button", { name: "打开仓库", exact: true }).click();
  await app.page.locator(".repo-context .sample-badge").filter({ hasText: "本地仓库" }).waitFor({ state: "visible" });
  await app.page.getByRole("tab", { name: "讲解", exact: true }).click();

  const importedNote = {
    id: "late-import-note", fileId: "main.ts", path: "main.ts", startLine: 1,
    text: "这条记录必须被清除", contentHash: "h1", createdAt: 1, kind: "note",
  };
  await app.page.locator(".reading-import-button input[type=file]").setInputFiles({
    name: "reading.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ format: "repolens-reading", version: 1, workspaceId: "recovery-local", notes: [importedNote], tours: [] })),
  });
  await app.page.getByRole("dialog", { name: "导入预览" }).waitFor({ state: "visible" });

  const sourceRead = app.holdNextSourceRead();
  await app.page.getByRole("button", { name: "确认导入", exact: true }).click();
  await sourceRead.started.promise;
  const clearResponse = app.page.waitForResponse((response) => response.url().includes("/api/workspace") && response.request().method() === "POST" && response.request().postData()?.includes("clear-all"));
  // Simulate an external clear while the modal holds a validation request.
  await app.page.evaluate(() => { const menu = document.querySelector(".repo-menu"); menu.open = true; const button = [...menu.querySelectorAll("button")].find((item) => item.textContent.includes("清除全部 RepoLens 保存数据")); button.click(); });
  assert.equal((await clearResponse).status(), 200);
  await dismissWelcomeAfterClear(app.page);
  assert.deepEqual((await app.store.getRepository("recovery-local")).readingNotes, []);

  sourceRead.release.resolve();
  await sourceRead.settled.promise;
  await app.page.getByRole("dialog", { name: "导入预览" }).waitFor({ state: "detached" });
  assert.deepEqual((await app.store.getRepository("recovery-local")).readingNotes, [], "a source validation started before clear must not recreate the imported note");
  assert.equal(app.workspaceWrites.some((write) => write.action === "reading-notes" && write.notes?.some((note) => note.id === importedNote.id)), false, "the invalidated import must not enter the persistence queue after clearing");
});

test("clearing a workspace during question generation aborts it before any stale answer can be saved", async () => {
  const app = await openDesktopPage();
  app.setWorkspaceReadsAvailable();
  app.setAiConfigured();
  await openAppPage(app);
  await returnToRepositoryHome(app.page);
  await app.page.locator("#repository-path").fill("recovery-fixture");
  await app.page.getByRole("button", { name: "打开仓库", exact: true }).click();
  await app.page.getByRole("tab", { name: "问答", exact: true }).click();
  await app.page.getByLabel("提问或追问").fill("What does the entry do?");
  await app.page.waitForFunction(() => !document.querySelector('.chat-send')?.disabled);

  const pending = app.holdNextGeneration();
  await app.page.getByRole("button", { name: "发送", exact: true }).click();
  await pending.started.promise;
  const clearRequest = app.page.waitForResponse((response) => response.url().includes("/api/workspace") && response.request().method() === "POST" && response.request().postData()?.includes("clear-repository"));
  try {
    await clickRepositoryMenuAction(app.page, "清除此仓库的阅读记录");
    await pending.aborted.promise;
    pending.release.resolve();
    await pending.settled.promise;
    assert.equal((await clearRequest).status(), 200);
    assert.equal(app.generationCalls, 1, "the active request is not retried");
    assert.equal(app.workspaceWrites.some((write) => write.action === "conversations"), false, "the late response must not submit conversation data");
    assert.deepEqual((await app.store.getRepository("recovery-local")).conversations, []);
    await app.page.getByRole("tab", { name: "问答", exact: true }).click();
    await app.page.getByRole("button", { name: "新对话", exact: true }).waitFor({ state: "visible" });
    assert.equal(await app.page.getByText("迟到回答", { exact: true }).count(), 0);
  } finally {
    pending.release.resolve();
  }
});

test("clearing a workspace invalidates an already-read but delayed conversation response", async () => {
  const app = await openDesktopPage();
  app.setWorkspaceReadsAvailable();
  await app.store.saveConversations("recovery-local", [{ id: "old", title: "旧问答", messages: [], updatedAt: 1 }]);
  await openAppPage(app);
  await returnToRepositoryHome(app.page);
  await app.page.locator("#repository-path").fill("recovery-fixture");
  const openResponse = app.page.waitForResponse((response) => response.url().includes("/api/open"), { timeout: 5000 });
  await app.page.getByRole("button", { name: "打开仓库", exact: true }).click();
  assert.equal((await openResponse).status(), 200);
  await app.page.locator(".repo-context .sample-badge").filter({ hasText: "本地仓库" }).waitFor({ state: "visible" });
  await app.page.waitForFunction(() => !document.body.innerText.includes("正在获取并扫描…"));
  const pendingRead = app.holdWorkspaceRead("recovery-local");
  await app.page.getByRole("tab", { name: "问答", exact: true }).click();
  await pendingRead.started.promise;
  const completedRecoveryRead = app.waitForWorkspaceRead("recovery-local", 2);
  await app.page.locator(".repo-menu summary").click();
  const clearButton = app.page.getByRole("button", { name: "清除此仓库的阅读记录", exact: true });
  await clearButton.waitFor({ state: "visible" });
  try { await app.page.waitForFunction(() => {
    const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "清除此仓库的阅读记录");
    return Boolean(button && !button.disabled);
  }); } catch {
    const state = await app.page.evaluate(() => {
      const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "清除此仓库的阅读记录");
      return { button: button?.outerHTML, text: document.body.innerText.slice(-1200) };
    });
    throw new Error(`clear button remained disabled: ${JSON.stringify(state)}`);
  }
  const clearResponse = app.page.waitForResponse((response) => response.url().includes("/api/workspace") && response.request().method() === "POST" && response.request().postData()?.includes("clear-repository"));
  await clearButton.click();
  assert.equal((await clearResponse).status(), 200);
  assert.deepEqual((await app.store.getRepository("recovery-local")).conversations, []);

  pendingRead.release.resolve();
  await pendingRead.settled.promise;
  await completedRecoveryRead;
  await assertChatHistory(app.page, "旧问答", false);
  assert.deepEqual((await app.store.getRepository("recovery-local")).conversations, [], "a read that began before clearing cannot repopulate or rewrite the old list");
});

test("clear-all waits for an in-flight desktop progress write before deleting saved data", async () => {
  const app = await openDesktopPage();
  app.setWorkspaceReadsAvailable();
  await openAppPage(app);
  const delayedProgress = app.holdNextProgressWrite(2);
  await chooseTourStep(app.page, 2, "查看列表渲染");
  await delayedProgress.started.promise;

  try {
    await clickRepositoryMenuAction(app.page, "清除全部 RepoLens 保存数据");
    await app.page.getByRole("status").filter({ hasText: "正在清除" }).waitFor({ state: "visible" });
    assert.equal(app.workspaceWrites.some((write) => write.action === "clear-all"), false, "clear must wait while the progress request is still unresolved");

    delayedProgress.release.resolve();
    await delayedProgress.settled.promise;
    const clearResponse = await app.page.waitForResponse((response) => response.url().includes("/api/workspace") && response.request().method() === "POST" && response.request().postData()?.includes("clear-all"));
    assert.equal(clearResponse.status(), 200);
    await dismissWelcomeAfterClear(app.page);
    const stored = await app.store.getRepository("taskflow-sample");
    assert.equal(Object.values(stored.progress).some((value) => JSON.parse(value).stepIndex === 2), false, "a completed clear must remove the old in-flight route progress");
    const steps = app.page.locator(".tour-step-disclosure");
    if (!await steps.evaluate((element) => element.open)) await steps.locator("summary").click();
    await app.page.getByRole("button", { name: "第 1 步：从入口开始" }).waitFor({ state: "visible" });
  } finally {
    delayedProgress.release.resolve();
  }
});

test("clear-current waits for an in-flight desktop progress write before deleting that workspace", async () => {
  const localTour = ["从入口开始", "查看页面组织", "查看列表渲染", "跟随状态流转", "查看数据来源"].map((title, index) => ({
    id: `step-${index}`,
    title,
    focusFileId: "main.ts",
    description: `测试步骤 ${index + 1}`,
    reference: { fileId: "main.ts", line: 1 },
  }));
  const app = await openDesktopPage({ localTour });
  app.setWorkspaceReadsAvailable();
  await openAppPage(app);
  await returnToRepositoryHome(app.page);
  await app.page.locator("#repository-path").fill("recovery-fixture");
  const openResponse = app.page.waitForResponse((response) => response.url().includes("/api/open"), { timeout: 5000 });
  await app.page.getByRole("button", { name: "打开仓库", exact: true }).click();
  assert.equal((await openResponse).status(), 200);
  await app.page.waitForFunction(() => !document.body.innerText.includes("正在获取并扫描…"));
  const delayedProgress = app.holdNextProgressWrite(2);
  await chooseTourStep(app.page, 2, "查看列表渲染");
  await delayedProgress.started.promise;

  try {
    await app.page.locator(".repo-menu summary").click();
    const clearButton = app.page.getByRole("button", { name: "清除此仓库的阅读记录", exact: true });
    await app.page.waitForFunction(() => {
      const button = [...document.querySelectorAll(".repo-menu button")].find((item) => item.textContent?.trim() === "清除此仓库的阅读记录");
      return Boolean(button && !button.disabled);
    });
    const clearResponse = app.page.waitForResponse((response) => response.url().includes("/api/workspace") && response.request().method() === "POST" && response.request().postData()?.includes("clear-repository"));
    await clearButton.click();
    await app.page.getByRole("status").filter({ hasText: "正在清除" }).waitFor({ state: "visible" });
    assert.equal(app.workspaceWrites.some((write) => write.action === "clear-repository"), false, "current-workspace clear must wait for the pending progress write");
    delayedProgress.release.resolve();
    await delayedProgress.settled.promise;
    assert.equal((await clearResponse).status(), 200);
    assert.deepEqual((await app.store.getRepository("recovery-local")).progress, {}, "the old progress is gone after the current workspace clear succeeds");
  } finally {
    delayedProgress.release.resolve();
  }
});
