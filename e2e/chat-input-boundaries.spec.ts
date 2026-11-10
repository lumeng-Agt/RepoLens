import { test, expect, enterRepositoryLocation } from './fixtures';

import type { Page } from '@playwright/test';

async function fixture(page: Page, id: string, empty = false) {
  let writes = 0, calls = 0;
  const snapshot = { id, workspaceId: id, persistenceSessionId: 's', version: 'v', name: id, description: '', source: 'local', revision: 'r', sequence: 1, files: [{ id: 'main.ts', path: 'main.ts', name: 'main.ts', kind: 'typescript', contentHash: 'h', imports: [] }], dependencies: [], tour: [], diagnostics: [], unresolved: [] };
  if (empty) snapshot.files = [];
  await page.route('http://127.0.0.1:4319/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const json = (value: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/api/open') return json(snapshot);
    if (path === '/api/events') return route.fulfill({ status: 204 });
    if (path === '/api/ai/settings') return json({ configured: true, model: 'mock', baseUrl: 'https://mock.example/v1' });
    if (path === '/api/source') return json({ source: 'export const value = 1;', repositoryId: id, revision: 'r' });
    if (path === '/api/workspace' && request.method() === 'GET') return json({ version: 1, recentRepositories: [], aiResults: {}, aiRoute: null, progress: {}, nodePositions: {}, conversations: [], readingNotes: [], savedTours: [], investigations: [] });
    if (path === '/api/workspace') { if (request.postDataJSON().action === 'conversations') writes++; return json({ ok: true }); }
    if (path.endsWith('/preview')) return json({ scopeRequired: false, preview: { id: 'p', repositoryId: id, revision: 'r', entryFileId: empty ? '' : 'main.ts', mode: 'question', conversation: true, files: [], characters: 4, model: 'mock', baseUrl: 'https://mock.example/v1', expiresAt: Date.now() + 600000 } });
    if (path === '/api/ai/generate') { calls++; return json({ repositoryId:id,revision:'r',entryFileId:empty?'':'main.ts',mode:'question',cached:false,result:{answer:'EMPTY_REPOSITORY_CHAT_OK',references:[],insufficientEvidence:false} }); }
    return json({ ok: true });
  });
  await page.goto('/'); await enterRepositoryLocation(page, 'D:/isolated-probe'); await page.getByRole('button', { name: '打开仓库', exact: true }).click();
  await page.getByRole('button', { name: '打开 AI 聊天', exact: true }).click();
  return { get writes() { return writes; }, get calls() { return calls; } };
}
test('transient draft preference read failure must not erase a pre-existing draft', async ({ page }) => {
  await page.addInitScript(() => {
    const key = 'repolens:chat-ui:probe-draft'; const get = Storage.prototype.getItem;
    localStorage.setItem(key, JSON.stringify({ activeId: '', draft: '未发送的重要草稿', scrollTop: 0 }));
    let failed = false;
    Storage.prototype.getItem = function(name) { if (name === key && !failed) { failed = true; throw new Error('injected one-shot preference read failure'); } return get.call(this, name); };
  });
  const f = await fixture(page, 'probe-draft');
  // A pair of animation frames does not mean the asynchronous workspace read
  // has finished, especially on CI. Wait for the actual restored draft.
  await expect(page.getByLabel('提问或追问', { exact: true })).toHaveValue('未发送的重要草稿');
  const observed = { value: await page.getByLabel('提问或追问', { exact: true }).inputValue(), stored: await page.evaluate(() => localStorage.getItem('repolens:chat-ui:probe-draft')), modelCalls: f.calls };
  expect.soft(JSON.parse(observed.stored!).draft).toBe('未发送的重要草稿');
  expect(observed.value).toBe('未发送的重要草稿');
});

test('Shift Enter on a slash suggestion must insert a newline, not create a conversation', async ({ page }) => {
  const f = await fixture(page, 'probe-enter'); const input = page.getByLabel('提问或追问', { exact: true });
  await input.fill('/new'); await expect(page.getByRole('listbox', { name: '快捷指令' })).toBeVisible();
  await input.press('Shift+Enter');
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const observed = { value: await input.inputValue(), writes: f.writes, modelCalls: f.calls, ui: await page.evaluate(() => localStorage.getItem('repolens:chat-ui:probe-enter')) };
  expect.soft(observed.writes).toBe(0); expect(observed.value).toBe('/new\n');
});

test('unread draft preferences stay protected until retry, preserving newer input', async ({page}) => {
  await page.addInitScript(() => {
    const key='repolens:chat-ui:probe-retry', get=Storage.prototype.getItem;
    localStorage.setItem(key,JSON.stringify({draft:'原草稿',activeId:'',scrollTop:0,extension:{keep:true}}));
    let blocked=true;
    Object.assign(window,{releasePreferenceRead:()=>{blocked=false;},originalPreference:()=>get.call(localStorage,key)});
    Storage.prototype.getItem=function(name){if(name===key&&blocked)throw Error('injected read failure');return get.call(this,name);};
  });
  await fixture(page,'probe-retry');
  const input=page.getByLabel('提问或追问',{exact:true});await input.fill('读取失败期间的新草稿');
  await expect(page.getByRole('alert').filter({hasText:'无法读取上次的草稿和聊天位置'})).toContainText('本页修改仅在内存中');
  await page.getByRole('log',{name:'聊天消息'}).evaluate(element=>element.dispatchEvent(new Event('scroll')));
  const original=await page.evaluate(()=>(window as unknown as {originalPreference:()=>string}).originalPreference());
  expect(JSON.parse(original).draft).toBe('原草稿');
  await page.evaluate(()=>(window as unknown as {releasePreferenceRead:()=>void}).releasePreferenceRead());
  await page.getByRole('button',{name:'重试草稿保存',exact:true}).click();
  await expect(input).toHaveValue('读取失败期间的新草稿');
  await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('repolens:chat-ui:probe-retry')??'{}'))).toMatchObject({draft:'读取失败期间的新草稿',extension:{keep:true}});
  await expect(page.getByRole('button',{name:'重试草稿保存',exact:true})).toHaveCount(0);
});

test('Shift Enter with a file mention open inserts a newline without attaching',async({page})=>{
  await fixture(page,'probe-mention');const input=page.getByLabel('提问或追问',{exact:true});
  await input.fill('@main');await expect(page.getByRole('listbox',{name:'添加上下文'})).toBeVisible();await input.press('Shift+Enter');
  await expect(input).toHaveValue('@main\n');await expect(page.getByRole('button',{name:'移除附件 main.ts'})).toHaveCount(0);
});

test('a repository without indexed files can send and display an ordinary answer',async({page})=>{
  const f=await fixture(page,'probe-empty',true);const input=page.getByLabel('提问或追问',{exact:true});
  await input.fill('你好');expect(f.calls).toBe(0);await page.getByRole('button',{name:'发送',exact:true}).click();
  await expect(page.getByText('EMPTY_REPOSITORY_CHAT_OK',{exact:true})).toBeVisible();expect(f.calls).toBe(1);
});
