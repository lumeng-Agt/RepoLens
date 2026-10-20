import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildRepositoryOverview } from "./repository-overview.mjs";

test("repository overview reports README, manifests and evidence-based static entry candidates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-overview-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "README.md"), "# Example\n\nA small app.\n\n![external](https://example.test/image.png)");
    await writeFile(path.join(root, "package.json"), "{}");
    const snapshot = { revision: "r1", files: [{ id: "src/index.ts", path: "src/index.ts", name: "index.ts", language: "ts", kind: "typescript" }, { id: "src/lib.ts", path: "src/lib.ts", name: "lib.ts", language: "ts", kind: "typescript" }, { id: "src/lib.test.ts", path: "src/lib.test.ts", name: "lib.test.ts", language: "ts", kind: "typescript" }], dependencies: [{ fromId: "src/index.ts", toId: "src/lib.ts" }], diagnostics: [] };
    const result = await buildRepositoryOverview(root, snapshot);
    assert.equal(result.readme.path, "README.md");
    assert.equal(result.readme.summary.includes("external"), false);
    assert.deepEqual(result.manifests, ["package.json"]);
    assert.equal(result.candidates[0].fileId, "src/index.ts");
    assert.equal(result.testCount, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("repository overview ignores README symlinks", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-overview-link-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "repolens-overview-outside-"));
  try {
    await writeFile(path.join(outside, "secret.md"), "private data");
    try { await symlink(path.join(outside, "secret.md"), path.join(root, "README.md")); }
    catch (error) { if (error.code === "EPERM" || error.code === "ENOTSUP") { context.skip("当前 Windows 环境不允许创建符号链接。"); return; } throw error; }
    const result = await buildRepositoryOverview(root, { revision: "r", files: [], dependencies: [], diagnostics: [] });
    assert.equal(result.readme, null);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
