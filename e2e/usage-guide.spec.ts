import { expect, test } from "@playwright/test";

test("first-use welcome opens the sample guide without model or GitHub requests and remembers completion", async ({ page }) => {
  const externalOrModelRequests: string[] = [];
  page.on("request", (request) => {
    if (/github\.com|\/api\/ai\//i.test(request.url())) externalOrModelRequests.push(request.url());
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "从这里开始读懂一个仓库" })).toBeVisible();
  await expect(page.getByRole("button", { name: "体验示例" })).toBeVisible();
  await page.getByRole("button", { name: "体验示例" }).click();
  await expect(page.getByRole("dialog", { name: "使用指南" })).toBeVisible();
  await expect(page.getByRole("button", { name: "第 1 步：从入口开始" })).toBeVisible();
  expect(externalOrModelRequests).toEqual([]);

  await page.getByRole("button", { name: "快速打开文件" }).click();
  await expect(page.getByRole("dialog", { name: "快速打开文件" })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("repolens:usage-guide:v1") ?? "{}").completedTaskIds)).not.toContain("source");
  await page.getByRole("option").first().click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("repolens:usage-guide:v1") ?? "{}").completedTaskIds)).toContain("source");
  const stepBeforeGuideReturn = await page.locator(".tour-step[aria-current='step']").getAttribute("aria-label");
  await page.getByRole("button", { name: "使用指南" }).click();
  await expect(page.getByRole("dialog", { name: "使用指南" })).toBeVisible();
  await page.getByRole("button", { name: "重新查看欢迎页" }).click();
  await page.getByRole("button", { name: "体验示例" }).click();
  await expect(page.getByRole("button", { name: "第 1 步：从入口开始" })).toBeVisible();
  expect(await page.locator(".tour-step[aria-current='step']").getAttribute("aria-label")).toBe(stepBeforeGuideReturn);
  await page.reload();
  await expect(page.getByRole("heading", { name: "从这里开始读懂一个仓库" })).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "使用指南" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "使用指南" }).click();
  await expect(page.getByText("1 / 4 项已完成")).toBeVisible();
  expect(externalOrModelRequests).toEqual([]);
});

test("dependency and tour tasks complete only after the guided reading action", async ({ browser }) => {
  const dependencyPage = await browser.newPage();
  await dependencyPage.goto("/");
  await dependencyPage.getByRole("button", { name: "体验示例" }).click();
  await dependencyPage.getByRole("button", { name: "查看当前文件引用" }).click();
  expect(await dependencyPage.evaluate(() => JSON.parse(localStorage.getItem("repolens:usage-guide:v1") ?? "{}").completedTaskIds)).not.toContain("dependencies");
  await dependencyPage.locator(".relation-section .relation-list button").first().click();
  await expect.poll(() => dependencyPage.evaluate(() => JSON.parse(localStorage.getItem("repolens:usage-guide:v1") ?? "{}").completedTaskIds)).toContain("dependencies");
  await dependencyPage.close();

  const tourPage = await browser.newPage();
  await tourPage.goto("/");
  await tourPage.getByRole("button", { name: "体验示例" }).click();
  await tourPage.getByRole("button", { name: "查看下一步" }).click();
  await expect(tourPage.locator(".tour-step[aria-current='step']")).toBeVisible();
  expect(await tourPage.evaluate(() => JSON.parse(localStorage.getItem("repolens:usage-guide:v1") ?? "{}").completedTaskIds)).not.toContain("tour");
  await tourPage.getByRole("button", { name: "后退" }).click();
  await expect.poll(() => tourPage.evaluate(() => JSON.parse(localStorage.getItem("repolens:usage-guide:v1") ?? "{}").completedTaskIds)).toContain("tour");
  await tourPage.close();
});

test("welcome can be skipped or open the existing repository flow", async ({ browser }) => {
  const skipPage = await browser.newPage();
  await skipPage.goto("/");
  await skipPage.getByRole("button", { name: "跳过指引，直接进入工作区" }).click();
  await expect(skipPage.getByRole("button", { name: "第 1 步：从入口开始" })).toBeVisible();
  await skipPage.reload();
  await expect(skipPage.getByRole("heading", { name: "从这里开始读懂一个仓库" })).toHaveCount(0);
  await skipPage.close();

  const openPage = await browser.newPage();
  await openPage.goto("/");
  await openPage.getByRole("button", { name: "打开自己的仓库" }).click();
  await expect(openPage.getByLabel("本地仓库路径或 GitHub 链接")).toBeVisible();
  await expect(openPage.getByRole("dialog", { name: "使用指南" })).toHaveCount(0);
  await openPage.close();
});

test("existing browser progress shows a dismissible guide notice instead of blocking welcome", async ({ browser }) => {
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem("repolens:taskflow-sample:1.2", JSON.stringify({ stepIndex: 2, completedSteps: [] })));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "从这里开始读懂一个仓库" })).toHaveCount(0);
  await expect(page.getByText("RepoLens 使用指南已上线。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "查看指引" }).click();
  await expect(page.getByRole("dialog", { name: "使用指南" })).toBeVisible();
  await expect(page.getByText("RepoLens 使用指南已上线。", { exact: true })).toHaveCount(0);
  await page.close();
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 375, height: 812 }]) {
  test(`guide panel fits and restores focus at ${viewport.width}px`, async ({ browser }) => {
    const page = await browser.newPage({ viewport });
    await page.addInitScript(() => localStorage.setItem("repolens:usage-guide:v1", JSON.stringify({ version: 1, welcomeHandled: true, completedTaskIds: [], checklistOpen: false, noticeDismissed: true })));
    await page.goto("/");
    const trigger = page.getByRole("button", { name: "使用指南" });
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
