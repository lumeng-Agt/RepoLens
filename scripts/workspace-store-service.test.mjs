import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkspaceStore } from "../data/workspace-store.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForService(url, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error("本地服务在就绪前退出。");
    try { if ((await fetch(`${url}/api/health`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("本地服务未在期限内就绪。");
}

test("real local service reports incomplete clear and succeeds after the owned copy can be removed", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-workspace-service-"));
  const userData = path.join(root, "user-data");
  const original = [{ id: "answer-1", title: "Saved answer", messages: [{ id: "message-1", content: "private content" }], updatedAt: 1 }];
  assert.equal((await createWorkspaceStore(userData).saveConversations("repo", original)).persisted, true);
  const blockedCopy = path.join(userData, "workspace-v1.json.cccccccc-cccc-4ccc-8ccc-cccccccccccc.tmp.failed");
  await mkdir(blockedCopy, { recursive: true });

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(projectRoot, "scripts/local-server.mjs")], {
    cwd: projectRoot,
    env: { ...process.env, REPOLENS_PORT: String(port), REPOLENS_UI_PORT: "5173", REPOLENS_USER_DATA_PATH: userData, REPOLENS_TEMP_ROOT: root },
    stdio: "ignore",
    windowsHide: true,
  });
  context.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
    }
    await rm(root, { recursive: true, force: true });
  });

  await waitForService(origin, child);
  const api = (url, init = {}) => fetch(`${origin}${url}`, { ...init, headers: { Origin: "http://127.0.0.1:5173", ...(init.headers ?? {}) } });
  const clear = () => api("/api/workspace", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "clear-all", repositoryId: "" }) });

  const firstResponse = await clear();
  const firstBody = await firstResponse.json();
  assert.equal(firstResponse.status, 200);
  assert.equal(firstBody.ok, false, "service must not report full success while an owned copy remains");
  assert.match(firstBody.warning, /无法安全清除|无法清理本地保存副本/);
  assert.ok((await readdir(userData)).includes(path.basename(blockedCopy)), "failed copy cleanup remains available for retry");
  const afterPartialClear = JSON.parse(await readFile(path.join(userData, "workspace-v1.json"), "utf8"));
  assert.doesNotMatch(JSON.stringify(afterPartialClear), /Saved answer|private content/);

  await rm(blockedCopy, { recursive: true, force: true });
  const retryResponse = await clear();
  assert.equal(retryResponse.status, 200);
  assert.deepEqual(await retryResponse.json(), { ok: true });
  assert.deepEqual(await readdir(userData), ["workspace-v1.json"]);
  const saved = JSON.parse(await readFile(path.join(userData, "workspace-v1.json"), "utf8"));
  assert.doesNotMatch(JSON.stringify(saved), /Saved answer|private content/);
});
