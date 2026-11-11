import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import "app-builder-lib";
const { NsisTarget } = await import("app-builder-lib/out/targets/nsis/NsisTarget.js");

test("portable compiler uses a separate extraction directory for every launch", async () => {
  const configuration = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  let compiledDefines;
  const packager = {
    config: configuration.build,
    platformSpecificBuildOptions: configuration.build.win,
    projectDir: os.tmpdir(), compression: "normal",
    appInfo: { id: "org.repolens.desktop", name: "repo-lens", productName: "RepoLens", productFilename: "RepoLens", description: "Test", version: "0.1.0", buildVersion: "0.1.0", copyright: "Test", updaterCacheDirName: "test-cache", getVersionInWeirdWindowsForm: () => "0.1.0.0" },
    info: { metadata: {}, buildResourcesDir: os.tmpdir(), emitArtifactBuildStarted: async () => {} },
    expandArtifactNamePattern: () => "RepoLens-Test-Portable.exe",
    getIconPath: async () => null,
    packagerOptions: { effectiveOptionComputed: async ([defines]) => { compiledDefines = defines; return true; } },
  };
  // Run the installed builder's real option translation, stopping before compression/compilation.
  // This catches upstream changes to unpackDirName semantics without creating an installer.
  // In the locked builder, true omits UNPACK_DIR_NAME; false still generates a build-wide ID.
  const target = new NsisTarget(packager, os.tmpdir(), "portable", {
    refCount: 0,
    packArch: async () => ({ fileInfo: { path: path.join(os.tmpdir(), "payload.7z"), sha512: Buffer.alloc(64).toString("base64") }, unpackedSize: 1, storedMemberFiles: [] }),
  });
  await target.buildInstaller(new Map([[1, os.tmpdir()]]));
  assert.ok(compiledDefines, "compiler options must actually be observed");
  assert.equal(Object.hasOwn(compiledDefines, "UNPACK_DIR_NAME"), false,
    "a build-wide temp path lets a second launcher remove/overwrite the running app; use NSIS $PLUGINSDIR instead");
});
