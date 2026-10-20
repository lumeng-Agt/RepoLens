import test from "node:test";
import assert from "node:assert/strict";
import { isReadingRangeValid, mergeReadingNotes, mergeSavedTours, readingArtifactConflictFingerprint } from "./reading-artifacts.mjs";

const note = (text = "note", stale) => ({ id: "n1", fileId: "a.ts", path: "a.ts", startLine: 2, text, contentHash: "hash", createdAt: 1, kind: "note", ...(stale ? { stale } : {}) });
const route = (title = "route") => ({
  repositoryId: "repo", entryFileId: "a.ts", revision: "rev", title, signature: "same", contextFiles: [{ fileId: "a.ts", contentHash: "hash" }],
  sourceSteps: [{ fileId: "a.ts", purpose: "purpose", question: "why?", relationship: "entry", references: [{ fileId: "a.ts", startLine: 2 }] }],
  steps: [{ id: "s1", title: "a.ts", focusFileId: "a.ts", description: "purpose", relationship: "entry", question: "why?", reference: { fileId: "a.ts", line: 2 } }],
});

test("reading import skips identical notes and keeps conflicting IDs as copies", () => {
  let id = 0;
  const result = mergeReadingNotes([note()], [note("different"), note()], () => `copy-${++id}`);
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.conflicts, 1);
  assert.deepEqual(result.records.map((item) => item.id), ["n1", "copy-1"]);
});

test("route signature collisions preserve differing content as a new signed route", () => {
  const result = mergeSavedTours([route()], [route("changed")]);
  assert.equal(result.added, 1);
  assert.equal(result.conflicts, 1);
  assert.equal(result.records.length, 2);
  assert.notEqual(result.records[0].signature, result.records[1].signature);
  assert.match(result.records[1].title, /导入副本/);
});

test("same route content from another repository target is not duplicated", () => {
  const original = route();
  const imported = { ...route(), repositoryId: "other", revision: "other-rev", contextFiles: [{ fileId: "a.ts", contentHash: "other-hash" }] };
  const result = mergeSavedTours([original], [imported]);
  assert.equal(result.added, 0);
  assert.equal(result.skipped, 1);
});

test("reading artifact conflict fingerprint changes when an imported collision is added or edited", () => {
  const incomingNote = note("incoming");
  const preview = readingArtifactConflictFingerprint([], [incomingNote], [], []);
  assert.notEqual(readingArtifactConflictFingerprint([note("different")], [incomingNote], [], []), preview);
  const conflicting = readingArtifactConflictFingerprint([note("different")], [incomingNote], [], []);
  assert.notEqual(readingArtifactConflictFingerprint([note("changed again")], [incomingNote], [], []), conflicting);
  assert.equal(readingArtifactConflictFingerprint([incomingNote], [incomingNote], [], []), preview);
});

test("reading line ranges must fit within the current source", () => {
  assert.equal(isReadingRangeValid(10, 1, 10), true);
  assert.equal(isReadingRangeValid(10, 0), false);
  assert.equal(isReadingRangeValid(10, 4, 3), false);
  assert.equal(isReadingRangeValid(10, 11), false);
});
