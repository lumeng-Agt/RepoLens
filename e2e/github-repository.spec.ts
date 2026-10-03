import { test, expect } from "@playwright/test";

const apiOrigin = process.env.NEXT_PUBLIC_REPOLENS_API_ORIGIN ?? "http://127.0.0.1:4319";

test("GitHub link opens the selected tree, confirms only a previewed AI scope, and refreshes remote metadata", async ({ page }) => {
  const sourceText = "import { value } from './dep';\nexport const main = value;\n";
  const updatedText = "import { value } from './dep';\nexport const main = value + 1;\n";
  const makeSnapshot = (commit: string, revision: string, sequence: number) => ({
    id: "github-repolens-demo",
    version: "GitHub",
    name: "demo",
    description: "GitHub test snapshot",
    files: [
      { id: "src/main.ts", path: "src/main.ts", name: "main.ts", kind: "typescript", language: "typescript", contentHash: revision + "-main", imports: [] },
      { id: "src/dep.ts", path: "src/dep.ts", name: "dep.ts", kind: "typescript", language: "typescript", contentHash: revision + "-dep", imports: [] },
    ],
    dependencies: [{ id: "edge-main-dep", fromId: "src/main.ts", toId: "src/dep.ts", specifier: "./dep", reference: { fileId: "src/main.ts", line: 1 } }],
    tour: [],
    source: "local",
    revision,
    sequence,
    diagnostics: [],
    unresolved: [],
    origin: { kind: "github", url: "https://github.com/repolens-test/demo", owner: "repolens-test", repository: "demo", requestedRef: "feature/ui/src", resolvedRef: "refs/heads/feature/ui", commit, subdirectory: "src" },
  });
  let snapshot = makeSnapshot("a".repeat(40), "revision-one", 1);
  let loadedSource = sourceText;
  let modelCalls = 0;
  let previewCalls = 0;
  await page.route(apiOrigin + "/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/open") {
      const body = request.postDataJSON() as { path: string };
      expect(body.path).toBe("https://github.com/repolens-test/demo/tree/feature/ui/src");
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(snapshot) });
    }
    if (url.pathname === "/api/events") return route.fulfill({ status: 204, body: "" });
    if (url.pathname === "/api/ai/settings") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ baseUrl: "https://model.example/v1", model: "mock-model", configured: true }) });
    if (url.pathname === "/api/source") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ source: loadedSource, repositoryId: snapshot.id, revision: snapshot.revision }) });
    if (url.pathname === "/api/ai/preview") {
      previewCalls += 1;
      expect(modelCalls).toBe(0);
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        scopeRequired: false,
        preview: { id: "preview-one", repositoryId: snapshot.id, revision: snapshot.revision, entryFileId: "src/main.ts", mode: "explanation", baseUrl: "https://model.example/v1", model: "mock-model", files: [{ fileId: "src/main.ts", startLine: 1, endLine: 2, contentHash: "source-hash" }], characters: sourceText.length, expiresAt: Date.now() + 600_000 },
      }) });
    }
    if (url.pathname === "/api/ai/generate") {
      modelCalls += 1;
      const body = request.postDataJSON() as { previewId: string };
      expect(body).toEqual({ previewId: "preview-one" });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { role: "页面入口", keyPoints: ["读取任务数据"], references: [{ fileId: "src/main.ts", startLine: 2 }] }, cached: false, revision: snapshot.revision, repositoryId: snapshot.id, entryFileId: "src/main.ts", mode: "explanation" }) });
    }
    if (url.pathname === "/api/rescan") {
      snapshot = makeSnapshot("b".repeat(40), "revision-two", 2);
      loadedSource = updatedText;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(snapshot) });
    }
    if (url.pathname === "/api/close") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "unexpected API request" }) });
  });

  await page.goto("/");
  await expect(page.getByText("示例仓库", { exact: true })).toBeVisible();
  await expect(page.locator(".graph-file-card").first()).toBeVisible();
  await page.getByLabel("本地仓库路径或 GitHub 链接").fill("https://github.com/repolens-test/demo/tree/feature/ui/src");
  await expect(page.getByRole("button", { name: "打开仓库" })).toBeEnabled();
  await page.getByRole("button", { name: "打开仓库" }).click();
  await expect(page.getByText("GitHub 远端", { exact: true })).toBeVisible();
  await expect(page.getByText("refs/heads/feature/ui", { exact: false })).toBeVisible();
  await expect(page.getByText("commit · aaaaaaaaaaaa")).toBeVisible();
  await expect(page.getByLabel("筛选图谱目录")).toHaveValue("src");
  await expect(page.getByRole("treeitem", { name: "main.ts" })).toBeVisible();
  await page.getByRole("treeitem", { name: "main.ts" }).click();
  await page.getByRole("button", { name: "生成当前文件讲解" }).click();
  await expect(page.getByText("发送前确认")).toBeVisible();
  expect(previewCalls).toBe(1);
  expect(modelCalls).toBe(0);
  await page.getByRole("button", { name: "确认发送并生成" }).click();
  await expect.poll(() => modelCalls).toBe(1);
  await expect(page.getByText("页面入口", { exact: true })).toBeVisible();

  const refresh = page.waitForResponse((response) => response.url() === apiOrigin + "/api/rescan");
  await page.getByRole("button", { name: "检查远端更新" }).first().click();
  await refresh;
  await expect(page.getByText("commit · bbbbbbbbbbbb")).toBeVisible();
  await page.getByRole("tab", { name: "源码", exact: true }).click();
  await expect(page.locator(".source-code")).toContainText("export const main = value + 1;");
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole("button", { name: "文件" }).click();
  await expect(page.getByLabel("GitHub 来源信息")).toBeVisible();
  await expect(page.getByText("refs/heads/feature/ui", { exact: false })).toBeVisible();
});
