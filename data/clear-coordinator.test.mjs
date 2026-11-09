import test from 'node:test';
import assert from 'node:assert/strict';
import { createClearCoordinator } from './clear-coordinator.mjs';
test('failed model deletion preserves workspace; retry resumes without deleting new records', async () => {
  let failModel = true, writes = 0, copies = 0;
  const coordinator = createClearCoordinator({ deleteModel: async () => { if (failModel) throw Error('locked'); }, store: {
    clearAll: async () => { writes++; return { persisted: false, cleared: { workspace: true }, warning: 'copy locked' }; },
    cleanCopies: async () => { copies++; return { persisted: true }; },
  } });
  const first = await coordinator.clear('same'); assert.equal(first.cleared.workspace, false); assert.equal(writes, 0);
  failModel = false;
  const second = await coordinator.clear('same'); assert.equal(second.cleared.workspace, true); assert.equal(second.ok, false);
  const third = await coordinator.clear('same'); assert.equal(third.ok, true); assert.equal(writes, 1); assert.equal(copies, 1);
  await coordinator.clear('same'); assert.equal(writes, 1);
});
test('settings writes and clearing execute in order', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; }); const events = [];
  const coordinator = createClearCoordinator({ deleteModel: async () => { events.push('delete-model'); }, store: { clearAll: async () => ({ persisted: true }) } });
  const save = coordinator.run(async () => { events.push('save-start'); await gate; events.push('save-end'); });
  const clear = coordinator.clear('id'); await Promise.resolve(); assert.deepEqual(events, ['save-start']); release(); await save; await clear;
  assert.deepEqual(events, ['save-start','save-end','delete-model']);
});
import { clearWorkspacePersistence, enqueueWorkspacePersistence } from './workspace-persistence.mjs';
test('unknown clearing outcome blocks every queued persistence category until retry confirms', async () => {
  const id = 'unknown-clear-fixture';
  await assert.rejects(clearWorkspacePersistence([id], async () => { throw Object.assign(Error('lost response'), { clearUnknown: true }); }));
  let writes = 0;
  assert.equal((await enqueueWorkspacePersistence(id, async () => { writes++; })).skipped, true);
  assert.equal(writes, 0);
  await clearWorkspacePersistence([id], async () => ({ ok: true }));
  await enqueueWorkspacePersistence(id, async () => { writes++; });
  assert.equal(writes, 1);
});
import { getWorkspacePersistenceStatus } from './workspace-persistence.mjs';
test('copy-only retry does not acknowledge an unrelated failed new save', async () => {
  const id = 'copy-retry-unrelated-failure';
  await assert.rejects(enqueueWorkspacePersistence(id, async () => { throw Error('new note not saved'); }, { key: 'notes' }));
  await clearWorkspacePersistence([id], async () => ({ ok: true, preserveMemory: true }));
  assert.match(getWorkspacePersistenceStatus(id).error, /new note not saved/);
});
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkspaceStore } from './workspace-store.mjs';
test('actual store copy retry preserves records written after partial clear and restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rl-copy-retry-'));
  try {
    const store = createWorkspaceStore(dir);
    await store.saveNodePositions('workspace', { file: { x: 777, y: 888 } });
    const blocked = path.join(dir, 'workspace-v1.json.corrupt-123');
    await mkdir(blocked);
    let modelDeletes = 0;
    const coordinator = createClearCoordinator({ store, deleteModel: async () => { modelDeletes++; } });
    const partial = await coordinator.clear('receipt');
    assert.equal(partial.ok, false); assert.equal(partial.cleared.workspace, true);
    await store.saveNodePositions('workspace', { file: { x: 123, y: 456 } });
    await rm(blocked, { recursive: true });
    assert.equal((await coordinator.clear('receipt')).ok, true);
    const restored = await createWorkspaceStore(dir).getRepository('workspace');
    assert.deepEqual(restored.nodePositions, { file: { x: 123, y: 456 } });
    assert.equal(restored.warning, undefined); assert.equal(modelDeletes, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('copy-only and completed retries preserve new AI tasks and cached answers', async () => {
  const { createAiOperationScope } = await import('./ai-operation-scope.mjs');
  const scope = createAiOperationScope();
  let invalidations = 0;
  const coordinator = createClearCoordinator({
    beforeClear: id => { invalidations++; return scope.clear(id); }, deleteModel: async () => {},
    store: { clearAll: async () => ({ persisted: false, cleared: { workspace: true }, warning: 'copy locked' }), cleanCopies: async () => ({ persisted: true }) },
  });
  assert.equal((await coordinator.clear('receipt')).ok, false);
  const next = scope.begin('workspace', new AbortController()); next.cache('new', { answer: 'new' });
  assert.equal((await coordinator.clear('receipt')).ok, true);
  assert.equal((await coordinator.clear('receipt')).ok, true);
  assert.equal(invalidations, 1); assert.equal(next.isActive(), true);
  assert.deepEqual(next.getCached('new'), { answer: 'new' }); next.finish();
});
