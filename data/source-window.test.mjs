import test from "node:test";
import assert from "node:assert/strict";
import { visibleLineWindow } from "./source-window.mjs";

test("source window contains the viewport and bounded overscan", () => {
  const window = visibleLineWindow({ lineCount: 10_000, scrollTop: 4_845, viewportHeight: 480 });
  assert.deepEqual(window, { start: 188, end: 232, top: 4_512, bottom: 234_432 });
});

test("source window clamps at both ends and handles empty files", () => {
  assert.deepEqual(visibleLineWindow({ lineCount: 20, scrollTop: 0, viewportHeight: 48 }), { start: 0, end: 14, top: 0, bottom: 144 });
  assert.deepEqual(visibleLineWindow({ lineCount: 20, scrollTop: 1_000, viewportHeight: 48 }), { start: 7, end: 20, top: 168, bottom: 0 });
  assert.deepEqual(visibleLineWindow({ lineCount: 0, scrollTop: 0, viewportHeight: 0 }), { start: 0, end: 0, top: 0, bottom: 0 });
});
