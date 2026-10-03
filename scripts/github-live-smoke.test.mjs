import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { processAlive } from "./stop-local-service.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function runSmoke(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(projectRoot, "scripts", "github-live-smoke.mjs")], {
      cwd: projectRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

for (const scenario of ["http-close", "browser-close"]) test(`GitHub smoke keeps evidence and completes cleanup after ${scenario} failure`, { timeout: 180000 }, async () => {
  const testRoot = await mkdtemp(path.join(os.tmpdir(), "repolens-github-smoke-regression-"));
  const working = path.join(testRoot, "working");
  const remote = path.join(testRoot, "remote.git");
  await mkdir(working);
  await writeFile(path.join(working, "index.ts"), "export const value = 42;\n");
  git(working, "init");
  git(working, "config", "user.name", "RepoLens Test");
  git(working, "config", "user.email", "test@example.invalid");
  git(working, "add", ".");
  git(working, "commit", "-m", "smoke fixture");
  git(working, "branch", "-M", "main");
  git(testRoot, "init", "--bare", remote);
  git(working, "remote", "add", "origin", remote);
  git(working, "push", "origin", "main");
  git(testRoot, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");

  const cloneUrl = "https://github.com/repolens-smoke-test/cleanup-regression.git";
  const result = await runSmoke({
    ...process.env,
    REPOLENS_GITHUB_SMOKE_URL: cloneUrl,
    REPOLENS_GITHUB_SMOKE_TEST_CLOSE_FAILURE: scenario === "http-close" ? "1" : "0",
    REPOLENS_GITHUB_SMOKE_TEST_BROWSER_CLOSE_FAILURE: scenario === "browser-close" ? "1" : "0",
    REPOLENS_TEMP_ROOT: path.join(testRoot, "service-content"),
    VINEXT_NO_DEV_LOCK: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.${pathToFileURL(remote).href}.insteadOf`,
    GIT_CONFIG_VALUE_0: cloneUrl,
  });

  assert.notEqual(result.code, 0, `an injected close failure must fail the smoke check: ${result.stdout}`);
  assert.equal(result.signal, null);
  const evidenceMatch = result.stderr.match(/GitHub 烟测失败，证据保存在：(.+)/);
  assert.ok(evidenceMatch, `failure evidence path should be reported: ${result.stderr}`);
  const evidenceDirectory = evidenceMatch[1].trim();
  let validated = false;
  try {
    const diagnostics = JSON.parse(await readFile(path.join(evidenceDirectory, "diagnostics.json"), "utf8"));
    if (scenario === "http-close") {
      assert.ok(diagnostics.apiResponses.some((item) => item.url.endsWith("/api/close") && item.status === 500), `diagnostics must include the injected close failure: ${JSON.stringify(diagnostics)}`);
      assert.match(diagnostics.error, /returning to the sample must wait for successful remote cleanup/);
      assert.deepEqual(diagnostics.cleanupErrors, [], "fallback cleanup must introduce no additional failure");
      assert.equal(diagnostics.fallbackCloseStatus, 200);
    } else {
      assert.equal(diagnostics.error, null);
      assert.equal(diagnostics.cleanupErrors.length, 1);
      assert.match(diagnostics.cleanupErrors[0], /Injected browser close failure/);
    }
    assert.equal(diagnostics.repositoryClosed, true);
    assert.deepEqual(diagnostics.shutdownResult, { code: 0, signal: null, remainingPids: [] });
    assert.equal(diagnostics.childPids.length, 2);
    assert.ok(diagnostics.childPids.every(pid => !processAlive(pid)), "service and UI children must have exited");
    assert.ok(diagnostics.serviceOutput.length > 0, "service logs must be preserved");
    assert.ok((await stat(path.join(evidenceDirectory, "last-page.png"))).size > 0, "the last page screenshot must be preserved");
    assert.ok((await stat(path.join(evidenceDirectory, "trace.zip"))).size > 0, "the browser trace must be preserved");
    const contentDirectory = path.join(evidenceDirectory, "content");
    const contentExists = await access(contentDirectory).then(() => true, () => false);
    if (contentExists) assert.deepEqual(await readdir(contentDirectory), [], "the smoke fallback should still clean the remote checkout");
    validated = true;
  } finally {
    const absoluteEvidence = path.resolve(evidenceDirectory);
    assert.ok(absoluteEvidence.startsWith(path.resolve(os.tmpdir()) + path.sep), "only the smoke evidence directory may be removed");
    if (validated) await rm(absoluteEvidence, { recursive: true, force: true });
    else process.stderr.write(`Smoke regression evidence retained: ${absoluteEvidence}\n`);
    await rm(testRoot, { recursive: true, force: true });
  }
});
