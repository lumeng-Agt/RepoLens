import { createHash } from "node:crypto";
import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDirectory = path.join(root, "release");
const expected = ["Setup", "Portable"];
const names = (await readdir(releaseDirectory)).filter((name) => name.endsWith(".exe") && name.startsWith("RepoLens-") && (name.includes("-Setup.") || name.includes("-Portable.")));
for (const label of expected) {
  if (!names.some((name) => name.includes(`-${label}.`))) throw new Error(`桌面发行目录缺少 ${label} 程序。`);
}
const listed = new Set(names);
for (const name of await readdir(releaseDirectory)) {
  if (name.startsWith("RepoLens-") && name.endsWith(".exe") && !listed.has(name)) {
    await unlink(path.join(releaseDirectory, name));
    for (const suffix of [".blockmap", ".sha256"]) await unlink(path.join(releaseDirectory, `${name}${suffix}`)).catch(() => {});
  }
  if (name.startsWith("RepoLens-") && name.endsWith(".exe.sha256") && !listed.has(name.slice(0, -".sha256".length))) await unlink(path.join(releaseDirectory, name));
}
const lines = [];
for (const name of names.sort()) {
  const contents = await readFile(path.join(releaseDirectory, name));
  const digest = createHash("sha256").update(contents).digest("hex");
  lines.push(`${digest}  ${name}`);
  await writeFile(path.join(releaseDirectory, `${name}.sha256`), `${digest}  ${name}\n`, "utf8");
}
await writeFile(path.join(releaseDirectory, "SHA256SUMS.txt"), `${lines.join("\n")}\n`, "utf8");
process.stdout.write(`${lines.join("\n")}\n`);
