import test from "node:test";
import assert from "node:assert/strict";
import {
  completeUsageGuideTask,
  createDefaultUsageGuidePreferences,
  hasExistingBrowserUse,
  hasExistingWorkspaceUse,
  normalizeUsageGuidePreferences,
} from "./usage-guide.mjs";

test("usage guide preferences normalize versioned state and preserve valid completion", () => {
  const value = { ...createDefaultUsageGuidePreferences(), completedTaskIds: ["source", "source", "tour"] };
  assert.deepEqual(normalizeUsageGuidePreferences(value)?.completedTaskIds, ["source", "tour"]);
  assert.equal(normalizeUsageGuidePreferences({ ...value, version: 2 }), null);
  assert.equal(normalizeUsageGuidePreferences({ ...value, completedTaskIds: ["unknown"] }), null);
});

test("tutorial completion is idempotent and invalid identifiers are ignored", () => {
  const initial = createDefaultUsageGuidePreferences();
  const completed = completeUsageGuideTask(initial, "source");
  assert.deepEqual(completeUsageGuideTask(completed, "source"), completed);
  assert.equal(completeUsageGuideTask(initial, "invalid"), initial);
});

test("existing workspace or browser progress avoids interrupting returning users", () => {
  assert.equal(hasExistingWorkspaceUse({ recentRepositories: [{ id: "repo" }] }), true);
  assert.equal(hasExistingWorkspaceUse({ progress: { "repolens:repo:route": "{}" } }), true);
  assert.equal(hasExistingWorkspaceUse({}), false);
  assert.equal(hasExistingBrowserUse(["repolens:taskflow-sample:route"]), true);
  assert.equal(hasExistingBrowserUse(["repolens:usage-guide:v1"]), false);
});
