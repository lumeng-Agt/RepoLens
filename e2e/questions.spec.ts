import { test, expect } from "@playwright/test";
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
      const fileIds = Array.isArray(body.fileIds) ? body.fileIds as string[] : ["src/main.ts", "src/dep.ts"];
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        scopeRequired: false,
        preview: { id: `question-preview-${questionPreviewCalls}`, repositoryId: snapshot.id, revision, entryFileId: "src/main.ts", mode: "question", baseUrl: "https://model.example/v1", model: "mock-model", files: fileIds.map((fileId) => ({ fileId, startLine: 1, endLine: 2, contentHash: fileId === "src/main.ts" ? "main-hash" : "dep-hash" })), characters: source.length + 12, expiresAt: Date.now() + 600_000, question: body.question, history: body.history ?? [] },
      }) });
    }
    if (url.pathname === "/api/ai/generate") {
      generateCalls += 1;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { answer: "main 返回依赖导出的 value。", insufficientEvidence: false, references: [{ fileId: "src/main.ts", startLine: 2, endLine: 2 }] }, cached: false, revision, repositoryId: snapshot.id, entryFileId: "src/main.ts", mode: "question" }) });
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
  await expect(page.getByText("main 返回依赖导出的 value。")).toBeVisible();
  expect(generateCalls).toBe(1);
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
    { role: "assistant", content: "main 返回依赖导出的 value。" },
  ]);
  expect(generateCalls).toBe(1);
  await page.getByRole("button", { name: "删除对话" }).click();
});
