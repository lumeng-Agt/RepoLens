import test from "node:test";
import assert from "node:assert/strict";
import { createRepositorySessionGate } from "./repository-session.mjs";

test("repository session gate rejects late opens, stale snapshots, and duplicate revisions", () => {
  const gate = createRepositorySessionGate();
  const oldOpen = gate.begin();
  const latestOpen = gate.begin();
  assert.equal(gate.activate(oldOpen, { id: "repo-a", sequence: 1 }), false);
  assert.equal(gate.activate(latestOpen, { id: "repo-b", sequence: 4 }), true);
  assert.equal(gate.acceptUpdate(latestOpen, { id: "repo-a", sequence: 99 }), false);
  assert.equal(gate.acceptUpdate(latestOpen, { id: "repo-b", sequence: 4 }), false);
  assert.equal(gate.acceptUpdate(latestOpen, { id: "repo-b", sequence: 3 }), false);
  assert.equal(gate.acceptUpdate(latestOpen, { id: "repo-b", sequence: 5 }), true);
  assert.equal(gate.current().sequence, 5);
  const closed = gate.begin();
  assert.equal(gate.acceptUpdate(latestOpen, { id: "repo-b", sequence: 6 }), false);
  assert.equal(gate.activate(closed, { id: "sample", sequence: 1 }), true);
});
