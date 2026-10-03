import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import ignore from "ignore";
import { parsePolyglot } from "./polyglot-parser.mjs";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".css", ".scss", ".sass", ".less", ".py", ".pyi", ".go"]);
const TS_RESOLUTION_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".css", ".scss", ".sass", ".less"];
const BASE_IGNORES = [".git", "node_modules", ".next", "dist", "build", "coverage", ".wrangler", ".vinext", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", "vendor"];
const MAX_FILES = 5000;
const MAX_BYTES = 1024 * 1024;
const PYTHON_STDLIB = new Set("abc argparse array asyncio base64 bisect builtins calendar cmath collections concurrent contextlib copy csv ctypes dataclasses datetime decimal difflib dis email enum errno faulthandler fnmatch fractions functools gc getpass glob hashlib heapq hmac html http importlib inspect io itertools json logging math multiprocessing numbers operator os pathlib pdb pickle platform pprint queue random re shutil signal socket sqlite3 statistics string subprocess sys tempfile threading time tkinter traceback typing unittest urllib uuid warnings weakref xml zipfile zoneinfo".split(" "));
const GO_STDLIB = new Set("archive bufio bytes cmp compress container context crypto database debug embed encoding errors expvar flag fmt go hash html image index io log maps math mime net os path reflect regexp runtime slices sort strconv strings sync syscall testing text time unicode unique unsafe iter structs version".split(" "));
const DEFAULT_COMPILER_OPTIONS = Object.freeze({ allowJs: true, jsx: ts.JsxEmit.Preserve, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.Latest });

function digest(text) { return createHash("sha256").update(text).digest("hex"); }
function normalizeTsPath(fileName) { return path.resolve(fileName).replaceAll("\\", "/"); }
function fingerprintPath(root, fileName) {
  const absolute = path.resolve(fileName);
  const relative = path.relative(root, absolute);
  if (relative === "") return ".";
  if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) return relative.split(path.sep).join("/");
  return absolute.replaceAll("\\", "/");
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
  const parts = relative.split("/");
  return parts.some((part) => BASE_IGNORES.includes(part) || part.startsWith(".env"));
}
function findNearestConfigs(root, filePath, directoryCache) {
  let directory = path.dirname(path.join(root, ...filePath.split("/")));
  const visited = [];
  let found = null;
  while (directory === root || directory.startsWith(`${root}${path.sep}`)) {
    if (directoryCache.has(directory)) { found = directoryCache.get(directory); break; }
    visited.push(directory);
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const candidate = path.join(directory, name);
      if (ts.sys.fileExists(candidate)) { found = candidate; break; }
    }
    if (found) break;
    if (directory === root) break;
    directory = path.dirname(directory);
  }
  for (const visitedDirectory of visited) directoryCache.set(visitedDirectory, found);
  return found;
}
function compilerOptions(configPath, configHashes, stats) {
  if (!configPath) return { options: DEFAULT_COMPILER_OPTIONS, configFiles: new Map(), missingConfigFiles: new Set(), diagnostics: [] };
  const configFiles = new Map();
  const missingConfigFiles = new Set();
  const syntaxDiagnostics = new Map();
  const unrecoverableDiagnostics = [];
  const host = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic) { unrecoverableDiagnostics.push(diagnostic); },
    fileExists(fileName) {
      const normalized = normalizeTsPath(fileName);
      const exists = ts.sys.fileExists(normalized);
      if (exists) missingConfigFiles.delete(normalized);
      else missingConfigFiles.add(normalized);
      return exists;
    },
    readFile(fileName) {
      const absolute = normalizeTsPath(fileName);
      const content = ts.sys.readFile(absolute);
      if (content === undefined) {
        missingConfigFiles.add(absolute);
        configHashes.set(absolute, "missing");
        return content;
      }
      const contentHash = digest(content);
      missingConfigFiles.delete(absolute);
      configHashes.set(absolute, contentHash);
      stats.configReadCount += 1;
      try {
        const info = statSync(absolute);
        configFiles.set(absolute, { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, contentHash });
      } catch {}
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
    if (!ts.sys.fileExists(fileName)) configHashes.set(fileName, "missing");
  }
  const rawDiagnostics = [...(parsed?.errors ?? []), ...unrecoverableDiagnostics];
  const diagnostics = [...syntaxDiagnostics.values()];
  for (const diagnostic of rawDiagnostics) {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
    const fileName = diagnostic.file?.fileName ? normalizeTsPath(diagnostic.file.fileName) : normalizeTsPath(configPath);
    diagnostics.push({ path: fileName, message: `TypeScript 配置诊断 TS${diagnostic.code}: ${message}` });
  }
  const uniqueDiagnostics = [...new Map(diagnostics.map((diagnostic) => [`${diagnostic.path}:${diagnostic.message}`, diagnostic])).values()];
  return {
    options: syntaxDiagnostics.size > 0 || !parsed ? DEFAULT_COMPILER_OPTIONS : parsed.options,
    configFiles,
    missingConfigFiles,
    diagnostics: uniqueDiagnostics,
    parseState: syntaxDiagnostics.size > 0 ? "syntax-error" : parsed ? "parsed" : "unrecoverable",
  };
}
async function configCacheIsValid(cached, configHashes, stats) {
  for (const [fileName, previous] of cached.configFiles) {
    try {
      const content = await readFile(fileName, "utf8");
      stats.configReadCount += 1;
      const contentHash = digest(content);
      if (contentHash !== previous.contentHash) return false;
      configHashes.set(fileName, contentHash);
    } catch { return false; }
  }
  for (const fileName of cached.missingConfigFiles ?? []) {
    if (ts.sys.fileExists(fileName)) return false;
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
  const root = await realpath(requestedRoot);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("请选择一个真实的本地文件夹。");
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
        const contents = await readFile(absolute, "utf8");
        const relative = path.relative(root, absolute).split(path.sep).join("/");
        ignoreContents[relative] = contents;
        localMatcher.add(contents);
        hasLocalRules = true;
      } catch {}
    }
    if (hasLocalRules) localRules.push({ base: path.relative(root, directory).split(path.sep).join("/"), matcher: localMatcher });
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { diagnostics.push({ path: path.relative(root, directory), message: error.message }); return; }
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
    try { languageConfigContents.set(relative, await readFile(path.join(root, ...relative.split("/")), "utf8")); }
    catch (error) { diagnostics.push({ path: relative, message: `语言配置读取失败：${error.message}` }); }
  }
  const languageConfigHashes = new Map([...languageConfigContents].map(([relative, contents]) => [relative, digest(contents)]));
  const languageConfigChanged = !previous || languageConfigHashes.size !== (previous.languageConfigHashes?.size ?? 0) || [...languageConfigHashes].some(([key, value]) => previous.languageConfigHashes?.get(key) !== value);
  const goModules = languageConfigChanged || !previous.goModules ? buildGoModules(languageConfigContents, root) : previous.goModules;
  const languageConfigParseCount = languageConfigChanged ? 1 : 0;
  diagnostics.push(...(goModules.diagnostics ?? []));
  const configHashes = new Map();
  const directoryConfigCache = new Map();
  const configsByFile = new Map(paths.map((filePath) => [filePath, findNearestConfigs(root, filePath, directoryConfigCache)]));
  const configCache = new Map();
  const previousConfigCache = previous?.configCache ?? new Map();
  let configParseCount = 0;
  for (const configPath of new Set(configsByFile.values())) {
    if (!configPath) { configCache.set(null, { options: DEFAULT_COMPILER_OPTIONS, configFiles: new Map(), missingConfigFiles: new Set(), parseState: "no-config", diagnostics: [] }); continue; }
    const cached = previousConfigCache.get(configPath);
    if (cached && await configCacheIsValid(cached, configHashes, scanStats)) {
      configCache.set(configPath, cached);
    } else {
      const parsed = compilerOptions(configPath, configHashes, scanStats);
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
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) continue;
    if (info.size > MAX_BYTES) { diagnostics.push({ path: relative, message: "文件超过 1 MiB，已跳过。" }); continue; }
    const old = previous?.files.get(relative);
    const oldMetadata = previous?.metadata?.get(relative);
    const currentMetadata = { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ino: info.ino };
    const metadataMatches = old && oldMetadata && previous.sourceCache.has(relative) && Object.keys(currentMetadata).every((key) => oldMetadata[key] === currentMetadata[key]);
    const explicitlyDirty = explicitlyChanged.has(relative);
    const canReuseWithoutRead = scanMode === "incremental" && metadataMatches && !explicitlyDirty;
    const source = canReuseWithoutRead ? previous.sourceCache.get(relative) : await readFile(absolute, "utf8");
    if (!canReuseWithoutRead) sourceReadCount += 1;
    const contentHash = canReuseWithoutRead ? old.contentHash : digest(source);
    const contentChanged = !old || old.contentHash !== contentHash;
    const parsedStructure = contentChanged ? await extractFileStructure(source, absolute, relative) : { imports: old.imports, symbols: old.symbols ?? [] };
    const parsedImports = parsedStructure.imports;
    if (contentChanged) parsedFileCount += 1;
    const ext = path.extname(relative).slice(1).toLowerCase();
    const kind = ["css", "scss", "sass", "less"].includes(ext) ? "style" : ["py", "pyi"].includes(ext) ? "python" : ext === "go" ? "go" : "typescript";
    const language = ["py", "pyi"].includes(ext) ? "python" : ext;
    const conditionalGo = kind === "go" && /(?:^|\n)\s*\/\/(?:go:build|\+build)\b/.test(source);
    files.set(relative, { id: relative, path: relative, name: path.basename(relative), kind, role: kind === "python" ? "Python 模块" : kind === "go" ? conditionalGo ? "Go 条件编译文件" : "Go 源文件" : path.basename(relative), summary: "本地仓库文件；当前内容来自静态分析。", imports: parsedImports, symbols: parsedStructure.symbols, contentHash, language });
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
        if (target) {
          dependencies.push({ id: `${file.id}::${target}::${imported.line}`, fromId: file.id, toId: target, specifier: imported.specifier, kind: imported.kind, resolution: "file", typeOnly: false, reference: { fileId: file.id, line: imported.line } });
        } else {
          const rootModule = imported.specifier.replace(/^\.+/, "").split(".")[0];
          const standard = !imported.specifier.startsWith(".") && PYTHON_STDLIB.has(rootModule);
          const dynamic = imported.kind === "dynamic";
          unresolved.push({ fileId: file.id, specifier: imported.specifier, line: imported.line, kind: dynamic ? "dynamic" : standard ? "standard-library" : "unresolved", external: !dynamic && (standard || !imported.specifier.startsWith(".")) });
        }
      }
      continue;
    }
    if (file.kind === "go") {
      for (const imported of file.imports) {
        const packageDirectory = resolveGoPackage(imported.specifier, goModules);
        const targets = packageDirectory ? goFiles.filter((candidate) => path.posix.dirname(candidate) === packageDirectory && !path.posix.basename(candidate).endsWith("_test.go")) : [];
        if (targets.length) {
          for (const target of targets) dependencies.push({ id: `${file.id}::${target}::${imported.line}`, fromId: file.id, toId: target, specifier: imported.specifier, kind: "package", resolution: "package", typeOnly: false, reference: { fileId: file.id, line: imported.line } });
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
    if (!compilerHostsByConfig.has(configPath)) compilerHostsByConfig.set(configPath, ts.createCompilerHost(options));
    const compilerHost = compilerHostsByConfig.get(configPath);
    for (const imported of file.imports) {
      const fromAbsolute = path.join(root, ...file.path.split("/"));
      const resolved = ts.resolveModuleName(imported.specifier, fromAbsolute, options, compilerHost).resolvedModule?.resolvedFileName;
      let target = resolved ? path.relative(root, resolved).split(path.sep).join("/") : "";
      if (!target || target.startsWith("../") || path.isAbsolute(target) || !known.has(target)) {
        const base = path.resolve(path.dirname(fromAbsolute), imported.specifier);
        target = extensions.map((extension) => path.relative(root, `${base}${extension}`).split(path.sep).join("/")).find((candidate) => known.has(candidate)) ?? "";
      }
      if (target && known.has(target)) dependencies.push({ id: `${file.id}::${target}::${imported.line}`, fromId: file.id, toId: target, specifier: imported.specifier, kind: imported.kind, typeOnly: imported.typeOnly, resolution: "file", reference: { fileId: file.id, line: imported.line } });
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
  const fingerprint = digest(JSON.stringify({ files: [...files.values()].map(({ id, contentHash }) => [id, contentHash]), dependencies: dependencies.map(({ fromId, toId, specifier, kind, typeOnly, resolution, reference }) => [fromId, toId, specifier, kind, typeOnly, resolution, reference.line]), unresolved, ignoreContents, configHashes: stableConfigHashes, configState, languageConfigHashes: stableLanguageConfigHashes, goModules }));
  const sequence = previous?.snapshot.sequence ? previous.snapshot.sequence + (previous.snapshot.revision === fingerprint ? 0 : 1) : 1;
  const snapshot = { id, version: fingerprint.slice(0, 16), revision: fingerprint, sequence, name: path.basename(root), description: root, source: "local", diagnostics: [...diagnostics, ...unresolved.map((item) => ({ path: item.fileId, message: `${item.external ? "外部依赖" : "未解析引用"}: ${item.specifier}（第 ${item.line} 行）` }))], files: [...files.values()], dependencies, unresolved, tour: [], configPath: [...configHashes].filter(([, hash]) => hash !== "missing").map(([config]) => path.relative(root, config).split(path.sep).join("/")) };
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

function resolvePythonImport(filePath, specifier, known, pythonFiles) {
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
  const available = new Set(pythonFiles);
  for (const base of roots) {
    if (!base || base === ".") continue;
    const candidates = [
      `${base}.py`, `${base}.pyi`, `${base}/__init__.py`, `${base}/__init__.pyi`,
    ];
    const target = candidates.find((candidate) => available.has(candidate) && known.has(candidate));
    if (target) return target;
  }
  return null;
}

async function extractFileStructure(source, fileName, relativePath) {
  const extension = path.extname(fileName).toLowerCase();
  if ([".py", ".pyi"].includes(extension)) return parsePolyglot(source, relativePath, "python");
  if (extension === ".go") return parsePolyglot(source, relativePath, "go");
  return { imports: extractImports(source, fileName), symbols: [] };
}

function extractImports(source, fileName) {
  if ([".css", ".scss", ".sass", ".less"].includes(path.extname(fileName).toLowerCase())) {
    return [...source.matchAll(/@import\s+["']([^"']+)["']/g)].map((match) => ({ specifier: match[1], line: source.slice(0, match.index).split("\n").length, kind: "style", typeOnly: false }));
  }
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
  return imports;
}
