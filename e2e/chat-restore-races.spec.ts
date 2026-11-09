import { test, expect, enterRepositoryLocation } from './fixtures';
import { mkdir, writeFile } from 'node:fs/promises';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
import {test as realTest, type Page, type Response} from '@playwright/test';
import type {AddressInfo} from 'node:net';
import {withRealWorkspace} from './helpers/real-workspace';

test.beforeAll(async()=>{await mkdir('.artifacts/chat-recovery-fixes-2026-11-06',{recursive:true});});

const api = 'http://127.0.0.1:4319';
async function settleReleasedRead(page: Page, responsePromise: Promise<Response>) {
  const response=await responsePromise; await response.finished();
  // A network response event precedes JSON consumption and React's commit.
  // Observe after two rendering frames rather than accepting the pre-restore DOM.
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
}
async function setup(page: Page, name: string, seedDraft = '', readCompletionFirst = false) {
  const snapshot = { id: name, workspaceId: name, persistenceSessionId: 'session-1', version: 'fixture', name, source: 'local', revision: 'r1', sequence: 1, description: '', files: [{ id: 'main.ts', path: 'main.ts', name: 'main.ts', kind: 'typescript', language: 'ts', role: '模块', summary: '', imports: [], contentHash: 'hash' }], dependencies: [], tour: [], diagnostics: [], unresolved: [] };
  await page.addInitScript(({ name, seedDraft }) => { const key=`repolens:chat-ui:${name}`; if(localStorage.getItem(key)===null)localStorage.setItem(key, JSON.stringify({activeId:'',draft:seedDraft,scrollTop:0})); }, { name, seedDraft });
  let holdRead = false; let release!:()=>void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!:()=>void;
  const readStarted = new Promise<void>(resolve => { entered = resolve; });
  let finishCompletion!:()=>void;
  const completionGate = new Promise<void>(resolve => { finishCompletion = resolve; });
  let completionStarted!:()=>void;
  const completionReady = new Promise<void>(resolve => { completionStarted = resolve; });
  let persisted: unknown[] = []; let modelCalls = 0, chatWrites = 0;
  await page.route(`${api}/api/**`, async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    const json = (value: unknown, headers: Record<string,string> = {}) => route.fulfill({ contentType: 'application/json', headers, body: JSON.stringify(value) });
    if (pathname === '/api/open') return json(snapshot);
    if (pathname === '/api/events') return route.fulfill({ status: 204 });
    if (pathname === '/api/ai/settings') return json({configured:true,model:'local-mock',baseUrl:'https://model.example/v1'});
    if (pathname === '/api/source') return json({source:'export const value = 1;',repositoryId:name,revision:'r1'});
    if (pathname === '/api/workspace' && request.method() === 'GET') {
      let captured = structuredClone(persisted);
      if (holdRead) { entered(); await gate; if(readCompletionFirst)captured=structuredClone(persisted); return json({version:1,recentRepositories:[],aiResults:{},aiRoute:null,progress:{},nodePositions:{},conversations:captured,persistenceReady:true},{'x-probe':'held'}); }
      return json({version:1,recentRepositories:[],aiResults:{},aiRoute:null,progress:{},nodePositions:{},conversations:captured,persistenceReady:true});
    }
    if (pathname === '/api/workspace') { const body=request.postDataJSON(); if(body.action==='conversations'){persisted=body.conversations;chatWrites++;} return json({ok:true}); }
    if (pathname.endsWith('/preview')) { const body=request.postDataJSON(); return json({scopeRequired:false,preview:{id:'preview-1',repositoryId:name,revision:'r1',entryFileId:'main.ts',mode:'question',conversation:true,files:[],characters:body.question.length,model:'local-mock',baseUrl:'https://model.example/v1',expiresAt:Date.now()+600000}}); }
    if (pathname === '/api/ai/generate') {
      modelCalls++; const ids=request.postDataJSON().chat;
      persisted=[{id:ids.conversationId,title:'新的问题',updatedAt:Date.now(),messages:[{id:ids.userMessageId,role:'user',content:'新的问题',references:[],contextFiles:[]},{id:ids.answerMessageId,role:'assistant',content:'已经成功保存的新回答',references:[],contextFiles:[],insufficientEvidence:false}]}];
      completionStarted(); if(readCompletionFirst)await completionGate;
      return json({repositoryId:name,revision:'r1',entryFileId:'main.ts',mode:'question',cached:false,chatPersisted:true,result:{answer:'已经成功保存的新回答',references:[],insufficientEvidence:false}});
    }
    return json({ok:true});
  });
  await page.goto('/'); await enterRepositoryLocation(page,'D:/test-fixture'); await page.getByRole('button',{name:'打开仓库',exact:true}).click();
  holdRead=true; await page.getByRole('button',{name:'打开 AI 聊天',exact:true}).click(); await readStarted;
  return { release, finishCompletion, completionReady, get persisted(){return persisted;},get modelCalls(){return modelCalls;},get writes(){return chatWrites;} };
}

test('a late successful restore must not replace a newer draft', async ({page}) => {
  const f=await setup(page,'late-draft','上次尚未发送的旧草稿');
  try {
    const input=page.getByLabel('提问或追问',{exact:true}); await input.fill('刚刚输入、尚未发送的新草稿');
    const response=page.waitForResponse(r=>r.headers()['x-probe']==='held'); f.release(); await settleReleasedRead(page,response);
    await expect(input).toHaveValue('刚刚输入、尚未发送的新草稿');
    await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('repolens:chat-ui:late-draft')??'null')?.draft)).toBe('刚刚输入、尚未发送的新草稿');
    await page.reload();await enterRepositoryLocation(page,'D:/test-fixture');await page.getByRole('button',{name:'打开仓库',exact:true}).click();await page.getByRole('button',{name:'打开 AI 聊天',exact:true}).click();
    await expect(input).toHaveValue('刚刚输入、尚未发送的新草稿');
  } finally {f.release(); await writeFile('.artifacts/chat-recovery-fixes-2026-11-06/late-draft-observed.json',JSON.stringify({draft:await page.getByLabel('提问或追问',{exact:true}).inputValue().catch(()=>null),modelCalls:f.modelCalls},null,2));}
});

test('a delayed empty restore must not erase a newly persisted chat completion', async ({page}) => {
  const f=await setup(page,'late-answer');
  try {
    const input=page.getByLabel('提问或追问',{exact:true}); await input.fill('新的问题'); await input.press('Enter');
    await expect(page.getByText('已经成功保存的新回答',{exact:true})).toBeVisible();
    const response=page.waitForResponse(r=>r.headers()['x-probe']==='held'); f.release(); await settleReleasedRead(page,response);
    await expect(page.getByText('已经成功保存的新回答',{exact:true})).toBeVisible();
  } finally {f.release(); await writeFile('.artifacts/chat-recovery-fixes-2026-11-06/late-answer-observed.json',JSON.stringify({visible:await page.getByText('已经成功保存的新回答',{exact:true}).isVisible().catch(()=>false),persisted:f.persisted,modelCalls:f.modelCalls,writes:f.writes},null,2));}
});

realTest('real service: a late restore followed by a new conversation must retain the saved answer on disk',async({page})=>{
  await withRealWorkspace(page,async({api,data,snapshot,open})=>{
    const model=createServer(async(req,res)=>{for await(const chunk of req){void chunk;}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({answer:'REAL_SERVICE_SAVED_ANSWER',references:[],insufficientEvidence:false})}}]}));});
    await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let entered!:()=>void;const readStarted=new Promise<void>(resolve=>{entered=resolve;});
    try{
      const seeded=await page.evaluate(async({api,snapshot})=>(await fetch(api+'/api/workspace',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'conversations',repositoryId:snapshot.id,workspaceId:snapshot.workspaceId??snapshot.id,persistenceSessionId:snapshot.persistenceSessionId,conversations:[{id:'legacy-conversation',title:'原有对话',messages:[],updatedAt:1}]})})).json(),{api,snapshot});
      expect(seeded).toMatchObject({ok:true});
      await page.locator('.settings-trigger').click();
      const dialog=page.getByRole('dialog',{name:'模型设置',exact:true});
      await dialog.getByLabel('模型服务地址',{exact:true}).fill(`http://127.0.0.1:${(model.address() as AddressInfo).port}`);
      await dialog.getByLabel('模型名称',{exact:true}).fill('audit-real-mock');await dialog.getByLabel('API 密钥',{exact:true}).fill('audit-only-not-real');
      await dialog.getByRole('button',{name:'应用设置',exact:true}).click();await expect(dialog.locator('.settings-actions [role=status]')).toHaveText('已配置');
      await dialog.getByRole('button',{name:'关闭',exact:true}).click();
      await page.route(api+'/api/workspace**',async route=>{
        if(route.request().method()!=='GET')return route.continue();
        const upstream=await route.fetch();const captured=await upstream.json();entered();await gate;
        return route.fulfill({response:upstream,headers:{...upstream.headers(),'x-probe':'held'},json:captured});
      });
      await page.getByRole('button',{name:'打开 AI 聊天',exact:true}).click();await readStarted;
      const input=page.getByLabel('提问或追问',{exact:true});await input.fill('你好，这是恢复顺序测试');
      await expect(page.getByRole('button',{name:'发送',exact:true})).toBeEnabled();await input.press('Enter');
      await expect(page.getByText('REAL_SERVICE_SAVED_ANSWER',{exact:true})).toBeVisible();
      const file=path.join(data,'workspace-v1.json'),key=snapshot.workspaceId??snapshot.id;
      const before=JSON.parse(await readFile(file,'utf8'));expect(JSON.stringify(before.conversations[key])).toContain('REAL_SERVICE_SAVED_ANSWER');
      const response=page.waitForResponse(r=>r.headers()['x-probe']==='held');release();await settleReleasedRead(page,response);
      const visible=await page.getByText('REAL_SERVICE_SAVED_ANSWER',{exact:true}).isVisible();
      const saved=page.waitForResponse(r=>r.url()===api+'/api/workspace'&&r.request().method()==='POST'&&r.request().postDataJSON().action==='conversations');
      await page.getByRole('button',{name:'新对话',exact:true}).click();const responseSave=await saved;await responseSave.finished();
      const after=JSON.parse(await readFile(file,'utf8'));
      await writeFile('.artifacts/chat-recovery-fixes-2026-11-06/real-late-restore-disk.json',JSON.stringify({visibleAfterRestore:visible,saveResponse:await responseSave.json(),before:before.conversations[key],after:after.conversations[key]},null,2));
      expect(JSON.stringify(after.conversations[key])).toContain('REAL_SERVICE_SAVED_ANSWER');
      expect(after.conversations[key].some((item:{id:string})=>item.id==='legacy-conversation')).toBe(true);
      expect(visible).toBe(true);
      await page.reload();await open();await page.getByRole('button',{name:'打开 AI 聊天',exact:true}).click();
      await page.getByRole('button',{name:'聊天历史',exact:true}).click();
      await page.locator('.chat-history-list').getByRole('button').filter({hasText:'你好，这是恢复顺序测试'}).click();
      await expect(page.getByText('REAL_SERVICE_SAVED_ANSWER',{exact:true})).toBeVisible();
    }finally{release();model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));}
  });
});

test('a restored server completion is merged by message ID when its generation response arrives',async({page})=>{
  const f=await setup(page,'completion-order','',true);
  try {
    const input=page.getByLabel('提问或追问',{exact:true});await input.fill('新的问题');
    await expect(page.getByRole('button',{name:'发送',exact:true})).toBeEnabled();await input.press('Enter');await f.completionReady;
    const response=page.waitForResponse(r=>r.headers()['x-probe']==='held');f.release();await settleReleasedRead(page,response);
    await expect(page.getByText('已经成功保存的新回答',{exact:true})).toBeVisible();
    f.finishCompletion();await expect(page.getByRole('button',{name:'停止',exact:true})).toHaveCount(0);
    await expect(page.getByText('已经成功保存的新回答',{exact:true})).toHaveCount(1);
    await page.getByRole('button',{name:'新对话',exact:true}).click();await expect.poll(()=>f.writes).toBeGreaterThan(0);
    const saved=(f.persisted as {messages:{id:string}[]}[]).flatMap(item=>item.messages);
    expect(saved).toHaveLength(2);expect(new Set(saved.map(item=>item.id)).size).toBe(2);expect(f.modelCalls).toBe(1);
  } finally {f.release();f.finishCompletion();}
});
