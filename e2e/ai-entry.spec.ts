import { test, expect } from "./fixtures";
import { mkdir } from "node:fs/promises";

for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 375, height: 812 }]) {
  test(`sample explains the AI entry and opens the existing repository form at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const aiRequests: string[] = [];
    page.on("request", (request) => {
      if (/\/api\/ai\/(?:preview|generate|question)(?:[/?]|$)/.test(request.url())) aiRequests.push(request.url());
    });
    await page.goto("/");
    await expect(page.locator(".app-shell")).toHaveAttribute("data-app-ready", "true");
    if (viewport.width <= 860) await page.getByRole("button", { name: "详情", exact: true }).click();
    await page.getByRole("tab", { name: "讲解", exact: true }).click();
    const aiPanel = page.getByRole("region", { name: "AI 讲解", exact: true });
    await expect(page.locator(".guide-scroll > :first-child")).toHaveAttribute("aria-label", "AI 讲解");
    await expect(aiPanel).toBeInViewport();
    await expect(aiPanel).toContainText("当前是预置的示例讲解");
    await expect(aiPanel.getByRole("button", { name: "生成当前文件讲解" })).toHaveCount(0);
    await expect(page.locator(".workspace-resize-handle svg")).toHaveCount(0);
    if (viewport.width <= 860) await expect(page.locator("#files-graph-resize")).toBeHidden();
    await mkdir(".artifacts/ai-entry-visual", { recursive: true });
    await test.info().attach(`ai-entry-${viewport.width}.png`, { body: await page.screenshot({ path: `.artifacts/ai-entry-visual/${viewport.width}.png` }), contentType: "image/png" });
    await aiPanel.getByRole("button", { name: "打开自己的仓库", exact: true }).click();
    await expect(page.getByRole("heading", { name: "打开仓库，开始阅读" })).toBeVisible();
    await expect(page.locator("#repository-path")).toBeVisible();
    expect(aiRequests).toEqual([]);
  });
}
