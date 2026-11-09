import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { evaluate } from "../scripts/evaluate-investigation-retrieval.mjs";
test("upstream task evaluation is pinned, balanced, offline and reports range and context metrics", async () => {
  const corpus = JSON.parse(await readFile(new URL("../fixtures/investigation-retrieval.json", import.meta.url), "utf8"));
  for (const repo of corpus.repositories) {
    assert.match(repo.commit, /^[a-f0-9]{40}$/);
    assert.ok(repo.files.some(f => f.path === repo.license && f.source.length > 100));
    for (const task of repo.cases) for (const target of task.required) {
      const file = repo.files.find(f => f.path === target.path);
      assert.ok(file && target.startLine >= 1 && target.endLine >= target.startLine && target.endLine <= file.source.split(/\r?\n/).length, task.id);
    }
  }
  const result = await evaluate();
  assert.equal(result.results.length, 24);
  for (const language of ["typescript", "python", "go"]) assert.equal(result.results.filter(r => r.language === language).length, 8);
  assert.ok(result.results.every(r => Number.isFinite(r.elapsedMs) && r.characters <= 60000));
  // Quality deltas are reported separately; this integrity check must not claim a release gate passed.
});


test("no sendable evaluation samples report unavailable ratios and explicit failures", async () => {
  const result = await evaluate(() => ({candidates:[],retrievalInsufficient:true}));
  for (const language of ["typescript", "python", "go"]) {
    const summary = result.summary[`tuning/${language}`];
    assert.equal(summary.validSamples, 0);
    assert.equal(summary.preparationFailureRate, 1);
    assert.equal(summary.irrelevantRatio, null);
  }
  assert.ok(result.results.every(r => r.blockers.includes("insufficient_evidence")));
});


test("independent corpus preserves pinned licenses, review hashes and complete valid ranges", async () => {
  const corpus = JSON.parse(await readFile(new URL("../fixtures/investigation-retrieval-independent.json", import.meta.url), "utf8"));
  assert.equal(corpus.repositories.length, 3);
  for (const repo of corpus.repositories) {
    assert.match(repo.commit, /^[a-f0-9]{40}$/);
    assert.ok(repo.paths.length >= 20);
    assert.equal(repo.cases.length, 8);
    assert.ok(repo.files.find(f=>f.path===repo.license)?.source.length > 100);
    for (const task of repo.cases) for (const ref of [...task.required, ...task.auxiliary]) {
      const file = repo.files.find(f=>f.path===ref.path);
      assert.ok(file && ref.startLine>0 && ref.endLine>=ref.startLine && ref.endLine<=file.source.split(/\r?\n/).length);
    }
  }
});
