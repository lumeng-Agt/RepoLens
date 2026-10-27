import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { enterRepositoryLocation, test, expect } from "./fixtures";
import { installResizeObserverProbe } from "./helpers/resize-observer-probe";

const api = "http://127.0.0.1:4319";
const markdown = "## 数据如何传递\n\n先从 `main.ts` 查看入口，再核对依赖。\n\n- 读取输入\n  - 校验参数\n  - 调用 helper\n- 返回结果\n\n> 静态引用不代表运行时调用顺序。\n\n| 文件 | 职责 |\n| --- | --- |\n| main.ts | 入口 |\n| helper.ts | 计算 |\n\n```ts\nexport function main() {\n  return answer + 1;\n}\n```\n\n<img src=\"https://tracking.invalid/test\" onerror=\"alert(1)\">\n\n![tracking](https://tracking.invalid/pixel)";

test("chat keeps context explicit, evidence local, drafts editable, and controls visible", async ({ page }) => {
  await mkdir(".artifacts/chat-redesign", { recursive: true });
  const temp = await mkdtemp(path.join(os.tmpdir(), "repolens-chat-design-"));
  const probe = await installResizeObserverProbe(page);
  const ids = ["main.ts", "helper.ts", "third.ts", "fourth.ts"];
  const snapshot = { id: "chat-design", workspaceId: "chat-design", version: "fixture", name: "Design fixture", description: "", source: "local", revision: "r1", sequence: 1, files: ids.map(id => ({ id, path: id, name: id, kind: "typescript", language: "ts", role: "模块", summary: "", imports: [], contentHash: id + "-hash" })), dependencies: [], tour: [], diagnostics: [], unresolved: [] };
  const contextFiles = ids.map(fileId => ({ fileId, contentHash: fileId + "-hash", startLine: 1, endLine: 2 }));
  let saved = [{ id: "saved", title: "理解数据保存与依赖关系的较长对话标题", updatedAt: Date.now(), messages: [
    { id: "u1", role: "user", content: "main 如何得到数据？", references: [], contextFiles },
    { id: "a1", role: "assistant", content: markdown, references: [{ fileId: "main.ts", startLine: 1, endLine: 2 }], contextFiles, claims: [{ text: "需核对的独立结论", referenceIndices: [0] }] },
    { id: "stale", role: "assistant", content: "旧版本的结论", stale: true, contextFiles, references: [{ fileId: "helper.ts", startLine: 1 }] },
  ] }];
  let modelCalls = 0; let previewCount = 0; const bodies: { fileIds?: string[] }[] = []; let failSave = false;
  let externalRequests = 0; page.on("request", request => { if (request.url().includes("tracking.invalid")) externalRequests++; });
  await page.route(`${api}/api/**`, async route => {
    const request = route.request(); const url = new URL(request.url());
    const json = (value: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(value) });
    if (url.pathname === "/api/open") return json(snapshot);
    if (url.pathname === "/api/events") return route.fulfill({ status: 204 });
    if (url.pathname === "/api/source") return json({ source: "export const answer = 42;\nexport const main = answer;", repositoryId: snapshot.id, revision: "r1" });
    if (url.pathname === "/api/ai/settings") return json({ configured: true, model: "mock-model", baseUrl: "https://model.example/v1" });
    if (url.pathname === "/api/workspace" && request.method() === "GET") return json({ version: 1, recentRepositories: [], aiResults: {}, aiRoute: null, progress: {}, nodePositions: {}, conversations: saved });
    if (url.pathname === "/api/workspace") { const body = request.postDataJSON(); if (body.action === "conversations") { if (failSave) return json({ ok: false, warning: "测试磁盘写入失败" }); saved = body.conversations; } return json({ ok: true }); }
    if (url.pathname.endsWith("/preview")) {
      const body = request.postDataJSON(); bodies.push(body); previewCount++;
      return json({ scopeRequired: false, preview: { id: `p${previewCount}`, repositoryId: snapshot.id, revision: "r1", entryFileId: body.fileId, mode: body.mode ?? "question", baseUrl: "https://model.example/v1", model: "mock-model", files: (body.fileIds ?? ids.slice(0, 3)).map((fileId: string) => ({ fileId, startLine: 1, endLine: 2, contentHash: fileId + "-hash", reasons: ["命中符号 answer"] })), characters: 500, expiresAt: Date.now() + 600000 } });
    }
    if (url.pathname === "/api/ai/generate") { modelCalls++; return json({ result: { answer: "新的有效回答", references: [{ fileId: "helper.ts", startLine: 1 }] }, cached: false, repositoryId: snapshot.id, revision: "r1", entryFileId: "main.ts", mode: "question" }); }
    if (url.pathname === "/api/close") return json({ ok: true });
    return json({ error: url.pathname });
  });
  try {
    await page.goto("/"); await enterRepositoryLocation(page, temp); await page.getByRole("button", { name: "打开仓库", exact: true }).click();
    await page.getByRole("treeitem", { name: "main.ts", exact: true }).click(); await page.getByRole("button", { name: "打开 AI 聊天", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "AI 聊天", exact: true });
    await expect(panel.getByRole("heading", { name: "数据如何传递" })).toBeVisible();
    await expect(panel.locator("ul ul li")).toHaveCount(2);
    await expect(panel.getByRole("table")).toHaveCount(1);
    await expect(panel.locator("blockquote")).toHaveText("静态引用不代表运行时调用顺序。");
    await expect(panel.locator(".chat-code .token.keyword").first()).toBeVisible();
    expect(externalRequests).toBe(0); await expect(panel.locator("img, script")).toHaveCount(0);
    await expect(panel.getByText("需核对的独立结论")).toBeHidden();
    await panel.getByText("结论与依据", { exact: true }).click(); await expect(panel.getByText("需核对的独立结论")).toBeVisible();
    await panel.getByText("结论与依据", { exact: true }).click();
    const citation = panel.getByRole("button", { name: "main.ts:1–2", exact: true }).last();
    await citation.click(); await expect(panel.getByRole("complementary", { name: "回答证据" })).toContainText("export const answer = 42");
    await panel.getByRole("button", { name: "关闭证据", exact: true }).click();
    await expect(panel.getByRole("button", { name: "helper.ts:1", exact: true })).toBeDisabled();
    await panel.getByText("旧版本的结论", { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: ".artifacts/chat-redesign/stale-reference.png" });
    const input = page.getByLabel("提问或追问", { exact: true });
    await panel.getByRole("button", { name: "编辑为新问题", exact: true }).first().click();
    await expect(input).toHaveValue("main 如何得到数据？"); expect(modelCalls).toBe(0);
    const send = page.getByRole("button", { name: "发送", exact: true }); await expect(send).toBeEnabled();
    await expect(panel.getByRole("button", { name: "添加文件", exact: true })).toContainText("另 1 个文件");
    await panel.getByRole("button", { name: "移除附件 main.ts", exact: true }).click(); await expect(send).toBeDisabled(); await expect(send).toBeEnabled(); expect(bodies.at(-1)?.fileIds).toEqual(["helper.ts", "third.ts"]);
    await panel.getByRole("button", { name: "添加文件", exact: true }).click();
    await page.getByLabel("筛选聊天附件").fill("fourth"); await page.getByRole("button", { name: "fourth.ts", exact: true }).click();
    await expect(page.getByText("手动添加", { exact: true })).toBeVisible(); await page.keyboard.press("Escape");
    await expect(send).toBeEnabled(); expect(bodies.at(-1)?.fileIds).toEqual(["helper.ts", "third.ts", "fourth.ts"]); expect(modelCalls).toBe(0);
    await page.screenshot({ path: ".artifacts/chat-redesign/conversation-1440.png" });
    await panel.getByRole("button", { name: "AI 任务", exact: true }).click(); await page.getByRole("menuitem", { name: "讲解当前文件", exact: true }).click();
    await expect(panel.getByText("改为提问", { exact: true })).toBeVisible(); await expect(input).toHaveCount(0);
    await expect(panel.getByText("必需", { exact: true })).toBeVisible();
    await expect(send).toBeEnabled(); await panel.getByRole("button", { name: "添加文件", exact: true }).click();
    await expect(page.getByText(/已选历史 0 条/)).toBeVisible(); await page.keyboard.press("Escape");
    await panel.getByRole("button", { name: "改为提问", exact: true }).click();
    await input.fill(Array(14).fill("多行草稿，检查输入框增长与按钮位置").join("\n"));
    await expect(send).toBeEnabled(); const inputBox = await input.boundingBox(); expect(inputBox!.height).toBeLessThanOrEqual(157);
    for (const width of [320, 400, 480]) {
      if (width === 480) await page.setViewportSize({ width: 1680, height: 900 });
      const handle = page.getByRole("separator", { name: "调整 AI 栏宽度", exact: true });
      const box = await handle.boundingBox(); const currentWidth = (await panel.boundingBox())!.width;
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await page.mouse.down(); await page.mouse.move(box!.x + box!.width / 2 + currentWidth - width, box!.y + box!.height / 2, { steps: 10 }); await page.mouse.up();
      await expect.poll(async () => Math.abs((await panel.boundingBox())!.width - width)).toBeLessThan(12);
      await expect(input).toBeInViewport(); await expect(send).toBeInViewport(); await page.screenshot({ path: `.artifacts/chat-redesign/panel-${width}.png` });
    }
    for (const viewport of [{ width: 1024, height: 768 }, { width: 375, height: 812 }]) {
      await page.setViewportSize(viewport); await expect(input).toBeInViewport(); await expect(send).toBeInViewport();
      await expect.poll(() => panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: `.artifacts/chat-redesign/conversation-${viewport.width}.png` });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await panel.getByRole("button", { name: "聊天历史", exact: true }).click(); await expect(page.locator(".chat-history-list small")).toBeVisible(); await page.getByLabel("搜索聊天历史").fill("不存在的内容"); await expect(page.getByText("没有匹配的对话")).toBeVisible(); await page.keyboard.press("Escape");
    await expect(page.getByLabel("搜索聊天历史")).toBeHidden();
    while (await panel.getByRole("button", { name: /^移除附件 / }).count()) await panel.getByRole("button", { name: /^移除附件 / }).first().click();
    await expect(send).toBeDisabled(); await expect(panel.getByText("请添加至少一个源码文件。", { exact: true })).toBeVisible(); expect(modelCalls).toBe(0);
    await panel.getByRole("button", { name: "添加文件", exact: true }).click(); await page.getByLabel("筛选聊天附件").fill("helper"); await page.getByRole("button", { name: "helper.ts", exact: true }).click(); await page.keyboard.press("Escape"); await expect(send).toBeEnabled(); expect(bodies.at(-1)?.fileIds).toEqual(["helper.ts"]);
    failSave = true; await panel.getByRole("button", { name: "新对话", exact: true }).click(); await expect(panel.getByText(/对话尚未保存：/)).toBeInViewport();
    await page.screenshot({ path: ".artifacts/chat-redesign/save-failure.png" }); failSave = false; await panel.getByRole("button", { name: "重试保存", exact: true }).click(); await expect(panel.getByText(/对话尚未保存：/)).toHaveCount(0);
    expect(modelCalls).toBe(0);
    await writeFile(".artifacts/chat-redesign/resize-observer.json", JSON.stringify(await probe.errors(), null, 2));
  } finally { await rm(temp, { recursive: true, force: true }); }
});
