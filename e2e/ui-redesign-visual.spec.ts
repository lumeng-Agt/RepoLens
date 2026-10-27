import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { waitForStableGraphGeometry } from "./helpers/graph-geometry";

const screenshotDirectory = path.resolve(".artifacts/ui-redesign");
const viewports = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1024x768", width: 1024, height: 768 },
  { name: "375x812", width: 375, height: 812 },
];

test.beforeAll(async () => mkdir(screenshotDirectory, { recursive: true }));

for (const viewport of viewports) {
  test(`redesigned home and workspace render without horizontal overflow at ${viewport.name}`, async ({ browser }) => {
    const page = await browser.newPage({ viewport });
    const pageErrors: string[] = [];
    const modelRequests: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("request", (request) => {
      if (/\/api\/ai\/(?:preview|generate|question)/.test(request.url())) modelRequests.push(request.url());
    });

    await page.goto("/");
    await expect(page.getByRole("heading", { name: "打开仓库，开始阅读" })).toBeVisible();
    await page.screenshot({ path: path.join(screenshotDirectory, `${viewport.name}-home.png`), fullPage: true });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

    await page.getByRole("button", { name: "打开示例", exact: true }).click();
    const guide = page.getByRole("dialog", { name: "使用指南" });
    await expect(guide).toBeVisible();
    await guide.getByRole("button", { name: "关闭使用指南" }).click();
    if (viewport.width <= 860) await page.getByRole("button", { name: "依赖图" }).click();
    await expect(page.locator(".graph-pane")).toHaveAttribute("data-graph-ready", "true", { timeout: 10000 });
    await expect(page.locator(".graph-file-card").first()).toBeVisible();
    await waitForStableGraphGeometry(page, { minimumNodeCount: 1 });
    await page.screenshot({ path: path.join(screenshotDirectory, `${viewport.name}-workspace.png`), fullPage: true });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

    await page.locator(".settings-trigger").click();
    await expect(page.getByRole("dialog", { name: "模型设置" })).toBeVisible();
    await page.screenshot({ path: path.join(screenshotDirectory, `${viewport.name}-settings.png`), fullPage: true });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "模型设置" })).toHaveCount(0);
    await expect(pageErrors).toEqual([]);
    expect(modelRequests).toEqual([]);
    await page.close();
  });
}
