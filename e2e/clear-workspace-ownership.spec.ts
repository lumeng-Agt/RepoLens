import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test, expect, enterRepositoryLocation, openRepositoryMenu } from './fixtures';

test('retrying a failed workspace clear cannot clear the repository opened afterward', async ({ page }) => {
  const renderer = path.resolve("desktop/renderer");
  const server = createServer(async (request, response) => {
    try {
      const name = new URL(request.url ?? "/", "http://localhost").pathname;
      const file = path.resolve(renderer, `.${name === "/" ? "/index.html" : decodeURIComponent(name)}`);
      if (!file.startsWith(renderer + path.sep)) { response.writeHead(403).end(); return; }
      const content = await readFile(file);
      response.setHeader("Content-Type", file.endsWith(".html") ? "text/html" : file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "application/javascript" : "application/octet-stream");
      response.end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, '__REPOLENS_RUNTIME__', { configurable: true, get: () => ({ desktop: true, apiOrigin: 'http://127.0.0.1:4319' }), set: () => {} });
    Object.defineProperty(window, 'repoLens', { value: { onBackendStatus: () => () => {}, selectDirectory: async () => null } });
  });
  let active = 'repo-a';
  const clears: string[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request(); const url = new URL(request.url());
    const json = (value: unknown) => route.fulfill({ json: value });
    if (url.pathname === '/api/workspace' && request.method() === 'GET') return json({ version: 1, recentRepositories: [], aiResults: {}, aiRoute: null, progress: {}, nodePositions: {}, conversations: [], readingNotes: [], savedTours: [], investigations: [], persistenceReady: true, guidePreferences: { version: 1, welcomeHandled: true, completedTaskIds: [], checklistOpen: false, noticeDismissed: true } });
    if (url.pathname === '/api/workspace') {
      const body = request.postDataJSON();
      if (body.action === 'clear-repository') { clears.push(body.workspaceId); return json({ ok: false, warning: 'test storage locked', cleared: { workspace: false, copies: false } }); }
      return json({ ok: true });
    }
    if (url.pathname === '/api/open') {
      active = request.postDataJSON().path;
      return json({ id: active, workspaceId: `workspace-${active}`, persistenceSessionId: `session-${active}`, source: 'local', revision: `revision-${active}`, sequence: 1, version: 'fixture', name: active, description: 'fixture', files: [{ id: 'main.ts', path: 'main.ts', name: 'main.ts', kind: 'typescript', imports: [], symbols: [], contentHash: 'fixture' }], dependencies: [], tour: [], diagnostics: [] });
    }
    if (url.pathname === '/api/source') return json({ source: 'export const value = 1;', repositoryId: active, revision: `revision-${active}` });
    if (url.pathname === '/api/ai/settings') return json({ baseUrl: '', model: '', configured: false });
    if (url.pathname === '/api/events') return route.fulfill({ status: 204 });
    if (url.pathname === '/api/close' || url.pathname === '/api/health') return json({ ok: true });
    return route.fulfill({ status: 404, json: { error: 'unexpected fixture request' } });
  });
  const address = server.address() as import('node:net').AddressInfo;
  await page.goto(`http://127.0.0.1:${address.port}/`);
  await enterRepositoryLocation(page, 'repo-a');
  await page.getByRole('button', { name: '打开仓库', exact: true }).click();
  await expect(page.getByRole('tree', { name: 'repo-a 仓库文件' })).toBeVisible();
  await (await openRepositoryMenu(page)).getByRole('button', { name: '清除此仓库的阅读记录', exact: true }).click();
  await expect(page.getByRole('button', { name: '重试清除', exact: true })).toBeVisible();
  await enterRepositoryLocation(page, 'repo-b');
  await page.getByRole('button', { name: '打开仓库', exact: true }).click();
  await expect(page.getByRole('tree', { name: 'repo-b 仓库文件' })).toBeVisible();
  await page.getByRole('button', { name: '重试清除', exact: true }).click();
  await expect(page.getByText('请先返回未完成清除的仓库，再重试。', { exact: true })).toBeVisible();
  expect(clears).toEqual(['workspace-repo-a']);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
