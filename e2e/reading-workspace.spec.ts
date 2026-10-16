import { expect, test } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  await expect(page.getByRole("tab", { name: "源码" })).toHaveAttribute("data-state", "active");
  await expect(page.locator(".detail-file-title strong")).toHaveText("TaskList.tsx");
  await page.getByRole("button", { name: "结构", exact: true }).click();
  await expect(page.locator(".graph-pane")).toBeVisible();
  await expect(page.locator(".detail-file-title strong")).toHaveText("TaskList.tsx");
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
