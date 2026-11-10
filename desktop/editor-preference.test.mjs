import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink } from "node:fs/promises";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import {
  readEditorPreference,
  validateCodeExecutable,
  saveEditorPreference,
  findDefaultCodeExecutable,
  launchCodeEditor,
} from "./editor-preference.mjs";

test("readEditorPreference distinguishes unconfigured, corrupted, unreadable, and configured", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-editor-pref-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  // 1. Unconfigured when editor-v1.json does not exist
  const unconfigured = await readEditorPreference(root);
  assert.equal(unconfigured.status, "unconfigured");
  assert.equal(unconfigured.executable, null);

  // 2. Corrupted when JSON is malformed
  const prefPath = path.join(root, "editor-v1.json");
  await writeFile(prefPath, "{ not valid json");
  const corruptedJson = await readEditorPreference(root);
  assert.equal(corruptedJson.status, "corrupted");
  assert.match(corruptedJson.error, /JSON/);

  // 3. Corrupted when schema is invalid
  await writeFile(prefPath, JSON.stringify({ version: 2, executable: 123 }));
  const corruptedSchema = await readEditorPreference(root);
  assert.equal(corruptedSchema.status, "corrupted");
  assert.match(corruptedSchema.error, /格式无效/);

  // 4. Configured when valid
  await writeFile(prefPath, JSON.stringify({ version: 1, executable: "C:\\VSCode\\Code.exe" }));
  const configured = await readEditorPreference(root);
  assert.equal(configured.status, "configured");
  assert.equal(configured.executable, "C:\\VSCode\\Code.exe");

  // 5. Unreadable when read fails with unexpected error
  const unreadable = await readEditorPreference(root, {
    readFileFn: async () => {
      const err = new Error("EACCES permission denied");
      err.code = "EACCES";
      throw err;
    },
  });
  assert.equal(unreadable.status, "unreadable");
  assert.match(unreadable.error, /EACCES/);
});

test("saveEditorPreference uses atomic write and preserves original on failure", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-editor-save-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const prefPath = path.join(root, "editor-v1.json");
  await saveEditorPreference(root, "C:\\Original\\Code.exe");
  assert.deepEqual(JSON.parse(await readFile(prefPath, "utf8")), { version: 1, executable: "C:\\Original\\Code.exe" });

  // If rename fails, original file is preserved and error is thrown
  await assert.rejects(
    saveEditorPreference(root, "C:\\New\\Code.exe", {
      renameFn: async () => {
        throw new Error("rename failed");
      },
    }),
    /rename failed/
  );
  assert.deepEqual(JSON.parse(await readFile(prefPath, "utf8")), { version: 1, executable: "C:\\Original\\Code.exe" });
});

test("validateCodeExecutable enforces Code.exe only and gives specific reasons for invalid inputs", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-editor-val-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  // Relative path rejected
  const rel = await validateCodeExecutable("Code.exe");
  assert.equal(rel.ok, false);
  assert.match(rel.reason, /绝对路径/);

  // Non Code.exe (e.g. Cursor.exe, code.cmd) rejected
  const cursor = await validateCodeExecutable(path.join(root, "Cursor.exe"));
  assert.equal(cursor.ok, false);
  assert.match(cursor.reason, /仅支持 VS Code（Code\.exe），已选择 Cursor\.exe/);

  const cmd = await validateCodeExecutable(path.join(root, "bin", "code.cmd"));
  assert.equal(cmd.ok, false);
  assert.match(cmd.reason, /仅支持 VS Code（Code\.exe），已选择 code\.cmd/);

  // Non-existent file rejected
  const missing = await validateCodeExecutable(path.join(root, "Code.exe"));
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /不存在/);

  // Directory named Code.exe rejected
  const dirPath = path.join(root, "FakeDir", "Code.exe");
  await mkdir(dirPath, { recursive: true });
  const dir = await validateCodeExecutable(dirPath);
  assert.equal(dir.ok, false);
  assert.match(dir.reason, /不是文件/);

  // Valid file passes
  const validPath = path.join(root, "Real", "Code.exe");
  await mkdir(path.dirname(validPath), { recursive: true });
  await writeFile(validPath, "mock binary");
  const valid = await validateCodeExecutable(validPath);
  assert.equal(valid.ok, true);
  assert.equal(valid.executable, validPath);
});

test("findDefaultCodeExecutable returns candidate when found", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-editor-find-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const fakeLocal = path.join(root, "LocalApp");
  const codePath = path.join(fakeLocal, "Programs", "Microsoft VS Code", "Code.exe");
  await mkdir(path.dirname(codePath), { recursive: true });
  await writeFile(codePath, "mock");

  const found = await findDefaultCodeExecutable({
    env: { LOCALAPPDATA: fakeLocal },
  });
  assert.equal(found, codePath);

  const notFound = await findDefaultCodeExecutable({
    env: { LOCALAPPDATA: path.join(root, "Empty") },
  });
  assert.equal(notFound, null);
});

test("launchCodeEditor invokes executable with windowsHide: false and accurate target arguments", async () => {
  let spawnedArgs = null;
  let spawnedOpts = null;
  const mockSpawn = (cmd, args, opts) => {
    spawnedArgs = { cmd, args };
    spawnedOpts = opts;
    const proc = new EventEmitter();
    proc.pid = 12345;
    proc.unref = () => {};
    queueMicrotask(() => proc.emit("spawn"));
    return proc;
  };

  const res = await launchCodeEditor("C:\\VSCode\\Code.exe", { path: "D:\\repo\\src\\main.ts", line: 42 }, { spawnFn: mockSpawn, cwd: "D:\\repo" });
  assert.equal(res.targetArg, "D:\\repo\\src\\main.ts:42:1");
  assert.equal(spawnedOpts.windowsHide, false, "windowsHide must be false so cold-start VS Code is visible");
  assert.deepEqual(spawnedArgs.args, ["--reuse-window", "--goto", "D:\\repo\\src\\main.ts:42:1"]);
});
