import test from "node:test";
import assert from "node:assert/strict";
import { createOpenRequestGate } from "./open-request-gate.mjs";

test("only the latest open intent can commit, and close invalidates pending work", () => {
  const gate = createOpenRequestGate();
  const first = gate.begin();
  const second = gate.begin();
  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(second), true);
  gate.invalidate();
  assert.equal(gate.isCurrent(second), false);
  const afterClose = gate.begin();
  assert.equal(gate.isCurrent(afterClose), true);
});
