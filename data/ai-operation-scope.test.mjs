import test from 'node:test';
import assert from 'node:assert/strict';
import { createAiOperationScope } from './ai-operation-scope.mjs';

test('AI caches are isolated by workspace and current clearing preserves other workspaces', async () => {
  const scope = createAiOperationScope();
  const a = scope.begin('a', new AbortController()), b = scope.begin('b', new AbortController());
  a.cache('identical-context', { answer: 'A' }); b.cache('identical-context', { answer: 'B' });
  assert.deepEqual(a.getCached('identical-context'), { answer: 'A' });
  const cleared = scope.clear('a');
  assert.equal(a.isActive(), false); assert.equal(b.isActive(), true);
  assert.deepEqual(b.getCached('identical-context'), { answer: 'B' });
  assert.equal(a.cache('late', { answer: 'obsolete' }), false);
  a.finish(); await cleared;
  const reopened = scope.begin('a', new AbortController());
  assert.equal(reopened.getCached('identical-context'), undefined);
  assert.equal(reopened.getCached('late'), undefined);
  reopened.finish(); b.finish();
});

test('clear barrier waits for old operations and later operations cannot reuse the old generation', async () => {
  const scope = createAiOperationScope();
  const first = scope.begin('workspace', new AbortController());
  let cleared = false;
  const pending = scope.clear().then(() => { cleared = true; });
  await Promise.resolve(); assert.equal(cleared, false);
  const next = scope.begin('workspace', new AbortController());
  next.cache('context', { answer: 'new' });
  first.finish(); await pending;
  assert.equal(first.isActive(), false); assert.equal(next.isActive(), true);
  assert.deepEqual(next.getCached('context'), { answer: 'new' }); next.finish();
});

test('closing a repository can drop its cache without cancelling a confirmed background task', () => {
  const scope = createAiOperationScope({ maxCacheEntries: 1 });
  const task = scope.begin('workspace', new AbortController());
  task.cache('first', 1); task.cache('second', 2);
  assert.equal(task.getCached('first'), undefined);
  scope.clearCache();
  assert.equal(task.isActive(), true); assert.equal(task.getCached('second'), undefined);
  task.cache('complete-after-close', 3); assert.equal(task.getCached('complete-after-close'), 3); task.finish();
});
