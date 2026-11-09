import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorkspaceStore } from "./workspace-store.mjs";

// Imported by the child before the real service so tests can pause the actual rename.
const gate = `
  import fs from 'node:fs/promises';
  import http from 'node:http';
  import { basename } from 'node:path';
  import { syncBuiltinESMExports } from 'node:module';
  const rename = fs.rename;
  const createServer = http.createServer;
  const setTimer = globalThis.setTimeout;
  let armed = false, connectionsClosed = false, release;
  fs.rename = async (from, to) => {
    if (armed && basename(to) === 'workspace-v1.json') {
      armed = false;
      const result = await new Promise(resolve => { release = resolve; process.send({ type: 'write-held' }); });
      if (result === 'fail') throw Object.assign(new Error('Controlled rename failure'), { code: 'EBUSY' });
    }
    return rename(from, to);
  };
  http.createServer = (...args) => {
    const server = createServer(...args);
    const closeConnections = server.closeAllConnections;
    server.closeAllConnections = () => { connectionsClosed = true; closeConnections.call(server); };
    return server;
  };
  syncBuiltinESMExports();
  process.on('message', ({type, result}) => {
    if (type === 'arm') { armed = true; process.send({ type: 'armed' }); }
    if (type === 'release') release(result);
    if (type === 'shutdown') {
      if (process.env.REPOLENS_TEST_SHORT_SHUTDOWN === '1') {
        globalThis.setTimeout = (callback, delay, ...args) => setTimer(callback, delay === 15000 ? 150 : delay, ...args);
      }
      setImmediate(() => process.send({ type: 'closing', connectionsClosed }));
    }
  });
`;

for (const outcome of ["saved", "fail", "timeout"]) {
  test(`shutdown reports ${outcome} for a workspace write paused at atomic replacement`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "repolens-shutdown-save-"));
    const child = fork(new URL("../scripts/local-server.mjs", import.meta.url), [], {
      execArgv: [`--import=data:text/javascript,${encodeURIComponent(gate)}`],
      env: { ...process.env, REPOLENS_PORT: "0", REPOLENS_USER_DATA_PATH: root, REPOLENS_TEST_SHORT_SHUTDOWN: outcome === "timeout" ? "1" : "0" },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    const exited = once(child, "exit");
    const waitForMessage = async type => {
      const signal = AbortSignal.timeout(10000);
      for (;;) {
        const [message] = await once(child, "message", { signal });
        if (message.type === type) return message;
      }
    };
    try {
      const { port } = await waitForMessage("backend:ready");
      const setPosition = async x => {
        const response = await fetch(`http://127.0.0.1:${port}/api/workspace`, {
          method: "POST", headers: { Origin: "http://127.0.0.1:5173", "Content-Type": "application/json" },
          body: JSON.stringify({ action: "node-positions", repositoryId: "taskflow-sample", positions: { "main.ts": { x, y: 10 } } }),
          signal: AbortSignal.timeout(10000),
        });
        assert.equal(response.status, 200);
        return response.json();
      };
      assert.equal((await setPosition(100)).ok, true);
      child.send({ type: "arm" });
      await waitForMessage("armed");
      const pending = setPosition(200).then(value => ({ value }), error => ({ error }));
      await waitForMessage("write-held");
      child.send({ type: "shutdown" });
      assert.equal((await waitForMessage("closing")).connectionsClosed, false);
      if (outcome !== "timeout") child.send({ type: "release", result: outcome });
      assert.deepEqual(await exited, [outcome === "saved" ? 0 : 1, null]);
      const write = await pending;
      if (outcome === "timeout") assert.ok(write.error);
      else assert.equal(write.value?.ok, outcome === "saved");
      const { nodePositions } = await createWorkspaceStore(root).getRepository("taskflow-sample");
      assert.deepEqual(nodePositions, { "main.ts": { x: outcome === "saved" ? 200 : 100, y: 10 } });
      if (outcome !== "timeout") assert.deepEqual(await readdir(root), ["workspace-v1.json"]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
      assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
      await rm(root, { recursive: true, force: true });
    }
  });
}
