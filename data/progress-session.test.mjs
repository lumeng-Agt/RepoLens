import test from "node:test";
import assert from "node:assert/strict";
import { createProgressSessionGate } from "./progress-session.mjs";

test("progress hydration blocks writes until the active key has been restored", () => {
  const gate = createProgressSessionGate();
  const sample = gate.begin("sample:version-a");
  assert.equal(gate.canSave(sample.key), false);
  assert.equal(gate.complete(sample), true);
  assert.equal(gate.canSave(sample.key), true);

  const route = gate.begin("repo:route-signature-a");
  assert.equal(gate.canSave(sample.key), false);
  assert.equal(gate.canSave(route.key), false);
  assert.equal(gate.complete(sample), false);
  assert.equal(gate.complete(route), true);
  assert.equal(gate.canSave(route.key), true);
});

test("same route snapshot keeps its restored progress session", () => {
  const gate = createProgressSessionGate();
  const first = gate.begin("repo:route-signature-a");
  gate.complete(first);
  const afterUnrelatedSnapshot = gate.begin("repo:route-signature-a");
  assert.deepEqual(afterUnrelatedSnapshot, first);
  assert.equal(gate.canSave("repo:route-signature-a"), true);
  const changedRoute = gate.begin("repo:route-signature-b");
  assert.equal(gate.canSave(changedRoute.key), false);
});

test("reopening the same repository route forces hydration without letting the previous session save", () => {
  const gate = createProgressSessionGate();
  const firstSession = gate.begin("repo:route-signature-a");
  gate.complete(firstSession);
  const reopened = gate.begin("repo:route-signature-a", true);
  assert.notEqual(reopened.generation, firstSession.generation);
  assert.equal(gate.canSave(reopened.key), false);
  assert.equal(gate.complete(firstSession), false);
  assert.equal(gate.complete(reopened), true);
});
