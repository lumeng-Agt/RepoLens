import test from "node:test";
import assert from "node:assert/strict";
import { findRevisionImpacts } from "./revision-impact.mjs";

test("revision impacts identify notes, saved tours and explanations by changed context path", () => {
  const result = findRevisionImpacts({
    changes: [{ status: "renamed", oldPath: "src/old.ts", path: "src/new.ts" }, { status: "modified", path: "src/store.ts" }],
    files: [{ id: "src/new.ts", path: "src/new.ts" }, { id: "src/store.ts", path: "src/store.ts" }],
    notes: [{ id: "note-1", fileId: "src/new.ts", path: "src/old.ts", text: "Review migration" }, { id: "note-2", fileId: "README.md", path: "README.md", text: "Unrelated" }],
    tours: [{ signature: "tour-1", title: "Save flow", entryFileId: "src/new.ts", contextFiles: [{ fileId: "src/store.ts" }], steps: [{ focusFileId: "src/new.ts", reference: { fileId: "src/new.ts" } }] }],
    results: [{ __entryFileId: "src/store.ts", role: "Storage explanation", __contextFiles: [{ fileId: "src/store.ts" }] }],
  });
  assert.equal(result.total, 3);
  assert.deepEqual(result.notes[0].paths, ["src/new.ts", "src/old.ts"]);
  assert.deepEqual(result.tours[0].paths, ["src/new.ts", "src/store.ts"]);
  assert.equal(result.results[0].title, "Storage explanation");
});

test("deleted artifacts are found through retained paths and file ids", () => {
  const result = findRevisionImpacts({ changes: [{ status: "deleted", path: "pkg/gone.py" }], files: [], notes: [{ id: "n", fileId: "pkg/gone.py", path: "pkg/gone.py", text: "note" }] });
  assert.equal(result.total, 1);
  assert.deepEqual(result.notes[0].paths, ["pkg/gone.py"]);
});
