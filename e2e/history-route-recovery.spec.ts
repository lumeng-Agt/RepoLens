import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createAiRouteRecord } from "../data/ai-route.mjs";
import type { RepositorySnapshot } from "../data/model";
import { withRealWorkspace } from "./helpers/real-workspace";

async function seed(page: Page, api: string, snapshot: RepositorySnapshot, action: string, value: Record<string, unknown>) {
  const result = await page.request.post(api + "/api/workspace", { headers: { Origin: new URL(page.url()).origin }, data: { action, repositoryId: snapshot.id, workspaceId: snapshot.workspaceId ?? snapshot.id, persistenceSessionId: snapshot.persistenceSessionId, ...value } });
  expect((await result.json()).ok).toBe(true);
}
async function reopen(page: Page, open: () => Promise<RepositorySnapshot>) {
  const menu = page.locator(".repo-menu"); await menu.locator(":scope > summary").click();
  await menu.getByRole("button", { name: "返回首页", exact: true }).click(); return open();
}
const nextWrite = (page: Page, api: string, action: string) => page.waitForResponse(r => r.url() === api + "/api/workspace" && r.request().method() === "POST" && r.request().postDataJSON()?.action === action);

for (const desktop of [true, false]) test.describe(desktop ? "desktop storage" : "browser storage", () => {

test("full chat history blocks new conversations until an explicit deletion and survives reload", async ({ page }) => {
  await withRealWorkspace(page, async ({ api, snapshot, data, open }) => {
    const conversations = Array.from({ length: 100 }, (_, i) => ({ id: `saved-${i}`, title: `Saved ${i}`, messages: [{ id: `answer-${i}`, role: "assistant", content: `Important ${i}`, references: [], contextFiles: [] }], updatedAt: 100 - i }));
    await seed(page, api, snapshot, "conversations", { conversations }); await reopen(page, open);
    await page.getByRole("button", { name: "打开 AI 聊天", exact: true }).click(); await expect(page.getByText("Important 0", { exact: true })).toBeVisible();
    await page.locator(".ai-chat-sidebar").getByRole("button", { name: "新对话", exact: true }).click();
    await expect(page.locator(".ai-chat-sidebar")).toContainText("最多保存 100 个对话");
    let disk = JSON.parse(await readFile(path.join(data, "workspace-v1.json"), "utf8"));
    expect(disk.conversations[snapshot.workspaceId ?? snapshot.id]).toEqual(conversations);
    await page.getByRole("button", { name: "聊天历史", exact: true }).click(); await page.getByRole("button", { name: "会话菜单", exact: true }).click();
    const deleted = nextWrite(page, api, "conversations"); await page.getByRole("menuitem", { name: "删除对话", exact: true }).click(); expect((await (await deleted).json()).ok).toBe(true);
    const added = nextWrite(page, api, "conversations"); await page.locator(".ai-chat-sidebar").getByRole("button", { name: "新对话", exact: true }).click(); expect((await (await added).json()).ok).toBe(true);
    disk = JSON.parse(await readFile(path.join(data, "workspace-v1.json"), "utf8"));
    expect(disk.conversations[snapshot.workspaceId ?? snapshot.id]).toHaveLength(100);
    expect(disk.conversations[snapshot.workspaceId ?? snapshot.id].some((item: {id: string}) => item.id === "saved-99")).toBe(true);
    await page.reload(); await open(); await page.getByRole("button", { name: "打开 AI 聊天", exact: true }).click();
    await page.getByRole("button", { name: "聊天历史", exact: true }).click(); await page.getByLabel("搜索聊天历史").fill("Saved 99"); await expect(page.locator(".chat-history-list")).toContainText("Saved 99");
  }, { desktop });
});

test("legacy routes render safely and round-trip unchanged alongside new records", async ({ page }) => {
  await withRealWorkspace(page, async ({ api, snapshot, data, open }) => {
    const tours = [{ signature: "legacy", title: "Legacy route", future: { keep: [1, 2] } }, { title: "Unsigned A", extra: "keep" }, { title: "Unsigned B" }, { title: "Unsigned B" }];
    await seed(page, api, snapshot, "saved-tours", { tours }); await reopen(page, open);
    await expect(page.locator(".reading-artifacts")).toContainText("旧路线内容不完整");
    await page.locator(".saved-tour-list > summary").click();
    const legacy = page.locator(".saved-tour-list article").filter({ hasText: "Legacy route" });
    await expect(legacy.getByRole("button", { name: "打开路线", exact: true })).toBeDisabled();
    const download = page.waitForEvent("download"); await page.locator(".reading-artifacts").getByRole("button", { name: "JSON", exact: true }).click();
    const file = await (await download).path(); expect(file).toBeTruthy(); expect(JSON.parse(await readFile(file!, "utf8")).tours).toEqual(tours);
    await page.getByLabel("阅读笔记内容").fill("New note"); const note = nextWrite(page, api, "reading-notes"); await page.getByRole("button", { name: "保存记录", exact: true }).click(); await note;
    const builder = page.locator(".manual-tour-builder"); await builder.locator("summary").click(); await builder.getByLabel("路线标题").fill("New route"); await builder.locator('input[type="checkbox"]').check();
    const saved = nextWrite(page, api, "saved-tours"); await builder.getByRole("button", { name: "创建并开始路线", exact: true }).click(); expect((await (await saved).json()).ok).toBe(true);
    await page.reload(); await open();
    const disk = JSON.parse(await readFile(path.join(data, "workspace-v1.json"), "utf8")); expect(disk.savedTours[snapshot.workspaceId ?? snapshot.id].slice(0, 4)).toEqual(tours); expect(disk.savedTours[snapshot.workspaceId ?? snapshot.id]).toHaveLength(5);
  }, { desktop });
});

test("an eight-step manual route supports title edits, reordering and explicit step removal", async ({ page }) => {
  await withRealWorkspace(page, async ({ api, snapshot, data, open }) => {
    const notes = Array.from({ length: 8 }, (_, i) => ({ id: `note-${i}`, fileId: "main.ts", path: "main.ts", startLine: 1, text: `Read ${i}`, contentHash: snapshot.files[0].contentHash, createdAt: i, kind: "note" }));
    await seed(page, api, snapshot, "reading-notes", { notes }); await reopen(page, open);
    const builder = page.locator(".manual-tour-builder"); await builder.locator("summary").click(); await builder.getByLabel("路线标题").fill("Eight-step route"); for (const box of await builder.locator('input[type="checkbox"]').all()) await box.check();
    const created = nextWrite(page, api, "saved-tours"); await builder.getByRole("button", { name: "创建并开始路线", exact: true }).click(); await created;
    await page.getByRole("tab", { name: "讲解", exact: true }).click(); await page.locator(".saved-tour-list > summary").click(); await page.locator(".saved-tour-list").getByRole("button", { name: "编辑", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "编辑阅读路线" }); await dialog.getByLabel("路线标题").fill("Edited eight-step route"); await expect(dialog.getByRole("button", { name: "校验并保存路线", exact: true })).toBeEnabled();
    await dialog.getByRole("button", { name: "下移步骤", exact: true }).first().click();
    const edited = nextWrite(page, api, "saved-tours"); await dialog.getByRole("button", { name: "校验并保存路线", exact: true }).click(); expect((await (await edited).json()).ok).toBe(true);
    let disk = JSON.parse(await readFile(path.join(data, "workspace-v1.json"), "utf8")); expect(disk.savedTours[snapshot.workspaceId ?? snapshot.id][0].steps).toHaveLength(8); expect(disk.savedTours[snapshot.workspaceId ?? snapshot.id][0].steps[0].description).toBe("Read 1");
    await page.getByRole("tab", { name: "讲解", exact: true }).click(); await page.locator(".saved-tour-list > summary").click(); await page.locator(".saved-tour-list").getByRole("button", { name: "编辑", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "编辑阅读路线" }); await dialog.getByRole("button", { name: "删除第 8 步", exact: true }).click();
    const removed = nextWrite(page, api, "saved-tours"); await dialog.getByRole("button", { name: "校验并保存路线", exact: true }).click(); expect((await (await removed).json()).ok).toBe(true);
    disk = JSON.parse(await readFile(path.join(data, "workspace-v1.json"), "utf8")); expect(disk.savedTours[snapshot.workspaceId ?? snapshot.id][0].steps).toHaveLength(7);
  }, { desktop });
});

test("unbound imported references stay unknown until explicit source revalidation, preserving origin", async ({ page }) => {
  await withRealWorkspace(page, async ({ api, snapshot, data }) => {
    const route = createAiRouteRecord({ repositoryId: "old-repository", revision: "old-commit", entryFileId: "main.ts", title: "Unknown source route", steps: [{ fileId: "main.ts", purpose: "Read", references: [{ fileId: "main.ts", startLine: 1 }] }], contextFiles: [] });
    await page.locator(".reading-import-button input").setInputFiles({ name: "reading.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ format: "repolens-reading", version: 1, workspaceId: "old-workspace", notes: [], tours: [{ ...route, steps: route.steps.map((step: object) => ({ ...step, futureStep: "kept", reference: { ...route.steps[0].reference, futureReference: "kept" } })), sourceSteps: route.sourceSteps.map((step: object) => ({ ...step, futureSourceStep: "kept", references: [{ ...route.sourceSteps[0].references[0], futureSourceReference: "kept" }] })), future: { keep: true } }] })) });
    await expect(page.getByRole("dialog", { name: "导入预览" })).toBeVisible(); const imported = nextWrite(page, api, "saved-tours"); await page.getByRole("button", { name: "确认导入", exact: true }).click(); await imported;
    await page.locator(".saved-tour-list > summary").click(); const article = page.locator(".saved-tour-list article"); await expect(article).toContainText("缺少源码哈希"); await expect(article.getByRole("button", { name: "打开路线", exact: true })).toBeDisabled();
    await article.getByRole("button", { name: "编辑", exact: true }).click(); const dialog = page.getByRole("dialog", { name: "编辑阅读路线" });
    const bound = nextWrite(page, api, "saved-tours"); await dialog.getByRole("button", { name: "校验并保存路线", exact: true }).click(); expect((await (await bound).json()).ok).toBe(true);
    const disk = JSON.parse(await readFile(path.join(data, "workspace-v1.json"), "utf8")); const saved = disk.savedTours[snapshot.workspaceId ?? snapshot.id][0]; expect(saved.contextFiles[0].contentHash).toBe(snapshot.files[0].contentHash); expect(saved.importOrigin.revision).toBe("old-commit"); expect(saved.future).toEqual({ keep: true }); expect(saved.steps[0].futureStep).toBe("kept"); expect(saved.steps[0].reference.futureReference).toBe("kept"); expect(saved.sourceSteps[0].futureSourceStep).toBe("kept"); expect(saved.sourceSteps[0].references[0].futureSourceReference).toBe("kept");
    await page.getByRole("tab", { name: "讲解", exact: true }).click(); await page.locator(".saved-tour-list > summary").click(); await expect(page.locator(".saved-tour-list").getByRole("button", { name: "打开路线", exact: true })).toBeEnabled();
  }, { desktop });
});

});
