import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
const evidenceDirectory = path.join(root, ".artifacts", "verify", stamp);
await mkdir(evidenceDirectory, { recursive: true });

const steps = [
  ["typecheck", ["run", "typecheck"]],
  ["lint", ["run", "lint"]],
  ["node", ["test"]],
  ["desktop-candidate-package-and-smoke", ["run", "package:desktop"]],
  ["browser-and-service", ["run", "test:e2e"]],
  ["browser-build", ["run", "build"]],
  ["desktop-renderer-build", ["run", "build:desktop"]],
  ["startup-matrix", ["run", "check:startup"]],
  ["restore-default-browser-build", ["run", "build"]],
];
const results = [];
const npmCli = process.env.npm_execpath;
const npmCommand = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
const apiPortReservation = createServer();
await new Promise((resolve, reject) => apiPortReservation.listen(0, "127.0.0.1", resolve).once("error", reject));
const reservedApiPort = apiPortReservation.address().port;
const productionBuildEnvironment = {
  ...process.env,
  NEXT_PUBLIC_REPOLENS_API_ORIGIN: `http://127.0.0.1:${reservedApiPort}`,
};
let apiPortReleased = false;
let defaultBuildRestored = false;

async function releaseApiPortReservation() {
  if (apiPortReleased) return;
  apiPortReleased = true;
  await new Promise((resolve, reject) => apiPortReservation.close((error) => error ? reject(error) : resolve()));
}

function runStep(args, logPath, environment = process.env) {
  return new Promise((resolve) => {
    const child = spawn(npmCommand, npmCli ? [npmCli, ...args] : args, { cwd: root, env: environment, windowsHide: true, shell: !npmCli && process.platform === "win32", stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      chunks.push(text);
      (stream === child.stdout ? process.stdout : process.stderr).write(text);
    });
    child.once("error", (error) => resolve({ code: 1, output: [...chunks, error.stack ?? error.message].join("") }));
    child.once("close", (code, signal) => resolve({ code: code ?? 1, signal, output: chunks.join("") }));
  }).then(async (result) => {
    await writeFile(logPath, result.output, "utf8");
    return result;
  });
}

console.log(`RepoLens 验收运行开始；逐步执行，证据目录：${evidenceDirectory}`);
try {
  for (const [name, args] of steps) {
    if (name === "startup-matrix") await releaseApiPortReservation();
    const startedAt = new Date().toISOString();
    console.log(`\n[${name}] 开始`);
    const environment = name === "browser-build" || name === "startup-matrix" ? productionBuildEnvironment
      : name === "desktop-candidate-package-and-smoke" ? { ...process.env, REPOLENS_CANDIDATE_ONLY: "1" } : process.env;
    const result = await runStep(args, path.join(evidenceDirectory, `${name}.log`), environment);
    const record = { name, command: `npm ${args.join(" ")}`, startedAt, finishedAt: new Date().toISOString(), exitCode: result.code, ...(result.signal ? { signal: result.signal } : {}) };
    results.push(record);
    if (name === "restore-default-browser-build") defaultBuildRestored = result.code === 0;
    await writeFile(path.join(evidenceDirectory, "summary.json"), JSON.stringify({ node: process.version, platform: process.platform, productionApiOrigin: productionBuildEnvironment.NEXT_PUBLIC_REPOLENS_API_ORIGIN, defaultApiOriginRestored: results.some((step) => step.name === "restore-default-browser-build" && step.exitCode === 0), steps: results }, null, 2), "utf8");
    if (result.code !== 0) {
      console.error(`[${name}] 失败，已停止后续检查；日志保留在 ${evidenceDirectory}`);
      process.exitCode = result.code;
      break;
    }
    console.log(`[${name}] 通过`);
  }
} finally {
  await releaseApiPortReservation();
  if (!defaultBuildRestored) {
    const startedAt = new Date().toISOString();
    console.log("\n[restore-default-browser-build] 恢复默认本地服务地址构建");
    const result = await runStep(["run", "build"], path.join(evidenceDirectory, "restore-default-browser-build.log"), process.env);
    results.push({ name: "restore-default-browser-build", command: "npm run build", startedAt, finishedAt: new Date().toISOString(), exitCode: result.code, ...(result.signal ? { signal: result.signal } : {}) });
    defaultBuildRestored = result.code === 0;
    await writeFile(path.join(evidenceDirectory, "summary.json"), JSON.stringify({ node: process.version, platform: process.platform, productionApiOrigin: productionBuildEnvironment.NEXT_PUBLIC_REPOLENS_API_ORIGIN, defaultApiOriginRestored: defaultBuildRestored, steps: results }, null, 2), "utf8");
    if (!defaultBuildRestored) process.exitCode = 1;
  }
}

const passed = results.filter((result) => result.exitCode === 0).length;
if (passed === steps.length) console.log(`\nRepoLens 验收检查通过：${passed}/${steps.length}。证据：${evidenceDirectory}`);
