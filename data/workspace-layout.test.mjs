import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_WORKSPACE_LAYOUT, normalizeWorkspaceLayout, updateWorkspaceLayout, workspaceInnerLayout, workspaceOuterLayout } from "./workspace-layout.mjs";

test("workspace panel preferences validate and normalize stored proportions", () => {
  assert.deepEqual(normalizeWorkspaceLayout({ version: 1, structure: { files: 20, graph: 50, details: 30 }, reading: { files: 25, details: 75 } }), {
    version: 1, structure: { files: 20, graph: 50, details: 30 }, reading: { files: 25, details: 75 },
  });
  assert.equal(normalizeWorkspaceLayout({ version: 2, structure: {}, reading: {} }), null);
  assert.equal(normalizeWorkspaceLayout({ ...DEFAULT_WORKSPACE_LAYOUT, structure: { files: 90, graph: 0, details: 10 } }), null);
});

test("reading and structure layouts remain isolated when one layout is resized", () => {
  const resized = updateWorkspaceLayout(DEFAULT_WORKSPACE_LAYOUT, "reading", "outer", { files: 40, content: 60 });
  assert.deepEqual(resized.reading, { files: 40, details: 60 });
  assert.deepEqual(resized.structure, DEFAULT_WORKSPACE_LAYOUT.structure);
  assert.deepEqual(workspaceOuterLayout(resized, "reading"), { files: 40, content: 60 });
  assert.deepEqual(workspaceOuterLayout(resized, "structure"), { files: 22, content: 78 });
  assert.deepEqual(workspaceInnerLayout(resized, "reading"), { graph: 0, details: 100 });
  assert.deepEqual(workspaceInnerLayout(resized, "structure"), { graph: 61.54, details: 38.46 });
});

test("structure resize preserves the other split while reading resize stays independent", () => {
  const outer = updateWorkspaceLayout(DEFAULT_WORKSPACE_LAYOUT, "structure", "outer", { files: 32, content: 68 });
  assert.deepEqual(outer.structure, { files: 32, graph: 41.85, details: 26.15 });
  const inner = updateWorkspaceLayout(outer, "structure", "inner", { graph: 70, details: 30 });
  assert.deepEqual(inner.structure, { files: 32, graph: 47.6, details: 20.4 });
  assert.deepEqual(inner.reading, DEFAULT_WORKSPACE_LAYOUT.reading);
});

test("chat width is optional for old preferences and survives other panel changes", () => {
  const preferences = { ...DEFAULT_WORKSPACE_LAYOUT, chatWidth: 440 };
  assert.equal(normalizeWorkspaceLayout(preferences).chatWidth, 440);
  assert.equal(updateWorkspaceLayout(preferences, "reading", "outer", { files: 30, content: 70 }).chatWidth, 440);
});
