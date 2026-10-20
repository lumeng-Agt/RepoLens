import test from "node:test";
import assert from "node:assert/strict";
import { acknowledgeReadingArtifactJournal, applyReadingArtifactJournal, createReadingArtifactJournal, hasReadingArtifactOperations, readingArtifactJournalCheckpoint, stageReadingArtifactChanges } from "./reading-artifact-journal.mjs";

const note = (id, text) => ({ id, fileId: `${id}.ts`, text });
const tour = (signature, title) => ({ signature, title });

test("reading artifact edits made during a failed restore merge over saved notes and routes", () => {
  let journal = createReadingArtifactJournal();
  journal = stageReadingArtifactChanges(journal, "notes", [], [note("new", "local edit")]);
  journal = stageReadingArtifactChanges(journal, "tours", [], [tour("new-route", "local route")]);
  assert.deepEqual(applyReadingArtifactJournal([note("original", "keep me")], journal, "notes"), [note("original", "keep me"), note("new", "local edit")]);
  assert.deepEqual(applyReadingArtifactJournal([tour("saved-route", "keep route")], journal, "tours"), [tour("saved-route", "keep route"), tour("new-route", "local route")]);
});

test("explicit deletion during a failed restore does not resurrect the deleted record", () => {
  let journal = createReadingArtifactJournal();
  journal = stageReadingArtifactChanges(journal, "notes", [note("visible", "local record")], []);
  assert.deepEqual(applyReadingArtifactJournal([note("visible", "persisted record"), note("other", "preserved")], journal, "notes"), [note("other", "preserved")]);
});

test("acknowledging one save does not clear changes made while that save was pending", () => {
  let journal = createReadingArtifactJournal();
  journal = stageReadingArtifactChanges(journal, "notes", [], [note("first", "one")]);
  const checkpoint = readingArtifactJournalCheckpoint(journal);
  journal = stageReadingArtifactChanges(journal, "notes", [note("first", "one")], [note("first", "two"), note("second", "new")]);
  journal = acknowledgeReadingArtifactJournal(journal, "notes", checkpoint);
  assert.equal(hasReadingArtifactOperations(journal), true);
  assert.deepEqual(applyReadingArtifactJournal([note("first", "one")], journal, "notes"), [note("first", "two"), note("second", "new")]);
});

test("a successful tour save does not acknowledge a failed note save", () => {
  let journal = createReadingArtifactJournal();
  journal = stageReadingArtifactChanges(journal, "notes", [], [note("pending-note", "not persisted")]);
  journal = stageReadingArtifactChanges(journal, "tours", [], [tour("saved-route", "persisted")]);
  const checkpoint = readingArtifactJournalCheckpoint(journal);
  journal = acknowledgeReadingArtifactJournal(journal, "tours", checkpoint);
  assert.equal(hasReadingArtifactOperations(journal, "notes"), true);
  assert.equal(hasReadingArtifactOperations(journal, "tours"), false);
  assert.deepEqual(applyReadingArtifactJournal([note("original", "preserve")], journal, "notes"), [note("original", "preserve"), note("pending-note", "not persisted")]);
});
