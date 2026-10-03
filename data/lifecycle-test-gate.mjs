// Fault injection is loaded only by lifecycle tests, never by the application.
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

if (process.argv[1]?.endsWith("local-server.mjs")) {
  const remove = fs.rm;
  fs.rm = async (target, options) => {
    if (process.env.REPOLENS_TEST_CLEANUP_BLOCK && existsSync(process.env.REPOLENS_TEST_CLEANUP_BLOCK)
      && path.basename(String(target)).startsWith("repolens-github-")) {
      throw Object.assign(new Error("Controlled cleanup failure"), { code: "EBUSY" });
    }
    return remove(target, options);
  };
  const createServer = http.createServer;
  http.createServer = function (...args) {
    const server = createServer.apply(this, args);
    server.prependListener("request", (request, response) => {
      const id = request.headers["x-lifecycle-probe"];
      if (id) request.on("end", () => setImmediate(() => {
        process.send?.({ type: "request-state", id, ended: response.writableEnded });
      }));
    });
    return server;
  };
  if (process.env.REPOLENS_TEST_REFUSE_SHUTDOWN === "1") {
    const on = process.on;
    process.on = function (event, listener) {
      if (event === "message") return on.call(this, event, (message) => {
        if (message?.type !== "shutdown") listener(message);
      });
      return on.call(this, event, listener);
    };
  }
  syncBuiltinESMExports();
}
