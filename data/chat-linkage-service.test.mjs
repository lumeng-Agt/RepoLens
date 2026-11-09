import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('explicit summary retrieval is single-use and model checks do not change saved configuration', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'repolens-linkage-'));
  await writeFile(path.join(directory, 'store.py'), 'def save_task():\n    return "PRIVATE_SOURCE_MARKER"\n');
  const calls = [];
  const model = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    assert.equal(request.headers.authorization, undefined);
    calls.push({ path: request.url, text });
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/models') response.end(JSON.stringify({ data: [{ id: 'mock' }] }));
    else response.end(JSON.stringify({ choices: [{ message: { content: text.includes('PRIVATE_SOURCE_MARKER') ? JSON.stringify({ answer: 'hello', references: [], insufficientEvidence: false }) : text.includes('Reply with OK.') ? 'OK' : JSON.stringify({ candidates: [{ fileId: 'store.py', symbol: 'save_task', reason: '名称匹配' }] }) } }] }));
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const child = fork('scripts/local-server.mjs', [], { env: { ...process.env, REPOLENS_PORT: '0', REPOLENS_USER_DATA_PATH: path.join(directory, '.data') }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(async () => { if (child.exitCode === null) { const exit = once(child, 'exit'); child.send({ type: 'shutdown' }); await exit; } model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); assert.ok(directory.startsWith(os.tmpdir())); await rm(directory, { recursive: true, force: true }); });
  const [ready] = await once(child, 'message', { signal: AbortSignal.timeout(15000) });
  const api = async (endpoint, input) => {
    const response = await fetch(`http://127.0.0.1:${ready.port}${endpoint}`, { method: input ? 'POST' : 'GET', headers: { Origin: 'http://127.0.0.1:5173', 'Content-Type': 'application/json' }, ...(input ? { body: JSON.stringify(input) } : {}), signal: AbortSignal.timeout(15000) });
    return { status: response.status, value: await response.json() };
  };
  const opened = await api('/api/open', { path: directory, command: { clientId: 'linkage', intentSequence: 1 } }); assert.equal(opened.status, 200);
  const settings = { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, model: 'mock', apiKey: '', authMode: 'none' };
  assert.equal((await api('/api/ai/settings/check', { ...settings, action: 'models' })).status, 200);
  assert.equal((await api('/api/ai/settings')).value.configured, false);
  assert.equal((await api('/api/ai/settings', settings)).value.configured, true);
  const identity = { repositoryId: opened.value.id, revision: opened.value.revision, persistenceSessionId: opened.value.persistenceSessionId };
  const preview = await api('/api/ai/retrieve/preview', { ...identity, question: '如何保存任务？' }); assert.equal(preview.status, 200);
  assert.equal(calls.length, 1); assert.equal(JSON.stringify(preview).includes('PRIVATE_SOURCE_MARKER'), false);
  const answer = await api('/api/ai/retrieve', { ...identity, previewId: preview.value.id }); assert.equal(answer.status, 200);
  assert.equal(answer.value.candidates[0].startLine, 1); assert.equal(calls.length, 2);
  assert.equal(calls[1].text.includes('PRIVATE_SOURCE_MARKER'), false);
  assert.equal((await api('/api/ai/retrieve', { ...identity, previewId: preview.value.id })).status, 409);
  assert.equal(calls.length, 2);
  assert.equal((await api('/api/ai/settings', { ...settings, authMode: 'key', apiKey: 'test-secret' })).value.configured, true);
  assert.equal((await api('/api/ai/settings', { ...settings, model: 'other-model', authMode: 'key' })).value.configured, true, 'changing the model on the same service retains its configured key');
  assert.equal((await api('/api/ai/settings', { ...settings, baseUrl: 'https://other.example/v1', authMode: 'key' })).value.configured, false, 'a different service cannot inherit the old key');
  await api('/api/ai/settings', settings);
  const ordinary = await api('/api/ai/question/preview', { repositoryId: opened.value.id, fileId: 'store.py', question: '解释这段代码', conversation: true }); assert.equal(ordinary.status, 200);
});
