import { extractAll } from "@electron/asar";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getGitProvenance, hashBuildInputs, hashPackagedApplication } from "./release-provenance.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDirectory = path.resolve(process.env.REPOLENS_RELEASE_DIRECTORY ?? path.join(root, "release"));
const expected = ["Setup", "Portable"];
await mkdir(releaseDirectory, { recursive: true });
const names = (await readdir(releaseDirectory)).filter((name) => name.endsWith(".exe") && name.startsWith("RepoLens-") && (name.includes("-Setup.") || name.includes("-Portable.")));
for (const label of expected) {
  if (!names.some((name) => name.includes(`-${label}.`))) throw new Error(`桌面发行目录缺少 ${label} 程序。`);
}

const lines = [];
const files = [];
for (const name of names.sort()) {
  const filePath = path.join(releaseDirectory, name);
  const contents = await readFile(filePath);
  const sha256 = createHash("sha256").update(contents).digest("hex");
  lines.push(`${sha256}  ${name}`);
  files.push({ name, sizeBytes: (await stat(filePath)).size, sha256 });
  await writeFile(path.join(releaseDirectory, `${name}.sha256`), `${sha256}  ${name}\n`, "utf8");
}
await writeFile(path.join(releaseDirectory, "SHA256SUMS.txt"), `${lines.join("\n")}\n`, "utf8");

const { sourceCommit, workingTreeDirty } = getGitProvenance(root);
const extracted = await mkdtemp(path.join(os.tmpdir(), "repolens-manifest-"));
let packaged;
try { extractAll(path.join(releaseDirectory, "win-unpacked", "resources", "app.asar"), extracted); packaged = await hashPackagedApplication(extracted, { actual: true }); }
finally { await rm(extracted, { recursive: true, force: true }); }
const { sourceTreeSha256, sourceFiles } = packaged;
const { sourceInputsSha256, sourceInputs } = await hashBuildInputs(root);
const appPackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const electronPackage = JSON.parse(await readFile(path.join(root, "node_modules", "electron", "package.json"), "utf8"));
const manifest = {
  application: appPackage.name,
  applicationVersion: appPackage.version,
  sourceCommit,
  workingTreeDirty,
  sourceTreeSha256,
  sourceFiles,
  packagedArchiveSha256: createHash("sha256").update(await readFile(path.join(releaseDirectory, "win-unpacked", "resources", "app.asar"))).digest("hex"),
  sourceInputsSha256,
  sourceInputs,
  nodeVersion: process.version,
  electronVersion: electronPackage.version,
  builtAt: new Date().toISOString(),
  artifacts: files,
};
await writeFile(path.join(releaseDirectory, "BUILD-MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`${lines.join("\n")}\n`);
