import { readFile, writeFile, rename, rm, lstat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";

export async function readEditorPreference(userDataDir, { readFileFn = readFile } = {}) {
  const filePath = path.join(userDataDir, "editor-v1.json");
  try {
    const raw = await readFileFn(filePath, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { status: "corrupted", executable: null, error: "偏好文件不是有效的 JSON 格式。" };
    }
    if (!parsed || typeof parsed !== "object" || parsed.version !== 1 || typeof parsed.executable !== "string" || !parsed.executable.trim()) {
      return { status: "corrupted", executable: null, error: "偏好文件格式无效。" };
    }
    return { status: "configured", executable: parsed.executable };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { status: "unconfigured", executable: null };
    }
    return { status: "unreadable", executable: null, error: error?.message || "无法读取偏好文件。" };
  }
}

export async function validateCodeExecutable(value, { lstatFn = lstat } = {}) {
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, reason: "请选择 VS Code 的 Code.exe 程序。" };
  }
  if (!path.isAbsolute(value)) {
    return { ok: false, reason: "程序路径必须为绝对路径。" };
  }
  const baseName = path.basename(value);
  if (baseName.toLowerCase() !== "code.exe") {
    return { ok: false, reason: `仅支持 VS Code（Code.exe），已选择 ${baseName}。` };
  }
  try {
    const info = await lstatFn(value);
    if (info.isSymbolicLink()) {
      return { ok: false, reason: "不支持符号链接，请选择实际的 Code.exe 程序。" };
    }
    if (!info.isFile()) {
      return { ok: false, reason: "指定的路径不是文件。" };
    }
    return { ok: true, executable: value };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { ok: false, reason: "指定的 Code.exe 文件不存在。" };
    }
    return { ok: false, reason: `无法检查指定程序：${error?.message || "未知错误"}` };
  }
}

export async function saveEditorPreference(userDataDir, executable, { writeFileFn = writeFile, renameFn = rename, rmFn = rm } = {}) {
  const filePath = path.join(userDataDir, "editor-v1.json");
  const temporary = path.join(userDataDir, `editor-v1.json.${randomUUID()}.tmp`);
  try {
    const content = JSON.stringify({ version: 1, executable });
    await writeFileFn(temporary, content, { encoding: "utf8", mode: 0o600 });
    await renameFn(temporary, filePath);
  } finally {
    try {
      await rmFn(temporary, { force: true });
    } catch {}
  }
}

export async function findDefaultCodeExecutable({ env = process.env, lstatFn = lstat } = {}) {
  const candidates = [
    path.join(env.LOCALAPPDATA ?? "", "Programs", "Microsoft VS Code", "Code.exe"),
    path.join(env.ProgramFiles ?? "", "Microsoft VS Code", "Code.exe"),
    path.join(env["ProgramFiles(x86)"] ?? "", "Microsoft VS Code", "Code.exe"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const result = await validateCodeExecutable(candidate, { lstatFn });
    if (result.ok) {
      return candidate;
    }
  }
  return null;
}

export function launchCodeEditor(executable, target, { spawnFn = spawn, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const targetArg = `${target.path}:${target.line}:1`;
    const child = spawnFn(executable, ["--reuse-window", "--goto", targetArg], {
      shell: false,
      windowsHide: false,
      detached: true,
      stdio: "ignore",
      cwd,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve({ pid: child.pid, targetArg });
    });
  });
}
