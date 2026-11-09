import test from "node:test";
import assert from "node:assert/strict";
import { createAiRouteRecord } from "./ai-route.mjs";
import { getReadingTourStatus } from "./reading-route-state.mjs";

const files = new Map([["main.ts", { contentHash: "main-hash" }], ["other.ts", { contentHash: "other-hash" }]]);
const route = () => createAiRouteRecord({ repositoryId: "repo", revision: "revision", entryFileId: "main.ts", title: "Read", steps: [{ fileId: "main.ts", purpose: "Read main", references: [{ fileId: "main.ts", startLine: 1 }] }], contextFiles: [{ fileId: "main.ts", contentHash: "main-hash" }] });

test("legacy route inspection is safe and leaves partial records and extension fields untouched", () => {
  for (const value of [{ title: "Old", future: { keep: true } }, { signature: "old", steps: [] }, null]) {
    const before = structuredClone(value);
    assert.deepEqual(getReadingTourStatus(value, files), { state: "legacy", readable: false, editable: false });
    assert.deepEqual(value, before);
  }
});

test("missing source hashes remain unknown, including secondary references", () => {
  const value = route(); value.contextFiles = [];
  assert.deepEqual(getReadingTourStatus(value, files), { state: "unknown", readable: false, editable: true });
  value.contextFiles = [{ fileId: "main.ts", contentHash: "main-hash" }];
  value.sourceSteps[0].references.push({ fileId: "other.ts", startLine: 2 });
  assert.equal(getReadingTourStatus(value, files).state, "unknown");
  value.contextFiles.push({ fileId: "other.ts", contentHash: "other-hash" });
  assert.equal(getReadingTourStatus(value, files).state, "current");
});

test("changed, removed and explicitly stale sources disable navigation", () => {
  const value = route();
  assert.equal(getReadingTourStatus(value, files).readable, true);
  assert.equal(getReadingTourStatus(value, new Map()).state, "stale");
  value.contextFiles[0].contentHash = "old-hash";
  assert.equal(getReadingTourStatus(value, files).state, "stale");
  value.contextFiles[0].contentHash = "main-hash"; value.stale = true;
  assert.equal(getReadingTourStatus(value, files).state, "stale");
});
