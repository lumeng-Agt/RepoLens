import type { AiRouteRecord, ReadingNote } from "../data/model";
import { test, expect } from "@playwright/test";
import { readFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import { createAiRouteRecord } from "../data/ai-route.mjs";
import { withRealWorkspace } from "./helpers/real-workspace";

for (const desktop of [true, false]) for (const scenario of ["count", "merged", "bytes", "depth"]) {
  test(`${desktop ? "desktop" : "browser"} reading import rejects ${scenario} before mutation and normal saves still work`, async ({ page }) => {
    await withRealWorkspace(page, async ({ snapshot, data, api, open }) => {
      const workspaceId = snapshot.workspaceId ?? snapshot.id;
      const envelope = { format: "repolens-reading", version: 1, workspaceId, notes: [] as ReadingNote[], tours: [] as AiRouteRecord[] };
      const route = (i: number) => createAiRouteRecord({ repositoryId: snapshot.id, entryFileId: "main.ts", revision: snapshot.revision, title: `Route ${i}`, steps: [{ fileId: "main.ts", purpose: "Read", references: [{ fileId: "main.ts", startLine: 1 }] }], contextFiles: [{ fileId: "main.ts", contentHash: snapshot.files[0].contentHash }] });
      const upload = async (text: string) => page.locator(".reading-import-button input").setInputFiles({ name: "reading.json", mimeType: "application/json", buffer: Buffer.from(text) });
      const write = (action: string) => page.waitForResponse(r => r.url() === api + "/api/workspace" && r.request().method() === "POST" && r.request().postDataJSON()?.action === action);
      if (scenario === "merged") {
        await upload(JSON.stringify({ ...envelope, tours: Array.from({ length: 99 }, (_, i) => route(i)) }));
        await expect(page.getByRole("dialog", { name: "导入预览" })).toBeVisible();
        const saved = write("saved-tours");
        await page.getByRole("button", { name: "确认导入", exact: true }).click();
        expect((await saved).status()).toBe(200);
        await expect(page.getByRole("dialog", { name: "导入预览" })).toBeHidden();
      }
      const note = { id: "imported", fileId: "main.ts", path: "main.ts", startLine: 1, text: "note", contentHash: snapshot.files[0].contentHash, createdAt: 1, kind: "note" };
      let text: string;
      if (scenario === "count" || scenario === "merged") text = JSON.stringify({ ...envelope, tours: Array.from({ length: scenario === "count" ? 101 : 2 }, (_, i) => route(i + 99)) });
      else if (scenario === "bytes") text = JSON.stringify({ ...envelope, notes: Array.from({ length: 140 }, (_, i) => ({ ...note, id: `note-${i}`, text: "x".repeat(16000) })) });
      else text = JSON.stringify({ ...envelope, notes: [] }).replace('"notes":[]', '"notes":[' + JSON.stringify(note).slice(0, -1) + ',"future":' + '{"x":'.repeat(12000) + '0' + '}'.repeat(12000) + '}]');
      const rejectedWrites: string[] = [];
      page.on("request", request => { if (request.url() === api + "/api/workspace" && request.method() === "POST" && ["reading-notes", "saved-tours"].includes(request.postDataJSON()?.action)) rejectedWrites.push(request.postDataJSON().action); });
      await upload(text);
      await expect(page.locator(".reading-artifacts")).toContainText(scenario === "bytes" ? "2 MB" : scenario === "depth" ? "层级" : "100");
      await expect(page.getByRole("dialog", { name: "导入预览" })).toBeHidden();
      expect(rejectedWrites).toEqual([]);
      await page.getByLabel("阅读笔记内容").fill("Normal note after rejected import");
      const noteSaved = write("reading-notes"); await page.getByRole("button", { name: "保存记录", exact: true }).click();
      expect((await (await noteSaved).json()).ok).toBe(true);
      const builder = page.locator(".manual-tour-builder"); await builder.locator("summary").click();
      await builder.getByLabel("路线标题").fill("Normal route after rejected import"); await builder.locator('input[type="checkbox"]').first().check();
      const tourSaved = write("saved-tours"); await builder.getByRole("button", { name: "创建并开始路线" }).click();
      expect((await (await tourSaved).json()).ok).toBe(true);
      const disk = JSON.parse(await readFile(path.join(data, "workspace-v1.json"), "utf8"));
      expect(disk.readingNotes[workspaceId]).toHaveLength(1);
      expect(disk.savedTours[workspaceId]).toHaveLength(scenario === "merged" ? 100 : 1);
      await page.reload();
      await open();
      await expect(page.locator(".reading-note-list")).toContainText("Normal note after rejected import");
      await expect(page.locator(".saved-tour-list > summary")).toContainText(String(scenario === "merged" ? 100 : 1));
    }, { desktop });
  });
}

for (const scope of ["all", "current"]) test(`${scope} copy-only cleanup retry leaves a new real model request running`, async ({ page }) => {
  await withRealWorkspace(page, async ({ data, api, open, snapshot: original }) => {
    const obstruction = path.join(data, "workspace-v1.json.corrupt-123"); await mkdir(obstruction);
    const menu = page.locator(".repo-menu"); await menu.locator(":scope > summary").click();
    await menu.getByRole("button", { name: scope === "all" ? "清除全部 RepoLens 保存数据" : "清除此仓库的阅读记录", exact: true }).click();
    await expect(page.getByText("阅读记录已清除，保存副本未能清理", { exact: false }).first()).toBeVisible();
    const snapshot = scope === "all" ? await open() : original;
    await page.getByLabel("阅读笔记内容").fill("New note before retry");
    const saved = page.waitForResponse(r => r.url() === api + "/api/workspace" && r.request().method() === "POST" && r.request().postDataJSON()?.action === "reading-notes");
    await page.getByRole("button", { name: "保存记录", exact: true }).click(); expect((await saved).status()).toBe(200);
    let release!: () => void, entered!: () => void, released = false, closed = false, calls = 0;
    const hold = new Promise<void>(resolve => { release = () => { released = true; resolve(); }; });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const model = createServer(async (request, response) => {
      for await (const chunk of request) void chunk;
      calls++; response.on("close", () => { if (!released) closed = true; }); entered();
      await hold; if (response.destroyed) return;
      response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: "COPY_RETRY_ANSWER", insufficientEvidence: false, references: [{ fileId: "main.ts", startLine: 1 }] }) } }] }));
    });
    await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
    try {
      await page.locator(".settings-trigger").click(); const settings = page.getByRole("dialog", { name: "模型设置" });
      await settings.getByLabel("模型服务地址").fill(`http://127.0.0.1:${(model.address() as import("node:net").AddressInfo).port}`);
      await settings.getByLabel("模型名称").fill("copy-retry-test"); await settings.getByLabel("API 密钥").fill("test-only");
      const configured = page.waitForResponse(r => r.url() === api + "/api/ai/settings" && r.request().method() === "POST");
      await settings.getByRole("button", { name: "应用设置", exact: true }).click(); expect((await configured).status()).toBe(200);
      await settings.getByRole("button", { name: "关闭", exact: true }).click();
      await page.getByRole("button", { name: "打开 AI 聊天", exact: true }).click();
      await page.locator(".ai-chat-sidebar").getByLabel("提问或追问").fill("value 是怎样定义的？");
      await expect(page.getByRole("button", { name: "发送", exact: true })).toBeEnabled(); expect(calls).toBe(0);
      await page.getByRole("button", { name: "发送", exact: true }).click(); await reached;
      await rm(obstruction, { recursive: true });
      const retried = page.waitForResponse(r => r.url() === api + "/api/workspace" && r.request().method() === "POST" && r.request().postDataJSON()?.action === (scope === "all" ? "clear-all" : "clear-repository"));
      await page.getByRole("button", { name: "重试清除", exact: true }).click(); expect((await (await retried).json()).ok).toBe(true);
      await expect(page.getByText("剩余保存副本已清理，新阅读记录已保留。", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "停止", exact: true })).toBeVisible(); expect(closed).toBe(false);
      release(); await expect(page.getByText("COPY_RETRY_ANSWER", { exact: true })).toBeVisible();
      const disk = JSON.parse(await readFile(path.join(data, "workspace-v1.json"), "utf8"));
      expect(disk.readingNotes[snapshot.workspaceId ?? snapshot.id][0].text).toBe("New note before retry"); expect(calls).toBe(1);
    } finally { release(); model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())); }
  });
});


test("a full route collection keeps the generated route in chat until an explicit delete and save", async ({ page }, testInfo) => {
  await withRealWorkspace(page, async ({ snapshot, api, data, open }) => {
    const workspaceId = snapshot.workspaceId ?? snapshot.id;
    const routes = Array.from({ length: 100 }, (_, i) => createAiRouteRecord({ repositoryId: snapshot.id, entryFileId: "main.ts", revision: snapshot.revision!, title: `Manual ${i}`, steps: [{ fileId: "main.ts", purpose: "Read", references: [{ fileId: "main.ts", startLine: 1 }] }], contextFiles: [{ fileId: "main.ts", contentHash: snapshot.files[0].contentHash! }] }));
    const seeded = await page.request.post(api + "/api/workspace", { headers: { Origin: new URL(page.url()).origin }, data: { action: "saved-tours", repositoryId: snapshot.id, workspaceId, persistenceSessionId: snapshot.persistenceSessionId, tours: routes } });
    expect((await seeded.json()).ok).toBe(true);
    const menu = page.locator(".repo-menu"); await menu.locator(":scope > summary").click(); await menu.getByRole("button", { name: "返回首页", exact: true }).click();
    await open();
    let calls = 0;
    const model = createServer(async (request, response) => {
      for await (const chunk of request) void chunk;
      calls++; response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: "AI route at capacity", steps: Array.from({ length: 3 }, (_, i) => ({ fileId: "main.ts", purpose: `Read ${i}`, relationship: "Static source", question: "What is exported?", references: [{ fileId: "main.ts", startLine: 1 }] })) }) } }] }));
    });
    await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
    try {
      await page.locator(".settings-trigger").click(); const settings = page.getByRole("dialog", { name: "模型设置" });
      await settings.getByLabel("模型服务地址").fill(`http://127.0.0.1:${(model.address() as import("node:net").AddressInfo).port}`); await settings.getByLabel("模型名称").fill("capacity-test"); await settings.getByLabel("API 密钥").fill("test-only");
      const configured = page.waitForResponse(r => r.url() === api + "/api/ai/settings" && r.request().method() === "POST"); await settings.getByRole("button", { name: "应用设置", exact: true }).click(); expect((await configured).status()).toBe(200); await settings.getByRole("button", { name: "关闭", exact: true }).click();
      await page.getByRole("button", { name: "打开 AI 聊天", exact: true }).click();
      await page.locator(".ai-chat-sidebar").getByRole("button", { name: "规划阅读路线", exact: true }).click();
      await expect(page.getByRole("button", { name: "发送", exact: true })).toBeEnabled(); expect(calls).toBe(0);
      const generated = page.waitForResponse(r => r.url() === api + "/api/ai/generate");
      await page.getByRole("button", { name: "发送", exact: true }).click(); await generated;
      await expect(page.getByText("本次路线未加入已保存路线；完整内容已保留在这条回答中。", { exact: true })).toBeVisible();
      for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 375, height: 812 }]) {
        await page.setViewportSize(viewport);
        await expect(page.locator(".ai-chat-sidebar").getByRole("button", { name: "保存路线", exact: true })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath(`route-capacity-${viewport.width}.png`) });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      let disk = JSON.parse(await readFile(path.join(data, "workspace-v1.json"), "utf8"));
      expect(disk.savedTours[workspaceId].map((r: {signature: string}) => r.signature)).toEqual(routes.map(r => r.signature));
      expect(disk.conversations[workspaceId][0].messages.at(-1).route.title).toBe("AI route at capacity");
      await page.locator(".saved-tour-list > summary").click();
      const deleted = page.waitForResponse(r => r.url() === api + "/api/workspace" && r.request().method() === "POST" && r.request().postDataJSON()?.action === "saved-tours");
      await page.getByRole("button", { name: "删除路线：Manual 0", exact: true }).click(); expect((await (await deleted).json()).ok).toBe(true);
      const saved = page.waitForResponse(r => r.url() === api + "/api/workspace" && r.request().method() === "POST" && r.request().postDataJSON()?.action === "saved-tours");
      await page.locator(".ai-chat-sidebar").getByRole("button", { name: "保存路线", exact: true }).click(); expect((await (await saved).json()).ok).toBe(true);
      disk = JSON.parse(await readFile(path.join(data, "workspace-v1.json"), "utf8"));
      expect(disk.savedTours[workspaceId]).toHaveLength(100);
      expect(disk.savedTours[workspaceId].some((r: {title: string}) => r.title === "AI route at capacity")).toBe(true);
      expect(disk.savedTours[workspaceId].some((r: {signature: string}) => r.signature === routes[0].signature)).toBe(false);
      expect(calls).toBe(1);
    } finally { model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())); }
  });
});
