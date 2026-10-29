import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { resolveEditorTarget } from "./editor-target.mjs";
test("editor target binds source identity, session and actual safe local file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-editor-"));
  try {
    const source = "export const value = 1;\n"; const contentHash = createHash("sha256").update(source).digest("hex");
    await writeFile(path.join(root, "中文 file.ts"), source);
    const file = { id: "file", path: "中文 file.ts", contentHash };
    const session = { root, snapshot: { id: "repo", source: "local", revision: "rev", persistenceSessionId: "session", files: [file] } };
    const input = { repositoryId: "repo", revision: "rev", persistenceSessionId: "session", fileId: "file", contentHash, line: 1 };
    assert.equal((await resolveEditorTarget(session, input)).path, path.join(root, file.path));
    for (const invalid of [{ line: 99 }, { line: -1 }, { fileId: "../outside" }, { persistenceSessionId: "old" }, { revision: "old" }, { contentHash: "old" }]) await assert.rejects(resolveEditorTarget(session, { ...input, ...invalid }));
    await assert.rejects(resolveEditorTarget({ ...session, snapshot: { ...session.snapshot, origin: { kind: "github" } } }, input));
    await writeFile(path.join(root, file.path), "changed");
    await assert.rejects(resolveEditorTarget(session, input), /已变化/);
    session.snapshot.files = [{ ...file, path: "../outside.ts" }];
    await assert.rejects(resolveEditorTarget(session, input));
  } finally { await rm(root, { recursive: true, force: true }); }
});
