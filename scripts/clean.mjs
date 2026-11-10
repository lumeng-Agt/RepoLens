import { lstat, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const args = new Set(process.argv.slice(2));
if ([...args].some(arg => !["--apply", "--artifacts", "--release"].includes(arg))) {
  throw new Error("用法：npm run clean -- [--apply] [--artifacts] [--release]");
}
const targets = ["dist", "desktop/renderer", "coverage", "test-results", "playwright-report", ".next", ".vinext", ".wrangler", ".sites-runtime"];
if (args.has("--artifacts")) targets.push(".artifacts");
if (args.has("--release")) targets.push("release");

async function sizeOf(directory) {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) bytes += await sizeOf(target);
    else if (entry.isFile()) bytes += (await lstat(target)).size;
  }
  return bytes;
}

let total = 0;
for (const relative of targets) {
  const target = path.resolve(root, relative);
  let info;
  try { info = await lstat(target); }
  catch (error) { if (error.code === "ENOENT") continue; throw error; }
  // Reject a link or redirected parent before measuring or deleting any directory.
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(target) !== target
    || path.relative(root, target) !== path.normalize(relative)) throw new Error(`路径不符合清理范围：${relative}`);
  const bytes = await sizeOf(target);
  if (args.has("--apply")) {
    const current = await lstat(target);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== info.dev || current.ino !== info.ino
      || await realpath(target) !== target) throw new Error(`清理前目录已变化：${relative}`);
    await rm(target, { recursive: true });
  }
  total += bytes;
  console.log(`${relative}\t${(bytes / 1048576).toFixed(1)} MiB`);
}
console.log(`${args.has("--apply") ? "已清理" : "预计可清理"} ${(total / 1048576).toFixed(1)} MiB`);
