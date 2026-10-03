import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import os from "node:os";
import path from "node:path";
import { cleanupGitHubRepository, cleanupPendingGitHubContent, parseGitHubRepositoryUrl, prepareGitHubRepository, readGitBlobs } from "./githubRepository.mjs";

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function deferredGitChild(output = "6f blob 2\nok\n") {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdin.resume();
  child.stdout = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; child.emit("killed"); return true; };
  child.finish = (code = 0) => { child.stdout.end(); child.emit("close", code, null); };
  queueMicrotask(() => child.stdout.write(output));
  return child;
}

test("temporary GitHub cleanup retries transient sharing errors a bounded number of times", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-cleanup-retry-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  let attempts = 0;
  const cleaned = await cleanupGitHubRepository({ storageRoot: root }, async (directory, options) => {
    attempts += 1;
    if (attempts < 3) { const error = new Error("test sharing violation"); error.code = "EBUSY"; throw error; }
    await rm(directory, options);
  });
  assert.equal(cleaned, true);
  assert.equal(attempts, 3);
  await assert.rejects(access(root));
});

test("failed temporary cleanup is logged and retried from the pending cleanup set", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-cleanup-pending-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const diagnostics = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => { diagnostics.push(String(chunk)); return true; };
  let cleaned;
  try {
    cleaned = await cleanupGitHubRepository({ storageRoot: root }, async () => {
      const error = new Error("test sharing violation"); error.code = "EBUSY"; throw error;
    });
  } finally { process.stderr.write = originalWrite; }
  assert.equal(cleaned, false);
  assert.match(diagnostics.join(""), new RegExp(path.basename(root)));
  assert.match(diagnostics.join(""), /EBUSY/);
  assert.equal(await cleanupPendingGitHubContent(), true);
  await assert.rejects(access(root));
});

test("Git blob reads wait for the child process to close before resolving", async () => {
  let child;
  let settled = false;
  const pending = readGitBlobs("unused", [{ oid: "6f", relative: "src/a.ts" }], undefined, 1024, () => (child = deferredGitChild()))
    .finally(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "reading stdout is not proof that git has released its repository handles");
  child.finish(0);
  assert.equal((await pending).get("src/a.ts").toString("utf8"), "ok");
  assert.equal(settled, true);
});

test("Git blob read failures kill and await the child before rejecting", async () => {
  let child;
  let settled = false;
  const pending = readGitBlobs("unused", [{ oid: "6f", relative: "src/a.ts" }], undefined, 1024, () => (child = deferredGitChild("bad header\n")))
    .catch((error) => error)
    .finally(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(child.killed, true, "a malformed response stops the git process");
  assert.equal(settled, false, "the caller waits for git to release the repository before cleanup");
  child.finish(1);
  assert.match((await pending).message, /格式无效/);
});

test("cancelling a Git blob read waits for the killed child and preserves AbortError", async () => {
  const controller = new AbortController();
  let child;
  let settled = false;
  const pending = readGitBlobs("unused", [{ oid: "6f", relative: "src/a.ts" }], controller.signal, 1024, () => (child = deferredGitChild("")))
    .catch((error) => error)
    .finally(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  assert.equal(child.killed, true);
  assert.equal(settled, false);
  child.finish(1);
  assert.equal((await pending).name, "AbortError");
});

test("cancelling after Git output ends but before the child closes still aborts and waits", async () => {
  const controller = new AbortController();
  let child;
  let settled = false;
  const pending = readGitBlobs("unused", [{ oid: "6f", relative: "src/a.ts" }], controller.signal, 1024, () => (child = deferredGitChild()))
    .catch((error) => error)
    .finally(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.end();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "the completed output stream still waits for the Git process to close");
  controller.abort();
  assert.equal(child.killed, true, "cancellation remains active until the child closes");
  assert.equal(settled, false, "cancellation does not let the caller race process cleanup");
  child.emit("close", 1, null);
  assert.equal((await pending).name, "AbortError", "cancelled output cannot be returned as a successful read");
});

test("Git blob read timeouts kill and await the child before rejecting", async () => {
  let child;
  let settled = false;
  const pending = readGitBlobs("unused", [{ oid: "6f", relative: "src/a.ts" }], undefined, 1024, () => (child = deferredGitChild("")), 1)
    .catch((error) => error)
    .finally(() => { settled = true; });
  await new Promise((resolve) => child.once("killed", resolve));
  assert.equal(settled, false, "timeout does not let directory cleanup race the child exit");
  child.finish(1);
  assert.match((await pending).message, /超时/);
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-github-test-"));
  const work = path.join(root, "work"); const bare = path.join(root, "remote.git");
  await mkdir(work); git(work, "init"); git(work, "config", "user.name", "RepoLens Test"); git(work, "config", "user.email", "test@example.invalid");
  await mkdir(path.join(work, "src"));
  await writeFile(path.join(work, "src", "main.ts"), 'import { value } from "./dep";\nexport const main = value;\n');
  await writeFile(path.join(work, "src", "dep.ts"), "export const value = 1;\n");
  await writeFile(path.join(work, ".gitignore"), "ignored/\n");
  await writeFile(path.join(work, "src", ".repolensignore"), "secret.ts\n");
  await writeFile(path.join(work, "src", "secret.ts"), "export const secret = true;\n");
  await writeFile(path.join(work, "package.json"), JSON.stringify({ scripts: { postinstall: "throw new Error('must not run')" } }));
  await mkdir(path.join(work, "ignored")); await writeFile(path.join(work, "ignored", "hidden.ts"), "export const hidden = true;\n");
  await writeFile(path.join(work, ".env.production"), "must not be copied");
  git(work, "add", "."); git(work, "commit", "-m", "initial"); git(work, "branch", "-M", "main");
  const initialCommit = git(work, "rev-parse", "HEAD"); git(work, "tag", "v1");
  git(work, "checkout", "-b", "feature/ui");
  await writeFile(path.join(work, "src", "dep.ts"), "export const value = 2;\n");
  git(work, "add", "src/dep.ts"); git(work, "commit", "-m", "feature update");
  const featureCommit = git(work, "rev-parse", "HEAD");
  git(root, "init", "--bare", bare);
  git(work, "remote", "add", "origin", bare); git(work, "push", "origin", "main", "feature/ui", "--tags");
  git(root, "--git-dir", bare, "symbolic-ref", "HEAD", "refs/heads/main");
  return { root, work, bare, initialCommit, featureCommit };
}

async function isolatedAppTempRoot(context) {
  const previous = process.env.REPOLENS_TEMP_ROOT;
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-github-app-test-"));
  process.env.REPOLENS_TEMP_ROOT = root;
  context.after(async () => {
    if (previous === undefined) delete process.env.REPOLENS_TEMP_ROOT;
    else process.env.REPOLENS_TEMP_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test("GitHub URL validation only accepts repository and tree links on the canonical HTTPS host", () => {
  const home = parseGitHubRepositoryUrl("https://github.com/acme/demo");
  assert.equal(home.cloneUrl, "https://github.com/acme/demo.git");
  assert.equal(home.requestedRefParts, null);
  assert.deepEqual(parseGitHubRepositoryUrl("https://github.com/acme/demo/tree/feature%2Fui/src/lib").requestedRefParts, ["feature", "ui", "src", "lib"]);
  for (const url of [
    "http://github.com/acme/demo", "https://github.com.evil.test/acme/demo", "https://user:secret@github.com/acme/demo",
    "https://github.com/acme/demo/blob/main/src/main.ts", "https://github.com/acme/demo/tree/main/%2e%2e/private",
    "https://github.com/acme/demo/tree/main/%2e%2e%2fprivate",
  ]) assert.throws(() => parseGitHubRepositoryUrl(url), /GitHub|路径|HTTPS|主机/);
  assert.equal(parseGitHubRepositoryUrl("C:\\repos\\demo"), null);
});

test("GitHub import creates its configured temporary parent on first use", async (context) => {
  const repo = await fixture();
  const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), "repolens-github-missing-temp-parent-"));
  const configuredRoot = path.join(isolatedRoot, "not-created-yet", "repolens");
  const previous = process.env.REPOLENS_TEMP_ROOT;
  process.env.REPOLENS_TEMP_ROOT = configuredRoot;
  context.after(async () => {
    if (previous === undefined) delete process.env.REPOLENS_TEMP_ROOT;
    else process.env.REPOLENS_TEMP_ROOT = previous;
    await cleanupPendingGitHubContent();
    await rm(repo.root, { recursive: true, force: true });
    await rm(isolatedRoot, { recursive: true, force: true });
  });

  const opened = await prepareGitHubRepository("https://github.com/acme/demo", null, { gitRemoteOverride: repo.bare });
  assert.equal(path.dirname(opened.storageRoot), configuredRoot);
  assert.equal(await readFile(path.join(opened.root, "src", "main.ts"), "utf8"), 'import { value } from "./dep";\nexport const main = value;\n');
  await cleanupGitHubRepository(opened);
});

test("GitHub source fetch resolves slash branches, tags, commits, ignores unsafe entries, refreshes latest, and cleans up", async (context) => {
  const appTempRoot = await isolatedAppTempRoot(context);
  const repo = await fixture();
  context.after(() => rm(repo.root, { recursive: true, force: true }));

  const branch = await prepareGitHubRepository("https://github.com/acme/demo/tree/feature/ui/src", null, { gitRemoteOverride: repo.bare });
  context.after(() => cleanupGitHubRepository(branch));
  assert.equal(branch.origin.resolvedRef, "refs/heads/feature/ui");
  assert.equal(branch.origin.commit, repo.featureCommit);
  assert.equal(branch.origin.subdirectory, "src");
  assert.equal(await readFile(path.join(branch.root, "src", "dep.ts"), "utf8"), "export const value = 2;\n");
  await assert.rejects(access(path.join(branch.root, "ignored", "hidden.ts")));
  await assert.rejects(access(path.join(branch.root, "src", "secret.ts")));
  await assert.rejects(access(path.join(branch.root, ".env.production")));
  assert.match(await readFile(path.join(branch.root, "package.json"), "utf8"), /postinstall/);
  assert.equal(await readFile(path.join(branch.root, "package.json"), "utf8").then((text) => text.includes("must not run")), true, "repository package scripts remain inert data");

  const homepage = await prepareGitHubRepository("https://github.com/acme/demo", null, { gitRemoteOverride: repo.bare });
  context.after(() => cleanupGitHubRepository(homepage));
  assert.equal(homepage.origin.resolvedRef, "refs/heads/main");
  assert.equal(homepage.origin.subdirectory, "");

  const tag = await prepareGitHubRepository("https://github.com/acme/demo/tree/v1/src", null, { gitRemoteOverride: repo.bare });
  context.after(() => cleanupGitHubRepository(tag));
  assert.equal(tag.origin.commit, repo.initialCommit);
  const fixedCommit = await prepareGitHubRepository(`https://github.com/acme/demo/tree/${repo.initialCommit}/src`, null, { gitRemoteOverride: repo.bare });
  context.after(() => cleanupGitHubRepository(fixedCommit));
  assert.equal(fixedCommit.origin.commit, repo.initialCommit);

  await writeFile(path.join(repo.work, "src", "dep.ts"), "export const value = 3;\n");
  git(repo.work, "add", "src/dep.ts"); git(repo.work, "commit", "-m", "remote update"); git(repo.work, "push", "origin", "feature/ui");
  const refreshed = await prepareGitHubRepository("https://github.com/acme/demo/tree/feature/ui/src", branch, { gitRemoteOverride: repo.bare });
  context.after(() => cleanupGitHubRepository({ ...refreshed, storageRoot: refreshed.checkoutRoot }));
  assert.notEqual(refreshed.origin.commit, branch.origin.commit);
  assert.equal(await readFile(path.join(refreshed.root, "src", "dep.ts"), "utf8"), "export const value = 3;\n");

  const temporaryRoot = branch.storageRoot;
  await cleanupGitHubRepository(branch);
  await assert.rejects(access(temporaryRoot));
  for (const workspace of [homepage, tag, fixedCommit, refreshed]) await cleanupGitHubRepository(workspace);
  assert.deepEqual(await readdir(appTempRoot), [], "all successful fetches remove their isolated application workspace");
});

test("GitHub materialization skips symlinks and submodule entries without checking out or running them", async (context) => {
  const appTempRoot = await isolatedAppTempRoot(context);
  const repo = await fixture();
  context.after(() => rm(repo.root, { recursive: true, force: true }));
  const blob = git(repo.work, "rev-parse", "HEAD:src/main.ts");
  git(repo.work, "update-index", "--add", "--cacheinfo", `120000,${blob},src/linked.ts`);
  git(repo.work, "update-index", "--add", "--cacheinfo", `160000,${repo.featureCommit},vendor/nested-module`);
  git(repo.work, "commit", "-m", "add unsafe entries"); git(repo.work, "push", "origin", "feature/ui");
  const fetched = await prepareGitHubRepository("https://github.com/acme/demo/tree/feature/ui", null, { gitRemoteOverride: repo.bare });
  context.after(() => cleanupGitHubRepository(fetched));
  await assert.rejects(access(path.join(fetched.root, "src", "linked.ts")));
  await assert.rejects(access(path.join(fetched.root, "vendor", "nested-module")));
  assert.equal(await cleanupGitHubRepository(fetched), true);
  assert.deepEqual(await readdir(appTempRoot), [], "successful materialization cleanup removes its isolated application workspace");
});

test("cancelled GitHub fetch removes its temporary workspace", async (context) => {
  const appTempRoot = await isolatedAppTempRoot(context);
  const repo = await fixture();
  try {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(prepareGitHubRepository("https://github.com/acme/demo", null, { signal: controller.signal, gitRemoteOverride: repo.bare }), { name: "AbortError" });
    assert.deepEqual(await readdir(appTempRoot), [], "an aborted open removes the mirror and checkout it created");
  } finally { await rm(repo.root, { recursive: true, force: true }); }
});

test("cancelling an active GitHub fetch waits for Git and removes its temporary workspace", async (context) => {
  const appTempRoot = await isolatedAppTempRoot(context);
  let aborted = false;
  const signal = {
    get aborted() { return aborted; },
    addEventListener(event, callback) { if (event === "abort") { aborted = true; callback(); } },
    removeEventListener() {},
  };
  await assert.rejects(prepareGitHubRepository("https://github.com/acme/demo", null, { signal, gitRemoteOverride: path.join(appTempRoot, "remote.git") }), { name: "AbortError" });
  assert.deepEqual(await readdir(appTempRoot), [], "an active Git cancellation waits for child exit before deleting the workspace");
});

test("a failed GitHub remote fetch removes its allocated mirror and checkout", async (context) => {
  const appTempRoot = await isolatedAppTempRoot(context);
  await assert.rejects(prepareGitHubRepository("https://github.com/acme/demo", null, { gitRemoteOverride: path.join(appTempRoot, "missing-remote.git") }), /获取失败|GitHub|git 仓库/i);
  assert.deepEqual(await readdir(appTempRoot), [], "failed remote access leaves no application workspace behind");
});

test("GitHub source limits reject oversized files and more than 5,000 nonignored sources", async (context) => {
  const applicationTempRoot = await isolatedAppTempRoot(context);
  const oversized = await fixture();
  context.after(() => rm(oversized.root, { recursive: true, force: true }));
  await writeFile(path.join(oversized.work, "src", "too-large.ts"), "x".repeat(1024 * 1024 + 1));
  git(oversized.work, "add", "src/too-large.ts"); git(oversized.work, "commit", "-m", "oversized source"); git(oversized.work, "push", "origin", "feature/ui");
  await assert.rejects(prepareGitHubRepository("https://github.com/acme/demo/tree/feature/ui", null, { gitRemoteOverride: oversized.bare }), /超过 1 MiB/);
  assert.deepEqual(await readdir(applicationTempRoot), [], "oversize rejection cleans the mirror after git exits");

  const many = await fixture();
  context.after(() => rm(many.root, { recursive: true, force: true }));
  const generated = path.join(many.work, "generated"); await mkdir(generated);
  for (let index = 0; index <= 5000; index += 1) await writeFile(path.join(generated, `file-${String(index).padStart(4, "0")}.ts`), "export const value = 1;\n");
  git(many.work, "add", "generated"); git(many.work, "commit", "-m", "large repository"); git(many.work, "push", "origin", "feature/ui");
  await assert.rejects(prepareGitHubRepository("https://github.com/acme/demo/tree/feature/ui", null, { gitRemoteOverride: many.bare }), /超过 5000 个源码文件/);
  assert.deepEqual(await readdir(applicationTempRoot), [], "file-count rejection cleans the mirror after git exits");
});
