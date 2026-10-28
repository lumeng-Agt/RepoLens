import { mkdir } from "node:fs/promises";
import { test, expect, enterRepositoryLocation, openRepositoryMenu, type Page } from "./fixtures";
import type { Investigation } from "../data/model";

const api = "http://127.0.0.1:4319";
const ids = ["task.ts", "cleanup.ts", "task.test.ts"];
const snapshot = { id: "investigation-e2e", workspaceId: "investigation-e2e", persistenceSessionId: "session-1", version: "v1", revision: "r1", name: "Tasks", description: "", source: "local", sequence: 1,
  files: ids.map(id => ({ id, path: id, name: id, kind: "typescript", imports: [], contentHash: `${id}-hash` })),
  dependencies: [{ id: "task-cleanup", fromId: "task.ts", toId: "cleanup.ts", specifier: "./cleanup", kind: "import", resolutionBasis: "relative-path", reference: { fileId: "task.ts", line: 1 } }, { id: "test-task", fromId: "task.test.ts", toId: "task.ts", specifier: "./task", kind: "import", reference: { fileId: "task.test.ts", line: 1 } }], tour: [], diagnostics: [], unresolved: [] };
const result = { summary: "取消入口与清理需要一起核对。", items: [{ id: "cancel", title: "检查任务取消", responsibility: "取消入口", reason: "调用中断控制器；超时是否复用同一清理流程仍待确认。", references: [{ fileId: "task.ts", startLine: 1, endLine: 2 }] }, { id: "cleanup", title: "检查资源释放", responsibility: "资源清理", reason: "这里释放资源，需核对超时后的调用条件。", references: [{ fileId: "cleanup.ts", startLine: 1 }] }], questions: [{ question: "超时后是否执行清理？", suggestedFileId: "cleanup.ts" }] };
const original: Investigation = { ...result, id: "original", title: "原有调查", question: "已有问题", workspaceId: snapshot.id, repositoryName: "Tasks", contextFiles: ids.map(fileId => ({ fileId, contentHash: `${fileId}-hash`, startLine: 1, endLine: 2 })), excludedFileIds: [], verifiedItemIds: [], createdAt: 1, updatedAt: 1 };

async function setup(page: Page, options: { failedRead?: boolean; initial?: Investigation[] } = {}) {
  let records = options.initial ?? []; let conversations: unknown[] = []; let failedRead = options.failedRead ?? false; let failWrite = false;
  let readGate: { gate: Promise<void>; started: () => void } | null = null;
  let failChatWrite = false; let chatWrites = 0;
  let calls = 0; let writes = 0; let previewCount = 0; const previews: { mode?: string; excludedFileIds?: string[]; fileIds?: string[] }[] = [];
  await page.route(`${api}/api/**`, async route => {
    const request = route.request(); const url = new URL(request.url()); const json = (value: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(value) });
    if (url.pathname === "/api/open") return json(snapshot);
    if (url.pathname === "/api/events") return route.fulfill({ status: 204 });
    if (url.pathname === "/api/source") return json({ source: "export const cancel = () => cleanup();\nexport const timeout = 1000;", repositoryId: snapshot.id, revision: "r1" });
    if (url.pathname === "/api/ai/settings") return json({ configured: true, model: "mock-investigation", baseUrl: "https://model.example/v1" });
    if (url.pathname === "/api/rescan") return json({ ...snapshot, revision: "r2", sequence: 2 });
    if (url.pathname === "/api/workspace" && request.method() === "GET") {
      if (readGate && url.searchParams.get("repositoryId") === snapshot.id) {
        const held = readGate; readGate = null; const captured = structuredClone(records); held.started(); await held.gate;
        return json({ version: 1, persistenceReady: true, recentRepositories: [], aiResults: {}, aiRoute: null, progress: {}, nodePositions: {}, conversations, investigations: captured });
      }
      if (failedRead && url.searchParams.get("repositoryId") === snapshot.id) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "测试读取失败" }) });
      return json({ version: 1, persistenceReady: true, recentRepositories: [], aiResults: {}, aiRoute: null, progress: {}, nodePositions: {}, conversations, investigations: records });
    }
    if (url.pathname === "/api/workspace") {
      const body = request.postDataJSON();
      if (body.action === "investigations") { if (failWrite) return json({ ok: false, warning: "测试调查写入失败" }); writes++; records = body.records; }
      if (body.action === "conversations") { chatWrites++; if (failChatWrite) return json({ ok: false, warning: "测试问答写入失败" }); conversations = body.conversations; }
      if (body.action === "clear-all" || body.action === "clear-repository") { records = []; conversations = []; }
      return json({ ok: true });
    }
    if (url.pathname.endsWith("/preview")) {
      const body = request.postDataJSON(); previews.push(body); previewCount++;
      return json({ scopeRequired: false, preview: { id: `investigation-preview-${previewCount}`, repositoryId: snapshot.id, revision: "r1", entryFileId: body.fileId, mode: body.mode ?? "question", excludedFileIds: body.excludedFileIds ?? [], question: body.question, baseUrl: "https://model.example/v1", model: "mock-investigation", files: (body.fileIds ?? ids.slice(0, 2)).map((fileId: string) => ({ fileId, startLine: 1, endLine: 2, contentHash: `${fileId}-hash`, reasons: ["源码包含取消关键词"] })), characters: 100, expiresAt: Date.now() + 600000 } });
    }
    if (url.pathname === "/api/ai/generate") { calls++; return json({ result, cached: false, repositoryId: snapshot.id, revision: "r1", entryFileId: "task.ts", mode: "investigation" }); }
    if (url.pathname === "/api/compare") return json({ revision: "r1", mode: "working-tree", baseCommit: "a".repeat(40), headCommit: "WORKTREE", files: [{ status: "modified", path: "cleanup.ts" }, { status: "deleted", path: "old.ts" }], skipped: [{ path: "assets.bin", reason: "超过 64 MiB，未比较内容" }], diff: "- before\n+ after", limits: { maxFiles: 5000, maxDiffBytes: 2000000 } });
    if (url.pathname === "/api/close") return json({ ok: true });
    return json({ error: url.pathname });
  });
  await page.goto("/"); await enterRepositoryLocation(page, "D:/temporary-investigation-fixture"); await page.getByRole("button", { name: "打开仓库", exact: true }).click();
  await expect(page.getByRole("treeitem", { name: "task.ts", exact: true })).toBeVisible();
  await page.getByRole("treeitem", { name: "task.ts", exact: true }).click();
  return { records: () => records, calls: () => calls, writes: () => writes, previews, chatWrites: () => chatWrites, failChatWrites: (value: boolean) => { failChatWrite = value; }, holdNextRead: () => { let release!: () => void; let started!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); const ready = new Promise<void>(resolve => { started = resolve; }); readGate = { gate, started }; return { release, ready }; }, recover: () => { failedRead = false; }, failWrites: (value: boolean) => { failWrite = value; } };
}

async function investigate(page: Page) {
  await page.getByRole("button", { name: "打开 AI 聊天", exact: true }).click();
  const chat = page.getByRole("complementary", { name: "AI 聊天", exact: true });
  await chat.getByRole("button", { name: "AI 任务", exact: true }).click(); await page.getByRole("menuitem", { name: "定位改动位置", exact: true }).click();
  await chat.getByLabel("提问或追问", { exact: true }).fill("给任务取消增加超时，需要检查哪些位置？");
  await expect(chat.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
  return chat;
}

test("requirement investigation keeps candidates inspectable, exclusions explicit, and records recoverable", async ({ page }) => {
  const fixture = await setup(page); const chat = await investigate(page); expect(fixture.calls()).toBe(0);
  await chat.getByRole("button", { name: "发送", exact: true }).click(); await expect(chat.getByText("检查任务取消", { exact: true })).toBeVisible(); expect(fixture.calls()).toBe(1);
  await chat.getByRole("button", { name: "task.ts:1–2", exact: true }).click(); await expect(chat.getByLabel("回答证据")).toContainText("cancel");
  await chat.getByRole("button", { name: "关闭证据", exact: true }).click();
  await chat.getByRole("button", { name: "保存调查", exact: true }).click(); await expect.poll(() => fixture.records().length).toBe(1);
  await chat.getByLabel("我已核对结论").first().check(); await expect.poll(() => fixture.records()[0].verifiedItemIds).toEqual(["cancel"]);
  await chat.getByRole("button", { name: "排除此项文件", exact: true }).last().click();
  await expect.poll(() => fixture.records()[0].excludedFileIds).toEqual(["cleanup.ts"]);
  await chat.getByRole("button", { name: "继续调查", exact: true }).click();
  await expect.poll(() => fixture.previews.at(-1)?.excludedFileIds).toEqual(["cleanup.ts"]); expect(fixture.calls()).toBe(1);
  await page.keyboard.press("Escape"); await page.getByRole("button", { name: "调查记录 · 1", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "调查记录", exact: true }); await expect(dialog.getByLabel("调查标题")).toBeVisible();
  await dialog.getByLabel("调查标题").fill("取消与超时调查"); await expect.poll(() => fixture.records()[0].title).toBe("取消与超时调查");
  await mkdir(".artifacts/investigation", { recursive: true });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 375, height: 812 }]) {
    await page.setViewportSize(viewport); await expect(dialog.getByRole("button", { name: "关闭", exact: true })).toBeInViewport();
    await page.screenshot({ path: `.artifacts/investigation/records-${viewport.width}.png` });
  }
  await dialog.getByRole("button", { name: "关闭", exact: true }).click(); await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload(); await enterRepositoryLocation(page, "D:/temporary-investigation-fixture"); await page.getByRole("button", { name: "打开仓库", exact: true }).click();
  await page.getByRole("button", { name: "调查记录 · 1", exact: true }).click(); await expect(page.getByLabel("调查标题")).toHaveValue("取消与超时调查");
});

test("failed reads and partial writes retain original investigations and expose retry", async ({ page }) => {
  const fixture = await setup(page, { failedRead: true, initial: [original] }); const chat = await investigate(page);
  await chat.getByRole("button", { name: "发送", exact: true }).click(); await chat.getByRole("button", { name: "保存调查", exact: true }).click();
  await expect(page.locator(".investigation-entry")).toContainText("失败"); expect(fixture.records()).toEqual([original]); expect(fixture.writes()).toBe(0);
  fixture.recover(); await page.locator(".investigation-entry").getByRole("button", { name: "重试", exact: true }).click();
  await expect.poll(() => fixture.records().length).toBe(2);
  await page.getByRole("button", { name: "调查记录 · 2", exact: true }).click(); const dialog = page.getByRole("dialog", { name: "调查记录", exact: true });
  fixture.failWrites(true); await dialog.getByLabel("调查标题").fill("失败期间修改"); await expect(dialog.getByRole("alert")).toContainText("写入失败");
  fixture.failWrites(false); await dialog.getByRole("button", { name: "重试", exact: true }).click();
  await expect.poll(() => fixture.records().some(record => record.title === "失败期间修改")).toBe(true);
  await expect(dialog.getByRole("alert")).toHaveCount(0);
});

test("investigation import previews conflicts, preserves copies and cancels validation before clear", async ({ page }) => {
  const fixture = await setup(page, { initial: [original] }); await page.getByRole("button", { name: "调查记录 · 1", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "调查记录", exact: true });
  await dialog.getByLabel("导入调查 JSON").setInputFiles({ name: "investigations.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ version: 1, kind: "repolens-investigations", records: [{ ...original, summary: "导入的新发现" }] })) });
  await expect(dialog.getByLabel("调查导入预览")).toContainText("1 个冲突"); await dialog.getByRole("button", { name: "确认导入", exact: true }).click();
  await expect.poll(() => fixture.records().length).toBe(2); expect(fixture.records().find(record => record.id === "original")?.summary).toBe(original.summary);
  const imported = fixture.records().find(record => record.id !== "original")!;
  await dialog.getByLabel(`导出 ${imported.title}`, { exact: true }).check(); const downloaded = page.waitForEvent("download"); await dialog.getByRole("button", { name: "导出 JSON", exact: true }).click(); expect((await downloaded).suggestedFilename()).toBe("RepoLens-调查.json");
  const invalidRange = { ...original, id: "invalid-range", title: "需要重新定位的调查", items: [{ ...original.items[0], references: [{ fileId: "task.ts", startLine: 2, endLine: 1 }] }] };
  await dialog.getByLabel("导入调查 JSON").setInputFiles({ name: "invalid-range.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ version: 1, kind: "repolens-investigations", records: [invalidRange] })) });
  await dialog.getByRole("button", { name: "确认导入", exact: true }).click();
  await expect.poll(() => fixture.records().length).toBe(3);
  await expect(dialog.getByRole("button", { name: "task.ts:2–1", exact: true })).toBeDisabled();
  let release!: () => void; let started!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); const ready = new Promise<void>(resolve => { started = resolve; });
  await page.route(`${api}/api/source?**`, async route => { started(); await gate; await route.fulfill({ contentType: "application/json", body: JSON.stringify({ source: "export const value = 1;\n", repositoryId: snapshot.id, revision: "r1" }) }).catch(() => {}); });
  try {
  await dialog.getByLabel("导入调查 JSON").setInputFiles({ name: "late.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ version: 1, kind: "repolens-investigations", records: [{ ...original, id: "late" }] })) });
  await dialog.getByRole("button", { name: "确认导入", exact: true }).click(); await ready;
  await page.keyboard.press("Escape"); const menu = await openRepositoryMenu(page); await menu.getByRole("button", { name: "清除全部 RepoLens 保存数据", exact: true }).click();
  release(); await expect.poll(() => fixture.records().length).toBe(0); await expect(page.locator(".investigation-entry")).not.toContainText(" · ");
  } finally { release(); }
});

test("revision comparison organizes file-level consumer and test checks into a saved investigation", async ({ page }) => {
  const fixture = await setup(page); await page.locator(".overview-disclosure > summary").click();
  const panel = page.getByLabel("变更阅读", { exact: true }); await panel.getByRole("button", { name: "比较", exact: true }).click();
  await expect(panel).toContainText("assets.bin（超过 64 MiB，未比较内容）");
  await expect(panel).not.toContainText("已按对象内容判断是否有变更");
  const checks = page.getByLabel("建议检查", { exact: true }); await expect(checks).toContainText("task.test.ts"); await expect(checks).toContainText("无法列全旧版本使用方");
  await checks.getByLabel("task.test.ts 检查状态", { exact: true }).selectOption("checked"); await checks.getByRole("button", { name: "加入调查记录", exact: true }).click();
  await expect.poll(() => fixture.records().length).toBe(1); expect(fixture.records()[0].checks?.["task.test.ts"]).toBe("checked");
});


test("a delayed workspace read cannot restore investigations after a successful clear", async ({ page }) => {
  const fixture = await setup(page, { initial: [original] });
  await expect(page.getByRole("button", { name: "调查记录 · 1", exact: true })).toBeVisible();
  const held = fixture.holdNextRead();
  try {
    const menu = await openRepositoryMenu(page); await menu.getByRole("button", { name: "重新扫描", exact: true }).click(); await held.ready;
    const reopenedMenu = await openRepositoryMenu(page); await reopenedMenu.getByRole("button", { name: "清除全部 RepoLens 保存数据", exact: true }).click();
    await expect.poll(() => fixture.records().length).toBe(0);
    const late = page.waitForResponse(response => response.request().method() === "GET" && response.url().includes(`/api/workspace?repositoryId=${snapshot.id}`));
    held.release(); await late;
    await expect.poll(() => page.evaluate(async workspaceId => {
      const modulePath = "/data/investigation-state.mjs";
      const state = await import(modulePath);
      return state.getInvestigationState(workspaceId).records;
    }, snapshot.id)).toEqual([]);
    expect(fixture.records()).toEqual([]);
  } finally { held.release(); }
});

test("a full saved investigation keeps the completed answer available as a separate record", async ({ page }) => {
  const full = { ...original, items: Array.from({ length: 199 }, (_, index) => ({ ...original.items[0], id: `old-${index}` })) };
  const fixture = await setup(page, { initial: [full] });
  await page.getByRole("button", { name: "调查记录 · 1", exact: true }).click();
  await page.getByRole("dialog", { name: "调查记录", exact: true }).getByRole("button", { name: "继续调查", exact: true }).click();
  const chat = page.getByRole("complementary", { name: "AI 聊天", exact: true });
  await expect(chat.getByRole("button", { name: "发送", exact: true })).toBeEnabled(); await chat.getByRole("button", { name: "发送", exact: true }).click();
  await expect(chat.getByText("检查任务取消", { exact: true })).toBeVisible();
  await expect(chat.locator(".chat-pending-turn")).toHaveCount(0);
  await expect(chat.getByText(/请将本次结果另存调查/)).toBeVisible();
  expect(fixture.records()[0].items.length).toBe(199);
  await chat.getByRole("button", { name: "保存调查", exact: true }).click(); await expect.poll(() => fixture.records().length).toBe(2);
});


test("a new conversation starts a new investigation without changing the prior saved investigation", async ({ page }) => {
  const fixture = await setup(page, { initial: [original] });
  await page.getByRole("button", { name: "调查记录 · 1", exact: true }).click();
  await page.getByRole("dialog", { name: "调查记录", exact: true }).getByRole("button", { name: "继续调查", exact: true }).click();
  const chat = page.getByRole("complementary", { name: "AI 聊天", exact: true });
  await expect(chat.getByRole("button", { name: "发送", exact: true })).toBeEnabled(); await chat.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => fixture.records()[0].items.length).toBe(4);
  await chat.getByRole("button", { name: "新对话", exact: true }).click();
  await chat.getByRole("button", { name: "AI 任务", exact: true }).click(); await page.getByRole("menuitem", { name: "定位改动位置", exact: true }).click();
  await chat.getByLabel("提问或追问", { exact: true }).fill("重新调查任务状态的更新位置");
  const saved = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/api/workspace") && response.request().postDataJSON().action === "conversations");

  await expect(chat.getByRole("button", { name: "发送", exact: true })).toBeEnabled(); await chat.getByRole("button", { name: "发送", exact: true }).click();
  await expect(chat.getByText("检查任务取消", { exact: true })).toBeVisible(); await expect(chat.locator(".chat-pending-turn")).toHaveCount(0);
  await saved;
  expect(fixture.records()[0].items.length).toBe(4);
});


test("a failed chat write is not automatically retried for the same operation prefix", async ({ page }) => {
  const fixture = await setup(page);
  await page.getByRole("button", { name: "打开 AI 聊天", exact: true }).click();
  const chat = page.getByRole("complementary", { name: "AI 聊天", exact: true });
  await expect(chat.getByRole("button", { name: "新对话", exact: true })).toBeEnabled();
  await page.clock.install(); fixture.failChatWrites(true);
  const first = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/api/workspace") && response.request().postDataJSON().action === "conversations");
  await chat.getByRole("button", { name: "新对话", exact: true }).click(); await first;
  await expect(chat.getByText(/对话尚未保存：/)).toBeVisible();
  await page.clock.runFor(1000);
  expect(fixture.chatWrites()).toBe(1);
  fixture.failChatWrites(false);
  const second = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/api/workspace") && response.request().postDataJSON().action === "conversations");
  await chat.getByRole("button", { name: "重试保存", exact: true }).click(); await second;
  await expect(chat.getByText(/对话尚未保存：/)).toHaveCount(0);
  expect(fixture.chatWrites()).toBe(2);
  await page.clock.runFor(1000);
  expect(fixture.chatWrites()).toBe(2);
  await page.reload(); await enterRepositoryLocation(page, "D:/temporary-investigation-fixture"); await page.getByRole("button", { name: "打开仓库", exact: true }).click();
  await page.getByRole("button", { name: "打开 AI 聊天", exact: true }).click();
  await page.getByRole("button", { name: "聊天历史", exact: true }).click();
  await expect(page.locator(".chat-history-list")).toContainText("新对话");
});
