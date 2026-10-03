import assert from "node:assert/strict";
import test from "node:test";
import { parseTourProgress } from "./tour-progress.mjs";

const tour = [{ id: "entry" }, { id: "page" }, { id: "hook" }];

test("restores valid progress for the current route", () => {
  assert.deepEqual(parseTourProgress(JSON.stringify({ stepIndex: 2, completedSteps: ["entry", "page"] }), tour), {
    stepIndex: 2,
    completedSteps: ["entry", "page"],
  });
  assert.equal(parseTourProgress(null, tour), null);
  assert.equal(parseTourProgress("{}", []), null);
});

test("rejects damaged, out-of-range, or stale completion data", () => {
  for (const raw of [
    "{",
    JSON.stringify({ stepIndex: -1, completedSteps: [] }),
    JSON.stringify({ stepIndex: 3, completedSteps: [] }),
    JSON.stringify({ stepIndex: 0, completedSteps: "entry" }),
    JSON.stringify({ stepIndex: 0, completedSteps: ["removed-step"] }),
    JSON.stringify({ stepIndex: 0, completedSteps: ["entry", "entry"] }),
  ]) {
    assert.throws(() => parseTourProgress(raw, tour));
  }
});
