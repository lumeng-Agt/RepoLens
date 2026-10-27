import { expect, test as base, type Browser, type Page } from "@playwright/test";

export const returningUserGuidePreferences = {
  version: 1,
  welcomeHandled: true,
  completedTaskIds: [],
  checklistOpen: false,
  noticeDismissed: true,
};

export async function markReturningUser(page: Page) {
  await page.addInitScript((preferences) => {
    localStorage.setItem("repolens:usage-guide:v1", JSON.stringify(preferences));
  }, returningUserGuidePreferences);
}

export async function createReturningPage(browser: Browser, options?: Parameters<Browser["newPage"]>[0]) {
  const page = await browser.newPage(options);
  await markReturningUser(page);
  configureSampleWorkspaceNavigation(page);
  return page;
}

export async function openRepositoryHome(page: Page) {
  const heading = page.getByRole("heading", { name: "打开仓库，开始阅读" });
  if (await heading.isVisible().catch(() => false)) return;
  await expect(page.getByRole("button", { name: "使用指南", exact: true })).toBeEnabled();
  const menu = page.locator(".repo-menu");
  await menu.locator("summary").click();
  await menu.getByRole("button", { name: "返回首页", exact: true }).click();
  await expect(heading).toBeVisible();
}

export async function openRepositoryMenu(page: Page) {
  await expect(page.getByRole("button", { name: "使用指南", exact: true })).toBeEnabled();
  const menu = page.locator(".repo-menu");
  const isOpen = await menu.evaluate((element) => (element as HTMLDetailsElement).open);
  if (!isOpen) await menu.locator("summary").click();
  return menu;
}

export async function enterRepositoryLocation(page: Page, location: string) {
  await openRepositoryHome(page);
  await page.locator("#repository-path").fill(location);
}

export async function openModelSettings(page: Page) {
  const dialog = page.getByRole("dialog", { name: "模型设置" });
  if (!await dialog.isVisible().catch(() => false)) {
    const trigger = page.locator(".settings-trigger");
    if (await trigger.count()) await trigger.click();
    else await page.locator(".home-header-actions").getByRole("button", { name: "模型设置", exact: true }).click();
  }
  await expect(dialog).toBeVisible();
  return dialog;
}

export async function closeModelSettings(page: Page) {
  const dialog = page.getByRole("dialog", { name: "模型设置" });
  if (await dialog.isVisible().catch(() => false)) await dialog.getByRole("button", { name: "关闭", exact: true }).click();
}

export async function openTourSteps(page: Page) {
  await expect(page.getByRole("button", { name: "使用指南", exact: true })).toBeEnabled();
  const routeToggle = page.locator(".route-visibility-trigger");
  if (await routeToggle.count() && await routeToggle.getAttribute("aria-expanded") === "false") await routeToggle.click();
  const disclosure = page.locator(".tour-step-disclosure");
  await expect(disclosure).toHaveCount(1);
  const isOpen = await disclosure.evaluate((element) => (element as HTMLDetailsElement).open);
  if (!isOpen) await disclosure.locator("summary").click();
  const current = page.locator('.tour-step[aria-current="step"]');
  await expect(current).toBeVisible();
  return current;
}

export async function returnToSample(page: Page) {
  await expect(page.locator(".repository-home:visible, .app-shell:visible")).toHaveCount(1);
  const home = page.getByRole("heading", { name: "打开仓库，开始阅读" });
  if (await home.isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "打开示例", exact: true }).click();
    const guide = page.getByRole("dialog", { name: "使用指南" });
    await expect(guide).toBeVisible();
    await guide.getByRole("button", { name: "关闭使用指南" }).click();
    await expect(page.locator(".sample-badge")).toContainText("示例仓库");
    await expect(page.locator(".app-shell")).toBeVisible();
    return;
  }
  await expect(page.getByRole("button", { name: "使用指南", exact: true })).toBeEnabled();
  const menu = page.locator(".repo-menu");
  await menu.locator("summary").click();
  await menu.getByRole("button", { name: "打开示例", exact: true }).click();
  await expect(page.getByText("示例仓库", { exact: true })).toBeVisible();
  await expect(page.locator(".app-shell")).toBeVisible();
}

export const test = base.extend({
  page: async ({ page }, use) => {
    await markReturningUser(page);
    configureSampleWorkspaceNavigation(page);
    // Playwright's fixture callback is named `use`; it is not a React hook.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    await use(page);
  },
});

export { expect };
export type { Page };

// Workspace tests explicitly enter the example after each navigation. Startup
// behavior is tested with browser.newPage(), without this workspace helper.
function configureSampleWorkspaceNavigation(page: Page) {
  const navigate = page.goto.bind(page);
  page.goto = async (...args) => { const response = await navigate(...args); await expect(page.getByRole("heading", { name: "打开仓库，开始阅读" })).toBeVisible(); await returnToSample(page); return response; };
  const reload = page.reload.bind(page);
  page.reload = async (...args) => { const response = await reload(...args); await expect(page.getByRole("heading", { name: "打开仓库，开始阅读" })).toBeVisible(); await returnToSample(page); return response; };
}
