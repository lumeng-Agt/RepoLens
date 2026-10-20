import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, mkdir, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compareRepositoryRevisions } from "./revision-comparison.mjs";
import { readingBaselineHeadRef } from "./revision-baseline.mjs";

const execFile = promisify(execFileCallback);
async function run(root, ...args) { await execFile("git", args, { cwd: root, windowsHide: true, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" } }); }

test("revision comparison reads working changes and two verified commits without shell execution", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-revision-compare-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await run(root, "init", "-q"); await run(root, "config", "user.name", "RepoLens Test"); await run(root, "config", "user.email", "test@example.invalid");
  await mkdir(path.join(root, "src")); await writeFile(path.join(root, "src/a.ts"), "export const value = 1;\n");
  await run(root, "add", "."); await run(root, "commit", "-qm", "first");
  const first = (await execFile("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  await writeFile(path.join(root, "src/a.ts"), "export const value = 2;\n"); await run(root, "add", "."); await run(root, "commit", "-qm", "second");
  const second = (await execFile("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const commits = await compareRepositoryRevisions({ root, mode: "commits", baseRef: first, headRef: second, revision: "index-r1" });
  assert.equal(commits.files[0].status, "modified"); assert.equal(commits.diff.includes("value = 2"), true);
  await writeFile(path.join(root, "src/a.ts"), "export const value = 3;\n");
  await writeFile(path.join(root, "src/new.ts"), "export const added = true;\n");
  const working = await compareRepositoryRevisions({ root, mode: "working-tree", revision: "index-r1" });
  assert.equal(working.files.some((file) => file.path === "src/a.ts" && file.status === "modified"), true);
  assert.equal(working.files.some((file) => file.path === "src/new.ts" && file.status === "added"), true);
  assert.equal(working.diff.includes("value = 3"), true); assert.equal(working.diff.includes("added = true"), true);
});

test("revision comparison rejects option-like or unknown refs", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-revision-ref-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await run(root, "init", "-q");
  await assert.rejects(compareRepositoryRevisions({ root, mode: "commits", baseRef: "--upload-pack=oops", headRef: "HEAD", revision: "r" }), /提交标识无效/);
});

test("revision comparison preserves Unicode and spaced paths and reads immutable bare snapshots", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-revision-paths-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await run(root, "init", "-q"); await run(root, "config", "user.name", "RepoLens Test"); await run(root, "config", "user.email", "test@example.invalid");
  await mkdir(path.join(root, "src")); await writeFile(path.join(root, "src/old.ts"), "export const value = 1;\n");
  await run(root, "add", "."); await run(root, "commit", "-qm", "base");
  const base = (await execFile("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  await mkdir(path.join(root, "中文目录")); await run(root, "mv", "src/old.ts", "中文目录/新 文件.ts"); await run(root, "commit", "-qam", "rename");
  const head = (await execFile("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const renamed = await compareRepositoryRevisions({ root, mode: "commits", baseRef: base, headRef: head, revision: "r" });
  assert.deepEqual(renamed.files, [{ status: "renamed", oldPath: "src/old.ts", path: "中文目录/新 文件.ts" }]);
  await writeFile(path.join(root, "新增 文件.ts"), "export const added = true;\n");
  const working = await compareRepositoryRevisions({ root, mode: "working-tree", revision: "r" });
  assert.ok(working.files.some((file) => file.path === "新增 文件.ts" && file.status === "added"));
  const bare = path.join(root, "mirror.git");
  await execFile("git", ["clone", "--bare", "--quiet", root, bare], { windowsHide: true });
  const remoteSnapshot = await compareRepositoryRevisions({ root, gitDir: bare, currentCommit: head, mode: "working-tree", revision: "r" });
  assert.equal(remoteSnapshot.files.length, 0);
  assert.equal(remoteSnapshot.baseCommit, head);
  const baselineHead = readingBaselineHeadRef({ origin: { kind: "github", commit: head } });
  assert.equal(baselineHead, head);
  const sameCommitBaseline = await compareRepositoryRevisions({ root, gitDir: bare, mode: "commits", baseRef: head, headRef: baselineHead, revision: "r" });
  assert.deepEqual(sameCommitBaseline.files, []);
  assert.equal(sameCommitBaseline.diff, "");
  assert.equal(readingBaselineHeadRef({}), "HEAD");
});

test("revision comparison never runs a repository-configured textconv command", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-revision-textconv-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const marker = path.join(root, "textconv-was-run.txt");
  const converter = path.join(root, "textconv.mjs");
  await run(root, "init", "-q"); await run(root, "config", "user.name", "RepoLens Test"); await run(root, "config", "user.email", "test@example.invalid");
  await writeFile(converter, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "called"); process.stdout.write("converted\\n");\n`);
  await writeFile(path.join(root, ".gitattributes"), "*.ts diff=repolens-audit\n");
  await run(root, "config", "diff.repolens-audit.textconv", `"${process.execPath}" "${converter}"`);
  await mkdir(path.join(root, "src")); await writeFile(path.join(root, "src/a.ts"), "export const value = 1;\\n");
  await run(root, "add", "."); await run(root, "commit", "-qm", "base");
  await writeFile(path.join(root, "src/a.ts"), "export const value = 2;\\n");
  const result = await compareRepositoryRevisions({ root, mode: "working-tree", revision: "index-r1" });
  await assert.rejects(access(marker), { code: "ENOENT" });
  assert.match(result.diff, /value = 2/);
});

test("revision comparison never runs a promisor remote for missing Git objects", async (context) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "repolens-revision-no-lazy-fetch-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const root = path.join(temporaryRoot, "repo");
  await mkdir(root);
  const marker = path.join(temporaryRoot, "uploadpack-was-run.txt");
  const uploadPack = path.join(temporaryRoot, "upload-pack.mjs");
  await run(root, "init", "-q");
  await run(root, "config", "user.name", "RepoLens Test");
  await run(root, "config", "user.email", "test@example.invalid");
  await writeFile(path.join(root, "source.ts"), "export const value = 1;\n");
  await run(root, "add", ".");
  await run(root, "commit", "-qm", "base");
  const blob = (await execFile("git", ["rev-parse", "HEAD:source.ts"], { cwd: root })).stdout.trim();
  await writeFile(path.join(root, "source.ts"), "export const value = 2;\n");
  await writeFile(uploadPack, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "called"); process.exit(1);\n`);
  await run(root, "config", "core.repositoryformatversion", "1");
  await run(root, "config", "extensions.partialClone", "origin");
  await run(root, "config", "remote.origin.promisor", "true");
  await run(root, "config", "remote.origin.url", root);
  await run(root, "config", "remote.origin.uploadpack", `"${process.execPath.replaceAll("\\", "/")}" "${uploadPack.replaceAll("\\", "/")}"`);
  await rm(path.join(root, ".git", "objects", blob.slice(0, 2), blob.slice(2)));

  await assert.rejects(compareRepositoryRevisions({ root, mode: "working-tree", revision: "missing-promisor-object" }), /不会自动获取/);
  await assert.rejects(access(marker), { code: "ENOENT" });
});

test("revision comparison rejects a missing tree without invoking its promisor remote", async (context) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "repolens-revision-no-lazy-tree-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const root = path.join(temporaryRoot, "repo");
  await mkdir(root);
  const marker = path.join(temporaryRoot, "uploadpack-was-run.txt");
  const uploadPack = path.join(temporaryRoot, "upload-pack.mjs");
  await run(root, "init", "-q");
  await run(root, "config", "user.name", "RepoLens Test");
  await run(root, "config", "user.email", "test@example.invalid");
  await writeFile(path.join(root, "source.ts"), "export const value = 1;\n");
  await run(root, "add", ".");
  await run(root, "commit", "-qm", "base");
  const tree = (await execFile("git", ["rev-parse", "HEAD^{tree}"], { cwd: root })).stdout.trim();
  await writeFile(uploadPack, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "called"); process.exit(1);\n`);
  await run(root, "config", "core.repositoryformatversion", "1");
  await run(root, "config", "extensions.partialClone", "origin");
  await run(root, "config", "remote.origin.promisor", "true");
  await run(root, "config", "remote.origin.url", root);
  await run(root, "config", "remote.origin.uploadpack", `"${process.execPath.replaceAll("\\", "/")}" "${uploadPack.replaceAll("\\", "/")}"`);
  await rm(path.join(root, ".git", "objects", tree.slice(0, 2), tree.slice(2)));

  await assert.rejects(compareRepositoryRevisions({ root, mode: "working-tree", revision: "missing-promisor-tree" }), /不会自动获取/);
  await assert.rejects(access(marker), { code: "ENOENT" });
});

async function createUnsafeGitHookRepository(context, hookName) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), `repolens-revision-${hookName}-`));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const root = path.join(temporaryRoot, "repo");
  await mkdir(root);
  const marker = path.join(temporaryRoot, "hook-ran.txt");
  const hook = path.join(temporaryRoot, "hook.mjs");
  await writeFile(hook, `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(marker)}, "called\\n"); process.stdin.pipe(process.stdout);\n`);
  await run(root, "init", "-q");
  await run(root, "config", "user.name", "RepoLens Test");
  await run(root, "config", "user.email", "test@example.invalid");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, ".gitattributes"), "*.ts filter=repolens-audit diff=repolens-audit\n");
  await writeFile(path.join(root, "src/a.ts"), "export const value = 1;\n");
  await run(root, "add", ".");
  await run(root, "commit", "-qm", "base");
  await writeFile(path.join(root, "src/a.ts"), "export const value = 2;\n");
  const command = `"${process.execPath}" "${hook}"`;
  if (hookName === "clean") await run(root, "config", "filter.repolens-audit.clean", command);
  if (hookName === "process") await run(root, "config", "filter.repolens-audit.process", command);
  if (hookName === "fsmonitor") await run(root, "config", "core.fsmonitor", command);
  if (hookName === "external-diff") await run(root, "config", "diff.external", command);
  if (hookName === "textconv") await run(root, "config", "diff.repolens-audit.textconv", command);
  return { root, marker };
}

for (const hookName of ["clean", "process", "fsmonitor", "external-diff", "textconv"]) {
  test(`revision comparison never invokes repository ${hookName} configuration`, async (context) => {
    const { root, marker } = await createUnsafeGitHookRepository(context, hookName);
    const result = await compareRepositoryRevisions({ root, mode: "working-tree", revision: "r1" });
    await assert.rejects(access(marker), { code: "ENOENT" });
    assert.equal(result.files.some((file) => file.path === "src/a.ts"), true);
    assert.match(result.diff, /value = 2/);
  });
}
