import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareGitHubRepository, cleanupGitHubRepository } from "./githubRepository.mjs";
import { scanRepository } from "./localRepository.mjs";

function git(cwd, ...args) {
  execFileSync("git", args, { cwd, stdio: "ignore", windowsHide: true });
}

function semanticSnapshot(snapshot) {
  return {
    files: snapshot.files.map(({ id, kind, language, imports, symbols }) => ({ id, kind, language, imports, symbols })).sort((a, b) => a.id.localeCompare(b.id)),
    dependencies: snapshot.dependencies.map(({ fromId, toId, specifier, kind, resolution, typeOnly, reference }) => ({ fromId, toId, specifier, kind, resolution, typeOnly, line: reference.line })).sort((a, b) => `${a.fromId}:${a.toId}:${a.specifier}`.localeCompare(`${b.fromId}:${b.toId}:${b.specifier}`)),
    unresolved: snapshot.unresolved.map(({ fileId, specifier, line, kind, external }) => ({ fileId, specifier, line, kind, external })).sort((a, b) => `${a.fileId}:${a.specifier}`.localeCompare(`${b.fileId}:${b.specifier}`)),
    diagnostics: snapshot.diagnostics.map(({ path: itemPath, message }) => ({ path: itemPath, message })).sort((a, b) => `${a.path}:${a.message}`.localeCompare(`${b.path}:${b.message}`)),
  };
}

test("JS, Python, and Go results agree across cold, incremental, and local-bare GitHub scans", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-language-parity-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const work = path.join(root, "work");
  const bare = path.join(root, "remote.git");
  const tempRoot = path.join(root, "github-temp");
  await mkdir(path.join(work, "src", "pkg"), { recursive: true });
  await mkdir(path.join(work, "cmd"), { recursive: true });
  await mkdir(path.join(work, "internal", "core"), { recursive: true });
  await writeFile(path.join(work, "src", "main.ts"), "export const start = 1;\n", "utf8");
  await writeFile(path.join(work, "src", "logic.ts"), "export const result = 42;\n", "utf8");
  await writeFile(path.join(work, "src", "main.py"), "from pkg import worker\nprint(worker.VALUE)\n", "utf8");
  await writeFile(path.join(work, "src", "pkg", "__init__.py"), "\n", "utf8");
  await writeFile(path.join(work, "src", "pkg", "worker.py"), "VALUE = 42\n", "utf8");
  await writeFile(path.join(work, "go.mod"), "module example.com/repolens-parity\n\ngo 1.23\n", "utf8");
  await writeFile(path.join(work, "cmd", "main.go"), 'package main\nimport "example.com/repolens-parity/internal/core"\nfunc main() { _ = core.Value }\n', "utf8");
  await writeFile(path.join(work, "internal", "core", "core.go"), "package core\nconst Value = 42\n", "utf8");

  git(work, "init", "-b", "main");
  git(work, "config", "user.name", "RepoLens Test");
  git(work, "config", "user.email", "test@example.invalid");
  const cold = await scanRepository(work);
  await writeFile(path.join(work, "src", "main.ts"), 'import { result } from "./logic";\nexport const start = result;\n', "utf8");
  const incremental = await scanRepository(work, cold, { mode: "incremental", changedPaths: ["src/main.ts"] });
  assert.equal(incremental.stats.sourceReadCount, 1);
  assert.equal(incremental.stats.sourceParseCount, 1);
  const verified = await scanRepository(work, null, { mode: "verify" });
  assert.deepEqual(semanticSnapshot(incremental.snapshot), semanticSnapshot(verified.snapshot), "incremental output matches a cold full scan");

  git(work, "add", ".");
  git(work, "commit", "-m", "fixed mixed-language fixture");
  git(root, "clone", "--bare", work, bare);
  const previousTempRoot = process.env.REPOLENS_TEMP_ROOT;
  process.env.REPOLENS_TEMP_ROOT = tempRoot;
  let githubWorkspace;
  try {
    githubWorkspace = await prepareGitHubRepository("https://github.com/example/repolens-parity", null, { gitRemoteOverride: bare });
    const github = await scanRepository(githubWorkspace.root);
    assert.deepEqual(semanticSnapshot(github.snapshot), semanticSnapshot(verified.snapshot), "Git blob materialization retains the same file, edge, and diagnostic facts");
  } finally {
    if (githubWorkspace) assert.equal(await cleanupGitHubRepository(githubWorkspace), true);
    if (previousTempRoot === undefined) delete process.env.REPOLENS_TEMP_ROOT;
    else process.env.REPOLENS_TEMP_ROOT = previousTempRoot;
  }
});
