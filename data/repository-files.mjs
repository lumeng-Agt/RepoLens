import fs from "node:fs";
import path from "node:path";

export const REPOSITORY_BLOCKED_DIRECTORIES = [".git", "node_modules", ".next", "dist", "build", "coverage", ".wrangler", ".vinext", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", "vendor"];
const blockedDirectories = new Set(REPOSITORY_BLOCKED_DIRECTORIES);

export function repositoryPathIsBlocked(relative) {
  return relative.split(/[\\/]/).some(part => blockedDirectories.has(part.toLowerCase()) || part.toLowerCase().startsWith(".env"));
}

function repositoryPathIsSensitive(relative) {
  return relative.split(/[\\/]/).some(part => part.toLowerCase() === ".git" || part.toLowerCase().startsWith(".env"));
}

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function sameIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino; }
function sameFile(left, right) {
  return sameIdentity(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
function abort(signal) { signal?.throwIfAborted(); }

/** Restrict repository reads to regular, unlinked files and verify the opened identity. */
export function createRepositoryFileAccess(inputRoot, { expectedIdentity } = {}) {
  const root = path.resolve(inputRoot);
  const canonicalPath = fs.realpathSync.native ?? fs.realpathSync;
  const rootIdentity = fs.lstatSync(root);
  if (expectedIdentity && !sameIdentity(expectedIdentity, rootIdentity)) throw new Error("仓库目录在打开期间发生变化，请重新选择文件夹。");
  if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink() || path.relative(root, canonicalPath(root))) throw new Error("请选择一个真实的仓库文件夹。");
  function failure(fileName, code) {
    const absolute = path.resolve(root, fileName);
    const name = contained(root, absolute) ? path.relative(root, absolute).split(path.sep).join("/") || "." : "仓库外路径";
    const detail = code === "REPOSITORY_FILE_BLOCKED" ? "已阻止访问仓库外、符号链接或禁止读取的路径。"
      : code === "REPOSITORY_FILE_CHANGED" ? "文件或目录在读取期间发生替换，请重新扫描。"
        : code === "REPOSITORY_FILE_TOO_LARGE" ? "文件超过读取大小限制。" : code === "ENOENT" || code === "ENOTDIR" ? "文件已不存在，请重新扫描。" : "无法安全读取文件。";
    return Object.assign(new Error(`${name}：${detail}`), { code });
  }
  function capture(fileName) {
    const absolute = path.resolve(root, fileName);
    // Index exclusions belong to the scanner. Explicit config reads may use an
    // in-root dependency preset, while sensitive paths remain universally blocked.
    if (!contained(root, absolute) || repositoryPathIsSensitive(path.relative(root, absolute))) throw failure(fileName, "REPOSITORY_FILE_BLOCKED");
    try {
      const rootNow = fs.lstatSync(root);
      if (!sameIdentity(rootIdentity, rootNow) || rootNow.isSymbolicLink()) throw failure(fileName, "REPOSITORY_FILE_CHANGED");
      const chain = [{ name: root, info: rootNow }];
      let current = root;
      for (const part of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        const info = fs.lstatSync(current);
        if (info.isSymbolicLink()) throw failure(fileName, "REPOSITORY_FILE_BLOCKED");
        chain.push({ name: current, info });
      }
      const realPath = canonicalPath(absolute);
      if (!contained(root, realPath)) throw failure(fileName, "REPOSITORY_FILE_BLOCKED");
      return { path: absolute, realPath, info: chain.at(-1).info, chain };
    } catch (error) {
      if (String(error.code).startsWith("REPOSITORY_")) throw error;
      throw failure(fileName, error.code);
    }
  }
  function validateOpened(snapshot, openedInfo) {
    if (!openedInfo.isFile() || !sameFile(snapshot.info, openedInfo)) throw failure(snapshot.path, "REPOSITORY_FILE_CHANGED");
  }
  function validateComplete(snapshot, openedInfo) {
    validateOpened(snapshot, openedInfo);
    const current = capture(snapshot.path);
    if (!sameFile(snapshot.info, current.info) || snapshot.chain.length !== current.chain.length || snapshot.chain.some((item, index) => !sameIdentity(item.info, current.chain[index].info))) throw failure(snapshot.path, "REPOSITORY_FILE_CHANGED");
  }
  function prepare(fileName, maximumBytes) {
    const snapshot = capture(fileName);
    checkSize(snapshot, maximumBytes);
    return snapshot;
  }
  function checkSize(snapshot, maximumBytes) {
    if (!snapshot.info.isFile()) throw failure(snapshot.path, "REPOSITORY_FILE_BLOCKED");
    if (snapshot.info.size > maximumBytes) throw failure(snapshot.path, "REPOSITORY_FILE_TOO_LARGE");
  }
  // O_NOFOLLOW is not available on Windows; descriptor identity is still checked before any bytes are read.
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
  function readFileSync(fileName, { maximumBytes = 1024 * 1024, encoding = "utf8" } = {}) {
    const snapshot = prepare(fileName, maximumBytes);
    let descriptor;
    try {
      descriptor = fs.openSync(snapshot.path, flags);
      validateOpened(snapshot, fs.fstatSync(descriptor));
      const chunks = []; let bytes = 0;
      while (bytes < snapshot.info.size) {
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, snapshot.info.size - bytes));
        const length = fs.readSync(descriptor, buffer, 0, buffer.length, null);
        if (!length) throw failure(fileName, "REPOSITORY_FILE_CHANGED");
        bytes += length;
        chunks.push(buffer.subarray(0, length));
      }
      validateComplete(snapshot, fs.fstatSync(descriptor));
      const content = Buffer.concat(chunks, bytes);
      return { content: encoding ? content.toString(encoding) : content, info: snapshot.info };
    } catch (error) {
      if (String(error.code).startsWith("REPOSITORY_")) throw error;
      throw failure(fileName, error.code === "ENOENT" || error.code === "ENOTDIR" ? "REPOSITORY_FILE_CHANGED" : error.code);
    } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  }
  async function consumeSnapshot(snapshot, { maximumBytes = 1024 * 1024, signal } = {}, onChunk = () => {}) {
    abort(signal);
    checkSize(snapshot, maximumBytes);
    let handle;
    try {
      handle = await fs.promises.open(snapshot.path, flags);
      validateOpened(snapshot, await handle.stat());
      let bytes = 0;
      while (bytes < snapshot.info.size) {
        abort(signal);
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, snapshot.info.size - bytes));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) throw failure(snapshot.path, "REPOSITORY_FILE_CHANGED");
        bytes += bytesRead;
        onChunk(buffer.subarray(0, bytesRead), snapshot.info);
      }
      abort(signal);
      validateComplete(snapshot, await handle.stat());
      return snapshot.info;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (String(error.code).startsWith("REPOSITORY_")) throw error;
      throw failure(snapshot.path, error.code === "ENOENT" || error.code === "ENOTDIR" ? "REPOSITORY_FILE_CHANGED" : error.code);
    } finally { await handle?.close(); }
  }
  function consume(fileName, options = {}, onChunk) {
    abort(options.signal);
    return consumeSnapshot(prepare(fileName, options.maximumBytes ?? 1024 * 1024), options, onChunk);
  }
  async function readSnapshot(snapshot, options = {}) {
    const chunks = [];
    const info = await consumeSnapshot(snapshot, options, chunk => chunks.push(chunk));
    const content = Buffer.concat(chunks);
    return { content: options.encoding === null ? content : content.toString(options.encoding ?? "utf8"), info };
  }
  async function readFile(fileName, options = {}) {
    abort(options.signal);
    return readSnapshot(prepare(fileName, options.maximumBytes ?? 1024 * 1024), options);
  }
  function inspectSync(fileName) {
    const snapshot = capture(fileName);
    // Callers can reuse this inspection, but cannot replace its private identity or path.
    Object.freeze(snapshot.info);
    return Object.freeze({ path: snapshot.path, realPath: snapshot.realPath, info: snapshot.info,
      readFile: options => readSnapshot(snapshot, options), consume: (options, onChunk) => consumeSnapshot(snapshot, options, onChunk) });
  }
  function entriesSync(directory) {
    const before = capture(directory);
    if (!before.info.isDirectory()) throw failure(directory, "REPOSITORY_FILE_BLOCKED");
    const entries = fs.readdirSync(before.path, { withFileTypes: true });
    const after = capture(directory);
    if (before.chain.some((item, index) => !sameIdentity(item.info, after.chain[index]?.info ?? {}))) throw failure(directory, "REPOSITORY_FILE_CHANGED");
    return entries.filter(entry => !entry.isSymbolicLink() && !repositoryPathIsBlocked(entry.name));
  }
  const isType = (fileName, type) => { try { return capture(fileName).info[type](); } catch { return false; } };
  return { root, inspectSync, readFileSync, readFile, consume, entriesSync,
    fileExistsSync: fileName => isType(fileName, "isFile"), directoryExistsSync: fileName => isType(fileName, "isDirectory") };
}
