import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const APPLICATION_ROOTS = ["desktop", "data", "scripts/local-server.mjs", "package.json"];
const BUILD_INPUT_ROOTS = [
  "hooks", "lib", "public", "vendor", "app", "build", "components", "data", "desktop", "fixtures", "scripts",
  ".npmrc", "index.html", "components.json", "THIRD-PARTY-NOTICES.md", "package.json", "package-lock.json", "tsconfig.json", "vite.config.ts",
  "postcss.config.mjs", "eslint.config.mjs",
];

async function visit(root, relativePath, output, includeTests = false) {
  const absolutePath = path.join(root, relativePath);
  const entries = await readdir(absolutePath, { withFileTypes: true });
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    const childPath = path.join(relativePath, entry.name);
    if (entry.isDirectory()) await visit(root, childPath, output, includeTests);
    else if (entry.isFile() && (includeTests || !/\.test\.[^.]+$/.test(entry.name))) output.push(childPath);
  }
}

export async function hashPackagedApplication(root, { actual = false } = {}) {
  const paths = [];
  for (const relativePath of actual ? await readdir(root) : APPLICATION_ROOTS) {
    try {
      const entries = await readdir(path.join(root, relativePath), { withFileTypes: true });
      if (entries.length) await visit(root, relativePath, paths, actual);
    } catch (error) {
      if (error.code === "ENOTDIR") paths.push(relativePath);
      else if (error.code !== "ENOENT") throw error;
    }
  }

  const files = [];
  for (const relativePath of [...new Set(paths)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)) {
    const contents = await readFile(path.join(root, relativePath));
    files.push({ path: relativePath.split(path.sep).join("/"), sizeBytes: contents.length, sha256: createHash("sha256").update(contents).digest("hex") });
  }
  const sourceTreeSha256 = createHash("sha256").update(files.map(({ path: name, sizeBytes, sha256 }) => `${name}\0${sizeBytes}\0${sha256}\n`).join("")).digest("hex");
  return { sourceTreeSha256, sourceFiles: files };
}

export async function hashBuildInputs(root) {
  const paths = [];
  for (const relativePath of BUILD_INPUT_ROOTS) {
    try {
      const info = await stat(path.join(root, relativePath));
      if (info.isDirectory()) await visit(root, relativePath, paths);
      else if (info.isFile()) paths.push(relativePath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const excluded = paths.filter((relativePath) => {
    const normalized = relativePath.split(path.sep).join("/");
    return /(^|\/)(node_modules|dist|\.next|\.artifacts|renderer)(\/|$)/.test(normalized)
      || /\.test\.[^.]+$/.test(normalized);
  });
  const files = [];
  for (const relativePath of [...new Set(paths)].filter((item) => !excluded.includes(item)).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)) {
    const contents = await readFile(path.join(root, relativePath));
    files.push({ path: relativePath.split(path.sep).join("/"), sizeBytes: contents.length, sha256: createHash("sha256").update(contents).digest("hex") });
  }
  const sourceInputsSha256 = createHash("sha256").update(files.map(({ path: name, sizeBytes, sha256 }) => `${name}\0${sizeBytes}\0${sha256}\n`).join("")).digest("hex");
  return { sourceInputsSha256, sourceInputs: files };
}

export function getGitProvenance(root) {
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).trim();
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8", windowsHide: true }).trim();
  return { sourceCommit, workingTreeDirty: status.length > 0 };
}

export function canPromoteRelease({ workingTreeDirty, candidateOnly = false }) {
  return workingTreeDirty === false && candidateOnly === false;
}

export async function verifyCandidateArtifacts(directory, artifacts) {
  if (!Array.isArray(artifacts) || !artifacts.length) throw new Error("候选包缺少校验清单。");
  for (const artifact of artifacts) {
    if (typeof artifact.name !== "string" || path.basename(artifact.name) !== artifact.name) throw new Error("候选文件名无效。");
    const content = await readFile(path.join(directory, artifact.name));
    if (content.length !== artifact.sizeBytes || createHash("sha256").update(content).digest("hex") !== artifact.sha256) throw new Error(`候选文件与清单不一致：${artifact.name}`);
  }
}
