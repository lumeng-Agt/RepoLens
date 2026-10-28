// Deterministic fault injection for local-server AI lifecycle tests only.
import fs from "node:fs/promises";
import http from "node:http";
import { existsSync, realpathSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

const gateDirectory = process.env.REPOLENS_TEST_AI_GATE_DIR;

if (gateDirectory && process.argv[1]?.endsWith("local-server.mjs")) {
  writeFileSync(path.join(gateDirectory, "gate-loaded"), "ready\n");
  const mark = (kind, id) => {
    if (id && /^[a-z0-9-]+$/i.test(id)) writeFileSync(path.join(gateDirectory, `${kind}-${id}`), "ready\n");
  };
  const physicalPath = file => {
    const absolute = path.resolve(String(file));
    try { return (realpathSync.native ?? realpathSync)(absolute); } catch { return absolute; }
  };
  const gatedRead = async (file, operation) => {
    const id = process.env.REPOLENS_TEST_AI_READ_ID;
    const target = process.env.REPOLENS_TEST_AI_TARGET;
    const prefix = process.env.REPOLENS_TEST_AI_PREFIX;
    const suffix = process.env.REPOLENS_TEST_AI_SUFFIX;
    const absoluteFile = physicalPath(file);
    const isExactTarget = target && !path.relative(physicalPath(target), absoluteFile);
    const relativeToPrefix = prefix ? path.relative(physicalPath(prefix), absoluteFile) : "";
    const isUnderPrefix = prefix && relativeToPrefix && relativeToPrefix !== ".." && !relativeToPrefix.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeToPrefix);
    const matchesPrefixTarget = isUnderPrefix && suffix && absoluteFile.toLowerCase().endsWith(suffix.toLowerCase());
    const arm = path.join(gateDirectory, "read-arm");
    const release = path.join(gateDirectory, "read-release");
    const shouldHold = id && (isExactTarget || matchesPrefixTarget) && existsSync(arm);
    if (shouldHold) {
      unlinkSync(arm);
      mark("read-entered", id);
      await new Promise((resolve, reject) => {
        let watcher;
        const finish = () => {
          if (!existsSync(release)) return;
          if (!watcher) return resolve();
          watcher.once("close", resolve);
          watcher.close();
        };
        watcher = watch(gateDirectory, { persistent: false }, finish);
        watcher.once("error", reject);
        finish();
      });
    }
    const value = await operation();
    if (shouldHold) mark("read-finished", id);
    return value;
  };
  const originalReadFile = fs.readFile;
  fs.readFile = function gatedReadFile(file, ...args) { return gatedRead(file, () => originalReadFile.call(this, file, ...args)); };
  const originalOpen = fs.open;
  fs.open = async function gatedOpen(file, ...args) {
    const handle = await originalOpen.call(this, file, ...args);
    const originalRead = handle.read.bind(handle);
    handle.read = (...readArgs) => gatedRead(file, () => originalRead(...readArgs));
    return handle;
  };

  const originalCreateServer = http.createServer;
  http.createServer = function testLifecycleServer(listener, ...args) {
    return originalCreateServer.call(this, (request, response) => {
      const id = request.headers["x-repolens-test-id"];
      if (id) {
        request.once("end", () => setImmediate(() => mark("request-body", id)));
        response.once("close", () => { if (!response.writableEnded) mark("response-closed", id); });
      }
      const result = listener(request, response);
      if (id) Promise.resolve(result).then(() => mark("request-handled", id), () => mark("request-handled", id));
      return result;
    }, ...args);
  };
  syncBuiltinESMExports();
}
