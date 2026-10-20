import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getGitProvenance } from "./release-provenance.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const provenance = getGitProvenance(root);
if (provenance.workingTreeDirty) throw new Error("干净源码检查只接受无未提交改动的提交；本次检查已停止。");
const evidenceDirectory = path.join(root, ".artifacts", "clean-source", `${Date.now()}-${process.pid}`);
const checkout = path.join(evidenceDirectory, "checkout");
const logs = [];
await mkdir(evidenceDirectory, { recursive: true });

function run(executable, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { cwd, windowsHide: true, shell: process.platform === "win32" && executable.endsWith(".cmd"), stdio: ["ignore", "pipe", "pipe"] });
    const output = [];
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      output.push(text);
      (stream === child.stdout ? process.stdout : process.stderr).write(text);
    });
    child.once("error", (error) => resolve({ code: 1, output: [...output, error.stack ?? error.message].join("") }));
    child.once("close", (code, signal) => resolve({ code: code ?? 1, signal, output: output.join("") }));
  });
}

async function step(name, executable, args, cwd) {
  process.stdout.write(`\n[clean-source:${name}] 开始\n`);
  const result = await run(executable, args, cwd);
  await writeFile(path.join(evidenceDirectory, `${name}.log`), result.output, "utf8");
  logs.push({ name, exitCode: result.code, ...(result.signal ? { signal: result.signal } : {}) });
  await writeFile(path.join(evidenceDirectory, "summary.json"), JSON.stringify({ sourceCommit: provenance.sourceCommit, steps: logs }, null, 2), "utf8");
  if (result.code !== 0) throw new Error(`${name} 失败；日志保留在 ${evidenceDirectory}`);
}

try {
  await step("clone", "git", ["clone", "--shared", "--no-checkout", root, checkout], root);
  await step("checkout", "git", ["checkout", "--detach", provenance.sourceCommit], checkout);
  const npmCli = process.env.npm_execpath;
  const npmExecutable = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  const npmArgs = (args) => npmCli ? [npmCli, ...args] : args;
  await step("install", npmExecutable, npmArgs(["ci", "--no-audit", "--no-fund"]), checkout);
  await step("typecheck", npmExecutable, npmArgs(["run", "typecheck"]), checkout);
  await step("browser-build", npmExecutable, npmArgs(["run", "build"]), checkout);
  await step("desktop-build", npmExecutable, npmArgs(["run", "build:desktop"]), checkout);
  await step("startup-matrix", process.execPath, [path.join(checkout, "scripts", "check-startup.mjs")], checkout);
  await rm(checkout, { recursive: true, force: true });
  process.stdout.write(`\n干净提交 ${provenance.sourceCommit} 的独立依赖安装与构建检查通过；证据：${evidenceDirectory}\n`);
} catch (error) {
  await rm(checkout, { recursive: true, force: true }).catch(() => {});
  await writeFile(path.join(evidenceDirectory, "failure.txt"), `${error.stack ?? error.message}\n`, "utf8").catch(() => {});
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
