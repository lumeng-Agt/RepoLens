import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scanRepository } from "./localRepository.mjs";
import fs from "node:fs";
import { createRepositoryFileAccess } from "./repository-files.mjs";
import { buildRepositoryOverview } from "./repository-overview.mjs";
import { compareRepositoryRevisions } from "./revision-comparison.mjs";
import { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

async function fixture(t) {
  const parent = fs.realpathSync.native(await mkdtemp(path.join(os.tmpdir(), "repolens-file-boundary-")));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "repo"); const outside = path.join(parent, "outside");
  await mkdir(root); await mkdir(outside);
  await writeFile(path.join(root, "main.ts"), 'import { value } from "@private"; export { value };');
  await writeFile(path.join(root, "target.ts"), "export const value = 1;");
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ extends: "../outside/shared.json" }));
  return { root, outside };
}

test("repository reads accept an aliased ancestor while rejecting links inside the repository", async t => {
  const { root, outside } = await fixture(t);
  const alias = path.join(path.dirname(root), "parent-alias");
  fs.symlinkSync(path.dirname(root), alias, "junction");
  const aliasedRoot = path.join(alias, "repo");
  const access = createRepositoryFileAccess(aliasedRoot);
  assert.match(access.readFileSync("target.ts").content, /value = 1/);
  assert.match((await access.readFile(path.join(aliasedRoot, "target.ts"))).content, /value = 1/);
  fs.symlinkSync(outside, path.join(root, "linked"), "junction");
  await writeFile(path.join(outside, "secret.ts"), "EXTERNAL_BODY");
  await assert.rejects(access.readFile("linked/secret.ts"), { code: "REPOSITORY_FILE_BLOCKED" });
  assert.throws(() => createRepositoryFileAccess(path.join(root, "linked")), /真实的仓库文件夹/);
});

test("TypeScript extends outside the repository cannot supply compiler options", async t => {
  const { root, outside } = await fixture(t);
  await writeFile(path.join(outside, "shared.json"), JSON.stringify({ compilerOptions: { baseUrl: "../repo", paths: { "@private": ["target.ts"] } } }));
  const scan = await scanRepository(root);
  assert.equal(scan.snapshot.dependencies.some(edge => edge.toId === "target.ts"), false);
  assert.ok(scan.snapshot.diagnostics.some(item => /阻止|超出仓库/.test(item.message)));
  assert.ok(scan.snapshot.configPath.every(item => !item.startsWith("../")));
  await writeFile(path.join(outside, "shared.json"), "changed external content that must not be observed");
  const again = await scanRepository(root, scan);
  assert.equal(again.snapshot.revision, scan.snapshot.revision);
});

test("blocked external configuration diagnostics do not disclose resolved absolute paths", async t => {
  const { root, outside } = await fixture(t);
  await writeFile(path.join(outside, "shared.json"), '{ "compilerOptions": invalid external data');
  const scan = await scanRepository(root);
  const messages = JSON.stringify(scan.snapshot.diagnostics).replaceAll("\\\\", "/");
  assert.equal(messages.includes(outside.replaceAll("\\", "/")), false);
  assert.ok(scan.snapshot.diagnostics.some(item => /阻止|超出仓库/.test(item.message)));
});

test("repository reads reject external paths before opening them and preserve normal bounded reads", async t => {
  const { root, outside } = await fixture(t);
  await writeFile(path.join(outside, "secret.json"), "EXTERNAL_BODY");
  const access = createRepositoryFileAccess(root);
  assert.throws(() => access.readFileSync(path.join(outside, "secret.json")), { code: "REPOSITORY_FILE_BLOCKED" });
  await assert.rejects(access.readFile("../outside/secret.json"), { code: "REPOSITORY_FILE_BLOCKED" });
  assert.match(access.readFileSync("target.ts").content, /value = 1/);
  await assert.rejects(access.readFile("target.ts", { maximumBytes: 1 }), { code: "REPOSITORY_FILE_TOO_LARGE" });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(access.readFile("target.ts", { signal: controller.signal }), { name: "AbortError" });
});

for (const synchronous of [true, false]) test(`a directory replaced before ${synchronous ? "sync" : "async"} open is rejected before reading external bytes`, async t => {
  const { root, outside } = await fixture(t);
  const directory = path.join(root, "config"); await mkdir(directory);
  await writeFile(path.join(directory, "base.json"), "INSIDE"); await writeFile(path.join(outside, "base.json"), "EXTERNAL_BODY");
  const access = createRepositoryFileAccess(root); const target = path.join(directory, "base.json"); let changed = false; let externalReads = 0;
  const swap = file => {
    if (path.resolve(String(file)) !== target || changed) return;
    changed = true;
    fs.renameSync(directory, path.join(root, "saved-config")); fs.symlinkSync(outside, directory, "junction");
  };
  if (synchronous) {
    const open = fs.openSync; const read = fs.readSync;
    const opening = t.mock.method(fs, "openSync", (file, ...args) => { swap(file); return open(file, ...args); });
    const reading = t.mock.method(fs, "readSync", (...args) => { externalReads++; return read(...args); });
    try { assert.throws(() => access.readFileSync(target), error => /^REPOSITORY_FILE_(BLOCKED|CHANGED)$/.test(error.code)); }
    finally { opening.mock.restore(); reading.mock.restore(); }
  } else {
    const open = fs.promises.open;
    const opening = t.mock.method(fs.promises, "open", async (file, ...args) => {
      swap(file); const handle = await open(file, ...args); const read = handle.read.bind(handle);
      handle.read = (...readArgs) => { externalReads++; return read(...readArgs); }; return handle;
    });
    try { await assert.rejects(access.readFile(target), error => /^REPOSITORY_FILE_(BLOCKED|CHANGED)$/.test(error.code)); }
    finally { opening.mock.restore(); }
  }
  assert.equal(changed, true); assert.equal(externalReads, 0);
});

test("a changed path identity after reading is rejected without returning its content", async t => {
  const { root, outside } = await fixture(t); const directory = path.join(root, "config"); await mkdir(directory);
  await writeFile(path.join(directory, "base.json"), "INSIDE"); await writeFile(path.join(outside, "base.json"), "EXTERNAL_BODY");
  const target = path.join(directory, "base.json"); const access = createRepositoryFileAccess(root); const open = fs.promises.open;
  let changed = false;
  const externalIdentity = fs.lstatSync(path.join(outside, "base.json"));
  const lstat = fs.lstatSync;
  const inspecting = t.mock.method(fs, "lstatSync", (file, ...args) => changed && path.resolve(String(file)) === target ? externalIdentity : lstat(file, ...args));
  const opening = t.mock.method(fs.promises, "open", async (...args) => {
    const handle = await open(...args); const read = handle.read.bind(handle);
    handle.read = async (...readArgs) => {
      const result = await read(...readArgs);
      changed = true;
      return result;
    }; return handle;
  });
  try { await assert.rejects(access.readFile(target), error => /^REPOSITORY_FILE_(BLOCKED|CHANGED)$/.test(error.code)); }
  finally { opening.mock.restore(); inspecting.mock.restore(); }
  assert.equal(changed, true);
});

test("inherited configuration cache rejects a replaced directory and recovers after repair", async t => {
  const { root, outside } = await fixture(t); const directory = path.join(root, "config"); await mkdir(directory);
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ extends: "./config/base.json" }));
  await writeFile(path.join(directory, "base.json"), JSON.stringify({ compilerOptions: { baseUrl: "..", paths: { "@private": ["target.ts"] } } }));
  await writeFile(path.join(outside, "base.json"), "invalid external data");
  const first = await scanRepository(root); assert.ok(first.snapshot.dependencies.some(edge => edge.toId === "target.ts"));
  const saved = path.join(root, "saved-config"); fs.renameSync(directory, saved); fs.symlinkSync(outside, directory, "junction");
  const blocked = await scanRepository(root, first);
  assert.equal(blocked.snapshot.dependencies.some(edge => edge.toId === "target.ts"), false);
  assert.ok(blocked.snapshot.diagnostics.some(item => /阻止/.test(item.message)));
  assert.equal(JSON.stringify(blocked.snapshot.diagnostics).replaceAll("\\\\", "/").includes(outside.replaceAll("\\", "/")), false);
  fs.unlinkSync(directory); fs.renameSync(saved, directory);
  const repaired = await scanRepository(root, blocked); assert.ok(repaired.snapshot.dependencies.some(edge => edge.toId === "target.ts"));
});

function interceptOpen(t, target, swap) {
  const open = fs.promises.open; const state = { replaced: false, reads: 0 };
  const mocked = t.mock.method(fs.promises, "open", async (file, ...args) => {
    const match = path.resolve(String(file)) === target;
    if (match && !state.replaced) { state.replaced = true; swap(); }
    const handle = await open(file, ...args);
    if (match) { const read = handle.read.bind(handle); handle.read = (...readArgs) => { state.reads++; return read(...readArgs); }; }
    return handle;
  });
  return { state, restore: () => mocked.mock.restore() };
}

for (const [kind, name] of [["source", "file.ts"], ["language configuration", "go.mod"], ["ignore rules", ".gitignore"]]) {
  test(`the scanner protects ${kind} when its parent is replaced before open`, async t => {
    const { root, outside } = await fixture(t); const directory = path.join(root, "sub"); await mkdir(directory);
    await writeFile(path.join(directory, name), kind === "source" ? "export const inside = true;" : "");
    if (name !== "file.ts") await writeFile(path.join(directory, "file.ts"), "export const inside = true;");
    await writeFile(path.join(outside, name), "EXTERNAL_BODY");
    const interception = interceptOpen(t, path.join(directory, name), () => { fs.renameSync(directory, path.join(root, "saved-sub")); fs.symlinkSync(outside, directory, "junction"); });
    try {
      const scanned = await scanRepository(root);
      assert.equal(interception.state.replaced, true); assert.equal(interception.state.reads, 0);
      assert.equal([...scanned.sourceCache.values()].join("").includes("EXTERNAL_BODY"), false);
      assert.equal(JSON.stringify(scanned.ignoreContents).includes("EXTERNAL_BODY"), false);
      assert.ok(scanned.snapshot.diagnostics.some(item => /读取|阻止|替换/.test(item.message)));
    } finally { interception.restore(); }
  });
}

test("overview rejects a README replaced between inspection and open", async t => {
  const { root, outside } = await fixture(t); const target = path.join(root, "README.md");
  await writeFile(target, "Inside"); await writeFile(path.join(outside, "README.md"), "EXTERNAL_BODY");
  const interception = interceptOpen(t, target, () => { fs.renameSync(target, path.join(root, "README.saved")); fs.copyFileSync(path.join(outside, "README.md"), target); });
  try {
    const overview = await buildRepositoryOverview(root, { revision: "r", files: [], dependencies: [], diagnostics: [] });
    assert.equal(overview.readme, null); assert.equal(interception.state.replaced, true); assert.equal(interception.state.reads, 0);
  } finally { interception.restore(); }
});

test("raw version comparison rejects a replaced directory before reading its external file", async t => {
  const { root, outside } = await fixture(t); const directory = path.join(root, "sub"); await mkdir(directory);
  const target = path.join(directory, "file.ts"); await writeFile(target, "export const inside = true;");
  await writeFile(path.join(outside, "file.ts"), "EXTERNAL_BODY");
  const git = (...args) => execFileSync("git", args, { cwd: root, windowsHide: true });
  git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid"); git("add", "."); git("commit", "-qm", "base");
  const interception = interceptOpen(t, target, () => { fs.renameSync(directory, path.join(root, "saved-sub")); fs.symlinkSync(outside, directory, "junction"); });
  try {
    await assert.rejects(compareRepositoryRevisions({ root, mode: "working-tree", revision: "r" }), error => /^REPOSITORY_FILE_(BLOCKED|CHANGED)$/.test(error.code));
    assert.equal(interception.state.replaced, true); assert.equal(interception.state.reads, 0);
  } finally { interception.restore(); }
});

test("bounded configuration reads preserve BOM encodings and stable cache hashes", async t => {
  const { root } = await fixture(t);
  const configuration = JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@private": ["target.ts"] } } });
  for (const encoding of ["utf8", "utf16le", "utf16be"]) {
    const body = Buffer.from(configuration, encoding === "utf8" ? "utf8" : "utf16le");
    if (encoding === "utf16be") body.swap16();
    const bom = encoding === "utf8" ? Buffer.from([0xef, 0xbb, 0xbf]) : encoding === "utf16le" ? Buffer.from([0xff, 0xfe]) : Buffer.from([0xfe, 0xff]);
    await writeFile(path.join(root, "tsconfig.json"), Buffer.concat([bom, body]));
    const first = await scanRepository(root); const warm = await scanRepository(root, first);
    assert.ok(first.snapshot.dependencies.some(edge => edge.toId === "target.ts"), encoding);
    assert.equal(warm.snapshot.revision, first.snapshot.revision, encoding);
    assert.equal(warm.stats.configParseCount, 0, encoding);
  }
});

test("an ignore file removed after inspection cannot silently broaden the scan", async t => {
  const { root } = await fixture(t); const directory = path.join(root, "sub"); await mkdir(directory);
  const target = path.join(directory, ".gitignore");
  await writeFile(target, "file.ts\n"); await writeFile(path.join(directory, "file.ts"), "export const hidden = true;");
  const interception = interceptOpen(t, target, () => fs.unlinkSync(target));
  try {
    const scanned = await scanRepository(root);
    assert.equal(interception.state.replaced, true);
    assert.equal(scanned.files.has("sub/file.ts"), false);
    assert.ok(scanned.snapshot.diagnostics.some(item => /目录未继续扫描/.test(item.message)));
  } finally { interception.restore(); }
});

test("safe configuration reads preserve in-repository dependency presets without indexing dependencies", async t => {
  const { root } = await fixture(t); const preset = path.join(root, "node_modules", "preset"); await mkdir(preset, { recursive: true });
  const content = JSON.stringify({ compilerOptions: { baseUrl: "../..", paths: { "@private": ["target.ts"] } } });
  await writeFile(path.join(preset, "base.json"), content); await writeFile(path.join(preset, "hidden.ts"), "export const hidden = true;");
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ extends: "./node_modules/preset/base.json" }));
  const scanned = await scanRepository(root);
  assert.ok(scanned.snapshot.dependencies.some(edge => edge.toId === "target.ts"));
  assert.equal(scanned.files.has("node_modules/preset/hidden.ts"), false);
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ extends: "preset/base.json" }));
  const namedPreset = await scanRepository(root, scanned);
  assert.ok(namedPreset.snapshot.dependencies.some(edge => edge.toId === "target.ts"));
  const access = createRepositoryFileAccess(root);
  for (const sensitive of [".env.private", ".git/private.json"]) {
    await assert.rejects(access.readFile(sensitive), { code: "REPOSITORY_FILE_BLOCKED" });
  }
});

test("a root replaced while resolving its real path cannot become the allowed repository", async t => {
  const { root, outside } = await fixture(t);
  await writeFile(path.join(outside, "external.ts"), "export const EXTERNAL_BODY = true;");
  const realpath = fs.promises.realpath; let changed = false;
  const mocked = t.mock.method(fs.promises, "realpath", async (file, ...args) => {
    if (path.resolve(String(file)) === root && !changed) {
      changed = true; fs.renameSync(root, path.join(path.dirname(root), "saved-repo")); fs.symlinkSync(outside, root, "junction");
    }
    return realpath(file, ...args);
  });
  syncBuiltinESMExports();
  try { await assert.rejects(scanRepository(root), /目录.*变化|替换/); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(changed, true);
});
