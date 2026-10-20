import { spawn } from "node:child_process";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { canPromoteRelease, getGitProvenance, hashBuildInputs } from "./release-provenance.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runId = `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const workRoot = path.join(root, ".artifacts", "desktop-candidates", runId);
const candidateDirectory = path.join(workRoot, "package");
const releaseDirectory = path.join(root, "release");
const backupDirectory = path.join(root, ".artifacts", "desktop-backups", runId);
const logPath = path.join(workRoot, "package-and-smoke.log");
await mkdir(candidateDirectory, { recursive: true });

let log = "";
function run(executable, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, env, windowsHide: true, shell: process.platform === "win32" && executable.endsWith(".cmd"), stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => { const value = chunk.toString("utf8"); log += value; process.stdout.write(value); });
    child.stderr.on("data", (chunk) => { const value = chunk.toString("utf8"); log += value; process.stderr.write(value); });
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0 ? resolve() : reject(new Error(`${executable} exited with ${code ?? signal}`)));
  });
}

function runNpm(args, env = process.env) {
  const npmCli = env.npm_execpath;
  if (npmCli) return run(process.execPath, [npmCli, ...args], env);
  const executable = process.platform === "win32" ? "npm.cmd" : "npm";
  return run(executable, args, env);
}

let previousMoved = false;
try {
  const provenance = getGitProvenance(root);
  const initialInputs = await hashBuildInputs(root);
  await runNpm(["run", "build:desktop"]);
  const builderCli = path.join(root, "node_modules", "electron-builder", "out", "cli", "cli.js");
  await access(builderCli);
  await run(process.execPath, [
    builderCli,
    "--win", "--x64",
    `--config.electronDist=${path.join(root, "node_modules", "electron", "dist")}`,
    `--config.directories.output=${candidateDirectory}`,
  ]);
  const executable = path.join(candidateDirectory, "win-unpacked", "RepoLens.exe");
  await access(executable);
  const env = { ...process.env, REPOLENS_RELEASE_DIRECTORY: candidateDirectory, REPOLENS_DESKTOP_EXECUTABLE: executable };
  await run(process.execPath, [path.join(root, "scripts", "write-desktop-checksums.mjs")], env);
  await run(process.execPath, [path.join(root, "scripts", "desktop-smoke.mjs")], env);

  const finalProvenance = getGitProvenance(root);
  const finalInputs = await hashBuildInputs(root);
  const manifest = JSON.parse(await readFile(path.join(candidateDirectory, "BUILD-MANIFEST.json"), "utf8"));
  const inputsStayedStable = initialInputs.sourceInputsSha256 === finalInputs.sourceInputsSha256
    && manifest.sourceInputsSha256 === initialInputs.sourceInputsSha256
    && provenance.sourceCommit === finalProvenance.sourceCommit;
  if (!canPromoteRelease(provenance) || !canPromoteRelease(finalProvenance) || !inputsStayedStable) {
    const reasons = [!canPromoteRelease(provenance) || !canPromoteRelease(finalProvenance) ? "构建使用了未提交源码" : null, !inputsStayedStable ? "构建期间源码输入发生变化" : null].filter(Boolean);
    await writeFile(path.join(workRoot, "CANDIDATE-ONLY.txt"), `此包仅作为候选，不会替换 release。\n提交：${provenance.sourceCommit}\n原因：${reasons.join("；")}\n参与文件哈希见 package/BUILD-MANIFEST.json。\n`, "utf8");
    process.stdout.write(`开发候选包已通过烟测并保留在 ${candidateDirectory}；${reasons.join("；")}，正式 release 未改变。\n`);
  } else {
    try {
      await access(releaseDirectory);
      await mkdir(path.dirname(backupDirectory), { recursive: true });
      await rename(releaseDirectory, backupDirectory);
      previousMoved = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`无法安全替换现有 release；旧包保持原位：${error.message}`);
    }
    try {
      await rename(candidateDirectory, releaseDirectory);
    } catch (error) {
      if (previousMoved) {
        await rename(backupDirectory, releaseDirectory).catch((restoreError) => { throw new AggregateError([error, restoreError], "候选包推广失败，且旧包回滚也失败。"); });
        previousMoved = false;
      }
      throw error;
    }
    if (previousMoved) {
      await rm(backupDirectory, { recursive: true, force: true }).catch((error) => {
        log += `旧包已成功替换；旧包备份保留在 ${backupDirectory}：${error.message}\n`;
      });
    }
    await rm(workRoot, { recursive: true, force: true }).catch(() => {});
    process.stdout.write("候选桌面包已通过保存、恢复、清除和退出烟测，并更新到 release。\n");
  }
} catch (error) {
  await mkdir(workRoot, { recursive: true });
  await writeFile(logPath, `${log}\n${error.stack ?? error.message}\n`, "utf8");
  process.stderr.write(`桌面包未推广；现有 release 保持不变。候选与日志保留于 ${workRoot}\n`);
  process.exitCode = 1;
}
