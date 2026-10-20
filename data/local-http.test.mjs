import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { readJsonRequestBody, sendJson, validateLocalRequest } from "./local-http.mjs";

const allowedOrigins = new Set(["http://127.0.0.1:5173", "http://127.0.0.1:5000"]);

test("local HTTP policy accepts only loopback host and registered page origin", () => {
  const valid = validateLocalRequest({ host: "127.0.0.1:4318", origin: "http://127.0.0.1:5173", method: "POST", url: "/api/open", port: 4318, allowedOrigins });
  assert.deepEqual(valid, { allowed: true });
  assert.equal(validateLocalRequest({ host: "evil.test", origin: "http://127.0.0.1:5173", method: "GET", url: "/api/snapshot", port: 4318, allowedOrigins }).allowed, false);
  assert.equal(validateLocalRequest({ host: "localhost:4318", origin: "http://evil.test", method: "POST", url: "/api/open", port: 4318, allowedOrigins }).error, "只允许 RepoLens 本地页面访问。");
  assert.equal(validateLocalRequest({ host: "localhost:4318", method: "GET", url: "/api/health", port: 4318, allowedOrigins }).allowed, true);
  assert.equal(validateLocalRequest({ host: "localhost:4318", method: "GET", url: "/api/snapshot", port: 4318, allowedOrigins }).error, "本地页面来源校验失败。");
});

test("request JSON parser enforces its byte limit before parsing", async () => {
  const request = new EventEmitter();
  request[Symbol.asyncIterator] = async function* () { yield Buffer.from('{"ok":true}'); };
  assert.deepEqual(await readJsonRequestBody(request), { ok: true });
  const oversized = new EventEmitter();
  oversized[Symbol.asyncIterator] = async function* () { yield Buffer.alloc(6); };
  await assert.rejects(readJsonRequestBody(oversized, 5), /请求过大/);
});

test("JSON responses keep explicit no-store headers", () => {
  const response = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
  sendJson(response, 200, { ok: true });
  assert.equal(response.status, 200);
  assert.equal(response.headers["Cache-Control"], "no-store");
  assert.deepEqual(JSON.parse(response.body), { ok: true });
});
