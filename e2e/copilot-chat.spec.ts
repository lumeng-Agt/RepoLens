import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { enterRepositoryLocation, test, expect } from "./fixtures";

const api = "http://127.0.0.1:4319";

test("chat streams into its own scroll area, freezes context, preserves drafts and stops safely", async ({ page }) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "repolens-chat-ui-"));
  await mkdir(".artifacts/copilot-chat", { recursive: true });
  const snapshot = { id: "copilot-demo", version: "fixture", name: "Demo", description: "", source: "local", revision: "r1", sequence: 1, files: ["main.ts", "helper.ts"].map(id => ({ id, path: id, name: id, kind: "typescript", language: "ts", role: "模块", summary: "示例", imports: [], contentHash: id + "-hash" })), dependencies: [], tour: [], diagnostics: [], unresolved: [] };
  let calls = 0; let writes = 0; let previewNumber = 0; let held: ServerResponse | undefined;
  let previewId = ""; let persisted: unknown[] = []; let started!: () => void;
  let begin = new Promise<void>(resolve => { started = resolve; });
  const streaming = createServer(async (request, response) => {
    let raw = ""; for await (const part of request) raw += part;
    const body = JSON.parse(raw); previewId = body.previewId; calls++;
    if (body.stream === false) {
      response.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      response.end(JSON.stringify({ result: { answer: "普通响应已完成", insufficientEvidence: false, references: [{ fileId: "helper.ts", startLine: 1 }] }, cached: false, repositoryId: snapshot.id, revision: "r1", entryFileId: "helper.ts", mode: "question" })); return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream", "Access-Control-Allow-Origin": "*" });
    if (calls === 3) { response.end(`data: ${JSON.stringify({ type: "error", requestId: previewId, repositoryId: snapshot.id, revision: "r1", code: "STREAM_UNSUPPORTED", error: "模型服务未接受流式请求。可选择普通响应后重新发送。" })}\n\n`); return; }
    held = response;
    response.write(`data: ${JSON.stringify({ type: "text", requestId: previewId, repositoryId: snapshot.id, revision: "r1", text: "第一段正在到达。\n\n" })}\n\n`);
    started();
  });
  streaming.listen(0, "127.0.0.1"); await once(streaming, "listening");
  const address = streaming.address(); if (!address || typeof address === "string") throw Error("port");
  try {
    await page.route(`${api}/api/**`, async route => {
      const request = route.request(); const url = new URL(request.url());
      const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
      if (url.pathname === "/api/open") return json(snapshot);
      if (url.pathname === "/api/events") return route.fulfill({ status: 204 });
      if (url.pathname === "/api/source") return json({ source: "export const answer = 42;\n", repositoryId: snapshot.id, revision: "r1" });
      if (url.pathname === "/api/ai/settings") return json({ configured: true, model: "mock-stream", baseUrl: "https://model.example/v1" });
      if (url.pathname === "/api/workspace" && request.method() === "GET") return json({ version: 1, recentRepositories: [], aiResults: {}, aiRoute: null, progress: {}, nodePositions: {}, conversations: persisted });
      if (url.pathname === "/api/workspace") { if (request.postDataJSON().action === "conversations") { writes++; persisted = request.postDataJSON().conversations; } return json({ ok: true }); }
      if (url.pathname.endsWith("/preview")) { const input = request.postDataJSON(); previewNumber++; return json({ scopeRequired: false, preview: { id: "preview-" + previewNumber, repositoryId: snapshot.id, revision: "r1", entryFileId: input.fileId, mode: input.mode ?? "question", baseUrl: "https://model.example/v1", model: "mock-stream", files: [{ fileId: input.fileId, startLine: 1, endLine: 1, contentHash: input.fileId + "-hash" }], characters: 80, expiresAt: Date.now() + 600000 } }); }
      if (url.pathname === "/api/ai/generate") return route.continue({ url: `http://127.0.0.1:${address.port}/generate` });
      if (url.pathname === "/api/close") return json({ ok: true });
      return json({ error: "unexpected " + url.pathname }, 404);
    });
    await page.goto("/"); await enterRepositoryLocation(page, temp); await page.getByRole("button", { name: "打开仓库", exact: true }).click();
    await page.getByRole("treeitem", { name: "main.ts", exact: true }).click();
    await page.getByRole("button", { name: "打开 AI 聊天", exact: true }).click();
    const input = page.getByLabel("提问或追问", { exact: true }); const send = page.getByRole("button", { name: "发送", exact: true });
    await expect(page.getByText("想了解这份代码的哪一部分？")).toBeVisible();
    await expect.poll(async () => (await input.boundingBox())!.height).toBeLessThanOrEqual(80);
    await page.screenshot({ path: ".artifacts/copilot-chat/empty-1440.png" });
    await input.fill("解释 answer"); await expect(send).toBeEnabled(); expect(calls).toBe(0);
    await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true }); expect(calls).toBe(0);
    await input.press("Enter"); await begin;
    await expect(page.getByText("第一段正在到达。", { exact: true })).toBeVisible();
    expect(persisted).toEqual([]); expect(calls).toBe(1);
    await expect(page.getByRole("button", { name: "停止", exact: true })).toBeInViewport();
    await input.fill("下一条草稿");
    await page.getByRole("treeitem", { name: "helper.ts", exact: true }).click();
    await expect(page.getByText("第一段正在到达。", { exact: true })).toBeVisible();
    await page.screenshot({ path: ".artifacts/copilot-chat/generating-1440.png" });
    const result = { result: { answer: "第一段正在到达。\n\n- 理解静态值\n- 查看引用\n\n```ts\nexport const answer = 42;\n```", insufficientEvidence: false, references: [{ fileId: "main.ts", startLine: 1 }] }, cached: false, repositoryId: snapshot.id, revision: "r1", entryFileId: "main.ts", mode: "question" };
    held!.end(`data: ${JSON.stringify({ type: "complete", requestId: previewId, repositoryId: snapshot.id, revision: "r1", result })}\n\n`);
    await expect(page.getByRole("button", { name: "复制代码", exact: true })).toBeVisible(); await expect(input).toHaveValue("下一条草稿");
    await expect.poll(() => persisted.length).toBe(1); expect(calls).toBe(1);
    await page.screenshot({ path: ".artifacts/copilot-chat/conversation-1440.png" });
    for (const viewport of [{ width: 1024, height: 768 }, { width: 375, height: 812 }]) {
      await page.setViewportSize(viewport); await expect(input).toBeInViewport(); await expect(send).toBeInViewport();
      await page.screenshot({ path: `.artifacts/copilot-chat/conversation-${viewport.width}.png` });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    begin = new Promise<void>(resolve => { started = resolve; });
    await expect(send).toBeEnabled(); await send.click(); await begin;
    await input.fill("停止后仍保留"); const writesBeforeStop = writes;
    await page.getByRole("button", { name: "停止", exact: true }).click();
    await expect(page.getByText("未完成", { exact: true })).toBeVisible(); await expect(input).toHaveValue("停止后仍保留");
    expect(writes).toBe(writesBeforeStop);
    await page.screenshot({ path: ".artifacts/copilot-chat/failure-1440.png" });
    await expect(send).toBeEnabled(); await send.click();
    const fallback = page.getByRole("button", { name: "使用普通响应", exact: true });
    await expect(fallback).toBeVisible(); expect(calls).toBe(3);
    await expect(send).toBeDisabled();
    await fallback.click(); await expect(send).toBeEnabled(); expect(calls).toBe(3);
    await send.click(); await expect(page.getByText("普通响应已完成", { exact: true })).toBeVisible(); expect(calls).toBe(4);
  } finally { held?.destroy(); streaming.closeAllConnections(); await new Promise<void>(resolve => streaming.close(() => resolve())); await rm(temp, { recursive: true, force: true }); }
});
