import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (!args.length) throw new Error("需要指定界面启动命令。");
const logPath = process.env.REPOLENS_SERVER_LOG;
const logStream = logPath ? createWriteStream(logPath, { flags: "a" }) : null;
function forward(stream, target) {
  if (!stream) return;
  stream.on("data", (chunk) => {
    target.write(chunk);
    logStream?.write(chunk);
  });
}
const childStdio = logStream ? ["inherit", "pipe", "pipe"] : "inherit";
const serverStdio = logStream ? ["inherit", "pipe", "pipe", "ipc"] : ["inherit", "inherit", "inherit", "ipc"];
const server = spawn(process.execPath, [path.join(root, "scripts/local-server.mjs")], { cwd: root, stdio: serverStdio, env: process.env, windowsHide: true, detached: process.platform !== "win32" });
const ui = spawn(process.execPath, args, { cwd: root, stdio: childStdio, env: process.env, windowsHide: true, detached: process.platform !== "win32" });
const children = [server, ui];
process.send?.({ type: "children", pids: children.map(child => child.pid).filter(Boolean) });
if (logStream) {
  for (const child of children) {
    forward(child.stdout, process.stdout);
    forward(child.stderr, process.stderr);
  }
}
let stopping = false;
let exitCode = 0;
let remaining = children.length;
function killTree(child, force = false) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    killer.on("error", (error) => { process.stderr.write(`RepoLens: 无法结束子进程树（${error.message}）。\n`); exitCode = Math.max(exitCode, 1); });
    killer.on("exit", (code) => {
      if (code !== 0 && child.exitCode === null) {
        process.stderr.write(`RepoLens: taskkill 未能结束子进程树（${code ?? "unknown"}）。\n`);
        exitCode = Math.max(exitCode, 1);
      }
    });
  } else {
    try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); } catch { child.kill(force ? "SIGKILL" : "SIGTERM"); }
  }
}
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  exitCode = Math.max(exitCode, code);
  killTree(ui);
  if (server.exitCode !== null) return;
  if (!server.connected) {
    exitCode = Math.max(exitCode, 1);
    killTree(server, true);
    return;
  }
  server.send({ type: "shutdown" }, (error) => {
    if (!error || server.exitCode !== null) return;
    process.stderr.write(`RepoLens: 本地服务未接受正常关闭请求（${error.message}）。\n`);
    exitCode = Math.max(exitCode, 1);
    killTree(server, true);
  });
  const shutdownTimer = setTimeout(() => {
    if (server.exitCode !== null) return;
    process.stderr.write("RepoLens: 本地服务超过 20 秒未完成清理，正在强制结束进程树。\n");
    exitCode = Math.max(exitCode, 1);
    killTree(server, true);
  }, 20_000);
  shutdownTimer.unref?.();
  server.once("exit", () => clearTimeout(shutdownTimer));
}
process.on("SIGINT", () => stop(130));
process.on("SIGTERM", () => stop(143));
process.on("message", (message) => {
  if (message?.type !== "shutdown") return;
  stop(0);
  process.send?.({ type: "shutdownAccepted" });
});
for (const child of children) {
  child.on("error", () => stop(1));
  child.on("exit", (code) => {
    if (child === server && code !== 0) exitCode = Math.max(exitCode, code ?? 1);
    remaining -= 1;
    if (!stopping) stop(child === ui ? (code ?? 1) : 1);
    if (remaining === 0) {
      logStream?.end();
      if (process.connected) process.disconnect();
      process.exitCode = exitCode;
    }
  });
}
