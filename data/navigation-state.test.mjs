import assert from "node:assert/strict";
import test from "node:test";
import { initialNavigationState, navigationReducer } from "./navigation-state.mjs";

const step = { id: "step-1", title: "Read entry", focusFileId: "src/main.ts", description: "Entry", reference: { fileId: "src/main.ts", line: 8 } };

test("navigation keeps route progress separate from expired route source locations", () => {
  const before = { ...initialNavigationState, selectedFileId: "src/old.ts", focusedLine: { fileId: "src/old.ts", line: 999 }, focusOrigin: "route", focusRouteSignature: "old", completedSteps: ["done"] };
  const restored = navigationReducer(before, { type: "restore-progress", stepIndex: 2, completedSteps: ["done"], step, routeSignature: "old", routeStale: true });
  assert.equal(restored.tourIndex, 2);
  assert.deepEqual(restored.completedSteps, ["done"]);
  assert.equal(restored.selectedFileId, "src/old.ts", "stale recovery must not navigate to an old target");
  assert.equal(restored.focusedLine, null, "stale line ranges are not restored");
  assert.equal(restored.focusOrigin, "none");
});

test("directory selection changes range and file in one reducer action", () => {
  const state = { ...initialNavigationState, selectedFileId: "src/a.ts", focusedLine: { fileId: "src/a.ts", line: 4 }, focusOrigin: "reference" };
  const selected = navigationReducer(state, { type: "directory-select", value: "src", fileId: "src/b.ts", preserveFocus: false });
  assert.equal(selected.graphDirectory, "src");
  assert.equal(selected.selectedFileId, "src/b.ts");
  assert.equal(selected.focusedLine, null);
  assert.equal(selected.focusOrigin, "none");
});

test("route navigation records completion and binds source highlighting to the route signature", () => {
  const state = navigationReducer(initialNavigationState, { type: "route-step", stepIndex: 1, step, routeSignature: "tour-v1", completedStepId: "step-1" });
  assert.equal(state.selectedFileId, "src/main.ts");
  assert.equal(state.focusedLine.line, 8);
  assert.equal(state.focusOrigin, "route");
  assert.equal(state.focusRouteSignature, "tour-v1");
  assert.deepEqual(state.completedSteps, ["step-1"]);
  assert.equal(navigationReducer(state, { type: "route-step", stepIndex: 1, step, routeSignature: "tour-v1", completedStepId: "step-1" }).completedSteps.length, 1);
});
