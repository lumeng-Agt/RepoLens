import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { selectAiContext } from "./ai-context.mjs";
import { rankQuestionCandidates } from "./question-retrieval.mjs";

const fixturePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/question-retrieval-evaluation.json");
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));

test("fixed question retrieval evaluation finds the expected source within a safe preview budget", () => {
  const sourceById = new Map(fixture.files.map((file) => [file.id, file.source]));
  let hitsAtThree = 0;
  let reasonsAccurate = 0;
  for (const item of fixture.cases) {
    const ranked = rankQuestionCandidates({
      files: fixture.files,
      dependencies: fixture.dependencies,
      sourceById,
      entryFileId: fixture.entryFileId,
      question: item.question,
    });
    const selected = ranked.candidates.slice(0, 3);
    if (selected.some((candidate) => candidate.id === item.expectedFileId)) hitsAtThree += 1;
    const expected = selected.find((candidate) => candidate.id === item.expectedFileId);
    assert.ok(expected, `${item.id}: expected source appears in top three candidates`);
    assert.ok(expected.reasons.some((reason) => reason.toLowerCase().includes(item.expectedReason.toLowerCase())), `${item.id}: reason explains why the file ranked`);
    reasonsAccurate += 1;
    if (item.suggestedRange) assert.deepEqual(expected.suggestedRange, item.suggestedRange, `${item.id}: matched symbol suggests only its definition range`);

    const ranges = Object.fromEntries(selected.flatMap((candidate) => candidate.suggestedRange ? [[candidate.id, candidate.suggestedRange]] : []));
    const context = selectAiContext({
      fileIds: selected.map((candidate) => candidate.id),
      candidateIds: fixture.files.map((file) => file.id),
      entryFileId: fixture.entryFileId,
      ranges,
      sourceById,
      requireEntry: false,
    });
    const historyCharacters = (item.history ?? []).reduce((sum, message) => sum + message.content.length, 0);
    const totalCharacters = context.characters + item.question.length + historyCharacters;
    assert.ok(totalCharacters <= 60_000, `${item.id}: question and selected source stay within the product character budget`);
    const expectedSource = context.sources.find((source) => source.fileId === item.expectedFileId)?.source;
    assert.ok(expectedSource?.includes(item.mustContain), `${item.id}: approved source range contains the evaluation key fragment`);
    if (item.mustExclude) assert.ok(!expectedSource.includes(item.mustExclude), `${item.id}: approved source range excludes unrelated neighboring code`);
  }

  assert.equal(hitsAtThree / fixture.cases.length, 1, "baseline recall@3 is 100% on the fixed fixture");
  assert.equal(reasonsAccurate / fixture.cases.length, 1, "each expected source has a relevant inclusion reason");
});

test("fixed retrieval evaluation identifies insufficient evidence instead of inventing a source", () => {
  const sourceById = new Map(fixture.files.map((file) => [file.id, file.source]));
  for (const item of fixture.insufficientEvidenceCases ?? []) {
    const ranked = rankQuestionCandidates({
      files: fixture.files,
      dependencies: fixture.dependencies,
      sourceById,
      entryFileId: fixture.entryFileId,
      question: item.question,
    });
    assert.equal(ranked.retrievalInsufficient, true, `${item.id}: no file or symbol matches the question`);
  }
});
