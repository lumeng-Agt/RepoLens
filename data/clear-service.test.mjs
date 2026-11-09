import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('real service rejects new AI work while model deletion is waiting', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rl-clear-service-'));
  const repo = path.join(dir, 'repository');
  await mkdir(repo); await writeFile(path.join(repo, 'main.ts'), 'export const value = 1;');
  const child = fork('scripts/local-server.mjs', [], { env: { ...process.env, REPOLENS_PORT: '0', REPOLENS_DESKTOP_SETTINGS: '1', REPOLENS_USER_DATA_PATH: dir }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  let held;
  let deletionStarted;
  const deleting = new Promise(resolve => { deletionStarted = resolve; });
  child.on('message', message => {
    if (message.type !== 'model-settings:save') return;
    if (message.settings === null) { held = message.id; deletionStarted(); }
    else child.send({ type: 'model-settings:saved', id: message.id, ok: true });
  });
  try {
    const [ready] = await once(child, 'message');
    const post = async (endpoint, body) => {
      const response = await fetch(`http://127.0.0.1:${ready.port}${endpoint}`, { method: 'POST', headers: { Origin: 'http://127.0.0.1:5173', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, value: await response.json() };
    };
    const opened = await post('/api/open', { path: repo, command: { clientId: 'clear-test', intentSequence: 1 } });
    assert.equal(opened.status, 200);
    await post('/api/ai/settings', { baseUrl: 'https://example.invalid', model: 'fake', apiKey: 'test-only' });
    const clearing = post('/api/workspace', { action: 'clear-all', repositoryId: '', operationId: 'clear-gate' });
    await deleting;
    const preview = await post('/api/ai/preview', { repositoryId: opened.value.id, fileId: 'main.ts', mode: 'explanation' });
    assert.equal(preview.status, 409); assert.match(preview.value.error, /正在清除/);
    child.send({ type: 'model-settings:saved', id: held, ok: true }); held = undefined;
    const result = await clearing;
    assert.equal(result.value.ok, true);
    assert.deepEqual(result.value.cleared, { model: true, workspace: true, copies: true });
  } finally {
    if (held !== undefined && child.connected) child.send({ type: 'model-settings:saved', id: held, ok: true });
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.send({ type: 'shutdown' }); await exited; }
    await rm(dir, { recursive: true, force: true });
  }
});
