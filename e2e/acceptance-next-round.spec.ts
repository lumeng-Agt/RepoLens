import { test, expect, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile, unlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const api = 'http://127.0.0.1:4319';
const headers = { Origin: 'http://127.0.0.1:5174' };
const roots: string[] = [];
let model: Server;
let modelUrl = '';
let modelCalls = 0;

test.beforeAll(async () => {
  model = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString());
    const prompt = String(input.messages[1].content);
    const files = [...prompt.matchAll(/^FILE (.+) LINES (\d+)-(\d+)/gm)];
    modelCalls += 1;
    const entry = files.some((file) => file[1] === 'main.ts') ? 'main.ts' : files[0][1];
    const result = prompt.includes('steps 需 3 到 7 个')
      ? { title: '独立验收路线', steps: ['main.ts', 'a.ts', 'main.ts'].map((fileId, index) => ({ fileId, purpose: `阅读 ${index + 1}`, references: [{ fileId, startLine: 1 }] })) }
      : { role: `已保存讲解:${entry}`, keyPoints: ['本地模拟结果'], references: [{ fileId: entry, startLine: 1 }] };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
  });
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
  const address = model.address();
  if (!address || typeof address === 'string') throw new Error('Mock failed to bind');
  modelUrl = `http://127.0.0.1:${address.port}/v1`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => model.close(() => resolve()));
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'repolens-reaudit-'));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), contents);
  }
  return root;
}

async function open(page: Page, root: string) {
  await page.goto('/');
  await page.getByRole('button', { name: '第 1 步：从入口开始' }).waitFor();
  await page.getByLabel('本地仓库路径').fill(root);
  const opened = page.waitForResponse(`${api}/api/open`);
  await page.getByRole('button', { name: '打开仓库', exact: true }).click();
  const snapshot = await (await opened).json();
  await expect(page.getByText('本地仓库', { exact: true })).toBeVisible();
  await page.getByLabel('兼容服务地址').fill(modelUrl);
  await page.getByLabel('模型名称').fill('audit-only');
  await page.getByLabel('API 密钥').fill('audit-local-dummy');
  await page.getByRole('button', { name: '保存本地配置' }).click();
  await expect(page.getByText('模型配置已保存在本地服务内存中。')).toBeVisible();
  return snapshot;
}

async function generate(page: Page, mode: string) {
  await page.getByRole('button', { name: mode, exact: true }).click();
  await expect(page.getByText('发送前确认', { exact: true })).toBeVisible();
  const result = page.waitForResponse(`${api}/api/ai/generate`);
  await page.getByRole('button', { name: '确认发送并生成' }).click();
  expect((await result).status()).toBe(200);
}

test('B1 narrowing to a directory containing the current file must retain selection', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('treeitem', { name: 'TaskList.tsx', exact: true }).click();
  await expect(page.locator('.detail-file-title strong')).toHaveText('TaskList.tsx');
  await page.getByLabel('筛选图谱目录').selectOption('src/components');
  await expect(page.getByLabel('筛选图谱目录')).toHaveValue('src/components');
  await expect(page.locator('.detail-file-title strong')).toHaveText('TaskList.tsx');
});

test('B2 a valid line range excluding an oversized line must be previewable', async ({ page }) => {
  await open(page, await fixture({ 'main.ts': `export const small = 1;\nexport const long = '${'x'.repeat(61000)}';\n` }));
  const calls = modelCalls;
  await page.getByRole('button', { name: '生成当前文件讲解', exact: true }).click();
  await expect(page.getByText('选择发送范围', { exact: true })).toBeVisible();
  await expect(page.getByText('所选范围包含超长单行，需调整起止行将其排除。')).toBeVisible();
  await expect(page.getByRole('button', { name: '预览所选范围' })).toBeDisabled();
  await page.getByLabel('main.ts 结束行').fill('1');
  await expect(page.getByRole('button', { name: '预览所选范围' })).toBeEnabled();
  await page.getByLabel('main.ts 结束行').fill('2');
  await expect(page.getByRole('button', { name: '预览所选范围' })).toBeDisabled();
  await page.getByLabel('main.ts 结束行').fill('1');
  const validPreview = page.waitForResponse(`${api}/api/ai/preview`);
  await page.getByRole('button', { name: '预览所选范围' }).click();
  expect((await validPreview).status()).toBe(200);
  await expect(page.getByText('发送前确认', { exact: true })).toBeVisible();
  expect(modelCalls).toBe(calls);
});

test('B3 returning to sample after an open committed but before its response arrives must complete', async ({ page }) => {
  const oldRoot = await fixture({ 'old.ts': 'export const old = 1;\n' });
  const newRoot = await fixture({ 'new.ts': 'export const fresh = 1;\n' });
  const oldSnapshot = await open(page, oldRoot);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let committed!: (value: { id: string }) => void;
  const serverCommitted = new Promise<{ id: string }>((resolve) => { committed = resolve; });
  await page.route(`${api}/api/open`, async (route) => {
    const response = await route.fetch();
    committed(await response.json());
    await held;
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    await page.getByLabel('本地仓库路径').fill(newRoot);
    await page.getByRole('button', { name: '打开仓库', exact: true }).click();
    const newSnapshot = await serverCommitted;
    const closed = page.waitForResponse(`${api}/api/close`);
    await page.getByRole('button', { name: '返回示例' }).click();
    const closeResponse = await closed;
    const activeNew = await page.request.get(`${api}/api/snapshot?repositoryId=${newSnapshot.id}`, { headers });
    expect(closeResponse.status()).toBe(200);
    expect(activeNew.status()).toBe(409);
    expect(oldSnapshot.id).not.toBe(newSnapshot.id);
    release();
    await expect(page.getByText('示例仓库', { exact: true })).toBeVisible();
  } finally { release(); }
});

test('B3 a delayed close response cannot undo a newer repository open', async ({ page }) => {
  await open(page, await fixture({ 'old.ts': 'export const old = 1;\n' }));
  const newRoot = await fixture({ 'fresh.ts': 'export const fresh = 1;\n' });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let committed!: (status: number) => void;
  const closeCommitted = new Promise<number>((resolve) => { committed = resolve; });
  await page.route(`${api}/api/close`, async (route) => {
    const response = await route.fetch();
    committed(response.status());
    await held;
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    await page.getByRole('button', { name: '返回示例' }).click();
    expect(await closeCommitted).toBe(200);
    await expect(page.getByText('示例仓库', { exact: true })).toBeVisible();
    await page.getByLabel('本地仓库路径').fill(newRoot);
    const opened = page.waitForResponse(`${api}/api/open`);
    await page.getByRole('button', { name: '打开仓库', exact: true }).click();
    const snapshot = await (await opened).json() as { id: string };
    await expect(page.getByText('本地仓库', { exact: true })).toBeVisible();
    release();
    await expect(page.locator('header').getByRole('button', { name: '重新扫描' })).toBeEnabled();
    expect((await page.request.get(`${api}/api/snapshot?repositoryId=${snapshot.id}`, { headers })).status()).toBe(200);
  } finally { release(); }
});

test('B4 route navigation should show an already saved explanation for its target file', async ({ page }) => {
  await open(page, await fixture({ 'a.ts': 'export const a = 1;\n', 'main.ts': "import { a } from './a';\nexport const main = a;\n" }));
  await page.getByRole('treeitem', { name: 'a.ts', exact: true }).click();
  await generate(page, '生成当前文件讲解');
  await expect(page.getByText('已保存讲解:a.ts', { exact: true })).toBeVisible();
  await page.getByRole('treeitem', { name: 'main.ts', exact: true }).click();
  await generate(page, '生成当前文件讲解');
  await expect(page.getByText('已保存讲解:main.ts', { exact: true })).toBeVisible();
  await generate(page, '生成阅读路线');
  await page.getByRole('button', { name: '第 2 步：a.ts' }).click();
  await page.getByRole('tab', { name: '讲解', exact: true }).click();
  await expect(page.locator('.detail-file-title strong')).toHaveText('a.ts');
  await expect(page.getByText('已保存讲解:a.ts', { exact: true })).toBeVisible();
});

test('B5 deleting the last file in the directory must clear obsolete scope before AI preview', async ({ page }) => {
  const root = await fixture({ 'src/main.ts': 'export const main = 1;\n', 'z.ts': 'export const z = 1;\n' });
  await open(page, root);
  await page.getByLabel('筛选图谱目录').selectOption('src');
  await unlink(path.join(root, 'src/main.ts'));
  await expect(page.locator('.detail-file-title strong')).toHaveText('z.ts', { timeout: 10000 });
  const preview = page.waitForResponse(`${api}/api/ai/preview`);
  await page.getByRole('button', { name: '生成当前文件讲解', exact: true }).click();
  const response = await preview;
  expect(response.status()).toBe(200);
});

test('a delayed older SSE snapshot cannot roll back a newer manual rescan', async ({ page }) => {
  const root = await fixture({ 'main.ts': 'export const main = 1;\n' });
  await page.goto('/');
  await page.getByRole('button', { name: '第 1 步：从入口开始' }).waitFor();
  const connected = page.waitForResponse((response) => response.url().startsWith(`${api}/api/events?`) && response.status() === 200);
  await page.getByLabel('本地仓库路径').fill(root);
  const openResponse = page.waitForResponse(`${api}/api/open`);
  await page.getByRole('button', { name: '打开仓库', exact: true }).click();
  const initial = await (await openResponse).json() as { id: string };
  await connected;
  await expect(page.getByText('本地仓库', { exact: true })).toBeVisible();
  await page.waitForTimeout(350);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let signalReady!: () => void;
  const ready = new Promise<void>((resolve) => { signalReady = resolve; });
  const staleSnapshots: { sequence: number; files: { id: string }[] }[] = [];
  let heldOnce = false;
  await page.route(`${api}/api/snapshot?repositoryId=${initial.id}`, async (route) => {
    const response = await route.fetch();
    if (!heldOnce) {
      heldOnce = true;
      staleSnapshots.push(await response.json() as { sequence: number; files: { id: string }[] });
      signalReady();
      await held;
    }
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    await writeFile(path.join(root, 'first.ts'), 'export const first = true;\n');
    await ready;
    const staleSnapshot = staleSnapshots[0];
    expect(staleSnapshot?.files.some((file) => file.id === 'first.ts')).toBe(true);
    await writeFile(path.join(root, 'second.ts'), 'export const second = true;\n');
    const rescanned = page.waitForResponse(`${api}/api/rescan`);
    await page.locator('header').getByRole('button', { name: '重新扫描' }).click();
    const latest = await (await rescanned).json() as { sequence: number; files: { id: string }[] };
    expect(latest.sequence).toBeGreaterThan(staleSnapshot!.sequence);
    expect(latest.files.some((file) => file.id === 'second.ts')).toBe(true);
    await expect(page.getByRole('treeitem', { name: 'second.ts', exact: true })).toBeVisible();
    release();
    await expect(page.getByRole('treeitem', { name: 'first.ts', exact: true })).toBeVisible();
    await expect(page.getByRole('treeitem', { name: 'second.ts', exact: true })).toBeVisible();
  } finally { release(); }
});
