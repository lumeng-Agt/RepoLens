import assert from "node:assert/strict";
import { cpus, platform, release, tmpdir, arch } from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { scanRepository } from "../data/localRepository.mjs";
import { fileURLToPath } from "node:url";

const median = (values) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
const rounded = (value) => Math.round(value * 100) / 100;
const sampleStats = (stats) => ({ ...stats, durationMs: rounded(stats.durationMs) });
const report = {
  generatedAt: new Date().toISOString(),
  environment: { node: process.version, platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model ?? "unknown" },
  note: "冷扫描不复用 RepoLens 索引对象；没有清除操作系统磁盘缓存。每次单文件修改都会写入新内容。",
  fixtures: [],
};

async function createFixture(root, configured) {
  if (configured) {
    await mkdir(path.join(root, "config"), { recursive: true });
    await mkdir(path.join(root, "src/core"), { recursive: true });
    await mkdir(path.join(root, "src/generated"), { recursive: true });
    await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ extends: "./config/base.json", include: ["src"] }));
    await writeFile(path.join(root, "config/base.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", moduleResolution: "Bundler", paths: { "@core/*": ["../src/core/*"] } } }));
    await writeFile(path.join(root, "src/main.ts"), 'import { value } from "@core/value"; export { value };\n');
    await writeFile(path.join(root, "src/core/value.ts"), "export const value = 1;\n");
  }
  const batchSize = 250;
  const count = configured ? 4998 : 5000;
  const directory = configured ? path.join(root, "src/generated") : root;
  for (let start = 0; start < count; start += batchSize) {
    await Promise.all(Array.from({ length: Math.min(batchSize, count - start) }, (_, offset) => {
      const index = start + offset;
      return writeFile(path.join(directory, `file-${String(index).padStart(4, "0")}.ts`), `export const file${index} = ${index};\n`);
    }));
  }
}

async function safeRemoveTempRoot(root) {
  const tempRoot = await realpath(tmpdir());
  const target = await realpath(root);
  if (target === tempRoot || !target.startsWith(`${tempRoot}${path.sep}`)) throw new Error(`Refusing to remove a path outside the task temp directory: ${target}`);
  await rm(target, { recursive: true, force: true });
}

async function benchmarkFixture(configured) {
  const root = await mkdtemp(path.join(tmpdir(), configured ? "repolens-benchmark-configured-" : "repolens-benchmark-plain-"));
  try {
    await createFixture(root, configured);
    const cold = [];
    let latest;
    for (let index = 0; index < 3; index += 1) {
      latest = await scanRepository(root);
      assert.equal(latest.stats.candidateCount, 5000);
      if (configured) {
        assert.equal(latest.stats.configParseCount, 1);
        assert.ok(latest.snapshot.dependencies.some((edge) => edge.fromId === "src/main.ts" && edge.toId === "src/core/value.ts"));
      }
      cold.push(sampleStats(latest.stats));
    }

    const incremental = [];
    for (let index = 0; index < 3; index += 1) {
      const fileName = configured ? "src/generated/file-0000.ts" : "file-0000.ts";
      await writeFile(path.join(root, ...fileName.split("/")), `export const file0 = ${index + 100};\n`);
      latest = await scanRepository(root, latest, { mode: "incremental", changedPaths: [fileName] });
      assert.equal(latest.stats.sourceReadCount, 1);
      assert.equal(latest.stats.sourceParseCount, 1);
      assert.equal(latest.stats.configParseCount, 0);
      incremental.push(sampleStats(latest.stats));
    }

    const configuration = [];
    if (configured) {
      for (let index = 0; index < 3; index += 1) {
        await writeFile(path.join(root, "config/base.json"), JSON.stringify({ compilerOptions: {
          baseUrl: ".", moduleResolution: "Bundler", paths: { "@core/*": ["../src/core/*"] },
          strict: index % 2 === 0, noImplicitAny: index % 2 !== 0,
        } }));
        latest = await scanRepository(root, latest);
        assert.equal(latest.stats.configParseCount, 1);
        configuration.push(sampleStats(latest.stats));
      }
    }

    const overflowFile = path.join(root, configured ? "src/generated/file-5000.ts" : "file-5000.ts");
    await writeFile(overflowFile, "export const overLimit = true;\n");
    await assert.rejects(scanRepository(root, latest), /超过 5000 个源码文件/);
    await unlink(overflowFile);
    const samples = { kind: configured ? "继承配置 + 路径别名 + 实际依赖" : "无配置", cold, incremental, configuration };
    samples.medians = {
      coldMs: rounded(median(cold.map((item) => item.durationMs))),
      incrementalMs: rounded(median(incremental.map((item) => item.durationMs))),
      ...(configuration.length ? { configurationMs: rounded(median(configuration.map((item) => item.durationMs))) } : {}),
    };
    return samples;
  } finally {
    await safeRemoveTempRoot(root);
  }
}

async function benchmarkPolyglotFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "repolens-benchmark-polyglot-"));
  try {
    const pythonDirectory = path.join(root, "py", "pkg");
    const goCommandDirectory = path.join(root, "go", "cmd");
    const goPackageDirectory = path.join(root, "go", "internal", "value");
    const typescriptDirectory = path.join(root, "ts");
    await Promise.all([mkdir(pythonDirectory, { recursive: true }), mkdir(goCommandDirectory, { recursive: true }), mkdir(goPackageDirectory, { recursive: true }), mkdir(typescriptDirectory, { recursive: true })]);
    await writeFile(path.join(root, "go", "go.mod"), "module example.com/repolens-mixed/go\n\ngo 1.23\n");
    await writeFile(path.join(pythonDirectory, "base.py"), "VALUE = 1\n");
    await writeFile(path.join(pythonDirectory, "__init__.py"), "");
    await writeFile(path.join(goPackageDirectory, "value.go"), "package value\nconst Value = 1\n");
    await writeFile(path.join(goCommandDirectory, "main.go"), 'package main\nimport "example.com/repolens-mixed/go/internal/value"\nfunc main() { _ = value.Value }\n');

    const languages = [
      { directory: pythonDirectory, count: 1664, extension: ".py", source: (index) => `from .base import VALUE\nvalue${index} = VALUE + ${index}\n` },
      { directory: goPackageDirectory, count: 1666, extension: ".go", source: (index) => `package value\nconst Value${index} = ${index}\n` },
      { directory: typescriptDirectory, count: 1666, extension: ".ts", source: (index) => `export const value${index} = ${index};\n` },
    ];
    for (const language of languages) {
      for (let start = 0; start < language.count; start += 250) {
        await Promise.all(Array.from({ length: Math.min(250, language.count - start) }, (_, offset) => {
          const index = start + offset;
          return writeFile(path.join(language.directory, `module-${String(index).padStart(4, "0")}${language.extension}`), language.source(index));
        }));
      }
    }

    const cold = [];
    let latest;
    for (let index = 0; index < 3; index += 1) {
      latest = await scanRepository(root);
      assert.equal(latest.stats.candidateCount, 5000);
      assert.ok(latest.snapshot.dependencies.some((edge) => edge.fromId === "py/pkg/module-0000.py" && edge.toId === "py/pkg/base.py"));
      assert.ok(latest.snapshot.dependencies.some((edge) => edge.fromId === "go/cmd/main.go" && edge.toId === "go/internal/value/value.go" && edge.resolution === "package"));
      cold.push(sampleStats(latest.stats));
    }

    const incremental = [];
    const changedFiles = ["py/pkg/module-0000.py", "go/internal/value/module-0000.go", "ts/module-0000.ts"];
    for (let index = 0; index < changedFiles.length; index += 1) {
      const fileName = changedFiles[index];
      const absolute = path.join(root, ...fileName.split("/"));
      const source = fileName.endsWith(".py") ? `from .base import VALUE\nvalue0 = VALUE + ${index + 10}\n`
        : fileName.endsWith(".go") ? `package value\nconst Value0 = ${index + 10}\n`
          : `export const value0 = ${index + 10};\n`;
      await writeFile(absolute, source);
      latest = await scanRepository(root, latest, { mode: "incremental", changedPaths: [fileName] });
      assert.equal(latest.stats.sourceReadCount, 1);
      assert.equal(latest.stats.sourceParseCount, 1);
      assert.equal(latest.stats.configParseCount, 0);
      assert.equal(latest.stats.languageConfigParseCount, 0);
      incremental.push(sampleStats(latest.stats));
    }

    const overflowFile = path.join(typescriptDirectory, "module-5000.ts");
    await writeFile(overflowFile, "export const overLimit = true;\n");
    await assert.rejects(scanRepository(root, latest), /超过 5000 个源码文件/);
    await unlink(overflowFile);

    const samples = { kind: "Python + Go + JavaScript/TypeScript 混合（5,000 个源码文件，Python 与 Go 含真实包引用）", cold, incremental };
    samples.medians = {
      coldMs: rounded(median(cold.map((item) => item.durationMs))),
      incrementalMs: rounded(median(incremental.map((item) => item.durationMs))),
    };
    return samples;
  } finally { await safeRemoveTempRoot(root); }
}

report.fixtures.push(await benchmarkFixture(false));
report.fixtures.push(await benchmarkFixture(true));
report.fixtures.push(await benchmarkPolyglotFixture());
report.limitCheck = "三类 5,000 文件样例添加第 5,001 个候选文件后均明确拒绝。";
const serialized = JSON.stringify(report, null, 2);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDirectory = path.join(repositoryRoot, "acceptance-evidence", "desktop-2026-10-03");
await mkdir(evidenceDirectory, { recursive: true });
await writeFile(path.join(evidenceDirectory, "benchmark-indexer.json"), `${serialized}\n`, "utf8");
console.log(serialized);
