import { expect, test } from "./fixtures";

test("first use starts at the repository home and opens the example without generating AI content", async ({ browser }) => {
  const page = await browser.newPage();
  const modelRequests: string[] = [];
  page.on("request", (request) => {
    if (/github\.com|\/api\/ai\/(?:preview|generate|question\/preview)/i.test(request.url())) modelRequests.push(request.url());
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "打开仓库，开始阅读" })).toBeVisible();
  await expect(page.getByLabel("本地路径或 GitHub 仓库链接")).toBeVisible();
  await expect(page.getByRole("button", { name: "打开仓库", exact: true })).toBeDisabled();
  await expect(page.getByRole("heading", { name: "最近打开" })).toBeVisible();

  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "模型设置" });
  await expect(settings).toBeVisible();
  await expect(settings.getByText("桌面版会加密保存模型配置，下次启动自动恢复；浏览器版密钥仅在本次服务中保留。")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);

  await page.getByRole("button", { name: "打开示例", exact: true }).click();
  await expect(page.locator(".graph-file-card").first()).toBeVisible();
  const guide = page.getByRole("dialog", { name: "使用指南" });
  await expect(guide).toBeVisible();
  await expect(guide.getByRole("button", { name: "快速打开文件" })).toBeVisible();
  expect(modelRequests).toEqual([]);

  await guide.getByRole("button", { name: "快速打开文件" }).click();
  await expect(page.getByRole("dialog", { name: "快速打开文件" })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("repolens:usage-guide:v1") ?? "{}").completedTaskIds)).not.toContain("source");
  await page.getByRole("option").first().click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("repolens:usage-guide:v1") ?? "{}").completedTaskIds)).toContain("source");

  // Guide actions open the real workspace flow and close the panel to avoid stacking dialogs.
  await page.getByRole("button", { name: "使用指南", exact: true }).click();
  await expect(guide).toBeVisible();
  await guide.getByRole("button", { name: "关闭使用指南" }).click();
  const steps = page.locator(".tour-step-disclosure");
  await steps.locator("summary").click();
  const currentStep = page.locator(".tour-step[aria-current='step']");
  const stepBeforeHome = await currentStep.getAttribute("aria-label");
  await page.getByRole("button", { name: "使用指南", exact: true }).click();
  await expect(guide).toBeVisible();
  await guide.getByRole("button", { name: "返回首页" }).click();
  await expect(page.getByRole("heading", { name: "打开仓库，开始阅读" })).toBeVisible();
  await page.getByRole("button", { name: "打开示例", exact: true }).click();
  await expect(guide).toBeVisible();
  await guide.getByRole("button", { name: "关闭使用指南" }).click();
  await page.locator(".tour-step-disclosure > summary").click();
  expect(await page.locator(".tour-step[aria-current='step']").getAttribute("aria-label")).toBe(stepBeforeHome);

  await page.reload();
  await expect(page.getByRole("heading", { name: "打开仓库，开始阅读" })).toBeVisible();
  await page.getByRole("button", { name: "打开示例", exact: true }).click();
  await expect(guide).toBeVisible();
  await guide.getByRole("button", { name: "关闭使用指南" }).click();
  await expect(guide).toHaveCount(0);
  await page.locator(".tour-step-disclosure > summary").click();
  expect(await page.locator(".tour-step[aria-current='step']").getAttribute("aria-label")).toBe(stepBeforeHome);
  await page.getByRole("button", { name: "使用指南", exact: true }).click();
  await expect(page.getByText("1 / 4 项已完成")).toBeVisible();
  expect(modelRequests).toEqual([]);
  await page.close();
});

test("dependency and tour tasks complete only after the guided reading action", async ({ browser }) => {
  const dependencyPage = await browser.newPage();
  await dependencyPage.goto("/");
  await dependencyPage.getByRole("button", { name: "打开示例", exact: true }).click();
  await dependencyPage.getByRole("button", { name: "查看当前文件引用" }).click();
  expect(await dependencyPage.evaluate(() => JSON.parse(localStorage.getItem("repolens:usage-guide:v1") ?? "{}").completedTaskIds)).not.toContain("dependencies");
  await dependencyPage.locator(".relation-section .relation-list button").first().click();
  await expect.poll(() => dependencyPage.evaluate(() => JSON.parse(localStorage.getItem("repolens:usage-guide:v1") ?? "{}").completedTaskIds)).toContain("dependencies");
  await dependencyPage.close();

  const tourPage = await browser.newPage();
  await tourPage.goto("/");
  await tourPage.getByRole("button", { name: "打开示例", exact: true }).click();
  await tourPage.getByRole("button", { name: "查看下一步" }).click();
  await tourPage.locator(".tour-step-disclosure > summary").click();
  await expect(tourPage.locator(".tour-step[aria-current='step']")).toBeVisible();
  expect(await tourPage.evaluate(() => JSON.parse(localStorage.getItem("repolens:usage-guide:v1") ?? "{}").completedTaskIds)).not.toContain("tour");
  await expect(tourPage.getByRole("button", { name: "后退" })).toBeEnabled();
  await tourPage.getByRole("button", { name: "后退" }).click();
  await expect.poll(() => tourPage.evaluate(() => JSON.parse(localStorage.getItem("repolens:usage-guide:v1") ?? "{}").completedTaskIds)).toContain("tour");
  await tourPage.close();
});

test("the home offers repository opening and the guide without blocking the main task", async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "打开仓库，开始阅读" })).toBeVisible();
  await expect(page.getByLabel("本地路径或 GitHub 仓库链接")).toBeVisible();
  await page.getByRole("button", { name: "查看使用指南" }).click();
  await expect(page.getByRole("dialog", { name: "使用指南" })).toBeVisible();
  await page.getByRole("button", { name: "返回首页" }).click();
  await expect(page.getByRole("heading", { name: "打开仓库，开始阅读" })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("repolens:usage-guide:v1") ?? "{}").welcomeHandled)).toBe(false);
  await page.close();
});

test("existing browser progress starts at home and remains available after opening the example", async ({ browser }) => {
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem("repolens:taskflow-sample:1.2", JSON.stringify({ stepIndex: 2, completedSteps: [] })));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "打开仓库，开始阅读" })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("repolens:taskflow-sample:1.2") ?? "{}").stepIndex)).toBe(2);
  await page.getByRole("button", { name: "打开示例", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "使用指南" })).toBeVisible();
  await expect(page.getByText("使用指南可随时从顶部重新打开。", { exact: true })).toHaveCount(0);
  await page.close();
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 375, height: 812 }]) {
  test(`guide panel fits and restores focus at ${viewport.width}px`, async ({ browser }) => {
    const page = await browser.newPage({ viewport });
    await page.addInitScript(() => localStorage.setItem("repolens:usage-guide:v1", JSON.stringify({ version: 1, welcomeHandled: true, completedTaskIds: [], checklistOpen: false, noticeDismissed: true })));
    await page.goto("/");
    const trigger = page.getByRole("button", { name: "使用指南", exact: true });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "使用指南" });
    await expect(dialog).toBeVisible();
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height + 1);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await page.close();
  });
}
