import { mkdir } from 'node:fs/promises';
import { test, expect, enterRepositoryLocation, openModelSettings } from './fixtures';

test('mentions, commands and source selection prepare visible attachments without a model call', async ({ page }) => {
  const snapshot = { id: 'linkage', workspaceId: 'linkage', persistenceSessionId: 'session', version: 'v', revision: 'r', sequence: 1, name: 'linkage', description: '', source: 'local', files: [{ id: 'src/store.ts', path: 'src/store.ts', name: 'store.ts', kind: 'typescript', language: 'ts', contentHash: 'hash', imports: [], symbolDetails: [{ name: 'saveTask', kind: 'function', startLine: 2, endLine: 4 }] }], dependencies: [], tour: [], diagnostics: [], unresolved: [] };
  let modelCalls = 0;
  const previews: Record<string, unknown>[] = [];
  await page.route('http://127.0.0.1:4319/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const json = (data: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
    if (path === '/api/open') return json(snapshot);
    if (path === '/api/source') return json({ fileId: 'src/store.ts', source: '// header\nexport function saveTask() {\n return 1;\n}\n', contentHash: 'hash', revision: 'r' });
    if (path === '/api/ai/settings') return json({ baseUrl: 'https://mock.test', model: 'mock', configured: true });
    if (path === '/api/workspace' && route.request().method() === 'GET') return json({ version: 1, recentRepositories: [], investigations: [], aiResults: {}, aiRoute: null, savedTours: [], readingNotes: [], progress: {}, nodePositions: {}, conversations: [] });
    if (path.endsWith('/preview')) { previews.push(route.request().postDataJSON()); return json({ scopeRequired: false, preview: { id: 'p', repositoryId: 'linkage', entryFileId: 'src/store.ts', mode: 'question', revision: 'r', files: [], characters: 5, baseUrl: 'https://mock.test', model: 'mock', expiresAt: Date.now() + 600000 } }); }
    if (path === '/api/ai/generate') modelCalls++;
    return json({ ok: true });
  });
  await page.goto('/'); await enterRepositoryLocation(page, 'D:/linkage'); await page.getByRole('button', { name: '打开仓库', exact: true }).click();
  await page.getByRole('button', { name: '打开 AI 聊天', exact: true }).click();
  const input = page.getByLabel('提问或追问', { exact: true });
  await input.fill('dev@example.com'); await expect(page.getByRole('listbox', { name: '添加上下文' })).toHaveCount(0);
  await input.fill('/home/project/file.ts'); await expect(page.getByRole('listbox', { name: '快捷指令' })).toHaveCount(0);
  await input.fill('@src'); await page.getByRole('option', { name: 'src 目录', exact: true }).click();
  await expect(page.getByRole('group', { name: '确认目录文件' })).toContainText('src/store.ts');
  await page.getByRole('group', { name: '确认目录文件' }).getByRole('button', { name: '取消', exact: true }).click();
  await input.fill('@save'); await expect(page.getByRole('listbox', { name: '添加上下文' })).toBeVisible(); await input.press('Enter');
  await expect(page.getByRole('button', { name: '移除附件 src/store.ts' })).toBeVisible();
  await input.fill('/route'); await input.press('Enter'); await expect(page.getByRole('button', { name: 'AI 任务' })).toContainText('阅读路线');
  await input.fill('/ask'); await input.press('Enter'); await expect(input).toHaveValue('');
  await page.getByRole('tab', { name: '源码', exact: true }).click();
  await page.getByRole('button', { name: '选择第 2 行', exact: true }).click();
  await page.getByRole('button', { name: '选择第 4 行', exact: true }).click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: '解释这段代码', exact: true }).click();
  await expect(input).toHaveValue('解释这段代码');
  expect(modelCalls).toBe(0);
  await mkdir('.artifacts/chat-linkage', { recursive: true });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 375, height: 812 }]) {
    await page.setViewportSize(viewport); await expect(input).toBeInViewport(); await page.screenshot({ path: `.artifacts/chat-linkage/selection-${viewport.width}.png` });
  }
});

test('model presets do not connect automatically; list and fixed-text checks require separate clicks', async ({ page }) => {
  const checks: Record<string, unknown>[] = [];
  let saves = 0;
  await page.route('http://127.0.0.1:4319/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const json = (data: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
    if (path === '/api/ai/settings/check') { const body = route.request().postDataJSON(); checks.push(body); return json(body.action === 'models' ? { models: ['local-model'] } : { ok: true }); }
    if (path === '/api/ai/settings') { if (route.request().method() === 'POST') saves++; return json({ baseUrl: '', model: '', configured: false }); }
    if (path === '/api/workspace') return json({ version: 1, recentRepositories: [], aiResults: {}, aiRoute: null, conversations: [], progress: {}, nodePositions: {} });
    return json({ ok: true });
  });
  await page.goto('/'); const dialog = await openModelSettings(page);
  await dialog.getByLabel('服务预设', { exact: true }).selectOption('ollama');
  await expect(dialog.getByLabel('模型服务地址')).toHaveValue('http://127.0.0.1:11434/v1');
  await dialog.getByLabel('模型认证方式').selectOption('none');
  expect(checks).toHaveLength(0); expect(saves).toBe(0);
  await dialog.getByRole('button', { name: '获取模型列表', exact: true }).click();
  await dialog.getByLabel('可用模型').selectOption('local-model');
  await dialog.getByRole('button', { name: '发送固定文字测试模型', exact: true }).click();
  await expect(dialog.getByText('模型已返回有效文本；测试配置尚未自动保存。')).toBeVisible();
  expect(checks.map(item => item.action)).toEqual(['models', 'test']); expect(saves).toBe(0);
  expect(checks[1]).not.toHaveProperty('repositoryId');
});

test('editing model settings cancels a pending check without resetting keyboard focus or the draft', async ({ page }) => {
  let started!: () => void, release!: () => void, finished!: () => void;
  const pending = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const settled = new Promise<void>(resolve => { finished = resolve; });
  const checks: Record<string, unknown>[] = [];
  await page.route('http://127.0.0.1:4319/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/ai/settings/check') {
      checks.push(route.request().postDataJSON());
      if (checks.length === 1) {
        started(); await gate;
        try { await route.fulfill({ json: { models: ['obsolete-model'] } }); } finally { finished(); }
        return;
      }
      return route.fulfill({ json: { models: ['current-model'] } });
    }
    if (path === '/api/ai/settings') return route.fulfill({ json: { baseUrl: '', model: '', configured: false } });
    if (path === '/api/workspace') return route.fulfill({ json: { version: 1, recentRepositories: [], aiResults: {}, aiRoute: null, conversations: [], progress: {}, nodePositions: {} } });
    return route.fulfill({ json: { ok: true } });
  });
  try {
    await page.goto('/'); const dialog = await openModelSettings(page);
    const address = dialog.getByLabel('模型服务地址');
    await address.fill('http://127.0.0.1:1234/v1');
    await dialog.getByRole('button', { name: '获取模型列表', exact: true }).click(); await pending;
    const cancelled = page.waitForEvent('requestfailed', request => request.url().endsWith('/api/ai/settings/check'));
    await address.fill('http://127.0.0.1:11434/v1'); await cancelled;
    await expect(address).toBeFocused(); await expect(address).toHaveValue('http://127.0.0.1:11434/v1');
    release(); await settled;
    await expect(dialog.getByLabel('可用模型')).toHaveCount(0);
    await dialog.getByRole('button', { name: '获取模型列表', exact: true }).click();
    await expect(dialog.getByLabel('可用模型')).toContainText('current-model');
    await expect(dialog.getByLabel('可用模型')).not.toContainText('obsolete-model');
    expect(checks[1].baseUrl).toBe('http://127.0.0.1:11434/v1');
  } finally { release(); }
});

test('summary retrieval resets on edited questions and hidden chat without discarding the draft', async ({ page }) => {
  const snapshot = { id: 'summary-reset', workspaceId: 'summary-reset', persistenceSessionId: 's', version: 'v', revision: 'r', sequence: 1, name: 'summary-reset', description: '', source: 'local', files: [{ id: 'main.ts', path: 'main.ts', name: 'main.ts', kind: 'typescript', imports: [], contentHash: 'h' }], dependencies: [], tour: [], diagnostics: [], unresolved: [] };
  let started!: () => void, release!: () => void, finished!: () => void;
  const pending = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const settled = new Promise<void>(resolve => { finished = resolve; });
  let previewCalls = 0, modelCalls = 0;
  await page.route('http://127.0.0.1:4319/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const json = (value: unknown) => route.fulfill({ json: value });
    if (path === '/api/open') return json(snapshot);
    if (path === '/api/events') return route.fulfill({ status: 204 });
    if (path === '/api/source') return json({ source: 'export const value = 1;', repositoryId: snapshot.id, revision: 'r' });
    if (path === '/api/ai/settings') return json({ baseUrl: 'https://mock.test', model: 'mock', configured: true });
    if (path === '/api/workspace' && route.request().method() === 'GET') return json({ version: 1, recentRepositories: [], aiResults: {}, aiRoute: null, conversations: [], progress: {}, nodePositions: {} });
    if (path === '/api/ai/retrieve/preview') {
      previewCalls++;
      if (previewCalls === 1) {
        started(); await gate;
        try { await json({ id: 'old', characters: 25, summary: ['obsolete-summary'] }); } finally { finished(); }
        return;
      }
      return json({ id: 'fresh', characters: 26, summary: ['current-summary'] });
    }
    if (path === '/api/ai/retrieve') {
      modelCalls++;
      return json({ candidates: [{ fileId: 'main.ts', startLine: 1, endLine: 1, contentHash: 'h', reason: '已完成的推荐应当保留' }] });
    }
    if (path === '/api/ai/generate') modelCalls++;
    return json({ ok: true });
  });
  try {
    await page.goto('/'); await enterRepositoryLocation(page, 'D:/summary-reset');
    await page.getByRole('button', { name: '打开仓库', exact: true }).click();
    await page.getByRole('button', { name: '打开 AI 聊天', exact: true }).click();
    const input = page.getByLabel('提问或追问', { exact: true }); await input.fill('原问题');
    const open = page.getByRole('button', { name: '让 AI 帮忙找文件', exact: true });
    const preview = page.getByRole('button', { name: '查看将发送的摘要', exact: true });
    const send = page.getByRole('button', { name: '发送摘要，让 AI 选择文件', exact: true });
    await open.click(); await page.getByLabel('辅助检索目录').fill('src');
    await preview.click(); await pending;
    const cancelled = page.waitForEvent('requestfailed', request => request.url().endsWith('/api/ai/retrieve/preview'));
    await input.fill('修改后的问题'); await cancelled;
    release(); await settled;
    await expect(preview).toHaveCount(0); await expect(send).toHaveCount(0);
    await open.click(); await expect(page.getByLabel('辅助检索目录')).toHaveValue('src');
    await preview.click(); await expect(send).toBeVisible();
    await page.getByRole('button', { name: '收起 AI 面板', exact: true }).click();
    await page.getByRole('button', { name: '打开 AI 聊天', exact: true }).click();
    await expect(input).toHaveValue('修改后的问题'); await expect(send).toHaveCount(0);
    await expect(preview).toBeVisible(); await preview.click(); await expect(send).toBeVisible();
    expect(previewCalls).toBe(3); expect(modelCalls).toBe(0);
    await send.click();
    const recommendation = page.getByText('模型推断：已完成的推荐应当保留', { exact: true });
    await expect(recommendation).toBeVisible(); expect(modelCalls).toBe(1);
    await page.getByRole('button', { name: '收起 AI 面板', exact: true }).click();
    await page.getByRole('button', { name: '打开 AI 聊天', exact: true }).click();
    await expect(recommendation).toBeVisible(); await expect(input).toHaveValue('修改后的问题');
    await input.fill('完全不同的问题'); await open.click();
    await expect(recommendation).toHaveCount(0); expect(modelCalls).toBe(1);
  } finally { release(); }
});
