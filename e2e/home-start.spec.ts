import { test, expect } from '@playwright/test';

test('every launch and refresh starts at home even with existing guide preferences', async ({ browser }) => {
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('repolens:usage-guide:v1', JSON.stringify({ version: 1, welcomeHandled: true, completedTaskIds: ['source'], checklistOpen: false, noticeDismissed: true })));
  const requests: string[] = [];
  page.on('request', request => { if (/github\.com|\/api\/ai\/(generate|preview|question\/preview)/.test(request.url())) requests.push(request.url()); });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '打开仓库，开始阅读' })).toBeVisible();
  await expect(page.locator('.app-shell')).toBeHidden();
  await page.getByRole('button', { name: '打开示例', exact: true }).click();
  await expect(page.locator('.app-shell')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '打开仓库，开始阅读' })).toBeVisible();
  expect(requests).toEqual([]);
  await page.close();
});
