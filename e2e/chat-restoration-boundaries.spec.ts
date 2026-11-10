import type {RepositorySnapshot} from "../data/model";
import {test,expect,type Page} from '@playwright/test';
import {writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {withRealWorkspace} from './helpers/real-workspace';
const out='.artifacts/fixes-2026-11-08-r3';
test.beforeAll(async()=>{await import('node:fs/promises').then(fs=>fs.mkdir(out,{recursive:true}));});
const conversation={id:'restore-history',title:'位置恢复检查',updatedAt:Date.now(),messages:Array.from({length:32},(_,i)=>({id:'message-'+i,role:i%2?'assistant':'user',content:`消息 ${i}\n\n`+'用于检查历史阅读位置的内容。'.repeat(12),references:[],contextFiles:[]}))};
async function seed(page:Page,api:string,snapshot:RepositorySnapshot,preferences:unknown){
 return page.evaluate(async({api,snapshot,conversation,preferences})=>{
  const send=async(action:string,extra:Record<string,unknown>)=>(await fetch(api+'/api/workspace',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,repositoryId:snapshot.id,workspaceId:snapshot.workspaceId??snapshot.id,persistenceSessionId:snapshot.persistenceSessionId,...extra})})).json();
  return [await send('conversations',{conversations:[conversation]}),await send('chat-preferences',{preferences})];
 },{api,snapshot,conversation,preferences});
}
const frames=(page:Page)=>page.evaluate(()=>new Promise<void>(resolve=>{let i=0;function frame(){if(++i===24)resolve();else requestAnimationFrame(frame);}requestAnimationFrame(frame);}));

test('long malformed Markdown fences stay readable without blocking chat history', async ({page}) => {
 await withRealWorkspace(page, async ({api, snapshot}) => {
  const malformed = ['~'.repeat(32768) + ' x', '`'.repeat(32768) + ' x'];
  const content = [...malformed, '~~~ts\nconst first = 1;\n~~~', '```js\nconst second = 2;\n```'].join('\n\n');
  const saved = await page.evaluate(async ({api, snapshot, content}) => {
   const conversations = [{id:'fences',title:'Fences',updatedAt:1,messages:[{id:'answer',role:'assistant',content,references:[],contextFiles:[]}]}];
   const response = await fetch(api+'/api/workspace', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'conversations',repositoryId:snapshot.id,workspaceId:snapshot.workspaceId??snapshot.id,persistenceSessionId:snapshot.persistenceSessionId,conversations})});
   return {status:response.status,value:await response.json()};
  }, {api, snapshot, content});
  expect(saved).toMatchObject({status:200,value:{ok:true}});
  const tasks = await page.evaluateHandle(() => {
   const durations: number[] = [];
   const observer = new PerformanceObserver(list => durations.push(...list.getEntries().map(entry => entry.duration)));
   observer.observe({type:'longtask'});
   return {durations,observer};
  });
  await page.getByRole('button',{name:'打开 AI 聊天',exact:true}).click();
  const markdown = page.getByRole('log',{name:'聊天消息'}).locator('.chat-markdown');
  await expect(markdown.locator('pre')).toHaveText(['const first = 1;', 'const second = 2;']);
  expect(await markdown.locator('p').allTextContents()).toEqual(malformed);
  await frames(page);
  const longestTask = await tasks.evaluate(({durations,observer}) => {
   observer.disconnect();
   return Math.max(0,...durations);
  });
  expect(longestTask).toBeLessThan(1000);
 });
});

test('chat bounds table rendering while keeping the original text available to copy', async ({page}) => {
 await withRealWorkspace(page, async ({api, snapshot}) => {
  const table = (columns: number, rows: number, value: string) => [
   `|${Array(columns).fill('Heading').join('|')}|`,
   `|${Array(columns).fill('---').join('|')}|`,
   ...Array(rows).fill(`|${value}|`),
  ].join('\n');
  const oversized = table(256, 192, 'Large table row');
  const repeated = [table(2, 400, 'First'), table(2, 400, 'Second'), table(2, 400, 'Third')].join('\n\n');
  const saved = await page.evaluate(async ({api, snapshot, oversized, repeated}) => {
   const conversations = [{id:'tables',title:'Tables',updatedAt:1,messages:[oversized,repeated].map((content,index)=>({id:`table-${index}`,role:'assistant',content,references:[],contextFiles:[]}))}];
   const response = await fetch(api+'/api/workspace', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'conversations',repositoryId:snapshot.id,workspaceId:snapshot.workspaceId??snapshot.id,persistenceSessionId:snapshot.persistenceSessionId,conversations})});
   return {status:response.status,value:await response.json()};
  }, {api, snapshot, oversized, repeated});
  expect(saved).toMatchObject({status:200,value:{ok:true}});
  await page.getByRole('button',{name:'打开 AI 聊天',exact:true}).click();
  const messages = page.getByRole('log',{name:'聊天消息'}).locator('.question-message');
  await expect(messages).toHaveCount(2);
  await expect(messages.first().locator('table')).toHaveCount(0);
  await expect(messages.first().locator('pre')).toHaveText(oversized, {useInnerText:true});
  await page.evaluate(() => {
   Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async (value: string) => { document.body.dataset.copiedTable = value; },
   } });
  });
  await messages.first().getByRole('button', {name:'复制表格原文'}).click();
  await expect(page.locator('body')).toHaveAttribute('data-copied-table', oversized);
  await expect(messages.last().locator('table')).toHaveCount(2);
  await expect(messages.last().locator('pre')).toContainText('|Third|');
  await expect(messages.last().locator('th,td')).toHaveCount(1604);
 });
});

test('saved non-bottom transcript position survives opening the chat',async({page})=>{
 await withRealWorkspace(page,async({api,data,snapshot})=>{
  expect(await seed(page,api,snapshot,{version:1,draft:'保留的草稿',activeId:conversation.id,scrollTop:350})).toEqual([{ok:true},{ok:true}]);
  let releaseModule!: () => void;
  const moduleGate = new Promise<void>(resolve => { releaseModule = resolve; });
  const modulePath = /\/assets\/QuestionPanel-[^/]+\.js$/;
  await page.route(modulePath, async route => {
   await moduleGate;
   await route.continue();
  });
  try {
   await page.getByRole('button',{name:'打开 AI 聊天',exact:true}).click();
   await expect(page.getByText('正在加载聊天…',{exact:true})).toBeVisible();
   await expect(page.getByRole('log',{name:'聊天消息'})).toHaveCount(0);
  } finally {
   releaseModule();
  }
  const log=page.getByRole('log',{name:'聊天消息'});await expect(log.locator('.question-message')).toHaveCount(32);
  await frames(page);
  const actual=await log.evaluate(e=>({top:e.scrollTop,height:e.scrollHeight,viewport:e.clientHeight}));
  const disk=JSON.parse(await readFile(path.join(data,'workspace-v1.json'),'utf8')).chatPreferences?.[snapshot.workspaceId??snapshot.id];
  await writeFile(out+'/scroll-restore.json',JSON.stringify({expected:350,actual,disk},null,2));
  await page.screenshot({path:out+'/scroll-restore.png'});
  expect(Math.abs(actual.top-350)).toBeLessThan(2);
 });
});
test('unreadable chat preferences cannot show all data saved after a draft edit',async({page})=>{
 await withRealWorkspace(page,async({api,data,snapshot})=>{
  expect(await seed(page,api,snapshot,{version:1,draft:'原始草稿',activeId:conversation.id,scrollTop:0})).toEqual([{ok:true},{ok:true}]);
  let writes=0, readable=false;
  let releaseWrite!:()=>void, startedWrite!:()=>void;
  const writeGate=new Promise<void>(resolve=>{releaseWrite=resolve;});
  const writeStarted=new Promise<void>(resolve=>{startedWrite=resolve;});
  await page.route(api+'/api/workspace**',async route=>{
   if(route.request().method()==='GET'&&!readable){
    const response=await route.fetch(),value=await response.json();
    return route.fulfill({response,json:{...value,chatPreferences:{version:2,draft:'unsupported preference'}}});
   }
   if(route.request().method()==='POST'&&route.request().postDataJSON().action==='chat-preferences'){writes++;startedWrite();await writeGate;}
   return route.continue();
  });
  await page.getByRole('button',{name:'打开 AI 聊天',exact:true}).click();
  await expect(page.getByRole('button',{name:'重试草稿保存',exact:true})).toBeVisible();
  await page.getByLabel('提问或追问',{exact:true}).fill('读取失败期间的新内容');await frames(page);
  const state={header:await page.locator('.workspace-save-status').innerText(),warnings:await page.getByRole('alert').allTextContents(),writes,disk:JSON.parse(await readFile(path.join(data,'workspace-v1.json'),'utf8')).chatPreferences?.[snapshot.workspaceId??snapshot.id]};
  await writeFile(out+'/read-failure-status.json',JSON.stringify(state,null,2));await page.screenshot({path:out+'/read-failure-status.png'});
  expect(state.writes).toBe(0);expect(state.disk.draft).toBe('原始草稿');expect(state.header).not.toBe('已保存');
  try {
    readable=true;
    await page.getByRole('button',{name:'重试保存',exact:true}).click();await writeStarted;
    await frames(page);expect(await page.locator('.workspace-save-status').innerText()).not.toBe('已保存');
    releaseWrite();
    await expect.poll(async()=>JSON.parse(await readFile(path.join(data,'workspace-v1.json'),'utf8')).chatPreferences?.[snapshot.workspaceId??snapshot.id]?.draft).toBe('读取失败期间的新内容');
    await expect(page.locator('.workspace-save-status')).toHaveText('已保存');
  } finally {releaseWrite();}

 });
});
