import { mkdir } from "node:fs/promises";
import { test, expect, enterRepositoryLocation } from "./fixtures";

const api = "http://127.0.0.1:4319";

test("chat accepts immediate Enter, optional source context and followups without opening a file form", async ({ page }) => {
  await mkdir(".artifacts/chat-freedom-2026-11-06", { recursive: true });
  const snapshot = { id: "free-chat", version: "fixture", name: "Chat fixture", source: "local", revision: "r1", sequence: 1, description: "", files: [{ id: "main.ts", path: "main.ts", name: "main.ts", kind: "typescript", language: "ts", role: "模块", summary: "", imports: [], contentHash: "hash" }], dependencies: [], tour: [], diagnostics: [], unresolved: [] };
  let modelCalls = 0;
  let budgetBlocked = true;
  let saved: unknown[] = [];
  const previews: { question: string; conversation: boolean; history?: {role: string; content: string}[]; fileIds?: string[] }[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const preparing = new Promise<void>(resolve => { entered = resolve; });
  await page.route(`${api}/api/**`, async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    const json = (value: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(value) });
    if (pathname === "/api/open") return json(snapshot);
    if (pathname === "/api/events") return route.fulfill({ status: 204 });
    if (pathname === "/api/source") return json({ source: "export const value = 1;", repositoryId: snapshot.id, revision: "r1" });
    if (pathname === "/api/ai/settings") return json({ configured: true, model: "local-mock", baseUrl: "https://model.example/v1" });
    if (pathname === "/api/workspace" && request.method() === "GET") return json({ version: 1, recentRepositories: [], aiResults: {}, aiRoute: null, progress: {}, nodePositions: {}, conversations: saved });
    if (pathname === "/api/workspace") { const body = request.postDataJSON(); if (body.action === "conversations") saved = body.conversations; return json({ ok: true }); }
    if (pathname.endsWith("/preview")) {
      const body = request.postDataJSON(); previews.push(body);
      if (body.question === "你好") { entered(); await gate; }
      if (body.question === "检查历史预算" && budgetBlocked) return route.fulfill({ status: 413, contentType: "application/json", body: JSON.stringify({ scopeRequired: true, blockers: ["character_limit"], candidates: [{ fileId: "main.ts", characters: 30, lineCount: 1, oversizedLines: [] }], maxFiles: 12, maxCharacters: 60000 }) });
      return json({ scopeRequired: false, preview: { id: `p-${previews.length}`, repositoryId: snapshot.id, revision: "r1", entryFileId: "main.ts", mode: "question", conversation: true, retrievalInsufficient: true, contextNotice: "本次不附带源码。", files: [], characters: body.question.length, model: "local-mock", baseUrl: "https://model.example/v1", expiresAt: Date.now() + 600000 } });
    }
    if (pathname === "/api/ai/generate") { modelCalls++; return json({ repositoryId: snapshot.id, revision: "r1", entryFileId: "main.ts", mode: "question", cached: false, result: { answer: modelCalls === 1 ? "你好，可以直接问我。" : "可以，接着刚才的问题讨论。", references: [], insufficientEvidence: false } }); }
    return json({ ok: true });
  });
  try {
    await page.goto("/"); await enterRepositoryLocation(page, "D:/test-fixture"); await page.getByRole("button", { name: "打开仓库", exact: true }).click();
    await page.getByRole("button", { name: "打开 AI 聊天", exact: true }).click();
    const input = page.getByLabel("提问或追问", { exact: true }), panel = page.getByRole("complementary", { name: "AI 聊天", exact: true });
    await expect(input).toBeVisible(); await page.screenshot({ path: ".artifacts/chat-freedom-2026-11-06/empty-1440.png" }); await panel.screenshot({ path: ".artifacts/chat-freedom-2026-11-06/panel-empty.png" }); await input.fill("你好"); await input.press("Enter");
    await preparing; await expect(panel.getByText("正在准备发送…", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "停止", exact: true })).toBeVisible(); expect(modelCalls).toBe(0);
    await panel.getByRole("button", { name: "停止", exact: true }).click(); release();
    await expect(input).toHaveValue("你好"); await expect(panel.getByRole("button", { name: "停止", exact: true })).toHaveCount(0); expect(modelCalls).toBe(0);
    await input.press("Enter"); await expect(panel.getByText("你好，可以直接问我。", { exact: true })).toBeVisible(); expect(modelCalls).toBe(1);
    await expect(page.locator(".chat-context-popover")).toHaveCount(0);
    await expect(panel.getByText("当前源码范围不足以确认结论。", { exact: true })).toHaveCount(0);
    expect(previews[0].conversation).toBe(true); expect(previews[0].fileIds).toBeUndefined();
    await panel.getByRole("button", { name: "源码上下文：自动参考仓库", exact: true }).click();
    await page.getByRole("menuitem", { name: "仅对话，不附源码", exact: true }).click();
    await input.fill("再具体说说"); await input.press("Enter");
    await expect(panel.getByText("可以，接着刚才的问题讨论。", { exact: true })).toBeVisible(); expect(modelCalls).toBe(2);
    expect(previews.at(-1)?.fileIds).toEqual([]);
    expect(previews.at(-1)?.history?.map(item => item.content)).toEqual(["你好", "你好，可以直接问我。"]);
    await expect(panel.getByRole("button", { name: "源码上下文：仅对话", exact: true })).toBeVisible();
    for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 375, height: 812 }]) {
      await page.setViewportSize(viewport); await expect(input).toBeInViewport(); await expect(panel.getByRole("button", { name: "发送", exact: true })).toBeInViewport();
      await page.screenshot({ path: `.artifacts/chat-freedom-2026-11-06/conversation-${viewport.width}.png` });
      if (viewport.width === 1440) await panel.screenshot({ path: ".artifacts/chat-freedom-2026-11-06/panel-conversation.png" });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await input.fill("检查历史预算");
    await expect(page.getByText("问题和历史消息超过 60,000 字符，请在上下文中减少携带的历史消息。", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "源码上下文：仅对话", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "移除文件 main.ts", exact: true })).toHaveCount(0);
    await page.getByText("携带的历史消息", { exact: true }).click(); budgetBlocked = false;
    await page.locator(".chat-context-popover details input[type=checkbox]").first().uncheck();
    await expect(page.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
    await expect.poll(() => previews.at(-1)?.fileIds).toEqual([]); expect(modelCalls).toBe(2);
  } finally { release(); }
});
