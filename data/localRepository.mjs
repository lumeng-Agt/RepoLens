import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import ignore from "ignore";
import { parsePolyglot } from "./polyglot-parser.mjs";
import { createRepositoryFileAccess, repositoryPathIsBlocked } from "./repository-files.mjs";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".css", ".scss", ".sass", ".less", ".py", ".pyi", ".go"]);
const TS_RESOLUTION_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".css", ".scss", ".sass", ".less"];
const MAX_FILES = 5000;
const MAX_BYTES = 1024 * 1024;
const PYTHON_STDLIB = new Set("abc argparse array asyncio base64 bisect builtins calendar cmath collections concurrent contextlib copy csv ctypes dataclasses datetime decimal difflib dis email enum errno faulthandler fnmatch fractions functools gc getpass glob hashlib heapq hmac html http importlib inspect io itertools json logging math multiprocessing numbers operator os pathlib pdb pickle platform pprint queue random re shutil signal socket sqlite3 statistics string subprocess sys tempfile threading time tkinter traceback typing unittest urllib uuid warnings weakref xml zipfile zoneinfo".split(" "));
const GO_STDLIB = new Set("archive bufio bytes cmp compress container context crypto database debug embed encoding errors expvar flag fmt go hash html image index io log maps math mime net os path reflect regexp runtime slices sort strconv strings sync syscall testing text time unicode unique unsafe iter structs version".split(" "));
const DEFAULT_COMPILER_OPTIONS = Object.freeze({ allowJs: true, jsx: ts.JsxEmit.Preserve, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.Latest });

function digest(text) { return createHash("sha256").update(text).digest("hex"); }
function decodeConfigContent(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString("utf16le");
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    const text = Buffer.from(buffer.subarray(2, buffer.length - (buffer.length % 2)));
    text.swap16(); return text.toString("utf16le");
  }
  return (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? buffer.subarray(3) : buffer).toString("utf8");
}
function normalizeTsPath(fileName) { return path.resolve(fileName).replaceAll("\\", "/"); }
function fingerprintPath(root, fileName) {
  const absolute = path.resolve(fileName);
  const relative = path.relative(root, absolute);
  if (relative === "") return ".";
  if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) return relative.split(path.sep).join("/");
  return "<outside>";
}
function rootIndependentValue(value, root) {
  if (typeof value === "string") {
    const normalized = value.replaceAll("\\", "/");
    const normalizedRoot = normalizeTsPath(root);
    return normalizedRoot && normalized.includes(normalizedRoot) ? normalized.replaceAll(normalizedRoot, "<repo>") : normalized;
  }
  if (Array.isArray(value)) return value.map((item) => rootIndependentValue(item, root));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rootIndependentValue(item, root)]));
}
function stableValue(value, seen = new WeakSet()) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  if (typeof value === "undefined" || typeof value === "function") return undefined;
  if (Array.isArray(value)) return value.map((item) => stableValue(item, seen));
  if (typeof value !== "object" || seen.has(value)) return undefined;
  seen.add(value);
  const result = Object.fromEntries(Object.keys(value).sort().flatMap((key) => {
    const item = stableValue(value[key], seen);
    return item === undefined ? [] : [[key, item]];
  }));
  seen.delete(value);
  return result;
}
function isHardIgnored(relative) {
  return repositoryPathIsBlocked(relative);
}
function findNearestConfigs(root, filePath, directoryCache, access, diagnostics) {
  let directory = path.dirname(path.join(root, ...filePath.split("/")));
  const visited = [];
  let found = null;
  while (directory === root || directory.startsWith(`${root}${path.sep}`)) {
    if (directoryCache.has(directory)) { found = directoryCache.get(directory); break; }
    visited.push(directory);
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const candidate = path.join(directory, name);
      try { if (access.inspectSync(candidate).info.isFile()) { found = candidate; break; } }
      catch (error) { if (String(error.code).startsWith("REPOSITORY_")) diagnostics.push({ path: fingerprintPath(root, candidate), message: error.message }); }
    }
    if (found) break;
    if (directory === root) break;
    directory = path.dirname(directory);
  }
  for (const visitedDirectory of visited) directoryCache.set(visitedDirectory, found);
  return found;
}
function compilerOptions(configPath, configHashes, stats, access) {
  if (!configPath) return { options: DEFAULT_COMPILER_OPTIONS, configFiles: new Map(), missingConfigFiles: new Set(), diagnostics: [] };
  const configFiles = new Map();
  const missingConfigFiles = new Set();
  const syntaxDiagnostics = new Map();
  const unrecoverableDiagnostics = [];
  const blockedPaths = new Set();
  function rejected(fileName, error) {
    const absolute = normalizeTsPath(fileName);
    if (String(error.code).startsWith("REPOSITORY_")) blockedPaths.add(absolute);
    if (fingerprintPath(access.root, absolute) !== "<outside>") missingConfigFiles.add(absolute);
  }
  const directoryEntries = directory => {
    try {
      const entries = access.entriesSync(directory);
      return { files: entries.filter(item => item.isFile()).map(item => item.name), directories: entries.filter(item => item.isDirectory()).map(item => item.name) };
    } catch (error) { rejected(directory, error); return { files: [], directories: [] }; }
  };
  const host = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    getCurrentDirectory: () => access.root,
    directoryExists: fileName => access.directoryExistsSync(fileName),
    getDirectories: directory => directoryEntries(directory).directories,
    readDirectory: (directory, extensions, excludes, includes, depth) => ts.matchFiles(directory, extensions, excludes, includes, ts.sys.useCaseSensitiveFileNames, access.root, depth, directoryEntries, fileName => fileName),
    onUnRecoverableConfigFileDiagnostic(diagnostic) { unrecoverableDiagnostics.push(diagnostic); },
    fileExists(fileName) {
      const normalized = normalizeTsPath(fileName);
      let exists = false;
      try { exists = access.inspectSync(normalized).info.isFile(); }
      catch (error) { rejected(normalized, error); return false; }
      if (exists) missingConfigFiles.delete(normalized);
      else missingConfigFiles.add(normalized);
      return exists;
    },
    readFile(fileName) {
      const absolute = normalizeTsPath(fileName);
      let content; let info;
      try { const read = access.readFileSync(absolute, { encoding: null }); content = decodeConfigContent(read.content); info = read.info; }
      catch (error) { rejected(absolute, error); return undefined; }
      const contentHash = digest(content);
      missingConfigFiles.delete(absolute);
      configHashes.set(absolute, contentHash);
      stats.configReadCount += 1;
      configFiles.set(absolute, { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, contentHash });
      // TypeScript accepts extensionless config files in `extends`; track and
      // validate every file it actually reads instead of assuming `.json`.
      const jsonResult = ts.parseConfigFileTextToJson(absolute, content);
      if (jsonResult.error) {
        const diagnostic = jsonResult.error;
        const key = `${absolute}:${diagnostic.code}:${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
        syntaxDiagnostics.set(key, { path: absolute, message: `TypeScript 配置 JSON 诊断 TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}` });
      }
      return content;
    },
  };
  let parsed;
  try {
    parsed = ts.getParsedCommandLineOfConfigFile(normalizeTsPath(configPath), { allowJs: true, jsx: ts.JsxEmit.Preserve }, host);
  } catch (error) {
    unrecoverableDiagnostics.push({ code: "PARSE", messageText: error instanceof Error ? error.message : String(error) });
  }
  for (const fileName of missingConfigFiles) {
    if (!access.fileExistsSync(fileName)) configHashes.set(fileName, "missing");
  }
  const rawDiagnostics = [...(parsed?.errors ?? []), ...unrecoverableDiagnostics];
  const diagnostics = [...syntaxDiagnostics.values()];
  if (blockedPaths.size) diagnostics.push({ path: normalizeTsPath(configPath), message: "配置继承或解析目标超出仓库、使用符号链接或不符合安全读取限制，已阻止访问。" });
  for (const diagnostic of rawDiagnostics) {
    let message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
    for (const blocked of [...blockedPaths].sort((a, b) => b.length - a.length)) {
      for (const variant of [blocked, blocked.replaceAll("/", "\\")]) message = message.replaceAll(variant, "<已阻止的路径>");
    }
    const fileName = diagnostic.file?.fileName ? normalizeTsPath(diagnostic.file.fileName) : normalizeTsPath(configPath);
    diagnostics.push({ path: fileName, message: `TypeScript 配置诊断 TS${diagnostic.code}: ${message}` });
  }
  const uniqueDiagnostics = [...new Map(diagnostics.map((diagnostic) => [`${diagnostic.path}:${diagnostic.message}`, diagnostic])).values()];
  return {
    options: syntaxDiagnostics.size > 0 || blockedPaths.size > 0 || !parsed ? DEFAULT_COMPILER_OPTIONS : parsed.options,
    configFiles,
    missingConfigFiles,
    diagnostics: uniqueDiagnostics,
    parseState: blockedPaths.size > 0 ? "blocked" : syntaxDiagnostics.size > 0 ? "syntax-error" : parsed ? "parsed" : "unrecoverable",
  };
}
async function configCacheIsValid(cached, configHashes, stats, access) {
  for (const [fileName, previous] of cached.configFiles) {
    try {
      const read = await access.readFile(fileName, { encoding: null });
      const content = decodeConfigContent(read.content);
      stats.configReadCount += 1;
      const contentHash = digest(content);
      if (contentHash !== previous.contentHash) return false;
      configHashes.set(fileName, contentHash);
    } catch { return false; }
  }
  for (const fileName of cached.missingConfigFiles ?? []) {
    if (access.fileExistsSync(fileName)) return false;
    configHashes.set(fileName, "missing");
  }
  return cached.configFiles.size > 0;
}

export async function scanRepository(inputPath, previous = null, { mode = "verify", changedPaths = [] } = {}) {
  const startedAt = performance.now();
  const scanStats = { configReadCount: 0 };
  const scanMode = mode === "incremental" && Array.isArray(changedPaths) && changedPaths.length > 0 ? "incremental" : "verify";
  const explicitlyChanged = new Set(changedPaths.map((item) => String(item).replaceAll("\\", "/").replace(/^\.\//, "")));
  const requestedRoot = path.resolve(inputPath);
  const requestedInfo = await lstat(requestedRoot);
  if (requestedInfo.isSymbolicLink()) throw new Error("为安全起见，不能以符号链接作为仓库根目录。");
  let root; let rootInfo; let requestedAfter;
  try {
    root = await realpath(requestedRoot);
    rootInfo = await lstat(root);
    requestedAfter = await lstat(requestedRoot);
  } catch { throw new Error("仓库目录在打开期间发生变化或无法读取，请重新选择文件夹。"); }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("请选择一个真实的本地文件夹。");
  if (requestedAfter.isSymbolicLink() || requestedInfo.dev !== rootInfo.dev || requestedInfo.ino !== rootInfo.ino || requestedAfter.dev !== rootInfo.dev || requestedAfter.ino !== rootInfo.ino) throw new Error("仓库目录在打开期间发生变化，请重新选择文件夹。");
  let access;
  try { access = createRepositoryFileAccess(root, { expectedIdentity: requestedInfo }); }
  catch { throw new Error("仓库目录在打开期间发生变化或无法读取，请重新选择文件夹。"); }
  const ignoreContents = {};
  const paths = [];
  const languageConfigPaths = new Set();
  const diagnostics = [];
  async function walk(directory, depth = 0, inheritedRules = []) {
    if (depth > 80) return;
    const localRules = [...inheritedRules];
    const localMatcher = ignore();
    let hasLocalRules = false;
    for (const name of [".gitignore", ".repolensignore"]) {
      const absolute = path.join(directory, name);
      try {
        const { content: contents } = await access.readFile(absolute);
        const relative = path.relative(root, absolute).split(path.sep).join("/");
        ignoreContents[relative] = contents;
        localMatcher.add(contents);
        hasLocalRules = true;
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
          diagnostics.push({ path: fingerprintPath(root, absolute), message: `${error.message} 此目录未继续扫描，以免忽略规则失效后扩大读取范围。` });
          return;
        }
      }
    }
    if (hasLocalRules) localRules.push({ base: path.relative(root, directory).split(path.sep).join("/"), matcher: localMatcher });
    let entries;
    try { entries = access.entriesSync(directory); } catch (error) { diagnostics.push({ path: path.relative(root, directory), message: error.message }); return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (isHardIgnored(relative)) continue;
      let ignored = false;
      for (const rule of localRules) {
        const scoped = rule.base ? relative.slice(rule.base.length + 1) : relative;
        if (scoped) {
          const result = rule.matcher.test(scoped);
          if (result.ignored || result.unignored) ignored = result.ignored;
        }
      }
      if (ignored) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { await walk(absolute, depth + 1, localRules); continue; }
      if (!entry.isFile()) continue;
      if (["go.mod", "go.work", "pyproject.toml", "setup.cfg", "setup.py"].includes(entry.name.toLowerCase())) languageConfigPaths.add(relative);
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      paths.push(relative);
      if (paths.length > MAX_FILES) throw new Error(`仓库超过 ${MAX_FILES} 个源码文件，请增加忽略规则后重新扫描。`);
    }
  }
  await walk(root);
  const languageConfigContents = new Map();
  for (const relative of [...languageConfigPaths].sort()) {
    try { languageConfigContents.set(relative, (await access.readFile(relative)).content); }
    catch (error) { diagnostics.push({ path: relative, message: `语言配置读取失败：${error.message}` }); }
  }
  const languageConfigHashes = new Map([...languageConfigContents].map(([relative, contents]) => [relative, digest(contents)]));
  const languageConfigChanged = !previous || languageConfigHashes.size !== (previous.languageConfigHashes?.size ?? 0) || [...languageConfigHashes].some(([key, value]) => previous.languageConfigHashes?.get(key) !== value);
  const goModules = languageConfigChanged || !previous.goModules ? buildGoModules(languageConfigContents, root) : previous.goModules;
  const languageConfigParseCount = languageConfigChanged ? 1 : 0;
  diagnostics.push(...(goModules.diagnostics ?? []));
  const configHashes = new Map();
  const directoryConfigCache = new Map();
  const configsByFile = new Map(paths.map((filePath) => [filePath, findNearestConfigs(root, filePath, directoryConfigCache, access, diagnostics)]));
  const configCache = new Map();
  const previousConfigCache = previous?.configCache ?? new Map();
  let configParseCount = 0;
  for (const configPath of new Set(configsByFile.values())) {
    if (!configPath) { configCache.set(null, { options: DEFAULT_COMPILER_OPTIONS, configFiles: new Map(), missingConfigFiles: new Set(), parseState: "no-config", diagnostics: [] }); continue; }
    const cached = previousConfigCache.get(configPath);
    if (cached && await configCacheIsValid(cached, configHashes, scanStats, access)) {
      configCache.set(configPath, cached);
    } else {
      const parsed = compilerOptions(configPath, configHashes, scanStats, access);
      configCache.set(configPath, parsed);
      configParseCount += 1;
    }
    for (const diagnostic of configCache.get(configPath).diagnostics ?? []) {
      diagnostics.push({
        ...diagnostic,
        path: fingerprintPath(root, diagnostic.path),
        message: rootIndependentValue(diagnostic.message, root),
      });
    }
  }
  const files = new Map();
  const sourceCache = new Map();
  const metadata = new Map();
  let parsedFileCount = 0;
  let sourceReadCount = 0;
  for (const relative of paths) {
    const absolute = path.join(root, ...relative.split("/"));
    let info; let inspected;
    try { inspected = access.inspectSync(absolute); info = inspected.info; }
    catch (error) { diagnostics.push({ path: relative, message: error.message }); continue; }
    if (!info.isFile() || info.isSymbolicLink()) continue;
    if (info.size > MAX_BYTES) { diagnostics.push({ path: relative, message: "文件超过 1 MiB，已跳过。" }); continue; }
    const old = previous?.files.get(relative);
    const oldMetadata = previous?.metadata?.get(relative);
    const currentMetadata = { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ino: info.ino };
    const metadataMatches = old && oldMetadata && previous.sourceCache.has(relative) && Object.keys(currentMetadata).every((key) => oldMetadata[key] === currentMetadata[key]);
    const explicitlyDirty = explicitlyChanged.has(relative);
    const canReuseWithoutRead = scanMode === "incremental" && metadataMatches && !explicitlyDirty;
    let source;
    try { source = canReuseWithoutRead ? previous.sourceCache.get(relative) : (await inspected.readFile()).content; }
    catch (error) { diagnostics.push({ path: relative, message: error.message }); continue; }
    if (!canReuseWithoutRead) sourceReadCount += 1;
    const contentHash = canReuseWithoutRead ? old.contentHash : digest(source);
    const contentChanged = !old || old.contentHash !== contentHash;
    const parsedStructure = contentChanged ? await extractFileStructure(source, absolute, relative) : { imports: old.imports, symbols: old.symbols ?? [], symbolDetails: old.symbolDetails ?? [] };
    const parsedImports = parsedStructure.imports;
    if (contentChanged) parsedFileCount += 1;
    const ext = path.extname(relative).slice(1).toLowerCase();
    const kind = ["css", "scss", "sass", "less"].includes(ext) ? "style" : ["py", "pyi"].includes(ext) ? "python" : ext === "go" ? "go" : "typescript";
    const language = ["py", "pyi"].includes(ext) ? "python" : ext;
    const conditionalGo = kind === "go" && /(?:^|\n)\s*\/\/(?:go:build|[ \t]+\+build)\b/.test(source);
    files.set(relative, { id: relative, path: relative, name: path.basename(relative), kind, role: kind === "python" ? "Python 模块" : kind === "go" ? conditionalGo ? "Go 条件编译文件" : "Go 源文件" : path.basename(relative), summary: "本地仓库文件；当前内容来自静态分析。", imports: parsedImports, symbols: parsedStructure.symbols, symbolDetails: parsedStructure.symbolDetails ?? [], contentHash, language });
    if (parsedStructure.diagnostic) diagnostics.push({ path: relative, message: parsedStructure.diagnostic });
    if (conditionalGo) diagnostics.push({ path: relative, message: "此 Go 文件带有条件编译标记；当前可阅读源码，但图谱未按运行平台筛选构建文件。" });
    sourceCache.set(relative, source);
    metadata.set(relative, currentMetadata);
  }
  const dependencies = [];
  const unresolved = [];
  const known = new Set(files.keys());
  const extensions = ["", ...TS_RESOLUTION_EXTENSIONS.flatMap((ext) => [ext, `/index${ext}`])];
  const pythonFiles = [...files.keys()].filter((filePath) => [".py", ".pyi"].includes(path.extname(filePath).toLowerCase()));
  const goFiles = [...files.keys()].filter((filePath) => path.extname(filePath).toLowerCase() === ".go");
  const optionsByConfig = new Map([...configCache].map(([configPath, value]) => [configPath, value.options]));
  const compilerHostsByConfig = new Map();
  for (const file of files.values()) {
    if (file.kind === "python") {
      for (const imported of file.imports) {
        const target = resolvePythonImport(file.path, imported.specifier, known, pythonFiles);
        let resolvedMember = false;
        if (target) {
          dependencies.push({ id: `${file.id}::${target}::${imported.line}`, fromId: file.id, toId: target, specifier: imported.specifier, kind: imported.kind, resolution: "file", resolutionBasis: "python-module", typeOnly: false, reference: { fileId: file.id, line: imported.line } });
        }
        const packageRoots = target
          ? path.posix.basename(target).startsWith("__init__.") ? [path.posix.dirname(target)] : []
          : pythonImportRoots(file.path, imported.specifier);
        for (const member of imported.members ?? []) {
          if (member === "*") {
            diagnostics.push({ path: file.path, message: `第 ${imported.line} 行使用了 from-import *；无法确定具体子模块，图谱只保留可解析的包引用。` });
            continue;
          }
          const memberPath = resolvePythonModuleFromRoots(packageRoots.map((rootPath) => path.posix.join(rootPath, member)), known, pythonFiles);
          if (!memberPath || memberPath === target) {
            if (target && path.posix.basename(target).startsWith("__init__.") && member !== "*") {
              diagnostics.push({ path: file.path, message: `第 ${imported.line} 行从包 ${imported.specifier || "当前包"} 导入 ${member}；无法判断它是普通符号还是未解析子模块，因此不按名称推测文件依赖。` });
            }
            continue;
          }
          resolvedMember = true;
          dependencies.push({ id: `${file.id}::${memberPath}::${imported.line}`, fromId: file.id, toId: memberPath, specifier: imported.specifier ? `${imported.specifier}.${member}` : member, kind: imported.kind, resolution: "file", resolutionBasis: "python-submodule", typeOnly: false, reference: { fileId: file.id, line: imported.line } });
        }
        if (!target && !resolvedMember) {
          const rootModule = imported.specifier.replace(/^\.+/, "").split(".")[0];
          const standard = !imported.specifier.startsWith(".") && PYTHON_STDLIB.has(rootModule);
          const dynamic = imported.kind === "dynamic";
          if (imported.specifier) unresolved.push({ fileId: file.id, specifier: imported.specifier, line: imported.line, kind: dynamic ? "dynamic" : standard ? "standard-library" : "unresolved", external: !dynamic && (standard || !imported.specifier.startsWith(".")) });
          if ((imported.members ?? []).length && imported.specifier.startsWith(".")) diagnostics.push({ path: file.path, message: `第 ${imported.line} 行的相对 from-import 无法解析：${imported.members.join(", ")}` });
        }
      }
      continue;
    }
    if (file.kind === "go") {
      for (const imported of file.imports) {
        const packageDirectory = resolveGoPackage(imported.specifier, goModules);
        const targets = packageDirectory ? goFiles.filter((candidate) => path.posix.dirname(candidate) === packageDirectory && !path.posix.basename(candidate).endsWith("_test.go")) : [];
        if (targets.length) {
          for (const target of targets) dependencies.push({ id: `${file.id}::${target}::${imported.line}`, fromId: file.id, toId: target, specifier: imported.specifier, kind: "package", resolution: "package", resolutionBasis: "go-package-expanded", typeOnly: false, reference: { fileId: file.id, line: imported.line } });
        } else {
          const rootImport = imported.specifier.split("/")[0];
          const standard = !rootImport.includes(".") && GO_STDLIB.has(rootImport);
          unresolved.push({ fileId: file.id, specifier: imported.specifier, line: imported.line, kind: standard ? "standard-library" : packageDirectory ? "unresolved" : "external-module", external: standard || !packageDirectory });
        }
      }
      continue;
    }
    const configPath = configsByFile.get(file.path);
    const options = optionsByConfig.get(configPath);
    if (!compilerHostsByConfig.has(configPath)) compilerHostsByConfig.set(configPath, {
      fileExists: fileName => access.fileExistsSync(fileName),
      readFile: fileName => { try { return access.readFileSync(fileName).content; } catch { return undefined; } },
      directoryExists: directory => access.directoryExistsSync(directory),
      getDirectories: directory => { try { return access.entriesSync(directory).filter(item => item.isDirectory()).map(item => item.name); } catch { return []; } },
      realpath: fileName => { try { return access.inspectSync(fileName).realPath; } catch { return fileName; } },
      getCurrentDirectory: () => root,
    });
    const compilerHost = compilerHostsByConfig.get(configPath);
    for (const imported of file.imports) {
      const fromAbsolute = path.join(root, ...file.path.split("/"));
      const resolved = ts.resolveModuleName(imported.specifier, fromAbsolute, options, compilerHost).resolvedModule?.resolvedFileName;
      let target = resolved ? path.relative(root, resolved).split(path.sep).join("/") : "";
      if (!target || target.startsWith("../") || path.isAbsolute(target) || !known.has(target)) {
        const base = path.resolve(path.dirname(fromAbsolute), imported.specifier);
        target = extensions.map((extension) => path.relative(root, `${base}${extension}`).split(path.sep).join("/")).find((candidate) => known.has(candidate)) ?? "";
      }
      if (target && known.has(target)) dependencies.push({ id: `${file.id}::${target}::${imported.line}`, fromId: file.id, toId: target, specifier: imported.specifier, kind: imported.kind, typeOnly: imported.typeOnly, resolution: "file", resolutionBasis: tsResolutionBasis(imported.specifier, options), reference: { fileId: file.id, line: imported.line } });
      else unresolved.push({ fileId: file.id, specifier: imported.specifier, line: imported.line, kind: imported.kind, external: !imported.specifier.startsWith(".") && !imported.specifier.startsWith("/") && !imported.specifier.startsWith("<") });
    }
  }
  const id = previous?.snapshot.id ?? `local-${digest(root).slice(0, 24)}`;
  const configState = [...configCache].map(([configPath, value]) => [
    configPath ? fingerprintPath(root, configPath) : null,
    value.parseState ?? "cached",
    rootIndependentValue(stableValue(value.options), root),
    [...(value.configFiles ?? [])].map(([fileName, info]) => [fingerprintPath(root, fileName), info.contentHash]).sort(([left], [right]) => left.localeCompare(right)),
    [...(value.missingConfigFiles ?? [])].map((fileName) => fingerprintPath(root, fileName)).sort(),
    rootIndependentValue((value.diagnostics ?? []).map((diagnostic) => ({ ...diagnostic, path: fingerprintPath(root, diagnostic.path) })), root),
  ]).sort(([left], [right]) => String(left).localeCompare(String(right)));
  const stableConfigHashes = [...configHashes].map(([fileName, hash]) => [fingerprintPath(root, fileName), hash]).sort(([left], [right]) => left.localeCompare(right));
  const stableLanguageConfigHashes = [...languageConfigHashes].sort(([left], [right]) => left.localeCompare(right));
  const fingerprint = digest(JSON.stringify({ files: [...files.values()].map(({ id, contentHash, symbolDetails }) => [id, contentHash, symbolDetails]), dependencies: dependencies.map(({ fromId, toId, specifier, kind, typeOnly, resolution, resolutionBasis, reference }) => [fromId, toId, specifier, kind, typeOnly, resolution, resolutionBasis, reference.line]), unresolved, ignoreContents, configHashes: stableConfigHashes, configState, languageConfigHashes: stableLanguageConfigHashes, goModules }));
  const sequence = previous?.snapshot.sequence ? previous.snapshot.sequence + (previous.snapshot.revision === fingerprint ? 0 : 1) : 1;
  // Keep routine third-party and standard-library imports as a small aggregate;
  // per-line diagnostics are reserved for imports that need the user's attention.
  const importDiagnostics = [];
  const externalImports = new Map();
  for (const item of unresolved) {
    const label = item.kind === "standard-library" ? "标准库" : item.kind !== "dynamic" && item.external ? "外部依赖" : null;
    if (label) {
      const key = `${label}:${item.specifier}`;
      const group = externalImports.get(key) ?? { label, specifier: item.specifier, count: 0 };
      group.count += 1;
      externalImports.set(key, group);
      continue;
    }
    importDiagnostics.push({ path: item.fileId, message: `${item.kind === "dynamic" ? "动态导入" : "未解析引用"}: ${item.specifier}（第 ${item.line} 行）` });
  }
  const externalDiagnostics = [...externalImports.values()].sort((left, right) => left.label.localeCompare(right.label) || left.specifier.localeCompare(right.specifier)).map((group) => ({ message: `${group.label}: ${group.specifier}（${group.count} 处引用）` }));
  const snapshot = { id, version: fingerprint.slice(0, 16), revision: fingerprint, sequence, name: path.basename(root), description: root, source: "local", diagnostics: [...diagnostics, ...importDiagnostics, ...externalDiagnostics], files: [...files.values()], dependencies, unresolved, tour: [], configPath: [...configHashes].filter(([, hash]) => hash !== "missing").map(([config]) => path.relative(root, config).split(path.sep).join("/")) };
  return { root, snapshot, files, sourceCache, metadata, ignoreContents, configHashes, configCache, languageConfigHashes, goModules, stats: { mode: scanMode, candidateCount: paths.length, indexedCount: files.size, parsedFileCount, sourceReadCount, sourceParseCount: parsedFileCount, configReadCount: scanStats.configReadCount, configParseCount, languageConfigReadCount: languageConfigContents.size, languageConfigParseCount, durationMs: performance.now() - startedAt } };
}

function buildGoModules(contentsByPath, root) {
  const modules = [];
  const replacements = [];
  const workspaceUses = [];
  const diagnostics = [];
  for (const [relative, contents] of contentsByPath) {
    const lines = contents.split(/\r?\n/);
    if (path.posix.basename(relative) === "go.mod") {
      const modulePath = lines.map((line) => line.trim()).find((line) => line.startsWith("module "))?.slice(7).trim().replace(/^['"]|['"]$/g, "");
      if (modulePath) modules.push({ importPath: modulePath, directory: path.posix.dirname(relative) === "." ? "." : path.posix.dirname(relative) });
      else diagnostics.push({ path: relative, message: "go.mod 中缺少有效 module 声明；无法解析仓库内部包导入。" });
    }
    let replaceBlock = false;
    let useBlock = false;
    for (const rawLine of lines) {
      const line = rawLine.replace(/\s+\/\/.*$/, "").trim();
      if (!line) continue;
      if (/^replace\s*\($/.test(line)) { replaceBlock = true; continue; }
      if (/^use\s*\($/.test(line)) { useBlock = true; continue; }
      if (line === ")") { replaceBlock = false; useBlock = false; continue; }
      let replaceText = line.startsWith("replace ") ? line.slice(8).trim() : replaceBlock ? line : "";
      if (replaceText.includes("=>")) {
        const [oldPart, newPart] = replaceText.split("=>", 2).map((value) => value.trim());
        const oldPath = oldPart.split(/\s+/)[0];
        const replacementPath = newPart.split(/\s+/)[0].replace(/^['"]|['"]$/g, "");
        if (oldPath && replacementPath && (replacementPath.startsWith(".") || path.isAbsolute(replacementPath))) {
          const absolute = path.resolve(root, path.posix.dirname(relative), replacementPath);
          const rel = path.relative(root, absolute);
          if (rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))) replacements.push({ importPath: oldPath, directory: rel.split(path.sep).join("/") || "." });
        }
      }
      const useText = line.startsWith("use ") ? line.slice(4).trim() : useBlock ? line : "";
      if (useText) workspaceUses.push({ config: relative, directory: useText.replace(/^['"]|['"]$/g, "") });
    }
  }
  // Workspace member module paths are taken from their in-root go.mod files;
  // the `use` records are retained in the signature for reviewability.
  modules.sort((left, right) => right.importPath.length - left.importPath.length || left.directory.localeCompare(right.directory));
  replacements.sort((left, right) => right.importPath.length - left.importPath.length || left.directory.localeCompare(right.directory));
  return { modules, replacements, workspaceUses, diagnostics };
}

function resolveGoPackage(specifier, goModules) {
  for (const replacement of goModules.replacements) {
    if (specifier === replacement.importPath || specifier.startsWith(`${replacement.importPath}/`)) {
      const suffix = specifier.slice(replacement.importPath.length).replace(/^\//, "");
      return path.posix.normalize(path.posix.join(replacement.directory, suffix));
    }
  }
  for (const moduleEntry of goModules.modules) {
    if (specifier === moduleEntry.importPath || specifier.startsWith(`${moduleEntry.importPath}/`)) {
      const suffix = specifier.slice(moduleEntry.importPath.length).replace(/^\//, "");
      return path.posix.normalize(path.posix.join(moduleEntry.directory, suffix));
    }
  }
  return null;
}

function pythonImportRoots(filePath, specifier) {
  const moduleText = specifier.trim();
  const relative = /^\.+/.exec(moduleText)?.[0] ?? "";
  const moduleName = moduleText.slice(relative.length).replaceAll(".", "/");
  const roots = [];
  if (relative) {
    let directory = path.posix.dirname(filePath);
    for (let index = 1; index < relative.length; index += 1) directory = path.posix.dirname(directory);
    roots.push(path.posix.join(directory, moduleName));
  } else {
    roots.push(moduleName, path.posix.join("src", moduleName));
  }
  return roots.filter(Boolean);
}

function resolvePythonModuleFromRoots(roots, known, pythonFiles) {
  const available = new Set(pythonFiles);
  for (const base of roots) {
    if (!base) continue;
    const candidates = [
      `${base}.py`, `${base}.pyi`, `${base}/__init__.py`, `${base}/__init__.pyi`,
    ];
    const target = candidates.find((candidate) => available.has(candidate) && known.has(candidate));
    if (target) return target;
  }
  return null;
}

function resolvePythonImport(filePath, specifier, known, pythonFiles) {
  return resolvePythonModuleFromRoots(pythonImportRoots(filePath, specifier), known, pythonFiles);
}

async function extractFileStructure(source, fileName, relativePath) {
  const extension = path.extname(fileName).toLowerCase();
  if ([".py", ".pyi"].includes(extension)) return parsePolyglot(source, relativePath, "python");
  if (extension === ".go") return parsePolyglot(source, relativePath, "go");
  if ([".css", ".scss", ".sass", ".less"].includes(extension)) return { imports: extractCssImports(source), symbols: [], symbolDetails: [] };
  return parseTypeScriptStructure(source, fileName);
}

function extractCssImports(source) {
  return [...source.matchAll(/@import\s+["']([^"']+)["']/g)].map((match) => ({ specifier: match[1], line: source.slice(0, match.index).split("\n").length, kind: "style", typeOnly: false }));
}

function parseTypeScriptStructure(source, fileName) {
  const extension = path.extname(fileName).toLowerCase();
  const kind = extension === ".tsx" ? ts.ScriptKind.TSX : extension === ".jsx" ? ts.ScriptKind.JSX : [".ts", ".mts", ".cts"].includes(extension) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const ast = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const imports = [];
  function visit(node) {
    const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const typeOnly = ts.isImportDeclaration(node)
        ? node.importClause?.isTypeOnly === true || Boolean(node.importClause && !node.importClause.name && node.importClause.namedBindings && ts.isNamedImports(node.importClause.namedBindings) && node.importClause.namedBindings.elements.length > 0 && node.importClause.namedBindings.elements.every((element) => element.isTypeOnly))
        : node.isTypeOnly === true || Boolean(node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0 && node.exportClause.elements.every((element) => element.isTypeOnly));
      imports.push({ specifier: node.moduleSpecifier.text, line, kind: ts.isImportDeclaration(node) ? "import" : "export", typeOnly: Boolean(typeOnly) });
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if (node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) imports.push({ specifier: node.arguments[0].text, line, kind: dynamic ? "dynamic" : "require", typeOnly: false });
      else if (dynamic) imports.push({ specifier: "<动态表达式>", line, kind: "dynamic", typeOnly: false });
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const symbolDetails = [];
  const symbolKeys = new Set();
  const addSymbol = (name, symbolKind, node) => {
    if (!name) return;
    const start = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
    const key = `${name}:${start}`;
    if (symbolKeys.has(key)) return;
    symbolKeys.add(key);
    const end = ast.getLineAndCharacterOfPosition(Math.max(node.getStart(ast), node.getEnd() - 1)).line + 1;
    symbolDetails.push({ name, kind: symbolKind, startLine: start, endLine: end });
  };
  const addMembers = (members) => {
    for (const member of members) {
      if (!member.name) continue;
      const name = ts.isIdentifier(member.name) || ts.isPrivateIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : undefined;
      if (!name) continue;
      if (ts.isMethodDeclaration(member) || ts.isMethodSignature(member) || ts.isConstructorDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) addSymbol(name, "method", member);
      else if (ts.isPropertyDeclaration(member) && member.initializer && (ts.isArrowFunction(member.initializer) || ts.isFunctionExpression(member.initializer))) addSymbol(name, "method", member);
    }
  };
  for (const statement of ast.statements) {
    if (ts.isFunctionDeclaration(statement)) addSymbol(statement.name?.text, "function", statement);
    else if (ts.isClassDeclaration(statement)) { addSymbol(statement.name?.text, "class", statement); addMembers(statement.members); }
    else if (ts.isInterfaceDeclaration(statement)) { addSymbol(statement.name.text, "interface", statement); addMembers(statement.members); }
    else if (ts.isTypeAliasDeclaration(statement)) addSymbol(statement.name.text, "type", statement);
    else if (ts.isEnumDeclaration(statement)) addSymbol(statement.name.text, "enum", statement);
    else if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) addSymbol(declaration.name.text, "function", declaration);
    }
    if (symbolDetails.length >= 200) break;
  }
  return { imports, symbols: symbolDetails.map((item) => item.name), symbolDetails };
}

function tsResolutionBasis(specifier, options) {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return "relative-path";
  for (const pattern of Object.keys(options.paths ?? {})) {
    const wildcard = pattern.indexOf("*");
    if (wildcard < 0 ? pattern === specifier : specifier.startsWith(pattern.slice(0, wildcard)) && specifier.endsWith(pattern.slice(wildcard + 1))) return "config-alias";
  }
  return "typescript-resolution";
}
