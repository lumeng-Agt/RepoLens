import { test, expect, enterRepositoryLocation } from './fixtures';

test('adjusting a route sends its original content and preserves the old card and conversation', async ({ page }) => {
  const contextFiles = [{ fileId: 'main.ts', contentHash: 'hash', startLine: 1, endLine: 2 }];
  const route = { repositoryId: 'refine', revision: 'r', entryFileId: 'main.ts', signature: 'old', title: '旧路线', contextFiles, steps: [0, 1, 2].map(index => ({ id: `old-${index}`, title: `旧步骤 ${index}`, description: '阅读', focusFileId: 'main.ts', reference: { fileId: 'main.ts', line: 1 } })) };
  let conversations: unknown[] = [{ id: 'history', title: '原问题', updatedAt: 1, messages: [{ id: 'u', role: 'user', content: '生成路线', references: [], contextFiles }, { id: 'a', role: 'assistant', content: '旧路线', references: [], contextFiles, route }] }];
  const snapshot = { id: 'refine', version: 'v', revision: 'r', sequence: 1, name: 'refine', description: '', source: 'local', files: [{ id: 'main.ts', path: 'main.ts', name: 'main.ts', kind: 'typescript', contentHash: 'hash', imports: [] }], dependencies: [], tour: [], diagnostics: [] };
  let calls = 0;
  const previews: Record<string, unknown>[] = [];
  await page.route('http://127.0.0.1:4319/api/**', async intercepted => {
    const request = intercepted.request(), path = new URL(request.url()).pathname;
    const json = (value: unknown) => intercepted.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/api/open') return json(snapshot);
    if (path === '/api/ai/settings') return json({ baseUrl: 'https://mock.test', model: 'mock', configured: true });
    if (path === '/api/workspace' && request.method() === 'GET') return json({ version: 1, recentRepositories: [], aiResults: {}, aiRoute: null, conversations, progress: {}, nodePositions: {}, readingNotes: [], savedTours: [], investigations: [] });
    if (path === '/api/workspace') { const body = request.postDataJSON(); if (body.action === 'conversations') conversations = body.conversations; return json({ ok: true }); }
    if (path === '/api/source') return json({ fileId: 'main.ts', revision: 'r', contentHash: 'hash', source: 'export const a = 1;\nexport const b = 2;' });
    if (path === '/api/ai/preview') { const body = request.postDataJSON(); previews.push(body); return json({ scopeRequired: false, preview: { id: 'p', repositoryId: 'refine', revision: 'r', entryFileId: 'main.ts', mode: 'route', model: 'mock', baseUrl: 'https://mock.test', files: contextFiles, characters: 500, expiresAt: Date.now() + 600000 } }); }
    if (path === '/api/ai/generate') { calls++; return json({ repositoryId: 'refine', revision: 'r', entryFileId: 'main.ts', mode: 'route', cached: false, result: { title: '调整后的路线', steps: [0, 1, 2].map(index => ({ fileId: 'main.ts', purpose: `检查错误处理 ${index}`, relationship: '静态阅读', question: '如何处理错误？', references: [{ fileId: 'main.ts', startLine: 1 }] })) } }); }
    return json({ ok: true });
  });
  await page.goto('/'); await enterRepositoryLocation(page, 'D:/refine'); await page.getByRole('button', { name: '打开仓库', exact: true }).click();
  await page.getByRole('button', { name: '打开 AI 聊天', exact: true }).click();
  await page.getByRole('button', { name: '调整这份结果', exact: true }).click();
  const input = page.getByLabel('提问或追问', { exact: true }); await input.fill('增加错误处理检查');
  await expect.poll(() => previews.at(-1)?.refinement).toMatchObject({ original: { title: '旧路线' }, instruction: '增加错误处理检查' });
  expect(calls).toBe(0); await input.press('Enter');
  await expect(page.getByText('调整后的路线', { exact: true })).toBeVisible();
  await expect(page.getByText('旧路线', { exact: true })).toBeVisible();
  await expect.poll(() => JSON.stringify(conversations).includes('调整后的路线')).toBe(true);
  expect(JSON.stringify(conversations)).toContain('旧路线'); expect(calls).toBe(1);
});
