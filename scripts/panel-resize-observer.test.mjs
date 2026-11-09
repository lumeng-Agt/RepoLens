import test from 'node:test';
import assert from 'node:assert/strict';
import { deferredPanelObserver } from './panel-resize-observer.mjs';

test('nested panel observations merge per target and run after native delivery', () => {
  let native, scheduled, fallback, cancelled = 0, disconnected = 0;
  class Observer {
    constructor(callback) { native = callback; }
    disconnect() { disconnected++; }
  }
  const calls = [];
  const observer = deferredPanelObserver(Observer, entries => calls.push(entries), {
    requestAnimationFrame(callback) { scheduled = callback; return 1; },
    cancelAnimationFrame() { cancelled++; },
    setTimeout(callback) { fallback = callback; return 1; },
    clearTimeout() {},
  });
  const a = {}, b = {};
  native([{target:a,size:1}]); native([{target:a,size:2},{target:b,size:3}]);
  assert.equal(calls.length, 0);
  scheduled();
  assert.deepEqual(calls, [[{target:a,size:2},{target:b,size:3}]]);
  native([{target:a,size:4}]); fallback();
  assert.equal(calls.length, 2, "hidden-window fallback delivers exactly one batch");
  native([{target:a,size:5}]); observer.disconnect();
  assert.equal(cancelled, 3); assert.equal(disconnected, 1);
  assert.equal(calls.length, 2);
});
