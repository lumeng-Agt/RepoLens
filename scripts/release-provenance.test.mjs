import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canPromoteRelease, hashBuildInputs, hashPackagedApplication } from "./release-provenance.mjs";

test("application source manifest is deterministic, content-sensitive, and excludes tests", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-release-provenance-"));
  try {
    await mkdir(path.join(root, "data"), { recursive: true });
    await mkdir(path.join(root, "desktop", "renderer"), { recursive: true });
    await mkdir(path.join(root, "desktop"), { recursive: true });
    await mkdir(path.join(root, "scripts"), { recursive: true });
    await writeFile(path.join(root, "package.json"), '{"version":"0.1.0"}');
    await writeFile(path.join(root, "data", "module.mjs"), "export const value = 1;\n");
    await writeFile(path.join(root, "data", "module.test.mjs"), "fixture\n");
    await writeFile(path.join(root, "desktop", "renderer", "index.js"), "console.log('ready');\n");
    await writeFile(path.join(root, "desktop", "main.mjs"), "app\n");
    await writeFile(path.join(root, "desktop", "preload.cjs"), "bridge\n");
    await writeFile(path.join(root, "desktop", "security-policy.mjs"), "policy\n");
    await writeFile(path.join(root, "scripts", "local-server.mjs"), "server\n");

    const first = await hashPackagedApplication(root);
    const repeated = await hashPackagedApplication(root);
    assert.deepEqual(repeated, first);
    assert.ok(first.sourceFiles.some((file) => file.path === "desktop/renderer/index.js"));
    assert.ok(!first.sourceFiles.some((file) => file.path.includes(".test.")));

    await writeFile(path.join(root, "data", "module.mjs"), "export const value = 2;\n");
    const changed = await hashPackagedApplication(root);
    assert.notEqual(changed.sourceTreeSha256, first.sourceTreeSha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("only a clean committed source may replace the release directory", () => {
  assert.equal(canPromoteRelease({ workingTreeDirty: false }), true);
  assert.equal(canPromoteRelease({ workingTreeDirty: true }), false);
  assert.equal(canPromoteRelease({ workingTreeDirty: undefined }), false);
  assert.equal(canPromoteRelease({ workingTreeDirty: false, candidateOnly: true }), false, "verification candidates cannot replace an existing release even from clean source");
});

test("build input provenance includes source, lockfile, and build configuration content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-build-inputs-"));
  try {
    await mkdir(path.join(root, "app"), { recursive: true });
    await writeFile(path.join(root, "app", "page.tsx"), "export default 1;\n");
    await writeFile(path.join(root, "package-lock.json"), "{\"lockfileVersion\": 3}\n");
    const first = await hashBuildInputs(root);
    assert.ok(first.sourceInputs.some((file) => file.path === "app/page.tsx"));
    assert.ok(first.sourceInputs.some((file) => file.path === "package-lock.json"));
    await writeFile(path.join(root, "app", "page.tsx"), "export default 2;\n");
    const changed = await hashBuildInputs(root);
    assert.notEqual(changed.sourceInputsSha256, first.sourceInputsSha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
