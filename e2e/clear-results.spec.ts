import { test, expect, openRepositoryMenu, returnToSample } from './fixtures';

for (const width of [1440, 1024, 375]) {
  test(`partial clear preserves warning and reuses receipt at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    const ids: string[] = [];
    await page.route('**/api/workspace', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const body = route.request().postDataJSON();
      if (body.action !== 'clear-all') return route.fulfill({ json: { ok: true } });
      ids.push(body.operationId);
      return route.fulfill({ json: ids.length === 1
        ? { ok: false, warning: '阅读记录已清除，保存副本未能清理：文件被占用', cleared: { model: true, workspace: true, copies: false } }
        : { ok: true, cleared: { model: true, workspace: true, copies: true } } });
    });
    await page.goto('/');
    await (await openRepositoryMenu(page)).getByRole('button', { name: '清除全部 RepoLens 保存数据', exact: true }).click();
    await expect(page.getByText('阅读记录已清除，保存副本未能清理：文件被占用', { exact: true }).first()).toBeVisible();
    await page.evaluate(() => localStorage.setItem('repolens:taskflow-sample:post-clear', 'new-progress'));
    await page.getByRole('button', { name: '重试清除', exact: true }).click();
    expect(await page.evaluate(() => localStorage.getItem('repolens:taskflow-sample:post-clear'))).toBe('new-progress');
    await expect(page.getByText('剩余保存副本已清理，新阅读记录已保留。', { exact: true })).toBeVisible();
    expect(ids).toHaveLength(2); expect(ids[0]).toBeTruthy(); expect(ids[1]).toBe(ids[0]);
    await returnToSample(page);
    await expect(page.getByRole('button', { name: '重试保存', exact: true })).toHaveCount(0);
  });
}

for (const width of [1440, 1024, 375]) {
  test(`unknown clear outcome pauses changes and offers a safe retry at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    const ids: string[] = [];
    await page.route('**/api/workspace', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const body = route.request().postDataJSON();
      if (body.action !== 'clear-all') return route.fulfill({ json: { ok: true } });
      ids.push(body.operationId);
      if (ids.length === 1) return route.abort('connectionreset');
      return route.fulfill({ json: { ok: true, cleared: { model: true, workspace: true, copies: true } } });
    });
    await page.goto('/');
    await (await openRepositoryMenu(page)).getByRole('button', { name: '清除全部 RepoLens 保存数据', exact: true }).click();
    await expect(page.getByText(/尚未确认清除结果，自动保存已暂停/).first()).toBeVisible();
    await expect(page.getByRole('button', { name: '重试清除', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '重试清除', exact: true }).click();
    await expect(page.getByText('已清除全部 RepoLens 本地保存数据。', { exact: true })).toBeVisible();
    expect(ids).toHaveLength(2); expect(ids[1]).toBe(ids[0]);
  });
}
