import test from "node:test";
import assert from "node:assert/strict";
import { findCycleForFile, findDependencyPath, findPotentialImpact } from "./dependency-query.mjs";

const snapshot = {
  files: ["a.ts", "b.ts", "c.ts", "d.ts", "isolated.ts"].map((id) => ({ id })),
  dependencies: [
    { id: "a-b", fromId: "a.ts", toId: "b.ts", reference: { fileId: "a.ts", line: 2 } },
    { id: "b-c", fromId: "b.ts", toId: "c.ts", reference: { fileId: "b.ts", line: 3 } },
    { id: "c-a", fromId: "c.ts", toId: "a.ts", reference: { fileId: "c.ts", line: 4 } },
    { id: "d-b", fromId: "d.ts", toId: "b.ts", reference: { fileId: "d.ts", line: 5 } },
  ],
};

test("dependency path returns a stable shortest static import path and supports reverse direction", () => {
  assert.deepEqual(findDependencyPath(snapshot, "a.ts", "c.ts").files, ["a.ts", "b.ts", "c.ts"]);
  assert.deepEqual(findDependencyPath(snapshot, "c.ts", "a.ts", "imports").files, ["c.ts", "a.ts"]);
  assert.deepEqual(findDependencyPath(snapshot, "c.ts", "a.ts", "imported-by").files, ["c.ts", "b.ts", "a.ts"]);
});

test("dependency path distinguishes missing endpoints and no path", () => {
  assert.equal(findDependencyPath(snapshot, "a.ts", "isolated.ts").status, "not-found");
  assert.equal(findDependencyPath(snapshot, "missing.ts", "a.ts").status, "missing");
});

test("potential impact and strongly connected cycle edges retain source locations", () => {
  assert.deepEqual(findPotentialImpact(snapshot, "c.ts").map((item) => item.to), ["b.ts", "a.ts", "d.ts"]);
  assert.deepEqual(findCycleForFile(snapshot, "a.ts").map((edge) => edge.id), ["a-b", "b-c", "c-a"]);
  assert.deepEqual(findCycleForFile(snapshot, "isolated.ts"), []);
});
