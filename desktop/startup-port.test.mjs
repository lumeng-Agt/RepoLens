import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

function createMockBackend() {
  const child = new EventEmitter();
  child.exitCode = null;
  return child;
}

function waitForBackendPort(child, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child?.off("message", onMessage);
      child?.off("exit", onExit);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`本地索引服务在就绪前退出（code: ${code}, signal: ${signal}）。`));
    };
    const onMessage = (message) => {
      if (message?.type !== "backend:ready") return;
      const port = Number(message.port);
      if (Number.isInteger(port) && port > 0 && port <= 65535) {
        cleanup();
        resolve(port);
      } else {
        cleanup();
        reject(new Error(`本地索引服务报告的端口无效：${message?.port}。`));
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("等待本地索引服务就绪超时。"));
    }, timeoutMs);
    child?.on("message", onMessage);
    child?.once("exit", onExit);
  });
}

test("waitForBackendPort resolves when valid backend:ready message is received", async () => {
  const child = createMockBackend();
  const promise = waitForBackendPort(child);
  child.emit("message", { type: "other" }); // ignored
  child.emit("message", { type: "backend:ready", port: 51234 });
  const port = await promise;
  assert.equal(port, 51234);
});

test("waitForBackendPort rejects when invalid port is reported", async () => {
  const child = createMockBackend();
  const promise = waitForBackendPort(child);
  child.emit("message", { type: "backend:ready", port: "not-a-number" });
  await assert.rejects(promise, /端口无效/);

  const child2 = createMockBackend();
  const promise2 = waitForBackendPort(child2);
  child2.emit("message", { type: "backend:ready", port: 99999 });
  await assert.rejects(promise2, /端口无效/);
});

test("waitForBackendPort rejects immediately when backend child exits before ready", async () => {
  const child = createMockBackend();
  const promise = waitForBackendPort(child);
  child.emit("exit", 1, null);
  await assert.rejects(promise, /在就绪前退出/);
});

test("waitForBackendPort rejects on timeout", async () => {
  const child = createMockBackend();
  const promise = waitForBackendPort(child, 50);
  await assert.rejects(promise, /超时/);
});
