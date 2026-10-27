import { test, expect, enterRepositoryLocation, openRepositoryMenu, openTourSteps } from "./fixtures";
import { installResizeObserverProbe } from "./helpers/resize-observer-probe";
import { graphNodesAreSeparated, waitForStableGraphGeometry } from "./helpers/graph-geometry";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function panelWidth(page: import("@playwright/test").Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`Panel is not visible: ${selector}`);
  return box.width;
}

async function dragHandle(page: import("@playwright/test").Page, selector: string, offsetX: number) {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`Resize handle is not visible: ${selector}`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + offsetX, y, { steps: 8 });
  await page.mouse.up();
}

async function waitAnimationFrames(page: import("@playwright/test").Page, frames: number) {
  await page.evaluate((frameCount) => new Promise<void>((resolve) => {
    let current = 0;
    const next = () => {
      if (++current >= frameCount) resolve();
      else requestAnimationFrame(next);
    };
    requestAnimationFrame(next);
  }), frames);
}

test("workspace columns resize by keyboard and retain separate reading and structure proportions", async ({ page }) => {
  const resizeProbe = await installResizeObserverProbe(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator("#workspace-columns")).toHaveAttribute("data-layout-ready", "true");
  const fileGraphHandle = page.locator("#files-graph-resize");
  await expect(fileGraphHandle).toBeVisible();
  await expect(page.locator(".workspace-resize-handle svg")).toHaveCount(0);

  const originalStructureWidth = await panelWidth(page, ".files-pane");
  await fileGraphHandle.focus();
  for (let index = 0; index < 12; index += 1) await fileGraphHandle.press("ArrowRight");
  const resizedStructureWidth = await panelWidth(page, ".files-pane");
  expect(resizedStructureWidth).toBeGreaterThan(originalStructureWidth + 40);

  await page.getByRole("button", { name: "阅读", exact: true }).click();
  await expect(page.locator("#graph-details-resize")).toBeHidden();
  await expect(page.locator("#graph")).toBeHidden();
  const originalReadingWidth = await panelWidth(page, ".files-pane");
  const readingContentWidth = await panelWidth(page, "#content");
  const readingSourceWidth = await panelWidth(page, ".details-pane");
  expect(readingSourceWidth).toBeGreaterThan(readingContentWidth - 3);
  await fileGraphHandle.focus();
  for (let index = 0; index < 8; index += 1) await fileGraphHandle.press("ArrowLeft");
  const resizedReadingWidth = await panelWidth(page, ".files-pane");
  expect(resizedReadingWidth).toBeLessThan(originalReadingWidth - 30);

  await page.getByRole("button", { name: "结构", exact: true }).click();
  await expect.poll(async () => Math.abs(await panelWidth(page, ".files-pane") - resizedStructureWidth)).toBeLessThan(3);
  await page.reload();
  await expect(fileGraphHandle).toBeVisible();
  await expect(page.locator("#workspace-columns")).toHaveAttribute("data-layout-ready", "true");
  await expect.poll(async () => Math.abs(await panelWidth(page, ".files-pane") - resizedStructureWidth)).toBeLessThan(3);
  await page.getByRole("button", { name: "阅读", exact: true }).click();
  await expect.poll(async () => Math.abs(await panelWidth(page, ".files-pane") - resizedReadingWidth)).toBeLessThan(3);

  await page.getByRole("button", { name: "结构", exact: true }).click();
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect.poll(() => panelWidth(page, ".files-pane")).toBeLessThan(resizedStructureWidth - 30);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(async () => Math.abs(await panelWidth(page, ".files-pane") - resizedStructureWidth)).toBeLessThan(3);
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(fileGraphHandle).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(fileGraphHandle).toBeVisible();
  await expect.poll(async () => Math.abs(await panelWidth(page, ".files-pane") - resizedStructureWidth)).toBeLessThan(3);
  const resizeWarnings = await resizeProbe.errors();
  await waitAnimationFrames(page, 24);
  const warningsAfterStableFrames = await resizeProbe.errors();
  expect(warningsAfterStableFrames).toHaveLength(resizeWarnings.length);
  await test.info().attach("raw-resize-observer-events.json", {
    body: JSON.stringify({ transientEvents: resizeWarnings, eventsAfter24StableFrames: warningsAfterStableFrames }, null, 2),
    contentType: "application/json",
  });
  expect(warningsAfterStableFrames, resizeProbe.logs.join("\n")).toEqual([]);
});

test("mouse resize respects panel minimums and double-click restores each layout default", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator("#workspace-columns")).toHaveAttribute("data-layout-ready", "true");

  const outer = page.locator("#files-graph-resize");
  const inner = page.locator("#graph-details-resize");
  await expect(outer).toHaveAttribute("title", /双击恢复默认宽度/);
  await expect(inner).toHaveAttribute("title", /双击恢复默认宽度/);

  const outerDefault = await panelWidth(page, "#files");
  await dragHandle(page, "#files-graph-resize", 90);
  expect(await panelWidth(page, "#files")).toBeGreaterThan(outerDefault + 50);
  await outer.dblclick();
  await expect.poll(async () => Math.abs(await panelWidth(page, "#files") - outerDefault)).toBeLessThan(4);

  const graphDefault = await panelWidth(page, "#graph");
  const detailsDefault = await panelWidth(page, "#details");
  await dragHandle(page, "#graph-details-resize", 100);
  expect(await panelWidth(page, "#graph")).toBeGreaterThan(graphDefault + 50);
  expect(await panelWidth(page, "#details")).toBeLessThan(detailsDefault - 40);
  await inner.dblclick();
  await expect.poll(async () => Math.abs(await panelWidth(page, "#graph") - graphDefault)).toBeLessThan(4);
  await expect.poll(async () => Math.abs(await panelWidth(page, "#details") - detailsDefault)).toBeLessThan(4);

  await dragHandle(page, "#files-graph-resize", -2_000);
  await expect.poll(async () => panelWidth(page, "#files")).toBeGreaterThanOrEqual(180);
  expect(await panelWidth(page, "#files")).toBeLessThan(190);

  await dragHandle(page, "#graph-details-resize", -2_000);
  expect(await panelWidth(page, "#graph")).toBeGreaterThanOrEqual(280);
  expect(await panelWidth(page, "#graph")).toBeLessThan(290);
  const narrowGraphBounds = await page.locator(".graph-pane").boundingBox();
  const resetButtonBounds = await page.getByRole("button", { name: "重置布局", exact: true }).boundingBox();
  expect(resetButtonBounds!.x + resetButtonBounds!.width).toBeLessThanOrEqual(narrowGraphBounds!.x + narrowGraphBounds!.width);
  await dragHandle(page, "#graph-details-resize", 2_000);
  expect(await panelWidth(page, "#details")).toBeGreaterThanOrEqual(280);
  expect(await panelWidth(page, "#details")).toBeLessThan(290);

  await page.getByRole("button", { name: "阅读", exact: true }).click();
  const readingDefault = await panelWidth(page, "#files");
  await dragHandle(page, "#files-graph-resize", 100);
  expect(await panelWidth(page, "#files")).toBeGreaterThan(readingDefault + 50);
  await outer.dblclick();
  await expect.poll(async () => Math.abs(await panelWidth(page, "#files") - readingDefault)).toBeLessThan(4);
  await page.reload();
  await expect(page.locator("#workspace-columns")).toHaveAttribute("data-layout-ready", "true");
  await page.getByRole("button", { name: "阅读", exact: true }).click();
  await expect.poll(async () => Math.abs(await panelWidth(page, "#files") - readingDefault)).toBeLessThan(4);
});

test("resizing columns keeps the mounted question draft and current source file", async ({ page }) => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "repolens-resize-state-"));
  try {
    await writeFile(join(repositoryPath, "main.ts"), 'import { value } from "./value";\nexport const main = value;\n');
    await writeFile(join(repositoryPath, "value.ts"), "export const value = 42;\n");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await enterRepositoryLocation(page, repositoryPath);
    await page.getByRole("button", { name: "打开仓库" }).click();
    await expect(page.locator(".sample-badge")).toContainText("本地仓库");
    await page.getByRole("tab", { name: "问答" }).click();
    const draft = page.getByRole("textbox", { name: "提问或追问" });
    await draft.fill("解释 main.ts 如何使用 value");

    await dragHandle(page, "#files-graph-resize", 55);
    await dragHandle(page, "#graph-details-resize", 70);

    await expect(page.locator("#ai-chat-panel")).toBeVisible();
    await expect(draft).toHaveValue("解释 main.ts 如何使用 value");
    await expect(page.getByRole("treeitem", { name: "main.ts" })).toHaveAttribute("aria-selected", "true");
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

test("clear all removes browser layout preferences", async ({ page }) => {
  const storedLayout = { version: 1, structure: { files: 30, graph: 40, details: 30 }, reading: { files: 36, details: 64 } };
  await page.addInitScript((layout) => localStorage.setItem("repolens:layout-preferences:v1", JSON.stringify(layout)), storedLayout);
  await page.goto("/");
  await expect(page.locator("#workspace-columns")).toHaveAttribute("data-layout-ready", "true");
  const menu = await openRepositoryMenu(page);
  await menu.getByRole("button", { name: "清除全部 RepoLens 保存数据" }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("repolens:layout-preferences:v1"))).toBeNull();
  await expect(page.getByText("已清除全部 RepoLens 本地保存数据。")).toBeVisible();
});

test("divider dragging preserves stable graph coordinates and the source reference", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await openTourSteps(page);
  await page.getByRole("button", { name: "第 5 步：查看数据来源" }).click();
  const expectedNodeIds = ["src/hooks/useTasks.ts", "src/services/taskService.ts", "src/data/seed.ts", "src/types.ts"];
  await waitForStableGraphGeometry(page, { expectedNodeIds, minimumNodeCount: 4 });
  const readCoordinates = () => page.locator(".react-flow__node").evaluateAll((elements) => Object.fromEntries(elements.map((element) => [element.getAttribute("data-id"), (element as HTMLElement).style.transform])));
  const before = await readCoordinates();
  await expect(page.locator("#source-line-4.is-focused")).toBeVisible();
  await dragHandle(page, "#files-graph-resize", 45);
  await dragHandle(page, "#graph-details-resize", 35);
  const finalGeometry = await waitForStableGraphGeometry(page, { expectedNodeIds, minimumNodeCount: 4 });
  expect(graphNodesAreSeparated(finalGeometry)).toBe(true);
  expect(await readCoordinates()).toEqual(before);
  await expect(page.locator("#source-line-4.is-focused")).toBeVisible();
  await expect(page.getByRole("treeitem", { name: "taskService.ts" })).toHaveAttribute("aria-selected", "true");
  await test.info().attach("resized-workspace.png", { body: await page.screenshot(), contentType: "image/png" });
});

test("phone tabs stay interactive after leaving the desktop reading layout", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator("#workspace-columns")).toHaveAttribute("data-layout-ready", "true");
  await page.getByRole("button", { name: "阅读", exact: true }).click();
  const readingWidth = await panelWidth(page, ".files-pane");
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await page.getByRole("treeitem", { name: "taskService.ts" }).click();
  await expect(page.locator(".details-pane")).toBeVisible();
  await page.getByRole("button", { name: "依赖图", exact: true }).click();
  await expect(page.locator(".graph-file-card.is-selected")).toContainText("taskService.ts");
  await waitForStableGraphGeometry(page, { minimumNodeCount: 4 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator("#graph")).toBeHidden();
  await expect.poll(async () => Math.abs(await panelWidth(page, ".files-pane") - readingWidth)).toBeLessThan(4);
});

test("AI width survives reload and narrow views without remounting chat", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator("#workspace-columns")).toHaveAttribute("data-layout-ready", "true");
  await page.getByRole("button", { name: "打开 AI 聊天", exact: true }).click();
  await expect(page.locator(".ai-chat-drawer")).toBeVisible();
  const handle = page.getByRole("separator", { name: "调整 AI 栏宽度" });
  await expect(handle).toBeVisible();
  const initial = await panelWidth(page, ".ai-chat-drawer");
  await dragHandle(page, ".chat-resize-handle", -80);
  await expect.poll(() => panelWidth(page, ".ai-chat-drawer")).toBeGreaterThan(initial + 40);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("repolens:layout-preferences:v1") ?? "{}").chatWidth ?? 0)).toBeGreaterThan(360);
  const preferred = await page.evaluate(() => JSON.parse(localStorage.getItem("repolens:layout-preferences:v1") ?? "{}").chatWidth);
  expect(preferred).toBeGreaterThan(360);
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(handle).not.toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(async () => Math.abs(await panelWidth(page, ".ai-chat-drawer") - preferred)).toBeLessThan(3);
  await page.reload();
  await page.getByRole("button", { name: "打开 AI 聊天", exact: true }).click();
  await expect.poll(async () => Math.abs(await panelWidth(page, ".ai-chat-drawer") - preferred)).toBeLessThan(3);
  await handle.dblclick();
  await expect.poll(async () => Math.abs(await panelWidth(page, ".ai-chat-drawer") - 360)).toBeLessThan(3);
});
