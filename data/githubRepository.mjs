import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ignore from "ignore";
import ts from "typescript";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".css", ".scss", ".sass", ".less", ".py", ".pyi", ".go"]);
const HARD_IGNORES = new Set([".git", "node_modules", ".next", "dist", "build", "coverage", ".wrangler", ".vinext", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", "vendor"]);
const MAX_SOURCE_FILES = 5000;
const MAX_FILE_BYTES = 1024 * 1024;
const pendingCleanupDirectories = new Set();
const RETRYABLE_CLEANUP_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

function decodePathSegment(value, { allowSlash = false } = {}) {
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { throw new Error("GitHub 链接中的路径编码无效。"); }
  if (!decoded || decoded === "." || decoded === ".." || decoded.includes("\\") || decoded.includes("\0") || (!allowSlash && decoded.includes("/"))) {
    throw new Error("GitHub 链接包含不安全的路径片段。");
  }
  return decoded;
}

/** Validate and split supported GitHub browser URLs without contacting the network. */
export function parseGitHubRepositoryUrl(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { return null; }
  if (!["http:", "https:"].includes(url.protocol) || url.hostname.toLowerCase() !== "github.com" || url.port || url.username || url.password) {
    if (/^https?:/i.test(String(value).trim()) || /^git@github\.com:/i.test(String(value).trim())) throw new Error("仅支持 https://github.com/owner/repository 链接，不支持其他主机或协议。");
    return null;
  }
  if (url.protocol !== "https:") throw new Error("GitHub 仓库链接必须使用 HTTPS。");
  const rawPathname = String(value).trim().match(/^https:\/\/github\.com(?::443)?([^?#]*)/i)?.[1] ?? url.pathname;
  const rawSegments = rawPathname.split("/").filter(Boolean);
  for (const rawSegment of rawSegments) {
    let decoded;
    try { decoded = decodeURIComponent(rawSegment); } catch { throw new Error("GitHub 链接中的路径编码无效。"); }
    if (decoded.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("GitHub 链接包含不安全的路径片段。");
  }
  if (rawSegments.length < 2) throw new Error("GitHub 链接需要包含 owner 和 repository。");
  const owner = decodePathSegment(rawSegments[0]);
  let repository = decodePathSegment(rawSegments[1]);
  if (repository.endsWith(".git")) repository = repository.slice(0, -4);
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repository) || owner === "." || owner === ".." || repository === "." || repository === "..") {
    throw new Error("GitHub 仓库地址格式无效。");
  }
  const remainder = rawSegments.slice(2);
  if (!remainder.length) return { owner, repository, cloneUrl: `https://github.com/${owner}/${repository}.git`, requestedRefParts: null, subdirectoryParts: [] };
  if (remainder[0] === "blob") throw new Error("目前不支持 GitHub 单文件链接，请改用仓库主页或 /tree/ 目录链接。");
  if (remainder[0] !== "tree" || remainder.length < 2) throw new Error("仅支持 GitHub 仓库主页和 /tree/{分支、标签或提交}/{目录} 链接。");
  const tail = remainder.slice(1).flatMap((part) => decodePathSegment(part, { allowSlash: true }).split("/"));
  if (tail.some((part) => !part || part === "." || part === "..")) throw new Error("GitHub 链接包含不安全的路径片段。");
  if (!tail.length) throw new Error("GitHub tree 链接缺少分支、标签或提交。");
  return { owner, repository, cloneUrl: `https://github.com/${owner}/${repository}.git`, requestedRefParts: tail, subdirectoryParts: [] };
}

function runGit(args, { cwd, signal, input, maxOutputBytes = 256 * 1024 * 1024, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("操作已取消。", "AbortError"));
    const child = spawn(process.env.REPOLENS_GIT_EXECUTABLE || "git", args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never", GIT_OPTIONAL_LOCKS: "0", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output = [];
    const errors = [];
    let outputLength = 0;
    let settled = false;
    let timedOut = false;
    let abortError = null;
    const finishError = (error) => { if (settled) return; settled = true; clearTimeout(timeout); signal?.removeEventListener("abort", abort); reject(error); };
    const abort = () => { abortError = new DOMException("GitHub 仓库操作已取消。", "AbortError"); child.kill(); };
    const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 120_000);
    timeout.unref?.();
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", () => finishError(new Error("无法启动本机 Git。请确认 Git 已安装并可从命令行使用。")));
    child.stdout.on("data", (chunk) => {
      outputLength += chunk.length;
      if (outputLength > maxOutputBytes) { abortError = new Error("GitHub 仓库索引清单过大，无法安全读取。"); child.kill(); return; }
      output.push(chunk);
    });
    child.stderr.on("data", (chunk) => { if (errors.reduce((sum, item) => sum + item.length, 0) < 16_384) errors.push(chunk); });
    child.on("close", (code) => {
      if (settled) return;
      settled = true; clearTimeout(timeout); signal?.removeEventListener("abort", abort);
      if (abortError) reject(abortError);
      else if (code === 0) resolve(Buffer.concat(output));
      else if (timedOut) reject(new Error("GitHub 操作超时，请检查网络连接后重试。"));
      else {
        const stderr = Buffer.concat(errors).toString("utf8").toLowerCase();
        if (/authentication failed|could not read username|terminal prompts disabled|repository not found|access denied|permission denied/.test(stderr)) reject(new Error("无法访问此 GitHub 仓库。公开仓库可直接打开；私有仓库请先在本机 Git Credential Manager 中配置访问凭据。"));
        else if (/could not resolve|failed to connect|connection timed out|network is unreachable/.test(stderr)) reject(new Error("无法连接 GitHub，请检查网络后重试。"));
        else reject(new Error("GitHub 仓库获取失败，请确认链接有效、仓库可访问且本机 Git 配置正常。"));
      }
    });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

function parseRemoteRefs(output) {
  const refs = new Map();
  let head = "";
  for (const line of output.toString("utf8").split(/\r?\n/)) {
    if (!line) continue;
    const [left, right] = line.split("\t");
    if (left.startsWith("ref: ") && right === "HEAD") { head = left.slice(5); continue; }
    if (/^[0-9a-f]{40,64}$/i.test(left) && right) refs.set(right, left.toLowerCase());
  }
  for (const [name, sha] of refs) if (name.endsWith("^{}")) refs.set(name.slice(0, -3), sha);
  return { refs, head };
}

function resolveRequestedRef(parsed, remote) {
  if (!parsed.requestedRefParts) {
    if (!remote.head || !remote.refs.has(remote.head)) throw new Error("GitHub 仓库没有可读取的默认分支。");
    return { ref: remote.head, resolvedRef: remote.head, subdirectory: "" };
  }
  const parts = parsed.requestedRefParts;
  const names = [...remote.refs.keys()].filter((name) => !name.endsWith("^{}"));
  const candidates = names.flatMap((name) => [name, name.replace(/^refs\/(?:heads|tags)\//, "")]).sort((a, b) => b.length - a.length);
  for (const candidate of candidates) {
    const candidateParts = candidate.split("/");
    if (candidateParts.length <= parts.length && candidateParts.every((part, index) => part === parts[index])) {
      const ref = names.find((name) => name === candidate || name.replace(/^refs\/(?:heads|tags)\//, "") === candidate);
      return { ref, resolvedRef: ref, subdirectory: parts.slice(candidateParts.length).join("/") };
    }
  }
  const possibleCommit = parts[0];
  if (/^[0-9a-f]{7,64}$/i.test(possibleCommit)) {
    const advertisedCommit = [...remote.refs.values()].find((sha) => sha.startsWith(possibleCommit.toLowerCase()));
    const commit = advertisedCommit ?? possibleCommit.toLowerCase();
    return { ref: commit, resolvedRef: commit, subdirectory: parts.slice(1).join("/") };
  }
  throw new Error("GitHub 链接中的分支、标签或提交不存在。");
}

function parseTreeListing(output) {
  const result = [];
  for (const record of output.toString("utf8").split("\0")) {
    if (!record) continue;
    const separator = record.indexOf("\t");
    if (separator < 0) continue;
    const [mode, type, oid, sizeText] = record.slice(0, separator).split(" ");
    const relative = record.slice(separator + 1);
    if (type !== "blob" || mode === "120000" || mode === "160000") continue;
    const pathParts = relative.split("/");
    if (relative.includes("\\") || relative.includes("\0") || path.posix.isAbsolute(relative) || pathParts.some((part) => part === ".." || part === "." || part === "" || part.includes(":") || /[ .]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part))) throw new Error("GitHub 仓库中存在不安全的文件路径，已停止导入。");
    result.push({ relative, oid, size: Number(sizeText), mode });
  }
  return result;
}

function hardIgnored(relative) { return relative.split("/").some((part) => HARD_IGNORES.has(part) || part.startsWith(".env")); }
function isSource(relative) { return SOURCE_EXTENSIONS.has(path.posix.extname(relative).toLowerCase()); }

function applyIgnoreRules(relative, ruleMap) {
  const directoryParts = relative.split("/").slice(0, -1);
  const ruleSets = [ruleMap.get("")];
  for (let index = 0; index < directoryParts.length; index += 1) ruleSets.push(ruleMap.get(directoryParts.slice(0, index + 1).join("/")));
  let ignored = false;
  for (let index = 0; index < ruleSets.length; index += 1) {
    const matcher = ruleSets[index];
    if (!matcher) continue;
    const base = directoryParts.slice(0, index).join("/");
    const scoped = base ? relative.slice(base.length + 1) : relative;
    const result = matcher.test(scoped);
    if (result.ignored || result.unignored) ignored = result.ignored;
  }
  return ignored;
}

function resolveConfigReference(configPath, specifier, entries) {
  if (!specifier.startsWith(".")) return "";
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(configPath), specifier));
  if (base.startsWith("../") || base === ".." || base.startsWith("/")) return "";
  for (const candidate of [base, `${base}.json`, `${base}/tsconfig.json`]) if (entries.has(candidate)) return candidate;
  return "";
}

async function materializeCommit(mirrorPath, commit, checkoutRoot, signal) {
  const listing = await runGit(["-C", mirrorPath, "ls-tree", "-r", "-l", "-z", "--full-tree", commit], { signal });
  const entries = new Map(parseTreeListing(listing).map((item) => [item.relative, item]));
  const ignoreFiles = [...entries.values()].filter(({ relative }) => [".gitignore", ".repolensignore"].includes(path.posix.basename(relative)) && !hardIgnored(relative));
  const configFiles = [...entries.values()].filter(({ relative }) => ["tsconfig.json", "jsconfig.json"].includes(path.posix.basename(relative)) && !hardIgnored(relative));
  const languageConfigFiles = [...entries.values()].filter(({ relative }) => ["go.mod", "go.work", "pyproject.toml", "setup.cfg", "setup.py"].includes(path.posix.basename(relative)) && !hardIgnored(relative));
  const packageFiles = [...entries.values()].filter(({ relative }) => path.posix.basename(relative) === "package.json" && !hardIgnored(relative));
  for (const entry of ignoreFiles) if (entry.size > MAX_FILE_BYTES) throw new Error(`GitHub 仓库忽略文件 ${entry.relative} 超过 1 MiB，无法安全读取。`);
  const sourceFiles = [...entries.values()].filter(({ relative }) => isSource(relative) && !hardIgnored(relative));

  // Load ignore files first so ignored source trees are excluded before the source-file limit is applied.
  const loadedIgnoreContents = await readGitBlobs(mirrorPath, ignoreFiles, signal, 1_048_576);
  const ruleMap = new Map();
  for (const item of ignoreFiles) {
    const directory = path.posix.dirname(item.relative) === "." ? "" : path.posix.dirname(item.relative);
    let matcher = ruleMap.get(directory);
    if (!matcher) { matcher = ignore(); ruleMap.set(directory, matcher); }
    matcher.add(loadedIgnoreContents.get(item.relative)?.toString("utf8") ?? "");
  }
  const visibleConfigs = configFiles.filter(({ relative }) => !applyIgnoreRules(relative, ruleMap));
  for (const entry of visibleConfigs) if (entry.size > MAX_FILE_BYTES) throw new Error(`GitHub 仓库配置文件 ${entry.relative} 超过 1 MiB，无法安全读取。`);
  const textSidecars = new Map([
    ...ignoreFiles,
    ...visibleConfigs,
    ...languageConfigFiles.filter(({ relative }) => !applyIgnoreRules(relative, ruleMap)),
    ...packageFiles.filter(({ relative }) => !applyIgnoreRules(relative, ruleMap)),
  ].map((item) => [item.relative, item]));
  const overviewNames = new Set(["readme.md", "readme.rst", "readme.txt", "readme", "requirements.txt", "cargo.toml"]);
  for (const entry of entries.values()) {
    if (entry.relative.includes("/") || !overviewNames.has(entry.relative.toLowerCase()) || applyIgnoreRules(entry.relative, ruleMap)) continue;
    if (entry.size > 256 * 1024) continue;
    textSidecars.set(entry.relative, entry);
  }
  const eligibleSources = sourceFiles.filter(({ relative }) => !applyIgnoreRules(relative, ruleMap));
  if (eligibleSources.length > MAX_SOURCE_FILES) throw new Error(`GitHub 仓库超过 ${MAX_SOURCE_FILES} 个源码文件，请增加忽略规则后重新扫描。`);
  const oversizedSource = eligibleSources.find((item) => item.size > MAX_FILE_BYTES);
  if (oversizedSource) throw new Error(`GitHub 源文件 ${oversizedSource.relative} 超过 1 MiB，已停止读取。`);

  // Follow local TypeScript "extends" files, including extensionless files, without executing repository code.
  const configQueue = visibleConfigs.map((item) => item.relative);
  const configVisited = new Set();
  const configContents = await readGitBlobs(mirrorPath, visibleConfigs, signal, MAX_FILE_BYTES);
  while (configQueue.length) {
    const configPath = configQueue.shift();
    if (!configPath || configVisited.has(configPath)) continue;
    configVisited.add(configPath);
    const contents = configContents.get(configPath);
    if (!contents) continue;
    const parsed = ts.parseConfigFileTextToJson(configPath, contents.toString("utf8"));
    const extendsValue = parsed.config?.extends;
    const references = Array.isArray(extendsValue) ? extendsValue : typeof extendsValue === "string" ? [extendsValue] : [];
    for (const specifier of references) {
      if (typeof specifier !== "string") continue;
      const candidate = resolveConfigReference(configPath, specifier, entries);
      if (candidate && !configVisited.has(candidate) && !applyIgnoreRules(candidate, ruleMap)) {
        const entry = entries.get(candidate);
        if (entry.size > MAX_FILE_BYTES) throw new Error(`配置文件 ${candidate} 超过 1 MiB，无法安全读取。`);
        textSidecars.set(candidate, entry);
        const loaded = await readGitBlobs(mirrorPath, [entry], signal, MAX_FILE_BYTES);
        configContents.set(candidate, loaded.get(candidate));
        configQueue.push(candidate);
      }
    }
  }

  const selected = new Map([...eligibleSources, ...textSidecars.values()].filter((item) => item.size <= MAX_FILE_BYTES).map((item) => [item.relative, item]));
  for (const batch of partitionGitBlobs([...selected.values()])) {
    const blobs = await readGitBlobs(mirrorPath, batch, signal, 8 * 1024 * 1024);
    for (const entry of batch) {
    if (signal?.aborted) throw new DOMException("GitHub 仓库操作已取消。", "AbortError");
    const target = path.join(checkoutRoot, ...entry.relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    const blob = blobs.get(entry.relative);
    if (blob) await writeFile(target, blob, { mode: entry.mode === "100755" ? 0o644 : 0o644 });
    }
  }
  return checkoutRoot;
}

export function partitionGitBlobs(items) {
  const batches = []; let batch = []; let bytes = 0;
  for (const item of items) {
    if (batch.length && (batch.length >= 100 || bytes + item.size > 8 * 1024 * 1024)) { batches.push(batch); batch = []; bytes = 0; }
    batch.push(item); bytes += item.size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export async function readGitBlobs(mirrorPath, items, signal, maxBytes, spawnProcess = spawn, timeoutMs = 120_000) {
  const result = new Map();
  if (!items.length) return result;
  const input = items.map((item) => item.oid).join("\n") + "\n";
  const child = spawnProcess(process.env.REPOLENS_GIT_EXECUTABLE || "git", ["-C", mirrorPath, "cat-file", "--batch"], { windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" }, stdio: ["pipe", "pipe", "ignore"] });
  let spawnError = null;
  let stdinError = null;
  let abortError = null;
  let timeoutError = null;
  let closed = false;
  const timeout = setTimeout(() => { timeoutError = new Error("Git 对象读取超时。"); child.kill(); }, timeoutMs);
  timeout.unref?.();
  const processClosed = new Promise((resolve) => child.once("close", (code, signalName) => {
    closed = true;
    resolve({ code, signal: signalName });
  }));
  child.once("error", (error) => { spawnError = error; });
  child.stdin.on("error", (error) => { stdinError = error; child.kill(); });
  const abort = () => { abortError = new DOMException("GitHub 仓库操作已取消。", "AbortError"); child.kill(); };
  signal?.addEventListener("abort", abort, { once: true });
  let readError = null;
  try {
    if (signal?.aborted) abort();
    child.stdin.end(input);
    const iterator = child.stdout[Symbol.asyncIterator]();
    let buffer = Buffer.alloc(0);
    let ended = false;
    const fill = async (minimum = 1) => {
      while (buffer.length < minimum && !ended) {
        const next = await iterator.next();
        if (next.done) { ended = true; break; }
        buffer = buffer.length ? Buffer.concat([buffer, next.value]) : next.value;
      }
    };
    const line = async () => {
      while (true) {
        const index = buffer.indexOf(10);
        if (index >= 0) { const value = buffer.subarray(0, index).toString("utf8"); buffer = buffer.subarray(index + 1); return value; }
        if (ended) throw new Error("GitHub 仓库对象数据不完整。");
        const next = await iterator.next();
        if (next.done) { ended = true; continue; }
        buffer = buffer.length ? Buffer.concat([buffer, next.value]) : next.value;
      }
    };
    for (const item of items) {
      if (signal?.aborted) abort();
      if (abortError) throw abortError;
      const header = await line();
      const match = /^([0-9a-f]+) blob (\d+)$/.exec(header);
      if (!match) throw new Error("GitHub 仓库对象数据格式无效。");
      const size = Number(match[2]);
      const keep = Math.min(size, maxBytes);
      const chunks = [];
      let remaining = size;
      let kept = 0;
      while (remaining > 0) {
        if (!buffer.length) await fill(1);
        if (!buffer.length) throw new Error("GitHub 仓库对象数据不完整。");
        const count = Math.min(remaining, buffer.length);
        if (kept < keep) { const take = Math.min(count, keep - kept); chunks.push(buffer.subarray(0, take)); kept += take; }
        buffer = buffer.subarray(count); remaining -= count;
      }
      await fill(1);
      if (buffer[0] !== 10) throw new Error("GitHub 仓库对象分隔符无效。");
      buffer = buffer.subarray(1);
      result.set(item.relative, Buffer.concat(chunks, kept));
    }
    while (!ended) {
      const next = await iterator.next();
      if (next.done) ended = true;
    }
  } catch (error) {
    readError = error;
    if (!closed) child.kill();
  }
  const exit = await processClosed;
  clearTimeout(timeout);
  signal?.removeEventListener("abort", abort);
  if (abortError) throw abortError;
  if (spawnError) throw new Error("无法启动 Git 对象读取进程。", { cause: spawnError });
  if (timeoutError) throw timeoutError;
  if (stdinError && !readError) readError = new Error("无法向 Git 对象读取进程发送请求。", { cause: stdinError });
  if (readError) throw readError;
  if (exit.code !== 0) throw new Error(`Git 对象读取进程异常退出（${exit.code ?? exit.signal ?? "unknown"}）。`);
  return result;
}

async function cleanupQuietly(directory, removeDirectory = rm) {
  if (!directory) return true;
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await removeDirectory(directory, { recursive: true, force: true });
      for (const pending of pendingCleanupDirectories) {
        const relative = path.relative(directory, pending);
        if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) pendingCleanupDirectories.delete(pending);
      }
      return true;
    } catch (error) {
      lastError = error;
      if (!RETRYABLE_CLEANUP_CODES.has(error?.code) || attempt === 3) break;
      await new Promise((resolve) => setTimeout(resolve, 30 * (attempt + 1)));
    }
  }
  pendingCleanupDirectories.add(directory);
  process.stderr.write(`RepoLens: GitHub 临时内容清理失败（${path.basename(directory)}，${lastError?.code ?? "unknown"}）。\n`);
  return false;
}

export async function cleanupPendingGitHubContent(removeDirectory = rm) {
  const results = await Promise.all([...pendingCleanupDirectories].map((directory) => cleanupQuietly(directory, removeDirectory)));
  return results.every(Boolean);
}

/** Fetch the selected GitHub ref and materialize only safe, relevant text files. */
export async function prepareGitHubRepository(value, previous = null, { signal, gitRemoteOverride, onWorkspace } = {}) {
  const parsed = parseGitHubRepositoryUrl(value);
  if (!parsed) throw new Error("请输入本地目录或 GitHub 仓库链接。");
  const configuredTempRoot = process.env.REPOLENS_TEMP_ROOT ? path.resolve(process.env.REPOLENS_TEMP_ROOT) : os.tmpdir();
  if (!previous) await mkdir(configuredTempRoot, { recursive: true });
  const storageRoot = previous?.storageRoot ?? await mkdtemp(path.join(configuredTempRoot, "repolens-github-"));
  const mirrorPath = previous?.mirrorPath ?? path.join(storageRoot, "mirror.git");
  let checkoutRoot;
  try {
    onWorkspace?.({ storageRoot, mirrorPath });
    checkoutRoot = await mkdtemp(path.join(storageRoot, "checkout-"));
    if (!previous) {
      await mkdir(storageRoot, { recursive: true });
      await runGit(["init", "--bare", mirrorPath], { signal });
      await runGit(["-C", mirrorPath, "remote", "add", "origin", gitRemoteOverride ?? parsed.cloneUrl], { signal });
    }
    const remoteOutput = await runGit(["-C", mirrorPath, "ls-remote", "--symref", "origin"], { signal });
    const chosen = resolveRequestedRef(parsed, parseRemoteRefs(remoteOutput));
    const fetchResult = await runGit(["-C", mirrorPath, "fetch", "--no-tags", "--depth=1", "origin", chosen.ref], { signal });
    void fetchResult;
    const commit = (await runGit(["-C", mirrorPath, "rev-parse", "FETCH_HEAD^{commit}"], { signal })).toString("utf8").trim().toLowerCase();
    if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error("GitHub 没有返回有效的提交记录。");
    await materializeCommit(mirrorPath, commit, checkoutRoot, signal);
    const origin = {
      kind: "github",
      url: `https://github.com/${parsed.owner}/${parsed.repository}`,
      owner: parsed.owner,
      repository: parsed.repository,
      requestedRef: parsed.requestedRefParts?.join("/") ?? "",
      resolvedRef: chosen.resolvedRef,
      commit,
      subdirectory: chosen.subdirectory,
    };
    return { root: checkoutRoot, storageRoot, mirrorPath, checkoutRoot, input: String(value).trim(), gitRemoteOverride, origin };
  } catch (error) {
    await cleanupQuietly(checkoutRoot);
    if (!previous) await cleanupQuietly(storageRoot);
    throw error;
  }
}

/** Fetch one user-confirmed GitHub revision into the app-owned mirror without changing the active snapshot. */
export async function fetchGitHubRevision(workspace, target, { signal } = {}) {
  if (!workspace?.mirrorPath || workspace?.origin?.kind !== "github") throw new Error("当前会话不是 RepoLens 管理的 GitHub 仓库。");
  const requested = String(target ?? "").trim();
  const isCommit = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(requested);
  const isNamedRef = /^refs\/(?:heads|tags)\//.test(requested);
  if (!isCommit && !isNamedRef) throw new Error("请输入完整提交 SHA，或完整的 refs/heads/...、refs/tags/... 名称。");
  const sourceRef = isCommit ? requested.toLowerCase() : requested;
  if (isNamedRef) {
    try { await runGit(["check-ref-format", sourceRef], { signal }); }
    catch (error) {
      if (error?.name === "AbortError") throw error;
      throw new Error("GitHub 版本名称无效，请使用完整分支或标签名称。");
    }
  }

  const destinationRef = `refs/repolens/fetched/${randomUUID()}`;
  try {
    await runGit([
      "-C", workspace.mirrorPath, "fetch", "--depth=1", "--no-tags", "--no-write-fetch-head",
      "--no-recurse-submodules", "--no-auto-gc", "--upload-pack=git-upload-pack", "origin", `${sourceRef}:${destinationRef}`,
    ], { signal, env: { GIT_ALLOW_PROTOCOL: "https:file" } });
  } catch (cause) {
    if (cause?.name === "AbortError") throw cause;
    const error = new Error(cause instanceof Error ? cause.message : "GitHub 版本获取失败。");
    if (/无法访问此 GitHub 仓库/.test(error.message)) { error.status = 403; error.code = "GITHUB_ACCESS_DENIED"; }
    else if (/无法连接 GitHub/.test(error.message)) { error.status = 502; error.code = "GITHUB_UNAVAILABLE"; }
    else { error.status = 404; error.code = "REVISION_TARGET_MISSING"; }
    throw error;
  }
  if (signal?.aborted) throw new DOMException("GitHub 历史获取已取消。", "AbortError");
  const commit = (await runGit(["-C", workspace.mirrorPath, "rev-parse", "--verify", "--end-of-options", `${destinationRef}^{commit}`], { signal })).toString("utf8").trim().toLowerCase();
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error("GitHub 没有返回有效的提交记录。");
  return { target: sourceRef, commit, objectsAvailable: true };
}

export async function cleanupGitHubRepository(value, removeDirectory = rm) {
  if (!value?.storageRoot) return;
  return cleanupQuietly(value.storageRoot, removeDirectory);
}
