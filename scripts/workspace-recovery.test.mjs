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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directories = [];
const servers = [];
const browsers = [];

async function openDesktopPage() {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "repolens-recovery-regression-"));
  directories.push(temporaryDirectory);
  const store = createWorkspaceStore(temporaryDirectory);
  const workspaceWrites = [];
  const workspaceReads = [];
  let failWorkspaceReads = true;
  let workspaceReadWarning = "";
  let failWorkspaceWrites = false;
  const api = createHttpServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (request.method === "OPTIONS") { response.writeHead(204).end(); return; }
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/api/workspace" && request.method === "GET") {
      workspaceReads.push(url.searchParams.get("repositoryId"));
      if (failWorkspaceReads) {
        response.writeHead(503, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "simulated workspace read failure" }));
      } else {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ...(await store.getRepository(url.searchParams.get("repositoryId"))), ...(workspaceReadWarning ? { warning: workspaceReadWarning } : {}) }));
      }
      return;
    }
    if (url.pathname === "/api/workspace" && request.method === "POST") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      workspaceWrites.push(payload);
      if (failWorkspaceWrites) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: false, warning: "simulated workspace write failure" }));
        return;
      }
      if (payload.action === "node-positions") await store.saveNodePositions(payload.workspaceId, payload.positions);
      if (payload.action === "conversations") await store.saveConversations(payload.workspaceId, payload.conversations);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === "/api/open") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        id: "recovery-local", workspaceId: "recovery-local", persistenceSessionId: "session-1", version: "1",
        name: "Recovery fixture", description: "", source: "local", revision: "r1", sequence: 1,
        files: [{ id: "main.ts", path: "main.ts", name: "main.ts", kind: "typescript", language: "ts", role: "入口", summary: "", imports: [], contentHash: "h1" }],
        dependencies: [], tour: [], diagnostics: [], unresolved: [],
      }));
      return;
    }
    if (url.pathname === "/api/events") { response.writeHead(204).end(); return; }
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
  await page.addInitScript((origin) => { window.__REPOLENS_RUNTIME__ = { desktop: true, apiOrigin: origin }; }, apiOrigin);
  return {
    page, store, workspaceReads, workspaceWrites,
    setWorkspaceReadsAvailable: () => { failWorkspaceReads = false; },
    setWorkspaceReadWarning: (warning) => { failWorkspaceReads = false; workspaceReadWarning = warning; },
    setWorkspaceWritesAvailable: () => { failWorkspaceWrites = false; },
    setWorkspaceWritesUnavailable: () => { failWorkspaceWrites = true; },
    origin: `http://127.0.0.1:${vite.httpServer.address().port}`,
  };
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
  await app.page.goto(app.origin);
  await app.page.getByText("桌面保存数据读取失败", { exact: false }).waitFor({ state: "visible" });
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
  await app.page.goto(app.origin);
  await app.page.locator("#repository-path").fill("recovery-fixture");
  const openResponse = app.page.waitForResponse((response) => response.url().includes("/api/open"), { timeout: 5000 });
  await app.page.getByRole("button", { name: "打开仓库", exact: true }).click();
  assert.equal((await openResponse).status(), 200, `open request should succeed: ${(await app.page.locator("body").innerText()).slice(-1200)}`);
  await app.page.getByText("本地仓库", { exact: true }).waitFor({ state: "visible", timeout: 5000 });
  await app.page.getByRole("tab", { name: "问答", exact: true }).click();
  await app.page.getByText("本地问答记录不可用", { exact: false }).waitFor({ state: "visible" });
  await app.page.waitForTimeout(600);
  assert.ok(app.workspaceReads.includes("recovery-local"));
  assert.equal(app.workspaceWrites.some((write) => write.action === "conversations"), false, `conversations must not be written before restore succeeds: ${JSON.stringify(app.workspaceWrites)}`);
  assert.deepEqual((await app.store.getRepository("recovery-local")).conversations, original);
  await app.page.getByRole("button", { name: "新对话", exact: true }).click();
  assert.equal(app.workspaceWrites.some((write) => write.action === "conversations"), false, "changes made while storage is unavailable remain in memory");
  app.setWorkspaceReadsAvailable();
  await app.page.getByRole("button", { name: "重试读取本地问答记录" }).click();
  await app.page.waitForFunction(async ({ apiOrigin }) => {
    const response = await fetch(`${apiOrigin}/api/workspace?repositoryId=recovery-local`);
    return (await response.json()).conversations?.length === 2;
  }, { apiOrigin: await app.page.evaluate(() => window.__REPOLENS_RUNTIME__?.apiOrigin) }, { timeout: 5000 });
  const recovered = await app.store.getRepository("recovery-local");
  assert.equal(recovered.conversations.length, 2);
  assert.ok(recovered.conversations.some((conversation) => conversation.id === "saved-conversation"), "retry preserves the original conversation");
  assert.ok(recovered.conversations.some((conversation) => conversation.id !== "saved-conversation" && conversation.title === "新对话"), "retry merges the conversation created during the outage");
});

test("pending conversations survive tab unmount and merge after a later successful restore", async () => {
  const app = await openDesktopPage();
  const original = [{ id: "saved-conversation", title: "Saved", messages: [], updatedAt: 10 }];
  await app.store.saveConversations("recovery-local", original);
  await app.page.goto(app.origin);
  await app.page.locator("#repository-path").fill("recovery-fixture");
  await app.page.getByRole("button", { name: "打开仓库", exact: true }).click();
  await app.page.getByRole("tab", { name: "问答", exact: true }).click();
  await app.page.getByText("本地问答记录不可用", { exact: false }).waitFor({ state: "visible" });
  await app.page.getByRole("button", { name: "新对话", exact: true }).click();
  await app.page.getByRole("tab", { name: "源码", exact: true }).click();
  await app.page.getByRole("tab", { name: "问答", exact: true }).click();
  await app.page.getByText("本地问答记录不可用", { exact: false }).waitFor({ state: "visible" });

  app.setWorkspaceReadsAvailable();
  await app.page.getByRole("button", { name: "重试读取本地问答记录" }).click();
  await app.page.getByRole("option", { name: "Saved", exact: true }).waitFor({ state: "attached" });
  await app.page.getByRole("option", { name: "新对话", exact: true }).waitFor({ state: "attached" });
  await app.page.waitForFunction(async ({ apiOrigin }) => {
    const response = await fetch(`${apiOrigin}/api/workspace?repositoryId=recovery-local`);
    const records = (await response.json()).conversations ?? [];
    return records.length === 2 && records.some((record) => record.id === "saved-conversation") && records.some((record) => record.title === "新对话");
  }, { apiOrigin: await app.page.evaluate(() => window.__REPOLENS_RUNTIME__?.apiOrigin) }, { timeout: 5000 });
  assert.equal(await app.page.getByRole("button", { name: "重试读取本地问答记录" }).count(), 0, "successful restore clears the read-failure prompt");
});

test("conversation deletion intent survives a failed save and a workspace reread", async () => {
  const app = await openDesktopPage();
  const original = [{ id: "saved-conversation", title: "Saved", messages: [], updatedAt: 10 }];
  await app.store.saveConversations("recovery-local", original);
  await app.page.goto(app.origin);
  await app.page.locator("#repository-path").fill("recovery-fixture");
  await app.page.getByRole("button", { name: "打开仓库", exact: true }).click();
  await app.page.getByRole("tab", { name: "问答", exact: true }).click();
  await app.page.getByText("本地问答记录不可用", { exact: false }).waitFor({ state: "visible" });
  app.setWorkspaceReadsAvailable();
  await app.page.getByRole("button", { name: "重试读取本地问答记录" }).click();
  await app.page.getByRole("option", { name: "Saved", exact: true }).waitFor({ state: "attached" });
  await app.page.getByText("读取失败", { exact: false }).waitFor({ state: "detached" });
  app.setWorkspaceWritesUnavailable();
  await app.page.getByRole("button", { name: "删除对话", exact: true }).click();
  await app.page.getByText("simulated workspace write failure", { exact: false }).waitFor({ state: "visible" });
  assert.equal((await app.store.getRepository("recovery-local")).conversations.some((item) => item.id === "saved-conversation"), true, "failed save leaves durable record untouched until retry");
  app.setWorkspaceWritesAvailable();
  await app.page.getByRole("tab", { name: "源码", exact: true }).click();
  await app.page.getByRole("tab", { name: "问答", exact: true }).click();
  await app.page.getByRole("option", { name: "Saved", exact: true }).waitFor({ state: "detached" });
  await app.page.waitForFunction(async ({ apiOrigin }) => {
    const response = await fetch(`${apiOrigin}/api/workspace?repositoryId=recovery-local`);
    return (await response.json()).conversations?.length === 0;
  }, { apiOrigin: await app.page.evaluate(() => window.__REPOLENS_RUNTIME__?.apiOrigin) }, { timeout: 5000 });
  assert.deepEqual((await app.store.getRepository("recovery-local")).conversations, [], "explicitly deleted conversations are not resurrected by rereading storage");
  assert.equal(await app.page.getByRole("button", { name: "重试读取本地问答记录" }).count(), 0, "successful reread clears the read-failure prompt");
});

test("a warning on a successful workspace response still blocks question autosave", async () => {
  const app = await openDesktopPage();
  const original = [{ id: "saved-conversation", title: "Saved", messages: [], updatedAt: 10 }];
  await app.store.saveConversations("recovery-local", original);
  app.setWorkspaceReadWarning("storage read is incomplete");
  await app.page.goto(app.origin);
  await app.page.locator("#repository-path").fill("recovery-fixture");
  await app.page.getByRole("button", { name: "打开仓库", exact: true }).click();
  await app.page.getByRole("tab", { name: "问答", exact: true }).click();
  await app.page.getByText("storage read is incomplete", { exact: false }).waitFor({ state: "visible" });
  await app.page.waitForTimeout(400);
  assert.equal(app.workspaceWrites.some((write) => write.action === "conversations"), false, "a warning does not count as a complete restore");
  assert.deepEqual((await app.store.getRepository("recovery-local")).conversations, original);
});
