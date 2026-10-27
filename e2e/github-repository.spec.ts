import { enterRepositoryLocation, openRepositoryMenu, test, expect } from "./fixtures";

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
    workspaceId: "github-demo-feature-ui",
    persistenceSessionId: "github-session-one",
  });
  let snapshot = makeSnapshot("a".repeat(40), "revision-one", 1);
  let loadedSource = sourceText;
  let modelCalls = 0;
  let previewCalls = 0;
  let historyFetchCalls = 0;
  let comparisonCalls = 0;
  await page.route(apiOrigin + "/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/open") {
      const body = request.postDataJSON() as { path: string };
      expect(body.path).toBe("https://github.com/repolens-test/demo/tree/feature/ui/src");
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(snapshot) });
    }
    if (url.pathname === "/api/events") return route.fulfill({ status: 204, body: "" });
    if (url.pathname === "/api/workspace") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(request.method() === "GET" ? { version: 1, recentRepositories: [], aiResults: {}, aiRoute: null, progress: {}, nodePositions: {}, conversations: [], readingNotes: [], savedTours: [], persistenceReady: true } : { ok: true }) });
    if (url.pathname === "/api/ai/settings") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ baseUrl: "https://model.example/v1", model: "mock-model", configured: true }) });
    if (url.pathname === "/api/source") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ source: loadedSource, repositoryId: snapshot.id, revision: snapshot.revision }) });
    if (url.pathname === "/api/compare") {
      comparisonCalls += 1;
      const body = request.postDataJSON() as { baseRef: string; headRef: string };
      if (body.headRef === "refs/heads/feature/ui") {
        return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "REVISION_OBJECT_MISSING", error: "缺少所需 Git 对象。" }) });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        revision: snapshot.revision,
        mode: "commits",
        baseCommit: body.baseRef,
        headCommit: body.headRef,
        files: [{ status: "modified", path: "src/main.ts" }],
        diff: "-old\n+new",
        limits: { maxFiles: 500, maxDiffBytes: 2_097_152 },
      }) });
    }
    if (url.pathname === "/api/compare/fetch") {
      historyFetchCalls += 1;
      const body = request.postDataJSON() as { repositoryId: string; workspaceId: string; persistenceSessionId: string; revision: string; target: string };
      expect(body).toEqual({ repositoryId: snapshot.id, workspaceId: snapshot.workspaceId, persistenceSessionId: snapshot.persistenceSessionId, revision: snapshot.revision, target: "refs/heads/feature/ui" });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ repositoryId: body.repositoryId, workspaceId: body.workspaceId, revision: body.revision, target: body.target, commit: "c".repeat(40), objectsAvailable: true }) });
    }
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
  const setDisclosureOpen = async (selector: string, open: boolean) => {
    const disclosure = page.locator(selector);
    const isOpen = await disclosure.evaluate((element) => (element as HTMLDetailsElement).open);
    if (isOpen !== open) await disclosure.locator(":scope > summary").click();
    await expect.poll(() => disclosure.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(open);
  };
  await expect(page.getByText("示例仓库", { exact: true })).toBeVisible();
  await expect(page.locator(".graph-file-card").first()).toBeVisible();
  await enterRepositoryLocation(page, "https://github.com/repolens-test/demo/tree/feature/ui/src");
  await expect(page.getByRole("button", { name: "打开仓库" })).toBeEnabled();
  await page.getByRole("button", { name: "打开仓库" }).click();
  await expect(page.getByText("GitHub 远端", { exact: true })).toBeVisible();
  await expect(page.locator(".workspace-context-label")).toContainText("refs/heads/feature/ui");
  await setDisclosureOpen(".overview-disclosure", true);
  await expect(page.getByText("commit · aaaaaaaaaaaa")).toBeVisible();
  await page.getByRole("button", { name: "将当前提交设为阅读基线" }).click();
  await page.getByLabel("比较类型").selectOption("commits");
  await page.getByLabel("起始提交").fill("a".repeat(40));
  await page.getByLabel("目标提交").fill("refs/heads/feature/ui");
  await page.getByRole("button", { name: "比较", exact: true }).click();
  await expect(page.getByText("缺少所需 Git 对象。", { exact: true })).toBeVisible();
  expect(historyFetchCalls).toBe(0);
  await page.getByRole("button", { name: "获取所需版本" }).click();
  const historyDialog = page.getByRole("dialog", { name: "获取 GitHub 版本" });
  await expect(historyDialog.getByText("https://github.com/repolens-test/demo")).toBeVisible();
  await expect(historyDialog.getByLabel("完整分支、标签或提交 SHA")).toHaveValue("refs/heads/feature/ui");
  expect(historyFetchCalls).toBe(0);
  await historyDialog.getByRole("button", { name: "确认获取" }).click();
  await expect.poll(() => historyFetchCalls).toBe(1);
  await expect(page.locator(".revision-comparison").getByText("已获取版本 cccccccccccc", { exact: false })).toBeVisible();
  expect(snapshot.origin.commit).toBe("a".repeat(40));
  await page.getByRole("button", { name: "比较", exact: true }).click();
  await expect(page.getByText("1 个变更文件")).toBeVisible();
  expect(comparisonCalls).toBe(2);
  expect(historyFetchCalls).toBe(1);
  await setDisclosureOpen(".overview-disclosure", false);
  await expect(page.getByLabel("筛选图谱目录")).toHaveValue("src");
  await expect(page.getByRole("treeitem", { name: "main.ts" })).toBeVisible();
  await page.getByRole("treeitem", { name: "main.ts" }).click();
  await page.getByRole("button", { name: "生成当前文件讲解" }).click();
  await expect(page.getByText("发送前确认")).toBeVisible();
  expect(previewCalls).toBe(1);
  expect(modelCalls).toBe(0);
  await page.getByRole("button", { name: "确认发送并生成" }).click();
  await expect.poll(() => modelCalls).toBe(1);
  await expect(page.getByRole("tabpanel", { name: "讲解" }).getByText("页面入口", { exact: true })).toBeVisible();

  const refresh = page.waitForResponse((response) => response.url() === apiOrigin + "/api/rescan");
  await setDisclosureOpen(".overview-disclosure", false);
  const repoMenu = await openRepositoryMenu(page);
  await repoMenu.getByRole("button", { name: "检查远端更新" }).click();
  await refresh;
  await setDisclosureOpen(".repo-menu", false);
  await setDisclosureOpen(".overview-disclosure", true);
  await expect(page.getByText("commit · bbbbbbbbbbbb")).toBeVisible();
  await setDisclosureOpen(".overview-disclosure", false);
  await page.getByRole("tab", { name: "源码", exact: true }).click();
  await expect(page.locator(".source-code")).toContainText("export const main = value + 1;");
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await setDisclosureOpen(".overview-disclosure", true);
  await expect(page.getByText("ref · refs/heads/feature/ui", { exact: true })).toBeVisible();
});
