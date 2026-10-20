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
  return page;
}

export const test = base.extend({
  page: async ({ page }, use) => {
    await markReturningUser(page);
    // Playwright's fixture callback is named `use`; it is not a React hook.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    await use(page);
  },
});

export { expect };
export type { Page };
