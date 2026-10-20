import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

const execFile = promisify(execFileCallback);
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_CHANGED_FILES = 500;
const MAX_CHANGED_CONTENT_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES = MAX_DIFF_BYTES + 64_000;
let noLazyFetchSupported;

function cleanGitEnvironment(extra = {}) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  return {
    ...inherited,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    ...extra,
    // Revision comparison reads only local objects and must never start a transport.
    GIT_ALLOW_PROTOCOL: "",
  };
}

function safeGitArgs(args) {
  // `ls-files` can consult a configured fsmonitor helper. Comparison never needs
  // the helper, the untracked cache, or an external diff command.
  return ["--no-lazy-fetch", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "diff.external=", ...args];
}

function missingObjectError() {
  return new Error("本地缺少版本比较所需的 Git 对象；为保护仓库，RepoLens 不会自动获取。请手动获取所需提交后重试。");
}

function isMissingObjectFailure(message) {
  return /promisor remote|could not fetch|missing object|unable to read (?:tree|object)|bad object|not a tree object|object .* not found/i.test(message);
}

async function ensureNoLazyFetchSupport() {
  noLazyFetchSupported ??= execFile("git", ["--no-lazy-fetch", "--version"], {
    windowsHide: true,
    timeout: 3_000,
    encoding: "utf8",
    env: cleanGitEnvironment(),
  }).then(() => true, () => false);
  if (!await noLazyFetchSupported) throw new Error("当前 Git 版本不支持安全的本地对象比较。请更新 Git；仓库源码阅读仍可继续。");
}

async function git(root, args, options = {}) {
  try {
    return await execFile("git", safeGitArgs(args), {
      cwd: root,
      windowsHide: true,
      timeout: options.timeoutMs ?? 8_000,
      maxBuffer: options.maxBuffer ?? MAX_OUTPUT_BYTES,
      encoding: options.encoding ?? "utf8",
      signal: options.signal,
      env: cleanGitEnvironment(options.env),
    });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    if (error.code === "ENOENT") throw new Error("未找到 Git。安装 Git 后才能比较提交；仓库源码阅读仍可继续。");
    if (error.killed || error.signal === "SIGTERM") throw new Error("版本比较已超时或取消。");
    throw new Error(`Git 版本比较失败：${String(error.stderr || error.message).trim().slice(0, 500)}`);
  }
}

function runGit(root, args, { input, signal, timeoutMs = 8_000, maxOutputBytes = MAX_OUTPUT_BYTES, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("版本比较已取消。"), { name: "AbortError" }));
      return;
    }
    const child = spawn("git", safeGitArgs(args), {
      cwd: root,
      windowsHide: true,
      env: cleanGitEnvironment(env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    let timedOut = false;
    let outputOverflow = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const kill = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    };
    const onAbort = () => kill();
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) { outputOverflow = true; kill(); return; }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (error.code === "ENOENT") finish(new Error("未找到 Git。安装 Git 后才能比较提交；仓库源码阅读仍可继续."));
      else finish(error);
    });
    child.on("close", (code) => {
      if (signal?.aborted) { finish(Object.assign(new Error("版本比较已取消。"), { name: "AbortError" })); return; }
      if (timedOut) { finish(new Error("版本比较已超时。")); return; }
      if (outputOverflow) { finish(new Error("差异内容超过查看上限；请缩小提交范围。")); return; }
      if (code !== 0) { finish(new Error(`Git 版本比较失败：${Buffer.concat(stderr).toString("utf8").trim().slice(0, 500)}`)); return; }
      finish(null, Buffer.concat(stdout));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

function validateRef(ref, label) {
  if (typeof ref !== "string" || !ref.trim() || ref.length > 200 || ref.startsWith("-") || /[\0\r\n]/.test(ref)) throw new Error(`${label}提交标识无效。`);
  return ref.trim();
}

async function resolveCommit(root, ref, label, signal) {
  const value = validateRef(ref, label);
  const { stdout } = await git(root, ["rev-parse", "--verify", "--end-of-options", `${value}^{commit}`], { signal });
  const commit = stdout.trim();
  if (!/^[a-f0-9]{40,64}$/i.test(commit)) throw new Error(`${label}没有解析为提交对象。`);
  return commit;
}

function parseNameStatus(output) {
  const fields = output.split("\0");
  const files = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) continue;
    const first = fields[index++] ?? "";
    if (status.startsWith("R") || status.startsWith("C")) {
      const second = fields[index++] ?? first;
      files.push({ status: "renamed", oldPath: first, path: second });
    } else files.push({ status: status === "A" ? "added" : status === "D" ? "deleted" : "modified", path: first });
  }
  return files;
}

function parseTree(output) {
  const result = new Map();
  for (const record of output.toString("utf8").split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, oid] = record.slice(0, tab).split(" ");
    const filePath = record.slice(tab + 1);
    if (type === "blob" && (mode === "100644" || mode === "100755")) result.set(filePath, { mode, oid });
  }
  return result;
}

async function readCommitTree(root, commit, signal) {
  try {
    const { stdout } = await git(root, ["ls-tree", "-r", "-z", "--full-tree", commit], { signal, maxBuffer: 128 * 1024 * 1024 });
    return parseTree(Buffer.from(stdout, "utf8"));
  } catch (error) {
    if (isMissingObjectFailure(String(error?.message ?? error))) throw missingObjectError();
    throw error;
  }
}

async function readCommitBlobs(root, records, signal) {
  const unique = [...new Set(records.map((record) => record.oid))];
  if (!unique.length) return new Map();
  const output = await runGit(root, ["cat-file", "--batch"], { input: `${unique.join("\n")}\n`, signal, maxOutputBytes: MAX_CHANGED_CONTENT_BYTES + unique.length * 128 });
  const blobs = new Map();
  let offset = 0;
  while (offset < output.length) {
    const headerEnd = output.indexOf(10, offset);
    if (headerEnd < 0) throw new Error("Git 对象响应不完整，无法比较。");
    const header = output.subarray(offset, headerEnd).toString("ascii").split(" ");
    const [oid, type, sizeText] = header;
    if (type === "missing" || !type) throw missingObjectError();
    const size = Number(sizeText);
    if (type !== "blob" || !Number.isSafeInteger(size) || size < 0 || size > 1024 * 1024) throw new Error("比较中包含无效或超过 1 MiB 的文件对象。");
    const start = headerEnd + 1;
    const end = start + size;
    if (end >= output.length || output[end] !== 10) throw new Error("Git 对象内容不完整，无法比较。");
    blobs.set(oid, output.subarray(start, end));
    offset = end + 1;
  }
  return blobs;
}

function blobOid(buffer) {
  return createHash("sha1").update(`blob ${buffer.length}\0`).update(buffer).digest("hex");
}

function validateRelativePath(value) {
  if (typeof value !== "string" || !value || value.startsWith("/") || /^[A-Za-z]:/.test(value) || /[\0\r\n]/.test(value) || value.split(/[\\/]/).some((part) => part === ".." || part === ".")) {
    throw new Error("仓库文件路径无效，已停止版本比较。");
  }
  return value.replaceAll("\\", "/");
}

async function readRawWorkingFiles(root, baseFiles, signal) {
  const rootReal = await realpath(root);
  const { stdout } = await git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { signal, maxBuffer: 128 * 1024 * 1024 });
  const paths = [...new Set(stdout.split("\0").filter(Boolean).map(validateRelativePath))];
  if (paths.length > 5_000) throw new Error(`版本比较候选文件共 ${paths.length} 个，超过 5,000 个限制。`);
  const files = new Map();
  let changedContentBytes = 0;
  for (const relativePath of paths) {
    if (signal?.aborted) throw Object.assign(new Error("版本比较已取消。"), { name: "AbortError" });
    const absolute = path.resolve(rootReal, ...relativePath.split("/"));
    const relative = path.relative(rootReal, absolute);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("仓库文件越出根目录，已停止版本比较。");
    let cursor = rootReal;
    let symbolic = false;
    for (const part of relativePath.split("/")) {
      cursor = path.join(cursor, part);
      try { if ((await lstat(cursor)).isSymbolicLink()) symbolic = true; }
      catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") { symbolic = true; break; } throw error; }
    }
    if (symbolic) continue;
    const stat = await lstat(absolute);
    if (!stat.isFile()) continue;
    const realFile = await realpath(absolute);
    const realRelative = path.relative(rootReal, realFile);
    if (realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) throw new Error("仓库文件解析后越出根目录。");
    if (stat.size > 1024 * 1024) throw new Error(`比较文件超过 1 MiB 上限：${relativePath}`);
    const content = await readFile(realFile);
    const mode = process.platform !== "win32" && (stat.mode & 0o111) ? "100755" : "100644";
    const oid = blobOid(content);
    const base = baseFiles.get(relativePath);
    if (!base || base.oid !== oid || base.mode !== mode) {
      changedContentBytes += content.length;
      if (changedContentBytes > MAX_CHANGED_CONTENT_BYTES) throw new Error("变更源码内容超过 32 MiB 比较上限；请缩小提交范围。");
      files.set(relativePath, { mode, oid, content });
    } else files.set(relativePath, { mode, oid });
  }
  return files;
}

function changedEntries(left, right) {
  const changed = [];
  for (const [filePath, oldFile] of left) {
    const newFile = right.get(filePath);
    if (!newFile || oldFile.oid !== newFile.oid || oldFile.mode !== newFile.mode) changed.push(filePath);
  }
  for (const filePath of right.keys()) if (!left.has(filePath)) changed.push(filePath);
  return [...new Set(changed)].sort((a, b) => a.localeCompare(b));
}

async function writeLooseBlob(gitDirectory, bytes) {
  const header = Buffer.from(`blob ${bytes.length}\0`);
  const oid = createHash("sha1").update(header).update(bytes).digest("hex");
  const folder = path.join(gitDirectory, "objects", oid.slice(0, 2));
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, oid.slice(2)), deflateSync(Buffer.concat([header, bytes])));
  return oid;
}

async function createRawComparison(root, leftFiles, rightFiles, changedPaths, signal) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "repolens-raw-diff-"));
  try {
    const workRoot = path.join(tempRoot, "repo");
    const gitDirectory = path.join(workRoot, ".git");
    const emptyHooks = path.join(tempRoot, "empty-hooks");
    await mkdir(emptyHooks, { recursive: true });
    await mkdir(workRoot, { recursive: true });
    await git(workRoot, ["init", "-q", "--object-format=sha1", "--template", ""], { signal });
    await git(workRoot, ["config", "core.fsmonitor", "false"], { signal });
    await git(workRoot, ["config", "core.untrackedCache", "false"], { signal });
    await git(workRoot, ["config", "core.hooksPath", emptyHooks], { signal });
    const makeTree = async (files, indexName) => {
      const indexPath = path.join(tempRoot, indexName);
      const lines = [];
      for (const filePath of changedPaths) {
        const file = files.get(filePath);
        if (!file) continue;
        const validPath = validateRelativePath(filePath);
        const content = file.content ?? (file.oid ? null : Buffer.alloc(0));
        const oid = content ? await writeLooseBlob(gitDirectory, content) : file.oid;
        if (!oid) continue;
        lines.push(`${file.mode ?? "100644"} blob ${oid}\t${validPath}\0`);
      }
      const env = { GIT_INDEX_FILE: indexPath };
      if (lines.length) await runGit(workRoot, ["update-index", "-z", "--index-info"], { input: Buffer.from(lines.join(""), "utf8"), signal, env });
      const { stdout } = await git(workRoot, ["write-tree"], { signal, env });
      return stdout.trim();
    };
    const leftTree = await makeTree(leftFiles, "left.index");
    const rightTree = await makeTree(rightFiles, "right.index");
    const nameStatus = await git(workRoot, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--find-renames", "--name-status", "-z", leftTree, rightTree], { signal });
    const files = parseNameStatus(nameStatus.stdout);
    if (files.length > MAX_CHANGED_FILES) throw new Error(`变更文件共 ${files.length} 个，超过 ${MAX_CHANGED_FILES} 个的查看上限；请缩小比较范围。`);
    const trackedDiff = await git(workRoot, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--find-renames", "--unified=3", leftTree, rightTree], { signal });
    if (Buffer.byteLength(trackedDiff.stdout) > MAX_DIFF_BYTES) throw new Error("差异内容超过 2 MiB 查看上限；请缩小提交范围。");
    return { files, diff: trackedDiff.stdout };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function emptyComparison({ revision, mode, baseCommit, headCommit }) {
  return { revision, mode, baseCommit, headCommit, files: [], diff: "", limits: { maxFiles: MAX_CHANGED_FILES, maxDiffBytes: MAX_DIFF_BYTES } };
}

export async function compareRepositoryRevisions({ root, gitDir = root, currentCommit, mode, baseRef, headRef, revision, signal }) {
  if (mode !== "working-tree" && mode !== "commits") throw new Error("版本比较模式无效。");
  await ensureNoLazyFetchSupport();
  const immutableSnapshot = mode === "working-tree" && Boolean(currentCommit);
  const base = mode === "working-tree" ? await resolveCommit(gitDir, currentCommit ?? "HEAD", "当前", signal) : await resolveCommit(gitDir, baseRef, "起始", signal);
  const head = mode === "working-tree" ? immutableSnapshot ? base : "WORKTREE" : await resolveCommit(gitDir, headRef, "目标", signal);
  if (immutableSnapshot || mode === "commits" && base === head) return emptyComparison({ revision, mode, baseCommit: base, headCommit: head });

  const left = await readCommitTree(gitDir, base, signal);
  let right;
  if (mode === "commits") right = await readCommitTree(gitDir, head, signal);
  else right = await readRawWorkingFiles(root, left, signal);
  const changedPaths = changedEntries(left, right);
  if (!changedPaths.length) return emptyComparison({ revision, mode, baseCommit: base, headCommit: head });
  if (changedPaths.length > MAX_CHANGED_FILES) throw new Error(`变更文件共 ${changedPaths.length} 个，超过 ${MAX_CHANGED_FILES} 个的查看上限；请缩小比较范围。`);

  const oldBlobs = await readCommitBlobs(gitDir, changedPaths.map((filePath) => left.get(filePath)).filter(Boolean), signal);
  const leftChanged = new Map(changedPaths.flatMap((filePath) => {
    const file = left.get(filePath);
    return file ? [[filePath, { ...file, content: oldBlobs.get(file.oid) }]] : [];
  }));
  if (mode === "commits") {
    const newBlobs = await readCommitBlobs(gitDir, changedPaths.map((filePath) => right.get(filePath)).filter(Boolean), signal);
    const rightChanged = new Map(changedPaths.flatMap((filePath) => {
      const file = right.get(filePath);
      return file ? [[filePath, { ...file, content: newBlobs.get(file.oid) }]] : [];
    }));
    return { ...await createRawComparison(root, leftChanged, rightChanged, changedPaths, signal), revision, mode, baseCommit: base, headCommit: head, limits: { maxFiles: MAX_CHANGED_FILES, maxDiffBytes: MAX_DIFF_BYTES } };
  }
  const rightChanged = new Map(changedPaths.flatMap((filePath) => {
    const file = right.get(filePath);
    return file ? [[filePath, file]] : [];
  }));
  return { ...await createRawComparison(root, leftChanged, rightChanged, changedPaths, signal), revision, mode, baseCommit: base, headCommit: head, limits: { maxFiles: MAX_CHANGED_FILES, maxDiffBytes: MAX_DIFF_BYTES } };
}
