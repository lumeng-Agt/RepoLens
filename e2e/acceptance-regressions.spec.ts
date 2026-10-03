import { test, expect, type Page } from '@playwright/test';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { isGraphNodeWithinBounds, waitForStableGraphGeometry } from './helpers/graph-geometry';

let modelServer: Server;
let modelOrigin = '';
let modelCalls = 0;
const roots: string[] = [];
const apiOrigin = 'http://127.0.0.1:4319';

test.beforeAll(async () => {
  modelServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    modelCalls += 1;
    const prompt = input.messages[1].content as string;
    const files = [...prompt.matchAll(/^FILE ([^\r\n]+) LINES (\d+)-(\d+)/gm)];
    const taskMatch = prompt.match(/^任务信息：(.+)$/m);
    if (!taskMatch) throw new Error('model request is missing selected task metadata');
    const task = JSON.parse(taskMatch[1]) as { mode: string; entryFileId: string };
    const entryRange = files.find((file) => file[1] === task.entryFileId);
    if (!entryRange) throw new Error(`model scope is missing selected entry ${task.entryFileId}`);
    const result = task.mode === 'route'
      ? { title: '验收路线', steps: (() => {
        const routeFiles = [entryRange, ...files.filter((file) => file[1] !== task.entryFileId)];
        while (routeFiles.length < 3) routeFiles.push(entryRange);
        return routeFiles.slice(0, 3).map((file, index) => ({
          fileId: file[1],
          purpose: `阅读路线第 ${index + 1} 步`,
          references: [{ fileId: file[1], startLine: Number(file[2]) }],
        }));
      })() }
      : { role: '验收文件讲解', keyPoints: ['文件讲解响应'], references: [{ fileId: task.entryFileId, startLine: Number(entryRange[2]) }] };
    response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
  });
  await new Promise<void>((resolve) => modelServer.listen(0, '127.0.0.1', resolve));
  const address = modelServer.address();
  if (!address || typeof address === 'string') throw new Error('mock bind failed');
  modelOrigin = `http://127.0.0.1:${address.port}/v1`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => modelServer.close(() => resolve()));
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function repository(source = 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'repolens-review-'));
  roots.push(root);
  await writeFile(path.join(root, 'main.ts'), source);
  return root;
}

async function open(page: Page, root: string) {
  await page.goto('/');
  await page.getByRole('button', { name: '第 1 步：从入口开始' }).waitFor();
  await page.getByLabel('本地仓库路径').fill(root);
  const responsePromise = page.waitForResponse((response) => response.url() === `${apiOrigin}/api/open`);
  await page.getByRole('button', { name: '打开仓库', exact: true }).click();
  const snapshot = await (await responsePromise).json();
  await expect(page.getByRole('treeitem', { name: 'main.ts', exact: true })).toBeVisible();
  await page.getByLabel('兼容服务地址').fill(modelOrigin);
  await page.getByLabel('模型名称').fill('review-mock');
  await page.getByLabel('API 密钥').fill('review-only-key');
  await page.getByRole('button', { name: '保存本地配置' }).click();
  await expect(page.getByText('模型配置已保存在本地服务内存中。')).toBeVisible();
  return snapshot;
}

async function openOnly(page: Page, root: string, filename = 'main.ts') {
  await page.goto('/');
  await page.getByRole('button', { name: '第 1 步：从入口开始' }).waitFor();
  await page.getByLabel('本地仓库路径').fill(root);
  const openButton = page.getByRole('button', { name: '打开仓库', exact: true });
  await expect(openButton).toBeEnabled();
  await openButton.click();
  await expect(page.getByRole('treeitem', { name: filename, exact: true })).toBeVisible({ timeout: 10_000 });
}

async function generate(page: Page, label: string) {
  await page.getByRole('button', { name: label, exact: true }).click();
  await expect(page.getByText('发送前确认', { exact: true })).toBeVisible();
  const responsePromise = page.waitForResponse((response) => response.url() === `${apiOrigin}/api/ai/generate`);
  await page.getByRole('button', { name: '确认发送并生成' }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  return response.json();
}

async function trackSettingsResponses(page: Page) {
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const response = await originalFetch(input, init);
      const request = input instanceof Request ? input : null;
      const requestUrl = request?.url ?? String(input);
      const method = init?.method ?? request?.method ?? 'GET';
      if (requestUrl.endsWith('/api/ai/settings')) {
        const originalJson = response.json.bind(response);
        response.json = async () => {
          const value = await originalJson();
          const state = window as unknown as Record<string, unknown>;
          const key = `__repolensSettingsParsed_${method}`;
          state[key] = Number(state[key] ?? 0) + 1;
          return value;
        };
      }
      return response;
    };
  });
}

async function waitForSettingsResponseParsed(page: Page, method: 'GET' | 'POST', count = 1) {
  await page.waitForFunction(({ expectedMethod, expectedCount }) => {
    const state = window as unknown as Record<string, unknown>;
    return Number(state[`__repolensSettingsParsed_${expectedMethod}`] ?? 0) >= expectedCount;
  }, { expectedMethod: method, expectedCount: count });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test('A1 oversize preview must expose selectable source ranges', async ({ page }) => {
  const source = Array.from({ length: 1300 }, (_, index) => `export const value${index} = '${'x'.repeat(40)}';`).join('\n');
  const root = await repository(source);
  await open(page, root);
  const responsePromise = page.waitForResponse((response) => response.url() === `${apiOrigin}/api/ai/preview`);
  await page.getByRole('button', { name: '生成当前文件讲解', exact: true }).click();
  const response = await responsePromise;
  console.log('A1 HTTP', response.status(), 'scopeRequired', (await response.json()).scopeRequired);
  await expect(page.getByText('选择发送范围', { exact: true })).toBeVisible();
  await page.getByLabel('main.ts 结束行').fill('300');
  const previewPromise = page.waitForResponse((next) => next.url() === `${apiOrigin}/api/ai/preview`);
  await page.getByRole('button', { name: '预览所选范围' }).click();
  expect((await previewPromise).status()).toBe(200);
  await expect(page.getByText('发送前确认', { exact: true })).toBeVisible();
});

test('A1b a single oversized source line reports why it cannot be narrowed', async ({ page }) => {
  const root = await repository(`export const long = '${'x'.repeat(61000)}';\n`);
  await open(page, root);
  await page.getByRole('button', { name: '生成当前文件讲解', exact: true }).click();
  await expect(page.getByText('选择发送范围', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('所选范围包含超长单行');
  await expect(page.getByRole('button', { name: '预览所选范围' })).toBeDisabled();
});

test('A1c more than twelve imported files opens the scope selector', async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'repolens-review-many-'));
  roots.push(root);
  const imports = Array.from({ length: 12 }, (_, index) => `import { value${index} } from './dep${index}';`).join('\n');
  await writeFile(path.join(root, 'main.ts'), `${imports}\nexport const total = ${Array.from({ length: 12 }, (_, index) => `value${index}`).join(' + ')};\n`);
  for (let index = 0; index < 12; index += 1) await writeFile(path.join(root, `dep${index}.ts`), `export const value${index} = ${index};\n`);
  await open(page, root);
  await page.getByRole('treeitem', { name: 'main.ts', exact: true }).click();
  await page.getByRole('button', { name: '生成阅读路线', exact: true }).click();
  await expect(page.getByText('选择发送范围', { exact: true })).toBeVisible();
  await expect(page.locator('.ai-scope-picker label')).toHaveCount(13);
  await page.getByRole('checkbox', { name: /dep11\.ts/ }).uncheck();
  const previewPromise = page.waitForResponse((response) => response.url() === `${apiOrigin}/api/ai/preview`);
  await page.getByRole('button', { name: '预览所选范围' }).click();
  expect((await previewPromise).status()).toBe(200);
  await expect(page.getByText('发送前确认', { exact: true })).toBeVisible();
});

test('A2 file explanation must not remove a generated route', async ({ page }) => {
  await open(page, await repository());
  await generate(page, '生成阅读路线');
  await expect(page.getByRole('button', { name: '第 1 步：main.ts' })).toBeVisible();
  await page.getByRole('button', { name: '第 2 步：main.ts' }).click();
  await page.getByRole('tab', { name: '讲解', exact: true }).click();
  await generate(page, '生成当前文件讲解');
  await expect(page.getByText('验收文件讲解', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '第 2 步：main.ts' })).toHaveAttribute('aria-current', 'step');
});

test('A2b explanation and route expire independently after a deep dependency changes', async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'repolens-review-stale-'));
  roots.push(root);
  await writeFile(path.join(root, 'main.ts'), "import { value } from './middle'; export const main = value;\n");
  await writeFile(path.join(root, 'middle.ts'), "import { deep } from './deep'; export const value = deep;\n");
  await writeFile(path.join(root, 'deep.ts'), "export const deep = 1;\n");
  await open(page, root);
  await page.getByRole('treeitem', { name: 'main.ts', exact: true }).click();
  await generate(page, '生成当前文件讲解');
  await expect(page.getByText('验收文件讲解', { exact: true })).toBeVisible();
  await generate(page, '生成阅读路线');
  await page.getByRole('tab', { name: '讲解', exact: true }).click();
  await writeFile(path.join(root, 'deep.ts'), "export const deep = 2;\n");
  await expect(page.getByRole('button', { name: '下一步' })).toBeDisabled({ timeout: 10_000 });
  await page.getByRole('treeitem', { name: 'main.ts', exact: true }).click();
  await expect(page.locator('.ai-result [role="status"]')).toHaveCount(0);
  await expect(page.locator('.ai-result .reference-row').first()).toBeEnabled();
});

test('an expired AI route restores its progress without restoring stale source focus', async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'repolens-review-reopen-stale-'));
  roots.push(root);
  await writeFile(path.join(root, 'main.ts'), "import { value } from './middle'; export const main = value;\n");
  await writeFile(path.join(root, 'middle.ts'), "import { deep } from './deep'; export const value = deep;\n");
  await writeFile(path.join(root, 'deep.ts'), 'export const deep = 1;\nexport const second = 2;\nexport const third = 3;\n');
  await open(page, root);
  await page.getByRole('treeitem', { name: 'main.ts', exact: true }).click();
  await generate(page, '生成阅读路线');
  const thirdStep = page.getByRole('button', { name: /第 3 步：middle\.ts/ });
  await thirdStep.click();
  await expect(thirdStep).toHaveAttribute('aria-current', 'step');
  await page.getByRole('tab', { name: '讲解', exact: true }).click();
  await writeFile(path.join(root, 'middle.ts'), "import { deep } from './deep'; export const value = deep + 1;\n");
  await expect(page.getByRole('button', { name: '完成导览' })).toBeDisabled({ timeout: 10_000 });
  await page.getByRole('button', { name: '返回示例' }).click();
  await page.getByLabel('本地仓库路径').fill(root);
  await page.getByRole('button', { name: '打开仓库', exact: true }).click();
  await expect(page.getByRole('button', { name: /第 3 步：middle\.ts/ })).toHaveAttribute('aria-current', 'step');
  await expect(page.getByRole('button', { name: '完成导览' })).toBeDisabled();
  await page.getByRole('tab', { name: '源码', exact: true }).click();
  await expect(page.locator('.source-line.is-focused')).toHaveCount(0);
  await expect(page.getByText(/旧行号定位已停用/)).toBeVisible();
});

test('a delayed settings save cannot overwrite a newer unsaved draft', async ({ page }) => {
  const root = await repository();
  let releaseSave!: () => void;
  let notifySaveStarted!: () => void;
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
  const saveStarted = new Promise<void>((resolve) => { notifySaveStarted = resolve; });
  await trackSettingsResponses(page);
  await page.route(`${apiOrigin}/api/ai/settings`, async (route) => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    const response = await route.fetch();
    notifySaveStarted();
    await saveGate;
    await route.fulfill({ response });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '第 1 步：从入口开始' }).waitFor();
  await page.getByLabel('本地仓库路径').fill(root);
  const openButton = page.getByRole('button', { name: '打开仓库', exact: true });
  await expect(openButton).toBeEnabled();
  await openButton.click();
  await expect(page.getByRole('treeitem', { name: 'main.ts', exact: true })).toBeVisible();
  await page.getByLabel('兼容服务地址').fill(modelOrigin);
  await page.getByLabel('模型名称').fill('old-model');
  await page.getByLabel('API 密钥').fill('old-test-key');
  await page.getByRole('button', { name: '保存本地配置' }).click();
  await saveStarted;
  await expect(page.getByRole('button', { name: '正在保存…' })).toBeDisabled();
  await page.getByLabel('模型名称').fill('new-unsaved-model');
  await page.getByLabel('API 密钥').fill('new-test-key');
  releaseSave();
  await waitForSettingsResponseParsed(page, 'POST');
  await expect(page.getByText('已保存较早的配置；当前表单包含更新内容，请再次保存后使用 AI。')).toBeVisible();
  await expect(page.getByLabel('模型名称')).toHaveValue('new-unsaved-model');
  await expect(page.getByLabel('API 密钥')).toHaveValue('new-test-key');
  await page.getByRole('button', { name: '生成当前文件讲解', exact: true }).click();
  await expect(page.getByText('请先保存完整的模型服务地址、模型名称和密钥，再预览发送范围。')).toBeVisible();
});

for (const draft of [
  { name: 'service address', label: '兼容服务地址', value: 'http://127.0.0.1:4319/unsaved-v2' },
  { name: 'model name', label: '模型名称', value: 'uncommitted-model-draft' },
  { name: 'API key', label: 'API 密钥', value: 'uncommitted-secret-draft' },
]) {
  test(`an unsaved ${draft.name} remains unusable after returning to the sample and reopening a repository`, async ({ page }) => {
    const root = await repository();
    let previewRequests = 0;
    await page.route(`${apiOrigin}/api/ai/settings`, async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ baseUrl: modelOrigin, model: 'persisted-test-model', configured: true }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ baseUrl: modelOrigin, model: 'persisted-test-model', configured: true }) });
    });
    await page.route(`${apiOrigin}/api/ai/preview`, async (route) => {
      previewRequests += 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ error: 'preview must not be reached' }) });
    });

    await openOnly(page, root);
    await expect(page.getByLabel('模型名称')).toHaveValue('persisted-test-model');
    await page.getByLabel(draft.label).fill(draft.value);
    await page.getByRole('button', { name: '返回示例', exact: true }).click();
    await page.getByLabel('本地仓库路径').fill(root);
    await page.getByRole('button', { name: '打开仓库', exact: true }).click();
    await expect(page.getByRole('treeitem', { name: 'main.ts', exact: true })).toBeVisible();
    await expect(page.getByLabel('模型名称')).toHaveValue(draft.label === '模型名称' ? draft.value : 'persisted-test-model');
    await expect(page.getByLabel(draft.label)).toHaveValue(draft.value);

    await page.getByRole('button', { name: '生成当前文件讲解', exact: true }).click();
    await expect(page.getByText('请先保存完整的模型服务地址、模型名称和密钥，再预览发送范围。')).toBeVisible();
    expect(previewRequests).toBe(0);
  });
}

test('a delayed settings read cannot replace a draft entered after the read began', async ({ page }) => {
  const root = await repository();
  let releaseRead!: () => void;
  let notifyReadStarted!: () => void;
  const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
  const readStarted = new Promise<void>((resolve) => { notifyReadStarted = resolve; });
  await trackSettingsResponses(page);
  await page.route(`${apiOrigin}/api/ai/settings`, async (route) => {
    if (route.request().method() !== 'GET') { await route.continue(); return; }
    const response = await route.fetch();
    notifyReadStarted();
    await readGate;
    await route.fulfill({ response });
  });
  try {
    await openOnly(page, root);
    await readStarted;
    await page.getByLabel('兼容服务地址').fill(modelOrigin);
    await page.getByLabel('模型名称').fill('draft-after-read');
    await page.getByLabel('API 密钥').fill('draft-key-after-read');
    releaseRead();
    await waitForSettingsResponseParsed(page, 'GET');
    await expect(page.getByLabel('兼容服务地址')).toHaveValue(modelOrigin);
    await expect(page.getByLabel('模型名称')).toHaveValue('draft-after-read');
    await expect(page.getByLabel('API 密钥')).toHaveValue('draft-key-after-read');
    await page.getByRole('button', { name: '生成当前文件讲解', exact: true }).click();
    await expect(page.getByText('请先保存完整的模型服务地址、模型名称和密钥，再预览发送范围。')).toBeVisible();
  } finally {
    releaseRead();
  }
});

test('a settings read failure remains visible when the user edits the draft while the request is pending', async ({ page }) => {
  const root = await repository();
  let releaseRead!: () => void;
  let notifyReadStarted!: () => void;
  const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
  const readStarted = new Promise<void>((resolve) => { notifyReadStarted = resolve; });
  let previewRequests = 0;
  await trackSettingsResponses(page);
  await page.route(`${apiOrigin}/api/ai/settings`, async (route) => {
    if (route.request().method() !== 'GET') { await route.continue(); return; }
    notifyReadStarted();
    await readGate;
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '模拟配置读取失败' }) });
  });
  await page.route(`${apiOrigin}/api/ai/preview`, async (route) => {
    previewRequests += 1;
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'unexpected preview' }) });
  });
  try {
    await openOnly(page, root);
    await readStarted;
    await page.getByLabel('模型名称').fill('dirty-draft-after-read-start');
    releaseRead();
    await waitForSettingsResponseParsed(page, 'GET');
    await expect(page.locator('.ai-feedback')).toContainText('读取本地模型配置失败：模拟配置读取失败');
    await page.getByRole('button', { name: '生成当前文件讲解', exact: true }).click();
    expect(previewRequests).toBe(0);
    await expect(page.getByLabel('模型名称')).toHaveValue('dirty-draft-after-read-start');
  } finally {
    releaseRead();
  }
});

test('repository config diagnostics show paths and messages beside an AI route and clear after repair', async ({ page }) => {
  const root = await repository();
  await writeFile(path.join(root, 'tsconfig.json'), '{ "compilerOptions": { "baseUrl": ".",');
  await open(page, root);
  const diagnostics = page.locator('.repository-diagnostics');
  await expect(diagnostics).toContainText('tsconfig.json');
  await expect(diagnostics).toContainText(/TS\d+/);
  await expect(diagnostics).toContainText(/JSON|配置/);

  await generate(page, '生成阅读路线');
  await page.getByRole('tab', { name: '讲解' }).click();
  await expect(diagnostics).toContainText('tsconfig.json');
  await expect(page.locator('.tourbar')).toContainText('阅读路线第');
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 375, height: 812 }]) {
    await page.setViewportSize(viewport);
    if (viewport.width <= 860) await page.getByRole('button', { name: '详情', exact: true }).click();
    await expect(diagnostics).toBeVisible();
    const bounds = await diagnostics.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
    const scrollBounds = await diagnostics.locator('ul').evaluate((list) => {
      const rect = list.getBoundingClientRect();
      return { right: rect.right, clientWidth: list.clientWidth, scrollWidth: list.scrollWidth };
    });
    expect(scrollBounds.right).toBeLessThanOrEqual(viewport.width);
    expect(scrollBounds.scrollWidth).toBeGreaterThanOrEqual(scrollBounds.clientWidth);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { moduleResolution: 'Bundler' } }));
  const rescan = page.waitForResponse((response) => response.url() === `${apiOrigin}/api/rescan`);
  await page.locator('header').getByRole('button', { name: '重新扫描', exact: true }).click();
  expect((await rescan).ok()).toBeTruthy();
  await expect(diagnostics).toContainText('无诊断');
  await expect(diagnostics).not.toContainText('TS1005');
});

test('read and save failures are shown separately and a successful save clears both', async ({ page }) => {
  const root = await repository();
  let postCount = 0;
  await trackSettingsResponses(page);
  await page.route(`${apiOrigin}/api/ai/settings`, async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'simulated read failure' }) });
      return;
    }
    postCount += 1;
    if (postCount === 1) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'simulated save failure' }) });
      return;
    }
    await route.continue();
  });
  let previewRequests = 0;
  await page.route(`${apiOrigin}/api/ai/preview`, async (route) => {
    previewRequests += 1;
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'unexpected preview' }) });
  });
  await openOnly(page, root);
  await waitForSettingsResponseParsed(page, 'GET');
  await expect(page.locator('.ai-settings-read-error')).toContainText('simulated read failure');

  await page.getByLabel('兼容服务地址').fill(modelOrigin);
  await page.getByLabel('模型名称').fill('settings-recovery-model');
  await page.getByLabel('API 密钥').fill('settings-recovery-key');
  const failedSave = page.waitForResponse((response) => response.url() === `${apiOrigin}/api/ai/settings` && response.request().method() === 'POST');
  await page.getByRole('button', { name: '保存本地配置' }).click();
  expect((await failedSave).status()).toBe(503);
  await waitForSettingsResponseParsed(page, 'POST', 1);
  await expect(page.locator('.ai-settings-read-error')).toContainText('simulated read failure');
  await expect(page.locator('.ai-settings-save-error')).toContainText('simulated save failure');
  await page.getByRole('button', { name: '生成当前文件讲解', exact: true }).click();
  expect(previewRequests).toBe(0);

  const successfulSave = page.waitForResponse((response) => response.url() === `${apiOrigin}/api/ai/settings` && response.request().method() === 'POST');
  await page.getByRole('button', { name: '保存本地配置' }).click();
  expect((await successfulSave).ok()).toBeTruthy();
  await waitForSettingsResponseParsed(page, 'POST', 2);
  await expect(page.locator('.ai-settings-read-error')).toHaveCount(0);
  await expect(page.locator('.ai-settings-save-error')).toHaveCount(0);
  await expect(page.getByLabel('API 密钥')).toHaveValue('');
  await expect(page.getByText('模型配置已保存在本地服务内存中。')).toBeVisible();
  expect(previewRequests).toBe(0);
});

test('a delayed settings save from the previous repository cannot overwrite the next repository draft', async ({ page }) => {
  const firstRoot = await repository();
  const secondRoot = await mkdtemp(path.join(os.tmpdir(), 'repolens-review-settings-next-'));
  roots.push(secondRoot);
  await writeFile(path.join(secondRoot, 'other.ts'), 'export const other = true;\n');
  let releaseSave!: () => void;
  let notifySaveStarted!: () => void;
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
  const saveStarted = new Promise<void>((resolve) => { notifySaveStarted = resolve; });
  await trackSettingsResponses(page);
  await page.route(`${apiOrigin}/api/ai/settings`, async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ baseUrl: '', model: '', configured: false }) });
      return;
    }
    notifySaveStarted();
    await saveGate;
    const response = await route.fetch();
    await route.fulfill({ response });
  });
  try {
    await openOnly(page, firstRoot);
    await page.getByLabel('兼容服务地址').fill(modelOrigin);
    await page.getByLabel('模型名称').fill('previous-repository-model');
    await page.getByLabel('API 密钥').fill('previous-repository-key');
    await page.getByRole('button', { name: '保存本地配置' }).click();
    await saveStarted;

    await page.getByLabel('本地仓库路径').fill(secondRoot);
    await page.getByRole('button', { name: '打开仓库', exact: true }).click();
    await expect(page.getByRole('treeitem', { name: 'other.ts', exact: true })).toBeVisible();
    await expect(page.getByLabel('模型名称')).toHaveValue('previous-repository-model');
    await page.getByLabel('兼容服务地址').fill('http://127.0.0.1:4319/v1');
    await page.getByLabel('模型名称').fill('next-repository-draft');
    await page.getByLabel('API 密钥').fill('next-repository-key');

    releaseSave();
    await waitForSettingsResponseParsed(page, 'POST');
    await expect(page.getByLabel('模型名称')).toHaveValue('next-repository-draft');
    await expect(page.getByLabel('API 密钥')).toHaveValue('next-repository-key');
    await page.getByRole('button', { name: '生成当前文件讲解', exact: true }).click();
    await expect(page.getByText('请先保存完整的模型服务地址、模型名称和密钥，再预览发送范围。')).toBeVisible();
  } finally {
    releaseSave();
  }
});

test('A3 identical cached route must keep its content identity and progress', async ({ page }) => {
  const root = await repository();
  const snapshot = await open(page, root);
  await generate(page, '生成阅读路线');
  await page.getByRole('button', { name: '第 2 步：main.ts' }).click();
  await page.getByRole('tab', { name: '讲解', exact: true }).click();
  const callsBefore = modelCalls;
  const cached = await generate(page, '生成阅读路线');
  expect(cached.cached).toBe(true);
  expect(modelCalls).toBe(callsBefore);
  const routeProgressKeys = await page.evaluate((id) => Object.keys(localStorage).filter((key) => key.startsWith(`repolens:${id}:`)).sort(), snapshot.id);
  console.log('A3 cached', cached.cached, 'storage keys', routeProgressKeys);
  await expect(page.getByRole('button', { name: '第 2 步：main.ts' })).toHaveAttribute('aria-current', 'step');
  await page.reload();
  await open(page, root);
  const afterReload = await generate(page, '生成阅读路线');
  expect(afterReload.cached).toBe(true);
  await expect(page.getByRole('button', { name: '第 2 步：main.ts' })).toHaveAttribute('aria-current', 'step');
});

test('A4 a failed open must not strand the previous repository', async ({ page }) => {
  const root = await repository();
  const snapshot = await open(page, root);
  await page.getByLabel('本地仓库路径').fill(path.join(root, 'does-not-exist'));
  const failedOpenPromise = page.waitForResponse((response) => response.url() === `${apiOrigin}/api/open`);
  await page.getByRole('button', { name: '打开仓库', exact: true }).click();
  expect((await failedOpenPromise).status()).toBe(400);
  await writeFile(path.join(root, 'added.ts'), 'export const added = true;\n');
  const rescanPromise = page.waitForResponse((response) => response.url() === `${apiOrigin}/api/rescan`);
  await page.getByRole('button', { name: '重新扫描', exact: true }).first().click();
  const rescanned = await (await rescanPromise).json();
  expect(rescanned.id).toBe(snapshot.id);
  console.log('A4 backend new file', rescanned.files.some((file: { id: string }) => file.id === 'added.ts'));
  expect(rescanned.files.some((file: { id: string }) => file.id === 'added.ts')).toBe(true);
  await expect(page.getByRole('treeitem', { name: 'added.ts', exact: true })).toBeVisible();
});

test('A4b the original repository watcher keeps publishing after a failed open', async ({ page }) => {
  const root = await repository();
  await open(page, root);
  await page.getByLabel('本地仓库路径').fill(path.join(root, 'missing-directory'));
  const failedOpenPromise = page.waitForResponse((response) => response.url() === `${apiOrigin}/api/open`);
  await page.getByRole('button', { name: '打开仓库', exact: true }).click();
  expect((await failedOpenPromise).status()).toBe(400);
  const updatedPath = path.join(root, 'auto-added.ts');
  await writeFile(updatedPath, 'export const observed = true;\n');
  await expect(page.getByRole('treeitem', { name: 'auto-added.ts', exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: '重新扫描' }).first()).toBeEnabled();
  await page.getByRole('treeitem', { name: 'main.ts', exact: true }).click();
  await unlink(path.join(root, 'main.ts'));
  await expect(page.getByRole('treeitem', { name: 'main.ts', exact: true })).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator('.detail-file-title strong')).toHaveText('auto-added.ts');
  await unlink(updatedPath);
  await expect(page.getByText('仓库中已没有可分析的源码文件。')).toBeVisible({ timeout: 10_000 });
});

test('SSE reconnect fetches the latest source while preserving a dragged node after an established stream drops', async ({ page }) => {
  const root = await repository();
  await writeFile(path.join(root, 'main.ts'), "import { value } from './dep'; export const main = value;\n");
  await writeFile(path.join(root, 'dep.ts'), 'export const value = 1;\n');
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    class ObservedEventSource extends NativeEventSource {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        this.addEventListener('revision', (event) => {
          const state = window as unknown as Record<string, unknown>;
          const revisions = (state.__repolensReceivedRevisionEvents as unknown[] | undefined) ?? [];
          revisions.push((event as MessageEvent<string>).data);
          state.__repolensReceivedRevisionEvents = revisions;
        });
      }
    }
    window.EventSource = ObservedEventSource;
  });
  let notifyInitialFrame!: () => void;
  let notifyReconnect!: () => void;
  const initialFrame = new Promise<void>((resolve) => { notifyInitialFrame = resolve; });
  const reconnectObserved = new Promise<void>((resolve) => { notifyReconnect = resolve; });
  let allowInitialDrop!: () => void;
  const initialDropGate = new Promise<void>((resolve) => { allowInitialDrop = resolve; });
  let releaseReconnect!: () => void;
  const reconnectGate = new Promise<void>((resolve) => { releaseReconnect = resolve; });
  let connectionCount = 0;
  const proxyServer = createServer(async (clientRequest, clientResponse) => {
    connectionCount += 1;
    const currentConnection = connectionCount;
    if (currentConnection === 2) {
      notifyReconnect();
      await reconnectGate;
      if (clientResponse.destroyed) return;
    }
    const upstreamRequest = httpRequest({
      hostname: '127.0.0.1', port: 4319, path: clientRequest.url,
      headers: { host: '127.0.0.1:4319', origin: clientRequest.headers.origin ?? '' },
    }, (upstreamResponse) => {
      clientResponse.writeHead(upstreamResponse.statusCode ?? 500, {
        ...upstreamResponse.headers,
        'access-control-allow-origin': clientRequest.headers.origin ?? '',
      });
      if (currentConnection !== 1) {
        upstreamResponse.on('data', (chunk: Buffer) => {
          clientResponse.write(chunk);
        });
        upstreamResponse.on('end', () => clientResponse.end());
        upstreamResponse.on('error', () => clientResponse.destroy());
        return;
      }
      let eventFrame = '';
      upstreamResponse.on('data', (chunk: Buffer) => {
        eventFrame += chunk.toString('utf8');
        clientResponse.write(chunk);
        if (eventFrame.includes('event: revision') && /\r?\n\r?\n/.test(eventFrame)) {
          notifyInitialFrame();
          upstreamResponse.pause();
          void initialDropGate.then(() => {
            upstreamResponse.destroy();
            clientResponse.destroy();
          });
        }
      });
      upstreamResponse.on('error', () => clientResponse.destroy());
    });
    clientResponse.on('close', () => upstreamRequest.destroy());
    upstreamRequest.on('error', () => { if (!clientResponse.destroyed) clientResponse.destroy(); });
    upstreamRequest.end();
  });
  await new Promise<void>((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
  const address = proxyServer.address();
  if (!address || typeof address === 'string') throw new Error('SSE proxy did not bind');
  const proxyOrigin = `http://127.0.0.1:${address.port}`;
  const eventsRoute = `${apiOrigin}/api/events*`;
  await page.route(eventsRoute, (route) => {
    const requested = new URL(route.request().url());
    return route.continue({ url: `${proxyOrigin}${requested.pathname}${requested.search}` });
  });
  try {
    const opened = await open(page, root);
    await initialFrame;
    await page.waitForFunction(() => ((window as unknown as Record<string, unknown>).__repolensReceivedRevisionEvents as unknown[] | undefined)?.length === 1);
    allowInitialDrop();
    await reconnectObserved;
    await page.getByRole('treeitem', { name: 'main.ts', exact: true }).click();
    await page.getByRole('tab', { name: '源码', exact: true }).click();
    const mainNode = page.locator('.react-flow__node[data-id="main.ts"]');
    await expect(mainNode).toBeVisible();
    const initialTransform = await mainNode.evaluate((element) => (element as HTMLElement).style.transform);
    const box = await mainNode.boundingBox();
    if (!box) throw new Error('main graph node has no measured bounds');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 65, box.y + box.height / 2 + 38, { steps: 8 });
    await page.mouse.up();
    await expect.poll(() => mainNode.evaluate((element) => (element as HTMLElement).style.transform)).not.toBe(initialTransform);
    const draggedTransform = await mainNode.evaluate((element) => (element as HTMLElement).style.transform);

    const changedMain = "import { value } from './dep'; export const main = value + 2;\n";
    await writeFile(path.join(root, 'main.ts'), changedMain);
    await writeFile(path.join(root, 'after-reconnect.ts'), 'export const afterReconnect = true;\n');
    const rescan = await fetch(`${apiOrigin}/api/rescan`, {
      method: 'POST', headers: { Origin: 'http://127.0.0.1:5174', 'Content-Type': 'application/json' },
      body: JSON.stringify({ repositoryId: opened.id }),
    });
    expect(rescan.status).toBe(200);
    const rescanned = await rescan.json() as { sequence: number; files: { id: string; contentHash: string }[] };
    expect(rescanned.sequence).toEqual(expect.any(Number));
    expect(rescanned.files.some((file) => file.id === 'after-reconnect.ts')).toBe(true);
    await expect(page.getByRole('treeitem', { name: 'after-reconnect.ts', exact: true })).toHaveCount(0);
    await expect(page.locator('.source-code')).not.toContainText('main = value + 2');
    releaseReconnect();
    await page.waitForFunction(() => (((window as unknown as Record<string, unknown>).__repolensReceivedRevisionEvents as unknown[] | undefined)?.length ?? 0) >= 2);
    await expect(page.getByRole('treeitem', { name: 'after-reconnect.ts', exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.detail-file-title strong')).toHaveText('main.ts');
    await expect(page.locator('.source-code')).toContainText('main = value + 2');
    await expect.poll(() => mainNode.evaluate((element) => (element as HTMLElement).style.transform)).toBe(draggedTransform);
  } finally {
    releaseReconnect();
    allowInitialDrop();
    await page.unroute(eventsRoute);
    proxyServer.closeAllConnections();
    await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
  }
});

test('the file watcher updates imports when a multi-level extensionless config changes', async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'repolens-extensionless-watch-'));
  roots.push(root);
  await mkdir(path.join(root, 'configs'), { recursive: true });
  await mkdir(path.join(root, 'src/a'), { recursive: true });
  await mkdir(path.join(root, 'src/b'), { recursive: true });
  await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ extends: './configs/middle', include: ['src'] }));
  await writeFile(path.join(root, 'configs/middle'), JSON.stringify({ extends: './base' }));
  await writeFile(path.join(root, 'configs/base'), JSON.stringify({ compilerOptions: { baseUrl: '..', moduleResolution: 'Bundler', paths: { '@value': ['src/a/value.ts'] } } }));
  await writeFile(path.join(root, 'src/main.ts'), 'import { value } from "@value"; export { value };\n');
  await writeFile(path.join(root, 'src/a/value.ts'), 'export const value = "a";\n');
  await writeFile(path.join(root, 'src/b/value.ts'), 'export const value = "b";\n');
  await openOnly(page, root);
  await page.getByRole('treeitem', { name: 'main.ts', exact: true }).click();
  const fromA = page.locator('.react-flow__node[data-id="src/a/value.ts"]');
  const fromB = page.locator('.react-flow__node[data-id="src/b/value.ts"]');
  await expect(page.locator('.detail-file-title strong')).toHaveText('main.ts');
  await expect(fromA).toBeVisible();
  await expect(fromB).toHaveCount(0);

  await writeFile(path.join(root, 'configs/base'), JSON.stringify({ compilerOptions: { baseUrl: '..', moduleResolution: 'Bundler', paths: { '@value': ['src/b/value.ts'] } } }));
  await expect(fromB).toBeVisible({ timeout: 10_000 });
  await expect(fromA).toHaveCount(0);
  await expect(page.locator('.detail-file-title strong')).toHaveText('main.ts');
});

test('A4c only the newest open commits, and close cancels a scan already in progress', async () => {
  const slowRoot = await mkdtemp(path.join(os.tmpdir(), 'repolens-review-slow-'));
  const latestRoot = await repository('export const newest = true;\n');
  roots.push(slowRoot);
  for (let start = 0; start < 5000; start += 250) {
    await Promise.all(Array.from({ length: 250 }, (_, offset) => {
      const index = start + offset;
      return writeFile(path.join(slowRoot, `file-${String(index).padStart(4, '0')}.ts`), `export const file${index} = ${index};\n`);
    }));
  }
  const clientId = `open-race-${Date.now()}`; let intentSequence = 0;
  const command = () => ({ clientId, intentSequence: ++intentSequence });
  const send = (route: string, body: unknown) => fetch(`${apiOrigin}/api/${route}`, { method: 'POST', headers: { Origin: 'http://127.0.0.1:5174', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const olderRequest = send('open', { path: slowRoot, command: command() });
  await delay(40);
  const newestResponse = await send('open', { path: latestRoot, command: command() });
  expect(newestResponse.status).toBe(200);
  const newest = await newestResponse.json() as { id: string; files: { id: string }[] };
  expect((await olderRequest).status).toBe(409);
  const active = await (await fetch(`${apiOrigin}/api/snapshot?repositoryId=${newest.id}`, { headers: { Origin: 'http://127.0.0.1:5174' } })).json() as { id: string; files: { id: string }[] };
  expect(active.id).toBe(newest.id);
  expect(active.files.map((file: { id: string }) => file.id)).toEqual(['main.ts']);

  const cancelledRequest = send('open', { path: slowRoot, command: command() });
  await delay(40);
  const closeResponse = await send('close', { command: command() });
  expect(closeResponse.status).toBe(200);
  expect((await cancelledRequest).status).toBe(409);
  expect((await fetch(`${apiOrigin}/api/snapshot?repositoryId=${newest.id}`, { headers: { Origin: 'http://127.0.0.1:5174' } })).status).toBe(409);
});

test('A5 changing graph directory must retain the new directory filter', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '第 1 步：从入口开始' }).waitFor();
  const filter = page.getByLabel('筛选图谱目录');
  await filter.selectOption('src/components');
  await expect(filter).toHaveValue('src/components');
  await expect(page.locator('.detail-file-title strong')).toHaveText('TaskFilter.tsx');
  await filter.selectOption('src/services');
  await expect(page.locator('.detail-file-title strong')).toHaveText('taskService.ts');
  await expect(filter).toHaveValue('src/services');
});

test('mobile graph toolbar separates repository statistics from touch controls', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
  await page.goto('/');
  await page.getByRole('button', { name: '依赖图' }).click();
  const title = page.locator('.graph-title-group');
  const actions = page.locator('.graph-actions');
  await expect(title).toBeVisible();
  await expect(actions).toBeVisible();
  const layout = await page.evaluate(() => {
    const titleElement = document.querySelector('.graph-title-group')!;
    const actionsElement = document.querySelector('.graph-actions')!;
    const titleRect = titleElement.getBoundingClientRect();
    const actionsRect = actionsElement.getBoundingClientRect();
    const stats = titleElement.querySelector('div > span')!;
    return {
      titleBottom: titleRect.bottom,
      actionsTop: actionsRect.top,
      statsFontSize: Number.parseFloat(getComputedStyle(stats).fontSize),
      buttons: [...actionsElement.querySelectorAll('button')].map((button) => {
        const rect = button.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      }),
      selectHeight: actionsElement.querySelector('select')!.getBoundingClientRect().height,
    };
  });
  expect(layout.titleBottom).toBeLessThanOrEqual(layout.actionsTop);
  expect(layout.statsFontSize).toBeGreaterThanOrEqual(12);
  expect(layout.buttons.length).toBeGreaterThan(0);
  expect(layout.buttons.every((button) => button.width >= 44 && button.height >= 44)).toBe(true);
  expect(layout.selectHeight).toBeGreaterThanOrEqual(44);
  await page.close();
});

test('all three target viewports can follow, complete, restart, and return to the selected graph node', async ({ browser }) => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 375, height: 812 }]) {
    const page = await browser.newPage({ viewport });
    await page.goto('/');
    const steps = page.locator('.tour-step');
    await expect(steps).toHaveCount(5);
    await steps.nth(0).click();
    for (let index = 1; index < 5; index += 1) {
      if (index < 4) await page.getByRole('button', { name: '下一步' }).click();
      else {
        await page.getByRole('button', { name: '下一步' }).click();
        await expect(steps.nth(4)).toHaveAttribute('aria-current', 'step');
        await page.getByRole('button', { name: '完成导览' }).click();
      }
      await expect(steps.nth(index)).toHaveAttribute('aria-current', 'step');
      if (index < 4) await expect(page.locator('.source-line.is-focused')).toBeVisible();
    }
    await expect(page.getByRole('button', { name: '导览已完成' })).toBeVisible();
    if (viewport.width <= 860) {
      await page.getByRole('button', { name: '依赖图' }).click();
      const selected = page.locator('.graph-file-card.is-selected');
      await expect(selected).toBeVisible();
      expect(isGraphNodeWithinBounds(await waitForStableGraphGeometry(page), 24)).toBe(true);
      await page.getByRole('button', { name: '详情' }).click();
      await expect(page.locator('.source-line.is-focused')).toBeVisible();
    }
    await page.getByRole('button', { name: '重新开始导览' }).click();
    await expect(steps.nth(0)).toHaveAttribute('aria-current', 'step');
    await page.close();
  }
});

test('selected graph node remains fully visible through same-page viewport changes', async ({ page }) => {
  const runtimeErrors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') runtimeErrors.push(message.text()); });
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  const root = await mkdtemp(path.join(os.tmpdir(), 'repolens-live-resize-'));
  roots.push(root);
  await writeFile(path.join(root, 'main.ts'), 'export const value = 1;\n');
  await openOnly(page, root);
  await page.getByRole('treeitem', { name: 'main.ts', exact: true }).click();
  const selected = page.locator('.graph-file-card.is-selected');
  await expect(selected).toBeVisible();
  const expectSelectedNodeInBounds = async () => {
    const geometry = await waitForStableGraphGeometry(page);
    expect(isGraphNodeWithinBounds(geometry), `selected node should retain 24px margins at ${geometry.viewport.width}px: ${JSON.stringify(geometry)}`).toBe(true);
  };
  await page.getByRole('button', { name: '定位当前文件', exact: true }).click();
  await expectSelectedNodeInBounds();
  const node = selected.locator('xpath=..');
  const originalNodeTransform = await node.evaluate((element) => (element as HTMLElement).style.transform);
  const initialBox = await selected.boundingBox();
  if (!initialBox) throw new Error('Selected graph node has no measured bounds');
  await page.mouse.move(initialBox.x + initialBox.width / 2, initialBox.y + initialBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(initialBox.x + initialBox.width / 2 + 180, initialBox.y + initialBox.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => node.evaluate((element) => (element as HTMLElement).style.transform)).not.toBe(originalNodeTransform);
  await expectSelectedNodeInBounds();
  const nodeTransform = await node.evaluate((element) => (element as HTMLElement).style.transform);
  for (const viewport of [{ width: 1024, height: 768 }, { width: 375, height: 812 }, { width: 1024, height: 768 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    if (viewport.width <= 860) await page.getByRole('button', { name: '依赖图', exact: true }).click();
    await expect(selected).toBeVisible();
    await expectSelectedNodeInBounds();
    await expect.poll(() => node.evaluate((element) => (element as HTMLElement).style.transform)).toBe(nodeTransform);
  }
  expect(runtimeErrors).toEqual([]);
});

test('current node remains visible after resizing a graph with several neighbors', async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'repolens-live-resize-neighbors-'));
  roots.push(root);
  await writeFile(path.join(root, 'main.ts'), "import { a } from './a'; import { b } from './b'; import { c } from './c'; export const value = a + b + c;\n");
  await writeFile(path.join(root, 'a.ts'), 'export const a = 1;\n');
  await writeFile(path.join(root, 'b.ts'), 'export const b = 2;\n');
  await writeFile(path.join(root, 'c.ts'), 'export const c = 3;\n');
  await openOnly(page, root);
  await page.getByRole('treeitem', { name: 'main.ts', exact: true }).click();
  await expect(page.getByText(/当前文件的一跳关系 · 4\/4 个节点/)).toBeVisible();
  await page.getByRole('button', { name: '定位当前文件', exact: true }).click();
  await page.setViewportSize({ width: 1024, height: 768 });
  expect(isGraphNodeWithinBounds(await waitForStableGraphGeometry(page))).toBe(true);
});

test('stable graph geometry waits through a briefly visible position before checking the final position', async ({ page }) => {
  await page.setContent(`<div class="graph-canvas"><div class="react-flow__viewport" style="transform: translate(0px, 0px) scale(1)"><div class="graph-file-card is-selected">node</div></div></div>
    <style>.graph-canvas{position:relative;width:400px;height:300px}.react-flow__viewport{position:absolute;inset:0}.graph-file-card{position:absolute;left:50px;top:50px;width:80px;height:40px}</style>`);
  await page.evaluate(() => {
    const node = document.querySelector('.graph-file-card') as HTMLElement;
    let frame = 0;
    const moveAfterTransientFrame = () => {
      if (frame === 0) (window as Window & { __transientInside?: boolean }).__transientInside = node.getBoundingClientRect().right < 400;
      if (frame === 3) node.style.transform = 'translateX(500px)';
      frame += 1;
      if (frame < 8) requestAnimationFrame(moveAfterTransientFrame);
    };
    requestAnimationFrame(moveAfterTransientFrame);
  });

  const geometry = await waitForStableGraphGeometry(page);
  expect(await page.evaluate(() => (window as Window & { __transientInside?: boolean }).__transientInside)).toBe(true);
  expect(geometry.node.left).toBeGreaterThan(geometry.canvas.right);
  expect(isGraphNodeWithinBounds(geometry)).toBe(false);
});

test('graph remains in bounds when resizing during tour navigation animation', async ({ page }) => {
  const runtimeErrors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') runtimeErrors.push(message.text()); });
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: '第 3 步：列表拆分为组件' }).click();
  await page.setViewportSize({ width: 1024, height: 768 });
  expect(isGraphNodeWithinBounds(await waitForStableGraphGeometry(page))).toBe(true);

  await page.getByRole('button', { name: '第 5 步：服务提供初始数据' }).click();
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole('button', { name: '依赖图', exact: true }).click();
  expect(isGraphNodeWithinBounds(await waitForStableGraphGeometry(page))).toBe(true);
  expect(runtimeErrors).toEqual([]);
});

test('dragged node positions survive a live repository update', async ({ page }) => {
  const graphIssues: string[] = [];
  page.on('console', (message) => { if (/not initialized|ResizeObserver loop/.test(message.text())) graphIssues.push(message.text()); });
  page.on('pageerror', (error) => { if (/ResizeObserver loop/.test(error.message)) graphIssues.push(error.message); });
  const root = await mkdtemp(path.join(os.tmpdir(), 'repolens-review-layout-'));
  roots.push(root);
  await writeFile(path.join(root, 'main.ts'), "import { value } from './dep'; export const main = value;\n");
  await writeFile(path.join(root, 'dep.ts'), 'export const value = 1;\n');
  await open(page, root);
  await expect(page.locator('.graph-flow-host')).toHaveAttribute('data-nodes-initialized', 'true');
  const node = page.locator('.react-flow__node[data-id="main.ts"]');
  await expect(node).toBeVisible();
  await expect(node).toHaveClass(/\bdraggable\b/);
  const viewport = page.locator('.react-flow__viewport');
  await expect.poll(() => viewport.evaluate(async (element) => {
    const read = () => (element as HTMLElement).style.transform;
    const first = read();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const second = read();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return first === second && second === read();
  })).toBe(true);
  const before = await node.evaluate((element) => (element as HTMLElement).style.transform);
  const box = await node.boundingBox();
  if (!box) throw new Error('graph node has no measured bounds');
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 12, start.y + 8, { steps: 2 });
  await page.mouse.move(start.x + 75, start.y + 45, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => node.evaluate((element) => (element as HTMLElement).style.transform)).not.toBe(before);
  const draggedTransform = await node.evaluate((element) => (element as HTMLElement).style.transform);
  await writeFile(path.join(root, 'extra.ts'), 'export const extra = true;\n');
  await expect(page.getByRole('treeitem', { name: 'extra.ts', exact: true })).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => node.evaluate((element) => (element as HTMLElement).style.transform)).toBe(draggedTransform);
  expect(graphIssues).toEqual([]);
});
