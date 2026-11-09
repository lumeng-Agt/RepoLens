import { test, expect, enterRepositoryLocation } from './fixtures';

import { test as realTest, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { withRealWorkspace } from './helpers/real-workspace';

async function fixture(page: Page, id: string, empty = false, conversations: unknown[] = []) {
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
    if (path === '/api/workspace' && request.method() === 'GET') return json({ version: 1, recentRepositories: [], aiResults: {}, aiRoute: null, progress: {}, nodePositions: {}, conversations, readingNotes: [], savedTours: [], investigations: [] });
    if (path === '/api/workspace') { if (request.postDataJSON().action === 'conversations') writes++; return json({ ok: true }); }
    if (path.endsWith('/preview')) return json({ scopeRequired: false, preview: { id: 'p', repositoryId: id, revision: 'r', entryFileId: empty ? '' : 'main.ts', mode: 'question', conversation: true, files: [], characters: 4, model: 'mock', baseUrl: 'https://mock.example/v1', expiresAt: Date.now() + 600000 } });
    if (path === '/api/ai/generate') { calls++; return json({ repositoryId:id,revision:'r',entryFileId:empty?'':'main.ts',mode:'question',cached:false,result:{answer:'EMPTY_REPOSITORY_CHAT_OK',references:[],insufficientEvidence:false} }); }
    return json({ ok: true });
  });
  await page.goto('/'); await enterRepositoryLocation(page, 'D:/isolated-probe'); await page.getByRole('button', { name: '打开仓库', exact: true }).click();
  await page.getByRole('button', { name: '打开 AI 聊天', exact: true }).click();
  return { get writes() { return writes; }, get calls() { return calls; } };
}

test('legacy invalid history timestamps remain readable and round-trip with new conversations', async ({page}) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const f = await fixture(page, 'invalid-legacy-date', false, [{id:'legacy', title:'旧对话', messages:[], updatedAt:1e100, future:{keep:true}}]);
  await expect(page.getByLabel('提问或追问',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'聊天历史',exact:true}).click();
  await expect(page.getByText('时间未记录',{exact:true})).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'新对话',exact:true}).click();
  await expect.poll(()=>f.writes).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

realTest('real service rejects a newly introduced invalid history timestamp without changing disk', async ({page}) => {
  await withRealWorkspace(page, async ({api,data,snapshot}) => {
    const save = (updatedAt: number) => page.evaluate(async ({api,snapshot,updatedAt}) => {
      const response = await fetch(api+'/api/workspace',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'conversations',repositoryId:snapshot.id,workspaceId:snapshot.workspaceId??snapshot.id,persistenceSessionId:snapshot.persistenceSessionId,conversations:[{id:'valid',title:'原记录',messages:[],updatedAt}]})});
      return {status:response.status, body:await response.json()};
    },{api,snapshot,updatedAt});
    expect((await save(1)).body).toMatchObject({ok:true});
    const before = await readFile(path.join(data,'workspace-v1.json'),'utf8');
    const rejected = await save(1e100);
    if (rejected.status < 400) expect(rejected.body).toMatchObject({ok:false});
    expect(await readFile(path.join(data,'workspace-v1.json'),'utf8')).toBe(before);
    await page.getByRole('button',{name:'打开 AI 聊天',exact:true}).click();
    await expect(page.getByLabel('提问或追问',{exact:true})).toBeVisible();
  });
});

test('unavailable clipboard produces feedback rather than an uncaught exception',async({page})=>{
  await page.addInitScript(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined}));
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await fixture(page,'r2-clipboard',false,[{id:'copy',title:'复制测试',updatedAt:1,messages:[{id:'answer',role:'assistant',content:'回答内容\n\n```ts\nconst audit=1;\n```',references:[],contextFiles:[]}]}]);
  await page.getByRole('button',{name:'复制回答',exact:true}).click();
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  await page.getByRole('button',{name:'复制代码',exact:true}).click();
  await expect(page.getByText('复制失败',{exact:true})).toHaveCount(2);
  expect.soft(errors).toEqual([]);await expect(page.getByText('复制失败',{exact:true}).first()).toBeVisible();
});

realTest('desktop draft: late restore keeps new input; failed save retries without losing the draft', async ({page}) => {
  await withRealWorkspace(page, async ({api,data,snapshot}) => {
    const workspaceId = snapshot.workspaceId ?? snapshot.id;
    const seeded = await page.evaluate(async ({api,snapshot,workspaceId}) => (await fetch(api+'/api/workspace', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'chat-preferences', repositoryId:snapshot.id, workspaceId, persistenceSessionId:snapshot.persistenceSessionId, preferences:{version:1,draft:'原来的草稿',activeId:'',scrollTop:0}}),
    })).json(), {api,snapshot,workspaceId});
    expect(seeded).toMatchObject({ok:true});
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let hold = true, failWrites = false, writes = 0;
    await page.route(api+'/api/workspace**', async route => {
      if (route.request().method()==='GET' && hold) {
        const upstream = await route.fetch(); entered(); await gate;
        return route.fulfill({response:upstream});
      }
      if (route.request().method()==='POST' && route.request().postDataJSON().action==='chat-preferences') {
        writes++;
        if (failWrites) return route.fulfill({json:{ok:false,warning:'模拟保存失败'}});
      }
      return route.continue();
    });
    try {
      await page.getByRole('button',{name:'打开 AI 聊天',exact:true}).click(); await started;
      const input = page.getByLabel('提问或追问',{exact:true});
      await input.fill('读取期间的新草稿');
      expect(writes).toBe(0);
      hold=false; release();
      const disk = async () => JSON.parse(await readFile(path.join(data,'workspace-v1.json'),'utf8')).chatPreferences?.[workspaceId]?.draft;
      await expect.poll(disk).toBe('读取期间的新草稿');
      await expect(input).toHaveValue('读取期间的新草稿');
      failWrites=true; await input.fill('失败后保留的新草稿');
      await expect(page.getByRole('alert').filter({hasText:'草稿和聊天位置尚未保存到本机，可以继续输入。'})).toBeVisible();
      expect(await disk()).toBe('读取期间的新草稿');
      failWrites=false;
      await page.getByRole('button',{name:'重试草稿保存',exact:true}).click();
      await expect.poll(disk).toBe('失败后保留的新草稿');
      await expect(input).toHaveValue('失败后保留的新草稿');
      await expect(page.getByRole('button',{name:'重试草稿保存',exact:true})).toBeHidden();
      expect(writes).toBeGreaterThanOrEqual(3);
      failWrites=true; await input.fill('收起聊天后仍可重试的草稿');
      await expect(page.getByRole('button',{name:'重试草稿保存',exact:true})).toBeVisible();
      await page.getByRole('button',{name:'收起 AI 面板',exact:true}).click();
      failWrites=false;
      await page.getByRole('button',{name:'重试保存',exact:true}).click();
      await expect.poll(disk).toBe('收起聊天后仍可重试的草稿');
    } finally { release(); }
  });
});
