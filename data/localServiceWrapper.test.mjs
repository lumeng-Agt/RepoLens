import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wrapper = path.join(root, "scripts/with-local-service.mjs");
async function waitForExit(child) {
  return Promise.race([new Promise((resolve) => child.once("exit", (code, signal) => resolve([code, signal]))), delay(6000).then(() => { throw new Error("Local service wrapper did not finish cleanup."); })]);
}
async function freePort() {
  const server = net.createServer(); server.listen(0, "127.0.0.1"); await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port;
}
async function assertPortClosed(port) {
  for (let i = 0; i < 20; i++) {
    try { await fetch(`http://127.0.0.1:${port}/api/health`); } catch { return; }
    await delay(50);
  }
  assert.fail(`The local service kept listening on ${port} after wrapper shutdown.`);
}

test("local preview wrapper returns child failures after stopping both services", async (context) => {
  const port = await freePort();
  const child = spawn(process.execPath, [wrapper, "-e", "setTimeout(() => process.exit(7), 300)"], { cwd: root, env: { ...process.env, REPOLENS_PORT: String(port) }, stdio: "ignore" });
  context.after(() => { if (child.exitCode === null) child.kill("SIGTERM"); });
  const [code] = await waitForExit(child);
  assert.equal(code, 7);
  await assertPortClosed(port);
});

test("local preview wrapper closes its local service when the UI exits", async (context) => {
  const port = await freePort();
  const child = spawn(process.execPath, [wrapper, "-e", "setTimeout(() => process.exit(0), 300)"], { cwd: root, env: { ...process.env, REPOLENS_PORT: String(port) }, stdio: "ignore" });
  context.after(() => { if (child.exitCode === null) child.kill("SIGTERM"); });
  const [code] = await waitForExit(child);
  assert.equal(code, 0);
  await assertPortClosed(port);
});
