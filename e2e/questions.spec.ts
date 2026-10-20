import { test, expect } from "./fixtures";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const apiOrigin = process.env.NEXT_PUBLIC_REPOLENS_API_ORIGIN ?? "http://127.0.0.1:4319";
let temporaryQuestionRepository = "";

test.afterEach(async () => {
  if (temporaryQuestionRepository) await rm(temporaryQuestionRepository, { recursive: true, force: true });
  temporaryQuestionRepository = "";
});

test("read-only question flow previews first, confirms source scope, cites lines, and carries follow-up history", async ({ page }) => {
  temporaryQuestionRepository = await mkdtemp(path.join(os.tmpdir(), "repolens-question-e2e-"));
  const source = "import { value } from './dep';\nexport function main() { return value; }\n";
  const revision = "question-fixture-revision";
  const snapshot = {
    id: "question-fixture-repository", version: "fixture", name: "Question fixture", description: "Question fixture",
    files: [
      { id: "src/main.ts", path: "src/main.ts", name: "main.ts", kind: "typescript", language: "ts", role: "入口", summary: "入口文件", imports: [], contentHash: "main-hash" },
      { id: "src/dep.ts", path: "src/dep.ts", name: "dep.ts", kind: "typescript", language: "ts", role: "依赖", summary: "导出值", imports: [], contentHash: "dep-hash" },
    ],
    dependencies: [{ id: "main-dep", fromId: "src/main.ts", toId: "src/dep.ts", specifier: "./dep", kind: "import", resolution: "file", reference: { fileId: "src/main.ts", line: 1 } }],
    tour: [], source: "local", revision, sequence: 1, diagnostics: [], unresolved: [],
  };
  let generateCalls = 0;
  let questionPreviewCalls = 0;
  const seenPreviewBodies: Record<string, unknown>[] = [];
  const savedConversations: unknown[][] = [];
  let persistedConversations: unknown[] = [];
  await page.route(`${apiOrigin}/api/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/open") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(snapshot) });
    if (url.pathname === "/api/events") return route.fulfill({ status: 204, body: "" });
    if (url.pathname === "/api/ai/settings") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ baseUrl: "https://model.example/v1", model: "mock-model", configured: true }) });
    if (url.pathname === "/api/workspace" && request.method() === "GET") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ version: 1, recentRepositories: [], aiResults: {}, aiRoute: null, progress: {}, nodePositions: {}, conversations: persistedConversations }) });
    if (url.pathname === "/api/workspace" && request.method() === "POST") {
      const body = request.postDataJSON() as { action: string; conversations?: unknown[] };
      if (body.action === "conversations") { persistedConversations = body.conversations ?? []; savedConversations.push(persistedConversations); }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    }
    if (url.pathname === "/api/ai/question/preview") {
      questionPreviewCalls += 1;
      const body = request.postDataJSON() as Record<string, unknown>;
      seenPreviewBodies.push(body);
      if (questionPreviewCalls === 1) expect(generateCalls).toBe(0);
      const fileIds = Array.isArray(body.fileIds) ? body.fileIds as string[] : questionPreviewCalls === 1 ? ["src/main.ts"] : ["src/main.ts", "src/dep.ts"];
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        scopeRequired: false,
        preview: { id: `question-preview-${questionPreviewCalls}`, repositoryId: snapshot.id, revision, entryFileId: "src/main.ts", mode: "question", baseUrl: "https://model.example/v1", model: "mock-model", files: fileIds.map((fileId) => ({ fileId, startLine: 1, endLine: 2, contentHash: fileId === "src/main.ts" ? "main-hash" : "dep-hash" })), characters: source.length + 12, expiresAt: Date.now() + 600_000, question: body.question, history: body.history ?? [] },
      }) });
    }
    if (url.pathname === "/api/ai/generate") {
      generateCalls += 1;
      const result = generateCalls === 1
        ? { answer: "当前范围无法确认该实现细节。", insufficientEvidence: true, references: [] }
        : { answer: "main 返回依赖导出的 value。", insufficientEvidence: false, references: [{ fileId: "src/main.ts", startLine: 2, endLine: 2 }] };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result, cached: false, revision, repositoryId: snapshot.id, entryFileId: "src/main.ts", mode: "question" }) });
    }
    if (url.pathname === "/api/source") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ source, repositoryId: snapshot.id, revision }) });
    if (url.pathname === "/api/close") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: `unexpected ${url.pathname}` }) });
  });

  await page.goto("/");
  await expect(page.locator(".graph-file-card").first()).toBeVisible();
  await page.locator("#repository-path").fill(temporaryQuestionRepository);
  const openRepository = page.getByRole("button", { name: "打开仓库", exact: true });
  await expect(openRepository).toBeEnabled();
  await openRepository.click();
  await expect(page.getByText("Question fixture", { exact: true }).first()).toBeVisible();
  await page.getByRole("treeitem", { name: "main.ts" }).click();
  await page.getByRole("tab", { name: "问答", exact: true }).click();
  await page.getByLabel("提问或追问").fill("What does main return?");
  await page.getByRole("button", { name: "预览发送范围" }).click();
  await expect(page.getByRole("region", { name: "问答发送确认" })).toBeVisible();
  expect(questionPreviewCalls).toBe(1);
  expect(generateCalls).toBe(0);
  await page.getByRole("button", { name: "确认发送并获取引用回答" }).click();
  await expect(page.getByText("当前范围无法确认该实现细节。")).toBeVisible();
  await page.getByRole("button", { name: "引用不足，补充文件" }).click();
  await expect(page.getByRole("region", { name: "补充问答源码范围" })).toBeVisible();
  await page.getByRole("checkbox", { name: "src/dep.ts" }).check();
  await page.getByRole("button", { name: "重新预览补充范围" }).click();
  await expect(page.getByRole("region", { name: "问答发送确认" })).toBeVisible();
  expect(seenPreviewBodies.at(-1)?.fileIds).toEqual(["src/main.ts", "src/dep.ts"]);
  expect(generateCalls).toBe(1);
  await page.getByRole("button", { name: "确认发送并获取引用回答" }).click();
  await expect(page.getByText("main 返回依赖导出的 value。")).toBeVisible();
  expect(generateCalls).toBe(2);
  await expect.poll(() => savedConversations.length).toBeGreaterThan(0);
  await page.getByRole("button", { name: /src\/main\.ts · 第 2–2 行/ }).click();
  await expect(page.getByRole("tab", { name: "源码", exact: true })).toHaveAttribute("data-state", "active");
  await expect(page.locator("#source-line-2")).toHaveClass(/is-focused/);

  await page.getByRole("tab", { name: "问答", exact: true }).click();
  await page.getByLabel("提问或追问").fill("Why does it return that value?");
  await page.getByRole("button", { name: "预览发送范围" }).click();
  await expect(page.getByRole("region", { name: "问答发送确认" })).toBeVisible();
  const followUp = seenPreviewBodies.at(-1);
  expect(followUp?.history).toEqual([
    { role: "user", content: "What does main return?" },
    { role: "assistant", content: "当前范围无法确认该实现细节。" },
    { role: "user", content: "What does main return?" },
    { role: "assistant", content: "main 返回依赖导出的 value。" },
  ]);
  expect(generateCalls).toBe(2);
  await page.getByRole("button", { name: "删除对话" }).click();
});

test("leaving the question tab cancels preview and generation without saving a late answer", async ({ page }) => {
  temporaryQuestionRepository = await mkdtemp(path.join(os.tmpdir(), "repolens-question-cancel-e2e-"));
  const source = "export const value = 1;\n";
  const revision = "question-cancel-revision";
  const snapshot = {
    id: "question-cancel-repository", version: "fixture", name: "Question cancel fixture", description: "",
    files: [{ id: "main.ts", path: "main.ts", name: "main.ts", kind: "typescript", language: "ts", role: "入口", summary: "入口", imports: [], contentHash: "main-hash" }],
    dependencies: [], tour: [], source: "local", revision, sequence: 1, diagnostics: [], unresolved: [],
  };
  let previewCalls = 0;
  let generateCalls = 0;
  let conversationWrites = 0;
  let releasePreview!: () => void;
  let releaseGenerate!: () => void;
  let previewStarted!: () => void;
  let generateStarted!: () => void;
  let previewSettled!: () => void;
  let generateSettled!: () => void;
  const previewGate = new Promise<void>((resolve) => { releasePreview = resolve; });
  const generateGate = new Promise<void>((resolve) => { releaseGenerate = resolve; });
  const previewStart = new Promise<void>((resolve) => { previewStarted = resolve; });
  const generateStart = new Promise<void>((resolve) => { generateStarted = resolve; });
  const previewDone = new Promise<void>((resolve) => { previewSettled = resolve; });
  const generateDone = new Promise<void>((resolve) => { generateSettled = resolve; });
  let persist: unknown[] = [];
  await page.route(`${apiOrigin}/api/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/open") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(snapshot) });
    if (url.pathname === "/api/events") return route.fulfill({ status: 204, body: "" });
    if (url.pathname === "/api/ai/settings") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ baseUrl: "https://model.example/v1", model: "mock", configured: true }) });
    if (url.pathname === "/api/workspace" && request.method() === "GET") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ version: 1, recentRepositories: [], aiResults: {}, aiRoute: null, progress: {}, nodePositions: {}, conversations: persist }) });
    if (url.pathname === "/api/workspace" && request.method() === "POST") {
      const body = request.postDataJSON() as { action: string; conversations?: unknown[] };
      if (body.action === "conversations") { conversationWrites += 1; persist = body.conversations ?? []; }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    }
    if (url.pathname === "/api/ai/question/preview") {
      previewCalls += 1;
      const call = previewCalls;
      if (call === 1) {
        previewStarted();
        await previewGate;
      }
      try {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        scopeRequired: false,
        preview: { id: `preview-${call}`, repositoryId: snapshot.id, revision, entryFileId: "main.ts", mode: "question", baseUrl: "https://model.example/v1", model: "mock", files: [{ fileId: "main.ts", startLine: 1, endLine: 1, contentHash: "main-hash" }], characters: source.length, expiresAt: Date.now() + 600_000, question: request.postDataJSON().question, history: [] },
        }) });
      } catch { /* The browser intentionally aborts this held response on tab leave. */ }
      finally { previewSettled(); }
      return;
    }
    if (url.pathname === "/api/ai/generate") {
      generateCalls += 1;
      generateStarted();
      await generateGate;
      try {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { answer: "迟到回答", references: [{ fileId: "main.ts", startLine: 1 }] }, cached: false, revision, repositoryId: snapshot.id, entryFileId: "main.ts", mode: "question" }) });
      } catch { /* The browser intentionally aborts this held response on tab leave. */ }
      finally { generateSettled(); }
      return;
    }
    if (url.pathname === "/api/source") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ source, repositoryId: snapshot.id, revision }) });
    if (url.pathname === "/api/close") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: `unexpected ${url.pathname}` }) });
  });

  await page.goto("/");
  await expect(page.locator(".graph-file-card").first()).toBeVisible();
  await page.locator("#repository-path").fill(temporaryQuestionRepository);
  const openRepository = page.getByRole("button", { name: "打开仓库", exact: true });
  await expect(openRepository).toBeEnabled();
  await openRepository.click();
  await page.getByRole("tab", { name: "问答", exact: true }).click();
  await page.getByLabel("提问或追问").fill("preview cancellation");
  const previewAborted = page.waitForEvent("requestfailed", (request) => request.url().includes("/api/ai/question/preview"));
  await page.getByRole("button", { name: "预览发送范围" }).click();
  await previewStart;
  await page.getByRole("tab", { name: "源码", exact: true }).click();
  await previewAborted;
  releasePreview();
  await previewDone;
  expect(generateCalls).toBe(0);
  expect(conversationWrites).toBe(0);

  await page.getByRole("tab", { name: "问答", exact: true }).click();
  await page.getByLabel("提问或追问").fill("generation cancellation");
  await page.getByRole("button", { name: "预览发送范围" }).click();
  await expect(page.getByRole("region", { name: "问答发送确认" })).toBeVisible();
  const generateAborted = page.waitForEvent("requestfailed", (request) => request.url().includes("/api/ai/generate"));
  await page.getByRole("button", { name: "确认发送并获取引用回答" }).click();
  await generateStart;
  await page.getByRole("tab", { name: "源码", exact: true }).click();
  await generateAborted;
  releaseGenerate();
  await generateDone;
  expect(conversationWrites).toBe(0);
  await expect(page.getByText("迟到回答", { exact: true })).toHaveCount(0);
});
