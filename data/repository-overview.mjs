import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

const README_NAMES = ["README.md", "README.rst", "README.txt", "README"];
const MANIFEST_NAMES = ["package.json", "pyproject.toml", "go.mod", "go.work", "Cargo.toml", "requirements.txt"];
const isTestPath = (value) => /(^|[/_.-])(test|tests|spec|specs)([/_.-]|$)|\.(test|spec)\./i.test(value);

async function safeReadKnownFile(root, name, maximumBytes) {
  const target = path.join(root, name);
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maximumBytes) return null;
    return await readFile(target, "utf8");
  } catch { return null; }
}

function readmeSummary(content) {
  if (!content) return null;
  const lines = content.replaceAll("\r", "").split("\n").map((line) => line.trim()).filter(Boolean)
    .filter((line) => !line.startsWith("![") && !/^https?:\/\//i.test(line));
  return lines.slice(0, 8).join("\n").slice(0, 1_200) || null;
}

export async function buildRepositoryOverview(root, snapshot) {
  let readme = null;
  for (const name of README_NAMES) {
    const content = await safeReadKnownFile(root, name, 256 * 1024);
    if (content !== null) { readme = { path: name, summary: readmeSummary(content) }; break; }
  }
  const manifests = [];
  for (const name of MANIFEST_NAMES) if (await safeReadKnownFile(root, name, 64 * 1024) !== null) manifests.push(name);
  const incoming = new Set(snapshot.dependencies.map((edge) => edge.toId));
  const preferred = /^(index|main|app|cli|server|manage|wsgi|asgi)\./i;
  const candidates = snapshot.files.filter((file) => !incoming.has(file.id) || preferred.test(file.name)).map((file) => ({
    fileId: file.id,
    path: file.path,
    reason: preferred.test(file.name) ? "文件名符合常见入口命名" : "没有仓库内文件直接引用此文件",
  })).sort((a, b) => Number(preferred.test(path.posix.basename(b.path))) - Number(preferred.test(path.posix.basename(a.path))) || a.path.localeCompare(b.path)).slice(0, 12);
  const directories = new Map();
  const languages = new Map();
  const tests = [];
  for (const file of snapshot.files) {
    const top = file.path.split("/")[0];
    if (top && top !== file.path) directories.set(top, (directories.get(top) ?? 0) + 1);
    const language = file.language || file.kind;
    languages.set(language, (languages.get(language) ?? 0) + 1);
    if (isTestPath(file.path)) tests.push(file.path);
  }
  return {
    revision: snapshot.revision ?? snapshot.version,
    readme,
    manifests,
    candidates,
    directories: [...directories].sort(([a], [b]) => a.localeCompare(b)).slice(0, 20).map(([name, files]) => ({ name, files })),
    languages: [...languages].sort((a, b) => b[1] - a[1]).map(([name, files]) => ({ name, files })),
    tests: tests.slice(0, 30),
    testCount: tests.length,
    diagnosticCount: snapshot.diagnostics?.length ?? 0,
    limitations: "入口是根据静态引用和文件名筛出的候选；依赖关系表示静态引用，不代表运行时调用。",
  };
}
