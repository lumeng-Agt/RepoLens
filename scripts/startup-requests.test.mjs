import test from "node:test";
import assert from "node:assert/strict";
import { createStartupRequestMonitor } from "./startup-requests.mjs";

const request = (pathname, error = "net::ERR_ABORTED", origin = "http://127.0.0.1:4318") => ({
  url: () => origin + pathname, method: () => "GET", failure: () => ({ errorText: error }),
});
test("startup monitor retains explicit event-stream close as expected cancellation", () => {
  const monitor = createStartupRequestMonitor("http://127.0.0.1:4318");
  const stream = request("/api/events?repositoryId=a");
  monitor.started(stream); monitor.beginRepositoryClose(); monitor.failed(stream);
  assert.deepEqual(monitor.failures, [{url:stream.url(),error:"net::ERR_ABORTED",expectedCancellation:true}]);
});
test("startup monitor never excuses earlier failures, other resources or network faults", () => {
  const monitor = createStartupRequestMonitor("http://127.0.0.1:4318");
  const early = request("/api/events?repositoryId=a");
  monitor.started(early); monitor.failed(early);
  const source = request("/api/source"), resource = request("/entry.js"), fault = request("/api/events", "net::ERR_CONNECTION_REFUSED"), foreign = request("/api/events", undefined, "http://127.0.0.1:9999");
  for (const item of [source,resource,fault,foreign]) monitor.started(item);
  monitor.beginRepositoryClose();
  for (const item of [source,resource,fault,foreign]) monitor.failed(item);
  assert.ok(monitor.failures.every(item => item.expectedCancellation === false));
});
