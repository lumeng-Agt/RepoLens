import { expect, test } from "./fixtures";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("quick open, source navigation history, and reading layout keep the selected file synchronized", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "第 1 步：从入口开始" })).toBeVisible();
  await expect(page.locator(".graph-legend")).toContainText("当前文件导入");
  await expect(page.locator(".graph-legend")).toContainText("文件导入当前");

  await page.getByRole("button", { name: /快速打开/ }).click();
  const dialog = page.getByRole("dialog", { name: "快速打开文件" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox", { name: "快速打开文件或符号" }).fill("TaskList");
  await dialog.getByText("src/components/TaskList.tsx").click();
  await expect(page.locator(".detail-file-title strong")).toHaveText("TaskList.tsx");

  await page.getByRole("button", { name: "后退" }).click();
  await expect(page.locator(".detail-file-title strong")).toHaveText("main.tsx");
  await page.getByRole("button", { name: "前进" }).click();
  await expect(page.locator(".detail-file-title strong")).toHaveText("TaskList.tsx");

  await page.getByRole("button", { name: "阅读", exact: true }).click();
  await expect(page.locator(".graph-pane")).toBeHidden();
  await expect(page.locator(".workspace-overview")).toHaveClass(/is-compact/);
  expect(await page.locator(".workspace-overview").evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(50);
  await expect(page.getByRole("tab", { name: "源码" })).toHaveAttribute("data-state", "active");
  await expect(page.locator(".detail-file-title strong")).toHaveText("TaskList.tsx");
  await page.getByRole("button", { name: "结构", exact: true }).click();
  await expect(page.locator(".graph-pane")).toBeVisible();
  await expect(page.locator(".detail-file-title strong")).toHaveText("TaskList.tsx");
});

test("symbol outline jumps to the exact TypeScript definition range", async ({ page }) => {
  const repositoryPath = await mkdtemp(path.join(os.tmpdir(), "repolens-symbol-outline-"));
  try {
    await writeFile(path.join(repositoryPath, "main.ts"), [
      "export const value = 1;",
      "",
      "export function calculateAnswer(input: number) {",
      "  return input * 2;",
      "}",
    ].join("\n"));
    await page.goto("/");
    await expect(page.getByRole("button", { name: "第 1 步：从入口开始" })).toBeVisible();
    await page.getByLabel("本地仓库路径").fill(repositoryPath);
    await page.getByRole("button", { name: "打开仓库" }).click();
    await expect(page.locator(".detail-file-title strong")).toHaveText("main.ts");
    const symbol = page.getByRole("button", { name: /calculateAnswer function · 第 3 行/ });
    await expect(symbol).toBeVisible();
    await symbol.click();
    await expect(page.getByRole("tab", { name: "源码", exact: true })).toHaveAttribute("data-state", "active");
    await expect(page.locator("#source-line-3")).toHaveClass(/is-focused/);
    await expect(page.locator("#source-line-5")).toHaveClass(/is-focused/);
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

test("mobile quick open stays available and large source jumps render the requested line", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "第 1 步：从入口开始" })).toBeVisible();
  const quickOpenButton = page.getByRole("button", { name: "快速打开文件" });
  await quickOpenButton.click();
  const dialog = page.getByRole("dialog", { name: "快速打开文件" });
  await expect(page.locator('[data-slot="dialog-content"]')).toBeVisible();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox", { name: "快速打开文件或符号" }).fill("TaskList");
  await dialog.getByText("src/components/TaskList.tsx").click();
  await expect(page.locator(".detail-file-title strong")).toHaveText("TaskList.tsx");

  const repositoryPath = await mkdtemp(path.join(os.tmpdir(), "repolens-large-source-"));
  const lines = Array.from({ length: 1_500 }, (_, index) => `// source row ${index + 1}`);
  lines.push('import { run } from "./worker";');
  lines.push("export const result = run();");
  try {
    await page.getByRole("button", { name: "文件", exact: true }).click();
    await writeFile(path.join(repositoryPath, "main.ts"), lines.join("\n"));
    await writeFile(path.join(repositoryPath, "worker.ts"), "export function run() { return 1; }\n");
    await page.getByLabel("本地仓库路径").fill(repositoryPath);
    await page.getByRole("button", { name: "打开仓库" }).click();
    await expect(page.locator(".detail-file-title strong")).toHaveText("main.ts");
    await page.getByRole("button", { name: "详情", exact: true }).click();
    await expect(page.locator(".relation-list button").filter({ hasText: "worker.ts" })).toBeVisible();
    await page.locator(".relation-list button").filter({ hasText: "worker.ts" }).click();
    await expect(page.getByRole("tab", { name: "源码", exact: true })).toHaveAttribute("data-state", "active");
    await expect(page.locator(".source-code.is-virtualized")).toBeVisible();
    expect(await page.locator(".source-line").count()).toBeLessThan(150);
    await expect(page.locator("#source-line-1501")).toHaveClass(/is-focused/, { timeout: 5_000 });
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

test("local content search locates source and reading notes survive export/import as a manual route", async ({ page }) => {
  const repositoryPath = await mkdtemp(path.join(os.tmpdir(), "repolens-search-reading-artifacts-"));
  const downloadDirectory = await mkdtemp(path.join(os.tmpdir(), "repolens-reading-export-"));
  await writeFile(path.join(repositoryPath, "main.ts"), [
    "export function routeTarget() {",
    "  return 42;",
    "}",
  ].join("\n"));
  await writeFile(path.join(repositoryPath, "worker.ts"), "export const workerValue = 1;\n");
  try {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "第 1 步：从入口开始" })).toBeVisible();
    await page.getByLabel("本地仓库路径").fill(repositoryPath);
    await page.getByRole("button", { name: "打开仓库" }).click();
    await expect(page.locator(".detail-file-title strong")).toHaveText("main.ts");

    await page.getByRole("button", { name: "内容", exact: true }).click();
    await page.getByLabel("搜索源码内容").fill("routeTarget");
    const hit = page.locator(".content-search-hit").filter({ hasText: "routeTarget" });
    await expect(hit).toBeVisible();
    await expect(hit.locator("mark")).toHaveText("routeTarget");
    await hit.click();
    await expect(page.locator("#source-line-1")).toHaveClass(/is-focused/);

    await page.getByRole("tab", { name: "讲解", exact: true }).click();
    await page.getByLabel("阅读笔记内容").fill("这里是路线入口的阅读说明。");
    await page.getByRole("button", { name: "保存记录" }).click();
    await expect(page.locator(".reading-note-list")).toContainText("路线入口的阅读说明");
    await page.locator(".manual-tour-builder summary").click();
    await page.locator(".manual-tour-builder input[type=checkbox]").check();
    await page.getByRole("button", { name: "创建并开始路线" }).click();
    await expect(page.getByRole("button", { name: /第 1 步：/ })).toBeVisible();

    await page.getByRole("tab", { name: "讲解", exact: true }).click();
    await page.locator(".reading-export-selection summary").click();
    await page.getByLabel("导出路线：手动阅读路线").uncheck();
    const notesOnlyDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "JSON", exact: true }).click();
    const notesOnly = await notesOnlyDownload;
    const notesOnlyPath = path.join(downloadDirectory, "notes-only.json");
    await notesOnly.saveAs(notesOnlyPath);
    const notesOnlyData = JSON.parse(await readFile(notesOnlyPath, "utf8"));
    expect(notesOnlyData.notes).toHaveLength(1);
    expect(notesOnlyData.tours).toHaveLength(0);
    await page.getByLabel("导出路线：手动阅读路线").check();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "JSON", exact: true }).click();
    const download = await downloadPromise;
    const exportPath = path.join(downloadDirectory, "repolens-reading-export.json");
    await download.saveAs(exportPath);
    const imported = JSON.parse(await readFile(exportPath, "utf8"));
    imported.notes[0].text = "导入冲突副本内容";
    await writeFile(exportPath, JSON.stringify(imported));
    await page.locator(".reading-import-button input[type=file]").setInputFiles(exportPath);
    await expect(page.getByRole("dialog", { name: "导入预览" })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "导入预览" })).toContainText("1 个 ID 冲突");
    await page.getByRole("button", { name: "确认导入" }).click();
    await expect(page.locator(".reading-note-list")).toContainText("路线入口的阅读说明");
    await expect(page.locator(".reading-note-list")).toContainText("导入冲突副本内容");
    await expect(page.locator(".reading-note-list article")).toHaveCount(2);
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
    await rm(downloadDirectory, { recursive: true, force: true });
  }
});

test("browser restore failure keeps existing notes and tours while local edits wait in memory", async ({ page }) => {
  const repositoryPath = await mkdtemp(path.join(os.tmpdir(), "repolens-reading-restore-failure-"));
  await writeFile(path.join(repositoryPath, "main.ts"), "export const entry = 1;\n");
  const waitForAction = (action: string) => page.waitForResponse((response) => {
    if (!response.url().includes("/api/workspace") || response.request().method() !== "POST") return false;
    try { return response.request().postDataJSON()?.action === action; } catch { return false; }
  });
  try {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "第 1 步：从入口开始" })).toBeVisible();
    await page.getByLabel("本地仓库路径").fill(repositoryPath);
    await page.getByRole("button", { name: "打开仓库" }).click();
    await expect(page.locator(".detail-file-title strong")).toHaveText("main.ts");
    await page.getByRole("tab", { name: "讲解", exact: true }).click();
    await expect(page.getByRole("status", { name: "本地保存状态：已保存" })).toBeVisible();

    await page.getByLabel("阅读笔记内容").fill("磁盘中的原始笔记");
    const originalNoteSave = waitForAction("reading-notes");
    await page.getByRole("button", { name: "保存记录" }).click();
    await originalNoteSave;
    await page.locator(".manual-tour-builder summary").click();
    await page.locator(".manual-tour-builder input[type=checkbox]").check();
    await page.getByLabel("路线标题").fill("磁盘中的原始路线");
    const originalTourSave = waitForAction("saved-tours");
    await page.getByRole("button", { name: "创建并开始路线" }).click();
    await originalTourSave;

    await page.getByRole("button", { name: "返回示例" }).click();
    await expect(page.getByRole("button", { name: "第 1 步：从入口开始" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "第 1 步：从入口开始" })).toBeVisible();

    let failNextRead = true;
    const savedNotePayloads: Array<{ notes?: Array<{ text?: string }> }> = [];
    await page.route("**/api/workspace*", async (route) => {
      const request = route.request();
      if (request.method() === "GET" && request.url().includes("repositoryId=") && failNextRead) {
        failNextRead = false;
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "测试用读取失败" }) });
        return;
      }
      if (request.method() === "POST") {
        try {
          const body = request.postDataJSON();
          if (body.action === "reading-notes") savedNotePayloads.push(body);
        } catch { /* Ignore unrelated or malformed test requests. */ }
      }
      await route.continue();
    });

    await page.getByLabel("本地仓库路径").fill(repositoryPath);
    await page.getByRole("button", { name: "打开仓库" }).click();
    await expect(page.getByRole("button", { name: "重试恢复" })).toBeVisible();
    await expect(page.getByRole("status", { name: "本地保存状态：仅在内存" })).toBeVisible();
    await page.getByRole("tab", { name: "讲解", exact: true }).click();
    await page.getByLabel("阅读笔记内容").fill("读取失败期间的新笔记");
    await page.getByRole("button", { name: "保存记录" }).click();
    await expect(page.locator(".reading-note-list")).toContainText("读取失败期间的新笔记");
    expect(savedNotePayloads).toHaveLength(0);

    const restoredNoteSave = waitForAction("reading-notes");
    await page.getByRole("button", { name: "重试恢复" }).click();
    await restoredNoteSave;
    await page.getByRole("tab", { name: "讲解", exact: true }).click();
    await expect(page.locator(".reading-note-list")).toContainText("磁盘中的原始笔记");
    await expect(page.locator(".reading-note-list")).toContainText("读取失败期间的新笔记");
    await page.locator(".saved-tour-list summary").click();
    await expect(page.locator(".saved-tour-list")).toContainText("磁盘中的原始路线");
    expect(savedNotePayloads.at(-1)?.notes?.map((item) => item.text)).toEqual(expect.arrayContaining(["磁盘中的原始笔记", "读取失败期间的新笔记"]));
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

test("an import confirmed during source validation preserves notes added before the validation finishes", async ({ page }) => {
  const repositoryPath = await mkdtemp(path.join(os.tmpdir(), "repolens-reading-import-race-"));
  const downloadDirectory = await mkdtemp(path.join(os.tmpdir(), "repolens-reading-import-race-export-"));
  await writeFile(path.join(repositoryPath, "main.ts"), "export const entry = 1;\n");
  let holdSource = false;
  let releaseSource!: () => void;
  let sourceReached!: () => void;
  const sourceGate = new Promise<void>((resolve) => { releaseSource = resolve; });
  const sourceRequest = new Promise<void>((resolve) => { sourceReached = resolve; });
  const waitForNoteSave = () => page.waitForResponse((response) => {
    if (!response.url().includes("/api/workspace") || response.request().method() !== "POST") return false;
    try { return response.request().postDataJSON()?.action === "reading-notes"; } catch { return false; }
  });
  try {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "第 1 步：从入口开始" })).toBeVisible();
    await page.getByLabel("本地仓库路径").fill(repositoryPath);
    await page.getByRole("button", { name: "打开仓库" }).click();
    await expect(page.locator(".detail-file-title strong")).toHaveText("main.ts");
    await page.getByRole("tab", { name: "讲解", exact: true }).click();
    await expect(page.getByRole("status", { name: "本地保存状态：已保存" })).toBeVisible();
    await page.getByLabel("阅读笔记内容").fill("先保存的笔记");
    const initialSave = waitForNoteSave();
    await page.getByRole("button", { name: "保存记录" }).click();
    await initialSave;

    await page.locator(".reading-export-selection summary").click();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "JSON", exact: true }).click();
    const download = await downloadPromise;
    const exportPath = path.join(downloadDirectory, "reading.json");
    await download.saveAs(exportPath);
    const imported = JSON.parse(await readFile(exportPath, "utf8"));
    imported.notes.push({ ...imported.notes[0], id: "imported-note", text: "导入期间待合并的笔记", createdAt: Date.now() + 1 });
    await writeFile(exportPath, JSON.stringify(imported));

    await page.route("**/api/source**", async (route) => {
      if (!holdSource) { await route.continue(); return; }
      holdSource = false;
      sourceReached();
      await sourceGate;
      await route.continue();
    });
    await page.locator(".reading-import-button input[type=file]").setInputFiles(exportPath);
    await expect(page.getByRole("dialog", { name: "导入预览" })).toBeVisible();
    holdSource = true;
    await page.getByRole("button", { name: "确认导入" }).click();
    await sourceRequest;

    await page.getByLabel("阅读笔记内容").fill("校验期间新增的笔记");
    const concurrentSave = waitForNoteSave();
    await page.getByRole("button", { name: "保存记录" }).click();
    await concurrentSave;
    releaseSource();

    await expect(page.locator(".reading-note-list")).toContainText("先保存的笔记");
    await expect(page.locator(".reading-note-list")).toContainText("导入期间待合并的笔记");
    await expect(page.locator(".reading-note-list")).toContainText("校验期间新增的笔记");
    await expect(page.locator(".reading-note-list article")).toHaveCount(3);
  } finally {
    releaseSource();
    await rm(repositoryPath, { recursive: true, force: true });
    await rm(downloadDirectory, { recursive: true, force: true });
  }
});

test("a successful route save does not clear a failed notes save indicator", async ({ page }) => {
  const repositoryPath = await mkdtemp(path.join(os.tmpdir(), "repolens-independent-artifact-saves-"));
  await writeFile(path.join(repositoryPath, "main.ts"), "export const entry = 1;\n");
  let failNotesOnce = true;
  try {
    await page.route("**/api/workspace", async (route) => {
      const request = route.request();
      if (request.method() === "POST") {
        try {
          if (request.postDataJSON()?.action === "reading-notes" && failNotesOnce) {
            failNotesOnce = false;
            await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: false, warning: "笔记写入失败" }) });
            return;
          }
        } catch { /* Continue unrelated workspace writes. */ }
      }
      await route.continue();
    });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "第 1 步：从入口开始" })).toBeVisible();
    await page.getByLabel("本地仓库路径").fill(repositoryPath);
    await page.getByRole("button", { name: "打开仓库" }).click();
    await expect(page.locator(".detail-file-title strong")).toHaveText("main.ts");
    await page.getByRole("tab", { name: "讲解", exact: true }).click();
    await expect(page.getByRole("status", { name: "本地保存状态：已保存" })).toBeVisible();
    await page.getByLabel("阅读笔记内容").fill("暂未落盘的笔记");
    await page.getByRole("button", { name: "保存记录", exact: true }).click();
    await expect(page.getByRole("status", { name: "本地保存状态：仅在内存" })).toBeVisible();

    await page.locator(".manual-tour-builder summary").click();
    await page.locator(".manual-tour-builder input[type=checkbox]").check();
    await page.getByLabel("路线标题").fill("已落盘的路线");
    await page.getByRole("button", { name: "创建并开始路线", exact: true }).click();
    await expect(page.getByRole("status", { name: "本地保存状态：仅在内存" })).toBeVisible();
    await expect(page.getByRole("button", { name: "重试保存", exact: true })).toBeVisible();
    await expect(page.locator(".workspace-save-status")).toHaveAttribute("title", /笔记写入失败/);

    await page.getByRole("button", { name: "重试保存", exact: true }).click();
    await expect(page.getByRole("status", { name: "本地保存状态：已保存" })).toBeVisible();
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

test("a successful notes save does not clear a failed route save indicator", async ({ page }) => {
  const repositoryPath = await mkdtemp(path.join(os.tmpdir(), "repolens-independent-route-save-"));
  await writeFile(path.join(repositoryPath, "main.ts"), "export const entry = 1;\n");
  let failTourOnce = true;
  try {
    await page.route("**/api/workspace", async (route) => {
      const request = route.request();
      if (request.method() === "POST") {
        try {
          if (request.postDataJSON()?.action === "saved-tours" && failTourOnce) {
            failTourOnce = false;
            await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: false, warning: "路线写入失败" }) });
            return;
          }
        } catch { /* Continue unrelated workspace writes. */ }
      }
      await route.continue();
    });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "第 1 步：从入口开始" })).toBeVisible();
    await page.getByLabel("本地仓库路径").fill(repositoryPath);
    await page.getByRole("button", { name: "打开仓库" }).click();
    await expect(page.locator(".detail-file-title strong")).toHaveText("main.ts");
    await page.getByRole("tab", { name: "讲解", exact: true }).click();
    await expect(page.getByRole("status", { name: "本地保存状态：已保存" })).toBeVisible();

    await page.getByLabel("阅读笔记内容").fill("已落盘的笔记");
    await page.getByRole("button", { name: "保存记录", exact: true }).click();
    await expect(page.getByRole("status", { name: "本地保存状态：已保存" })).toBeVisible();

    await page.locator(".manual-tour-builder summary").click();
    await page.locator(".manual-tour-builder input[type=checkbox]").check();
    await page.getByLabel("路线标题").fill("暂未落盘的路线");
    await page.getByRole("button", { name: "创建并开始路线", exact: true }).click();
    await expect(page.getByRole("status", { name: "本地保存状态：仅在内存" })).toBeVisible();
    await expect(page.getByRole("button", { name: "重试保存", exact: true })).toBeVisible();
    await expect(page.locator(".workspace-save-status")).toHaveAttribute("title", /路线写入失败/);

    await page.getByRole("tab", { name: "讲解", exact: true }).click();
    await page.getByLabel("阅读笔记内容").fill("后续笔记也已落盘");
    await page.getByRole("button", { name: "保存记录", exact: true }).click();
    await expect(page.getByRole("status", { name: "本地保存状态：仅在内存" })).toBeVisible();
    await expect(page.getByRole("button", { name: "重试保存", exact: true })).toBeVisible();
    await expect(page.locator(".workspace-save-status")).toHaveAttribute("title", /路线写入失败/);

    await page.getByRole("button", { name: "重试保存", exact: true }).click();
    await expect(page.getByRole("status", { name: "本地保存状态：已保存" })).toBeVisible();
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});
