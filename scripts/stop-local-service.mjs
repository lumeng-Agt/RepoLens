import { spawn } from "node:child_process";
import { once } from "node:events";

export async function bounded(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}超时（${milliseconds}ms）。`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
export function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}
export async function stopLocalService(child, childPids = []) {
  let result = { code: child.exitCode, signal: child.signalCode };
  if (result.code === null && result.signal === null) {
    const exited = once(child, "exit").then(([code, signal]) => ({ code, signal }));
    try {
      if (!child.connected) throw new Error("启动器 IPC 通道未连接，无法正常关闭。");
      await new Promise((resolve, reject) => child.send({ type: "shutdown" }, error => error ? reject(error) : resolve()));
      result = await bounded(exited, 20000, "等待本地服务清理");
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) {
        if (process.platform === "win32") {
          const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
          const [code] = await bounded(once(killer, "exit"), 5000, "强制结束进程树");
          if (code !== 0 && processAlive(child.pid)) throw new Error(`强制结束进程树失败（${code}）。`, { cause: error });
        } else {
          try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }
        await bounded(exited, 5000, "等待强制退出");
      }
      throw error;
    }
  }
  const remainingPids = [child.pid, ...childPids].filter(pid => pid && processAlive(pid));
  if (result.code !== 0 || result.signal || remainingPids.length) {
    throw new Error(`本地服务收尾失败：退出 ${result.code ?? result.signal}，残留进程 ${remainingPids.join(",") || "无"}。`);
  }
  return { ...result, remainingPids };
}
