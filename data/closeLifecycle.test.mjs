import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
async function waitFile(file) {
  if (await access(file).then(() => true, () => false)) return;
  await new Promise((resolve, reject) => {
    const watcher = watch(path.dirname(file), check);
    const timer = setTimeout(() => finish(new Error("gate did not open")), 10000);
    function finish(error) { clearTimeout(timer); watcher.close(); if (error) reject(error); else resolve(); }
    function check() { void access(file).then(() => finish(), () => {}); }
    check();
  });
}
async function fixture(context, { wrapper = false, refuse = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-close-lifecycle-"));
  const working = path.join(root, "working"), remote = path.join(root, "remote.git"), local = path.join(root, "local");
  await mkdir(working); await mkdir(local);
  await writeFile(path.join(working, "index.ts"), "export const value = 1;\n");
  await writeFile(path.join(local, "local.ts"), "export const local = true;\n");
  const git = (cwd, ...args) => { const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true }); assert.equal(r.status, 0, r.stderr); };
  git(working, "init"); git(working, "config", "user.name", "Test"); git(working, "config", "user.email", "test@example.invalid");
  git(working, "add", "."); git(working, "commit", "-m", "fixture"); git(working, "branch", "-M", "main");
  git(root, "init", "--bare", remote); git(working, "remote", "add", "origin", remote); git(working, "push", "origin", "main");
  git(root, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");
  const listener = net.createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const port = listener.address().port; await new Promise(r => listener.close(r));
  const arm = path.join(root, "arm"), entered = path.join(root, "entered"), release = path.join(root, "release"), block = path.join(root, "block");
  const url = "https://github.com/repolens-test/close-lifecycle.git";
  const child = spawn(process.execPath, wrapper ? ["scripts/with-local-service.mjs", "-e", "process.stdin.once('data',()=>process.exit(0));setInterval(()=>{},1000)"] : ["scripts/local-server.mjs"], {
    cwd: project, windowsHide: true, stdio: ["pipe", "pipe", "pipe", "ipc"],
    env: { ...process.env, REPOLENS_PORT: String(port), REPOLENS_TEMP_ROOT: root,
      REPOLENS_TEST_GIT_CLOSE_ARM: arm, REPOLENS_TEST_GIT_CLOSE_ENTERED: entered, REPOLENS_TEST_GIT_CLOSE_RELEASE: release,
      REPOLENS_TEST_CLEANUP_BLOCK: block, REPOLENS_TEST_REFUSE_SHUTDOWN: refuse ? "1" : "0",
      NODE_OPTIONS: ["github-git-close-gate.mjs", "lifecycle-test-gate.mjs"].map(f => `--import=${pathToFileURL(path.join(project, "data", f)).href}`).join(" "),
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${pathToFileURL(remote).href}.insteadOf`, GIT_CONFIG_VALUE_0: url },
  });
  let output = ""; child.stdout.on("data", x => { output += x; }); child.stderr.on("data", x => { output += x; });
  const exited = once(child, "exit");
  const api = async (route, body, probe) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: body ? "POST" : "GET", signal: AbortSignal.timeout(10000),
      headers: { Origin: "http://127.0.0.1:5173", "Content-Type": "application/json", ...(probe ? { "x-lifecycle-probe": probe } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, value: await response.json() };
  };
  const message = id => new Promise(resolve => { const fn = value => { if (value.id === id) { child.off("message", fn); resolve(value); } }; child.on("message", fn); });
  context.after(async () => {
    await writeFile(release, "release"); await rm(block, { force: true });
    if (child.exitCode === null && child.signalCode === null) {
      if (child.connected) child.send({ type: "shutdown" });
      let timer; await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 22000); })]); clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) { spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" }); await exited; }
    }
    assert.ok(root.startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(root, { recursive: true, force: true });
  });
  for (let i = 0; i < 100; i++) { try { await api("/api/health"); break; } catch { await new Promise(r => setTimeout(r, 30)); } }
  return { root, local, url, api, child, exited, message, output: () => output,
    command: (n, clientId = "test") => ({ clientId, intentSequence: n }),
    directories: async () => (await readdir(root)).filter(n => n.startsWith("repolens-github-")),
    arm: async () => { await Promise.all([arm, entered, release].map(f => rm(f, { force: true }))); await writeFile(arm, "arm"); },
    entered: () => waitFile(entered), release: () => writeFile(release, "release"),
    block: () => writeFile(block, "block"), unblock: () => rm(block, { force: true }) };
}

test("duplicate close waits for the first cleanup and cannot affect a newer client session", async context => {
  const f = await fixture(context);
  const open = await f.api("/api/open", { path: f.url, command: f.command(1) }); assert.equal(open.status, 200);
  await f.arm(); const rescan = f.api("/api/rescan", { repositoryId: open.value.id }); await f.entered();
  const firstState = f.message("first"); const first = f.api("/api/close", { command: f.command(2) }, "first");
  assert.equal((await firstState).ended, false);
  const duplicateState = f.message("duplicate"); const duplicate = f.api("/api/close", { command: f.command(2) }, "duplicate");
  const state = await duplicateState;
  const sameClient = await f.api("/api/open", { path: f.local, command: f.command(3) });
  assert.equal(sameClient.status, 200, "a newer open can commit while old cleanup waits");
  await f.release();
  assert.equal(state.ended, false, "a duplicate must not acknowledge unfinished cleanup");
  assert.deepEqual(await first, await duplicate); await rescan;
  assert.equal((await f.api(`/api/snapshot?repositoryId=${sameClient.value.id}`)).status, 200);
  assert.deepEqual(await f.directories(), []);
  const newer = await f.api("/api/open", { path: f.local, command: f.command(1, "other") });
  assert.equal(newer.status, 200);
  assert.equal((await f.api("/api/close", { command: f.command(4) })).status, 200);
  assert.equal((await f.api(`/api/snapshot?repositoryId=${newer.value.id}`)).status, 200);
});

test("closing a pending open waits until its owned workspace is removed", async context => {
  const f = await fixture(context); await f.arm();
  const opening = f.api("/api/open", { path: f.url, command: f.command(1) }); await f.entered();
  const handled = f.message("close-open"); const closing = f.api("/api/close", { command: f.command(2) }, "close-open");
  const state = await handled;
  assert.equal((await f.directories()).length, 1);
  await f.release(); await opening; await closing;
  assert.equal(state.ended, false, "close must wait for pending open cancellation and cleanup");
  assert.deepEqual(await f.directories(), []);
});

test("failed cleanup stays failed for duplicate commands and a new close retries owned resources", async context => {
  const f = await fixture(context);
  assert.equal((await f.api("/api/open", { path: f.url, command: f.command(1) })).status, 200);
  await f.block(); const first = await f.api("/api/close", { command: f.command(2) }); assert.equal(first.status, 500);
  assert.deepEqual(await f.api("/api/close", { command: f.command(2) }), first);
  assert.equal((await f.api("/api/close", { command: f.command(3) })).status, 500);
  assert.equal((await f.directories()).length, 1);
  await f.unblock(); assert.equal((await f.api("/api/close", { command: f.command(4) })).status, 200);
  assert.deepEqual(await f.directories(), []);
});

test("wrapper propagates backend cleanup failure and retains diagnostic resources", async context => {
  const f = await fixture(context, { wrapper: true });
  assert.equal((await f.api("/api/open", { path: f.url, command: f.command(1) })).status, 200);
  await f.block(); f.child.stdin.write("exit");
  const [code] = await f.exited; assert.notEqual(code, 0); assert.match(f.output(), /清理失败/);
  assert.equal((await f.directories()).length, 1);
});

test("wrapper reports failure after the backend refuses its bounded shutdown", { timeout: 30000 }, async context => {
  const f = await fixture(context, { wrapper: true, refuse: true });
  f.child.stdin.write("exit"); const [code] = await f.exited;
  assert.notEqual(code, 0); assert.match(f.output(), /超过 20 秒/);
  await assert.rejects(f.api("/api/health"));
});
