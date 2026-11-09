import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'repolens-ai-clear-'));
  const repo = path.join(root, 'repo'); await mkdir(repo);
  await writeFile(path.join(repo, 'main.ts'), 'export const value = 1;\n');
  let calls = 0;
  let hold;
  const model = createServer(async (request, response) => {
    let text = ''; for await (const part of request) text += part;
    const prompt = JSON.parse(text).messages.at(-1).content;
    const mode = JSON.parse(prompt.match(/^任务信息：(\{[^\r\n]+\})$/m)[1]).mode;
    calls++;
    if (hold) { const gate = hold; hold = null; gate.entered(); await gate.wait; }
    if (response.destroyed) return;
    const ref = { fileId: 'main.ts', startLine: 1 };
    const result = mode === 'route'
      ? { title: 'Test route', steps: Array.from({ length: 3 }, (_, index) => ({ fileId: 'main.ts', purpose: `Read ${index}`, relationship: 'Static source', question: 'What is exported?', references: [ref] })) }
      : mode === 'question' ? { answer: 'Test answer', insufficientEvidence: false, references: [ref] }
        : { role: 'Test explanation', keyPoints: ['Test only'], references: [ref] };
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const child = fork('scripts/local-server.mjs', [], { env: { ...process.env, REPOLENS_PORT: '0', REPOLENS_USER_DATA_PATH: path.join(root, 'data') }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const [ready] = await once(child, 'message', { signal: AbortSignal.timeout(15_000) });
  const api = async (endpoint, value) => {
    const response = await fetch(`http://127.0.0.1:${ready.port}${endpoint}`, { method: value === undefined ? 'GET' : 'POST', headers: { Origin: 'http://127.0.0.1:5173', 'Content-Type': 'application/json' }, ...(value === undefined ? {} : { body: JSON.stringify(value) }), signal: AbortSignal.timeout(15_000) });
    return { status: response.status, value: await response.json() };
  };
  let snapshot;
  let sequence = 0;
  const open = async directory => {
    const response = await api('/api/open', { path: directory, command: { clientId: 'ai-clear', intentSequence: ++sequence } });
    assert.equal(response.status, 200); snapshot = response.value; return snapshot;
  };
  const settings = { baseUrl: `http://127.0.0.1:${model.address().port}`, model: 'test-clear', apiKey: 'test-only-key' };
  const configure = () => api('/api/ai/settings', settings);
  const preview = async (mode = 'explanation') => {
    const response = await api(mode === 'question' ? '/api/ai/question/preview' : '/api/ai/preview', { repositoryId: snapshot.id, fileId: 'main.ts', ...(mode === 'question' ? { question: 'What is value?' } : { mode }) });
    assert.equal(response.status, 200, JSON.stringify(response)); return response.value.preview.id;
  };
  const clear = (all = false, operationId = crypto.randomUUID()) => api('/api/workspace', all ? { action: 'clear-all', repositoryId: '', operationId } : { action: 'clear-repository', repositoryId: snapshot.id, workspaceId: snapshot.workspaceId ?? snapshot.id, persistenceSessionId: snapshot.persistenceSessionId, operationId });
  let release;
  t.after(async () => {
    release?.();
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.send({ type: 'shutdown' }); await exited; }
    model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  await open(repo); await configure();
  return { root, api, open, preview, clear, configure, calls: () => calls, gate() {
    let entered; const reached = new Promise(resolve => { entered = resolve; });
    const wait = new Promise(resolve => { release = resolve; }); hold = { entered, wait };
    return { reached, release: () => release() };
  } };
}

for (const all of [false, true]) test(`clearing ${all ? 'all data' : 'current workspace'} expires its AI cache`, { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  assert.equal((await f.api('/api/ai/generate', { previewId: await f.preview() })).value.cached, false);
  assert.equal((await f.api('/api/ai/generate', { previewId: await f.preview() })).value.cached, true);
  assert.equal(f.calls(), 1);
  assert.equal((await f.clear(all)).value.ok, true);
  if (all) await f.configure();
  const generated = await f.api('/api/ai/generate', { previewId: await f.preview() });
  assert.equal(generated.status, 200); assert.equal(generated.value.cached, false); assert.equal(f.calls(), 2);
});

for (const mode of ['explanation', 'route', 'question']) test(`clearing cancels non-chat ${mode} before it can respond or refill the cache`, { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const previewId = await f.preview(mode);
  const gate = f.gate();
  const pending = f.api('/api/ai/generate', { previewId });
  await gate.reached;
  assert.equal((await f.clear()).value.ok, true);
  gate.release();
  const cancelled = await pending;
  assert.notEqual(cancelled.status, 200); assert.match(cancelled.value.error, /取消|清除/);
  const generated = await f.api('/api/ai/generate', { previewId: await f.preview(mode) });
  assert.equal(generated.status, 200); assert.equal(generated.value.cached, false); assert.equal(f.calls(), 2);
});

test('current clear preserves a different workspace cache and confirmed background chat', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const a = path.join(f.root, 'repo'), b = path.join(f.root, 'other');
  await mkdir(b); await writeFile(path.join(b, 'main.ts'), 'export const value = 1;\n');
  const generatedA = await f.api('/api/ai/generate', { previewId: await f.preview() });
  assert.equal(generatedA.value.cached, false);
  await f.open(b);
  const generatedB = await f.api('/api/ai/generate', { previewId: await f.preview() });
  assert.equal(generatedB.value.cached, false, 'identical source in another workspace has its own cache');
  await f.clear(); await f.open(a);
  assert.equal((await f.api('/api/ai/generate', { previewId: await f.preview() })).value.cached, true, 'clearing B does not discard A');
  const id = await f.preview('question'), gate = f.gate();
  const background = f.api('/api/ai/generate', { previewId: id, chat: { conversationId: 'background-a', userMessageId: 'u', answerMessageId: 'a' } });
  await gate.reached;
  await f.open(b); assert.equal((await f.clear()).value.ok, true);
  gate.release(); const result = await background;
  assert.equal(result.status, 200); assert.equal(result.value.chatPersisted, true);
});

test('a chat completion racing with full history returns its answer without evicting persisted conversations', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const snapshot = await f.open(path.join(f.root, 'repo'));
  const workspaceId = snapshot.workspaceId ?? snapshot.id;
  const conversations = Array.from({ length: 100 }, (_, i) => ({ id: `saved-${i}`, title: `Saved ${i}`, updatedAt: i, messages: [{ id: `message-${i}`, role: 'assistant', content: `Keep ${i}`, references: [], contextFiles: [] }] }));
  const previewId = await f.preview('question');
  const gate = f.gate();
  const pending = f.api('/api/ai/generate', { previewId, chat: { conversationId: 'new-chat', userMessageId: 'new-u', answerMessageId: 'new-a' } });
  await gate.reached;
  assert.equal((await f.api('/api/workspace', { action: 'conversations', repositoryId: snapshot.id, workspaceId, persistenceSessionId: snapshot.persistenceSessionId, conversations })).value.ok, true);
  gate.release();
  const result = await pending;
  assert.equal(result.status, 200);
  assert.equal(result.value.result.answer, 'Test answer');
  assert.equal(result.value.chatPersisted, false);
  assert.match(result.value.warning, /100/);
  assert.equal(f.calls(), 1);
  const disk = JSON.parse(await readFile(path.join(f.root, 'data', 'workspace-v1.json'), 'utf8'));
  assert.deepEqual(disk.conversations[workspaceId], conversations);
});
