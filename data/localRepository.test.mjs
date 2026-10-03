import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanRepository } from "./localRepository.mjs";

test("indexes Python and Go static imports without executing project code", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-polyglot-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src", "tasks"), { recursive: true });
  await mkdir(path.join(root, "internal", "task"), { recursive: true });
  await writeFile(path.join(root, "pyproject.toml"), "[project]\nname='fixture'\n[tool.fixture]\ncommand='must-not-run'\n");
  await writeFile(path.join(root, "go.mod"), "module example.com/repolens-fixture\n\ngo 1.23\n");
  await writeFile(path.join(root, "src", "__init__.py"), "");
  await writeFile(path.join(root, "src", "main.py"), "from .tasks import Task\nimport json\nimport importlib\nmodule = importlib.import_module(name)\n");
  await writeFile(path.join(root, "src", "tasks", "__init__.py"), "from .model import Task\n");
  await writeFile(path.join(root, "src", "tasks", "model.py"), "class Task: pass\n");
  await writeFile(path.join(root, "main.go"), 'package main\nimport (\n "fmt"\n task "example.com/repolens-fixture/internal/task"\n _ "example.com/repolens-fixture/internal/task/metrics"\n)\nfunc main() { fmt.Println(task.Name) }\n');
  await writeFile(path.join(root, "internal", "task", "task.go"), "package task\nconst Name = \"task\"\n");
  await writeFile(path.join(root, "internal", "task", "metrics.go"), "//go:build windows\n\npackage task\n");
  const indexed = await scanRepository(root);
  const files = new Map(indexed.snapshot.files.map((file) => [file.id, file]));
  assert.equal(files.get("src/main.py")?.language, "python");
  assert.equal(files.get("main.go")?.language, "go");
  assert.ok(indexed.snapshot.dependencies.some((edge) => edge.fromId === "src/main.py" && edge.toId === "src/tasks/__init__.py"));
  assert.ok(indexed.snapshot.dependencies.some((edge) => edge.fromId === "src/tasks/__init__.py" && edge.toId === "src/tasks/model.py"));
  assert.ok(indexed.snapshot.dependencies.some((edge) => edge.fromId === "main.go" && edge.toId === "internal/task/task.go" && edge.resolution === "package"));
  assert.ok(indexed.snapshot.unresolved.some((item) => item.fileId === "main.go" && item.specifier === "fmt" && item.kind === "standard-library"));
  assert.ok(indexed.snapshot.unresolved.some((item) => item.fileId === "src/main.py" && item.specifier === "json" && item.kind === "standard-library"));
  assert.ok(indexed.snapshot.unresolved.some((item) => item.fileId === "src/main.py" && item.specifier === "<动态模块导入>" && item.kind === "dynamic"));
  assert.ok(indexed.snapshot.diagnostics.some((item) => item.path === "internal/task/metrics.go" && /未按运行平台筛选/.test(item.message)));
  assert.equal(indexed.stats.sourceParseCount, 7);
});

test("resolves Go workspace and local replace imports as package-expanded static edges", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-go-workspace-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "cmd"), { recursive: true });
  await mkdir(path.join(root, "third_party", "lib", "tool"), { recursive: true });
  await mkdir(path.join(root, "plugins", "ext"), { recursive: true });
  await writeFile(path.join(root, "go.mod"), "module example.com/root\n\ngo 1.23\n\nreplace example.com/lib => ./third_party/lib\n");
  await writeFile(path.join(root, "go.work"), "go 1.23\n\nuse (\n .\n ./plugins/ext\n)\n");
  await writeFile(path.join(root, "plugins", "ext", "go.mod"), "module example.com/workspace/ext\n\ngo 1.23\n");
  await writeFile(path.join(root, "cmd", "main.go"), 'package main\nimport (\n "log/slog"\n "example.com/lib/tool"\n "example.com/workspace/ext"\n "github.com/acme/remote"\n)\nfunc main() { slog.Info(tool.Name, ext.Name, remote.Name) }\n');
  await writeFile(path.join(root, "third_party", "lib", "go.mod"), "module example.com/lib\n\ngo 1.23\n");
  await writeFile(path.join(root, "third_party", "lib", "tool", "tool.go"), "package tool\nconst Name = \"tool\"\n");
  await writeFile(path.join(root, "plugins", "ext", "ext.go"), "package ext\nconst Name = \"ext\"\n");
  const indexed = await scanRepository(root);
  const edges = indexed.snapshot.dependencies.filter((edge) => edge.fromId === "cmd/main.go");
  assert.ok(edges.some((edge) => edge.toId === "third_party/lib/tool/tool.go" && edge.resolution === "package"));
  assert.ok(edges.some((edge) => edge.toId === "plugins/ext/ext.go" && edge.resolution === "package"));
  assert.ok(indexed.snapshot.unresolved.some((item) => item.specifier === "log/slog" && item.kind === "standard-library"));
  assert.ok(indexed.snapshot.unresolved.some((item) => item.specifier === "github.com/acme/remote" && item.kind === "external-module"));
  assert.ok(indexed.snapshot.files.every((file) => file.language !== "go" || !file.path.endsWith("_test.go")));
  const contentRevision = indexed.snapshot.revision;
  await writeFile(path.join(root, "go.mod"), "module example.com/renamed\n\ngo 1.23\n\nreplace example.com/lib => ./third_party/lib\n");
  const changed = await scanRepository(root, indexed);
  assert.notEqual(changed.snapshot.revision, contentRevision, "module and replacement configuration participates in snapshot identity");
  assert.equal(changed.stats.languageConfigParseCount, 1);
});

test("indexes supported source files, resolves aliases, and reports unresolved imports", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-index-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src/lib"), { recursive: true });
  await mkdir(path.join(root, "src/feature"), { recursive: true });
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", moduleResolution: "Bundler", paths: { "@/*": ["src/*"] } } }));
  await writeFile(path.join(root, ".gitignore"), "ignored/\n");
  await mkdir(path.join(root, "ignored"));
  await writeFile(path.join(root, "ignored/no.ts"), "export const hidden = true;");
  await writeFile(path.join(root, "src/main.ts"), [
    'import { value } from "@/lib/value";',
    'import type { Shape } from "./types";',
    'export { other } from "./feature";',
    'const lazy = import("./feature");',
    'const unknownLazy = import(moduleName);',
    'const required = require("./legacy");',
    'import "./theme.css";',
    'import "external-package";',
    "export { value, Shape, lazy, unknownLazy, required };",
  ].join("\n"));
  await writeFile(path.join(root, "src/lib/value.ts"), "export const value = 1;");
  await writeFile(path.join(root, "src/types.ts"), "export type Shape = string;");
  await writeFile(path.join(root, "src/feature/index.ts"), "export const other = true;");
  await writeFile(path.join(root, "src/legacy.ts"), "export const legacy = true;");
  await writeFile(path.join(root, "src/theme.css"), '@import "./tokens.css";');
  await writeFile(path.join(root, "src/tokens.css"), ":root { color: red; }");
  await writeFile(path.join(root, ".env.local"), "SECRET=not-indexed");

  const indexed = await scanRepository(root);
  const files = new Set(indexed.snapshot.files.map((file) => file.path));
  assert.equal(files.has("ignored/no.ts"), false);
  assert.equal(files.has(".env.local"), false);
  assert.equal(files.has("src/feature/index.ts"), true);
  const targets = new Set(indexed.snapshot.dependencies.filter((edge) => edge.fromId === "src/main.ts").map((edge) => edge.toId));
  assert.deepEqual([...targets].sort(), ["src/feature/index.ts", "src/legacy.ts", "src/lib/value.ts", "src/theme.css", "src/types.ts"].sort());
  assert.equal(indexed.snapshot.dependencies.find((edge) => edge.fromId === "src/main.ts" && edge.toId === "src/types.ts").typeOnly, true);
  assert.equal(indexed.snapshot.dependencies.some((edge) => edge.fromId === "src/theme.css" && edge.toId === "src/tokens.css"), true);
  assert.equal(indexed.snapshot.unresolved.some((item) => item.specifier === "external-package" && item.external), true);
  assert.equal(indexed.snapshot.unresolved.some((item) => item.specifier === "<动态表达式>" && !item.external), true);

  const revision = indexed.snapshot.revision;
  await writeFile(path.join(root, "src/main.ts"), 'import "./types";\nexport {};');
  const updated = await scanRepository(root, indexed, { mode: "incremental", changedPaths: ["src/main.ts"] });
  assert.notEqual(updated.snapshot.revision, revision);
  assert.equal(updated.snapshot.dependencies.some((edge) => edge.fromId === "src/main.ts" && edge.toId === "src/types.ts"), true);
});

test("keeps the external AI integration fixture self-contained with the documented dependency graph", async () => {
  const root = fileURLToPath(new URL("../fixtures/ai-integration-sample", import.meta.url));
  const indexed = await scanRepository(root);
  const paths = new Set(indexed.snapshot.files.map((file) => file.path));
  assert.deepEqual([...paths].sort(), ["src/index.ts", "src/status.ts", "src/summary.ts", "src/task.ts"]);
  const edges = new Set(indexed.snapshot.dependencies.map((edge) => `${edge.fromId}->${edge.toId}`));
  assert.deepEqual([...edges].sort(), [
    "src/index.ts->src/summary.ts",
    "src/index.ts->src/task.ts",
    "src/status.ts->src/task.ts",
    "src/summary.ts->src/status.ts",
    "src/summary.ts->src/task.ts",
  ]);
});

test("rejects a symlink repository root and ignores symlinked files", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-link-"));
  const actual = path.join(root, "actual");
  await mkdir(actual);
  await writeFile(path.join(actual, "main.js"), "export {}; ");
  const link = path.join(root, "link");
  try { await (await import("node:fs/promises")).symlink(actual, link, "junction"); }
  catch { context.skip("当前用户权限不允许创建测试符号链接。"); return; }
  context.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(scanRepository(link), /符号链接/);
});

test("keeps repository identity stable and updates revisions for inherited config changes", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-stable-id-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ extends: "./tsconfig.base.json", include: ["src"] }));
  await writeFile(path.join(root, "tsconfig.base.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", moduleResolution: "Bundler", paths: { "@app/*": ["src/a/*"] } } }));
  await mkdir(path.join(root, "src/a")); await mkdir(path.join(root, "src/b"));
  await writeFile(path.join(root, "src/main.ts"), 'import { value } from "@app/value"; export { value };');
  await writeFile(path.join(root, "src/a/value.ts"), "export const value = 1;");
  await writeFile(path.join(root, "src/b/value.ts"), "export const value = 2;");
  const first = await scanRepository(root);
  assert.ok(first.snapshot.dependencies.some((edge) => edge.toId === "src/a/value.ts"));
  await writeFile(path.join(root, "tsconfig.base.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", moduleResolution: "Bundler", paths: { "@app/*": ["src/b/*"] } } }));
  const second = await scanRepository(root, first);
  assert.equal(second.snapshot.id, first.snapshot.id);
  assert.equal(second.snapshot.sequence, first.snapshot.sequence + 1);
  assert.notEqual(second.snapshot.revision, first.snapshot.revision);
  assert.ok(second.snapshot.dependencies.some((edge) => edge.toId === "src/b/value.ts"));
});

test("uses the nearest nested config for package aliases", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-nearest-config-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "packages/app/src"), { recursive: true });
  await mkdir(path.join(root, "packages/app/lib"), { recursive: true });
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@root/*": ["src/*"] } } }));
  await writeFile(path.join(root, "packages/app/tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", moduleResolution: "Bundler", paths: { "@app/*": ["src/*"] } } }));
  await writeFile(path.join(root, "packages/app/src/main.ts"), 'import { value } from "@app/value"; export { value };');
  await writeFile(path.join(root, "packages/app/src/value.ts"), "export const value = 1;");
  const indexed = await scanRepository(root);
  assert.ok(indexed.snapshot.dependencies.some((edge) => edge.fromId === "packages/app/src/main.ts" && edge.toId === "packages/app/src/value.ts"));
  assert.deepEqual(indexed.snapshot.configPath, ["packages/app/tsconfig.json"]);
});

test("adding and removing a nearest config changes the alias used by nested files", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-nearest-config-changes-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src/nested"), { recursive: true });
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", moduleResolution: "Bundler", paths: { "@choice": ["root-choice.ts"] } } }));
  await writeFile(path.join(root, "root-choice.ts"), "export const choice = 'root';");
  await writeFile(path.join(root, "src/nested/main.ts"), 'import { choice } from "@choice"; export { choice };');
  await writeFile(path.join(root, "src/nested/local-choice.ts"), "export const choice = 'local';");

  const rootConfig = await scanRepository(root);
  assert.ok(rootConfig.snapshot.dependencies.some((edge) => edge.fromId === "src/nested/main.ts" && edge.toId === "root-choice.ts"));
  const nestedConfigPath = path.join(root, "src/nested/tsconfig.json");
  await writeFile(nestedConfigPath, JSON.stringify({ compilerOptions: { baseUrl: ".", moduleResolution: "Bundler", paths: { "@choice": ["local-choice.ts"] } } }));
  const nestedConfig = await scanRepository(root, rootConfig);
  assert.ok(nestedConfig.snapshot.dependencies.some((edge) => edge.fromId === "src/nested/main.ts" && edge.toId === "src/nested/local-choice.ts"));
  assert.ok(nestedConfig.snapshot.configPath.includes("src/nested/tsconfig.json"));

  await rm(nestedConfigPath, { force: true });
  const removedConfig = await scanRepository(root, nestedConfig);
  assert.ok(removedConfig.snapshot.dependencies.some((edge) => edge.fromId === "src/nested/main.ts" && edge.toId === "root-choice.ts"));
  assert.equal(removedConfig.snapshot.configPath.includes("src/nested/tsconfig.json"), false);
});

test("tracks arbitrary JSON files in the full TypeScript extends chain", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-extends-chain-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "src/a")); await mkdir(path.join(root, "src/b"));
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ extends: "./base.json", include: ["src"] }));
  await writeFile(path.join(root, "base.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", moduleResolution: "Bundler", paths: { "@value": ["src/a/value.ts"] } } }));
  await writeFile(path.join(root, "src/main.ts"), 'import { value } from "@value"; export { value };');
  await writeFile(path.join(root, "src/a/value.ts"), "export const value = 1;");
  await writeFile(path.join(root, "src/b/value.ts"), "export const value = 2;");
  const first = await scanRepository(root);
  assert.ok(first.snapshot.dependencies.some((edge) => edge.toId === "src/a/value.ts"));
  assert.ok(first.snapshot.configPath.includes("base.json"));
  await writeFile(path.join(root, "base.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", moduleResolution: "Bundler", paths: { "@value": ["src/b/value.ts"] } } }));
  const second = await scanRepository(root, first);
  assert.notEqual(second.snapshot.revision, first.snapshot.revision);
  assert.ok(second.snapshot.dependencies.some((edge) => edge.toId === "src/b/value.ts"));
});

test("tracks content changes in an extensionless TypeScript extends config", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-extensionless-config-change-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src/a"), { recursive: true });
  await mkdir(path.join(root, "src/b"), { recursive: true });
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ extends: "./base", include: ["src"] }));
  await writeFile(path.join(root, "base"), JSON.stringify({ compilerOptions: { baseUrl: ".", moduleResolution: "Bundler", paths: { "@value": ["src/a/value.ts"] } } }));
  await writeFile(path.join(root, "src/main.ts"), 'import { value } from "@value"; export { value };');
  await writeFile(path.join(root, "src/a/value.ts"), "export const value = 'a';");
  await writeFile(path.join(root, "src/b/value.ts"), "export const value = 'b';");

  const first = await scanRepository(root);
  assert.ok(first.snapshot.dependencies.some((edge) => edge.fromId === "src/main.ts" && edge.toId === "src/a/value.ts"));
  await writeFile(path.join(root, "base"), JSON.stringify({ compilerOptions: { baseUrl: ".", moduleResolution: "Bundler", paths: { "@value": ["src/b/value.ts"] } } }));
  const second = await scanRepository(root, first);
  assert.notEqual(second.snapshot.revision, first.snapshot.revision);
  assert.equal(second.snapshot.sequence, first.snapshot.sequence + 1);
  assert.equal(second.stats.configParseCount, 1);
  assert.ok(second.snapshot.dependencies.some((edge) => edge.fromId === "src/main.ts" && edge.toId === "src/b/value.ts"));

  const stable = await scanRepository(root, second);
  assert.equal(stable.snapshot.revision, second.snapshot.revision);
  assert.equal(stable.snapshot.sequence, second.snapshot.sequence);
  assert.deepEqual(stable.snapshot.dependencies, second.snapshot.dependencies);
});

test("tracks and recovers a multi-level extensionless TypeScript config chain", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-multi-extensionless-config-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "configs"), { recursive: true });
  await mkdir(path.join(root, "src/a"), { recursive: true });
  await mkdir(path.join(root, "src/b"), { recursive: true });
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ extends: "./configs/middle", include: ["src"] }));
  await writeFile(path.join(root, "configs/middle"), JSON.stringify({ extends: "./base" }));
  await writeFile(path.join(root, "configs/base"), JSON.stringify({ compilerOptions: { baseUrl: "..", moduleResolution: "Bundler", paths: { "@value": ["src/a/value.ts"] } } }));
  await writeFile(path.join(root, "src/main.ts"), 'import { value } from "@value"; import { relative } from "./relative"; export { value, relative };');
  await writeFile(path.join(root, "src/relative.ts"), "export const relative = true;");
  await writeFile(path.join(root, "src/a/value.ts"), "export const value = 'a';");
  await writeFile(path.join(root, "src/b/value.ts"), "export const value = 'b';");

  const compareWithColdScan = async (cached) => {
    const cold = await scanRepository(root);
    assert.deepEqual(cached.snapshot.dependencies, cold.snapshot.dependencies);
    assert.deepEqual(cached.snapshot.diagnostics, cold.snapshot.diagnostics);
    assert.equal(cached.snapshot.revision, cold.snapshot.revision);
    return cold;
  };
  let indexed = await scanRepository(root);
  assert.ok(indexed.snapshot.dependencies.some((edge) => edge.fromId === "src/main.ts" && edge.toId === "src/a/value.ts"));
  await compareWithColdScan(indexed);

  await writeFile(path.join(root, "configs/base"), JSON.stringify({ compilerOptions: { baseUrl: "..", moduleResolution: "Bundler", paths: { "@value": ["src/b/value.ts"] } } }));
  const changed = await scanRepository(root, indexed);
  assert.ok(changed.snapshot.dependencies.some((edge) => edge.fromId === "src/main.ts" && edge.toId === "src/b/value.ts"));
  assert.equal(changed.stats.configParseCount, 1);
  await compareWithColdScan(changed);
  indexed = changed;

  await rm(path.join(root, "configs/base"));
  const deleted = await scanRepository(root, indexed);
  assert.equal(deleted.snapshot.dependencies.some((edge) => edge.fromId === "src/main.ts" && edge.toId.endsWith("/value.ts")), false);
  assert.ok(deleted.snapshot.dependencies.some((edge) => edge.fromId === "src/main.ts" && edge.toId === "src/relative.ts"));
  assert.ok(deleted.snapshot.diagnostics.some((diagnostic) => diagnostic.message.includes("./base")));
  await compareWithColdScan(deleted);
  indexed = deleted;

  await writeFile(path.join(root, "configs/base"), '{ "compilerOptions": { "paths": {');
  const broken = await scanRepository(root, indexed);
  assert.equal(broken.snapshot.dependencies.some((edge) => edge.fromId === "src/main.ts" && edge.toId.endsWith("/value.ts")), false);
  assert.ok(broken.snapshot.diagnostics.some((diagnostic) => diagnostic.path === "configs/base"));
  await compareWithColdScan(broken);
  indexed = broken;

  await writeFile(path.join(root, "configs/base"), JSON.stringify({ compilerOptions: { baseUrl: "..", moduleResolution: "Bundler", paths: { "@value": ["src/a/value.ts"] } } }));
  const repaired = await scanRepository(root, indexed);
  assert.ok(repaired.snapshot.dependencies.some((edge) => edge.fromId === "src/main.ts" && edge.toId === "src/a/value.ts"));
  assert.equal(repaired.snapshot.diagnostics.some((diagnostic) => diagnostic.path === "configs/base"), false);
  await compareWithColdScan(repaired);
});

test("a malformed root TypeScript config is diagnosed without aborting the repository scan", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-malformed-config-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "tsconfig.json"), '{ "compilerOptions": { "baseUrl": ".",');
  await writeFile(path.join(root, "src/main.ts"), 'import { value } from "./value"; export { value };');
  await writeFile(path.join(root, "src/value.ts"), "export const value = 1;");

  const indexed = await scanRepository(root);
  assert.equal(indexed.snapshot.files.length, 2);
  assert.ok(indexed.snapshot.dependencies.some((edge) => edge.fromId === "src/main.ts" && edge.toId === "src/value.ts"));
  assert.ok(indexed.snapshot.diagnostics.some((diagnostic) => diagnostic.path === "tsconfig.json" && /JSON|配置/.test(diagnostic.message)));
  const verified = await scanRepository(root, indexed);
  assert.equal(verified.snapshot.revision, indexed.snapshot.revision);
  assert.equal(verified.snapshot.sequence, indexed.snapshot.sequence);
  assert.deepEqual(verified.snapshot.diagnostics, indexed.snapshot.diagnostics);
});

test("a missing extensionless extends candidate is fingerprinted on the first scan", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-missing-config-stable-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ extends: "./base", compilerOptions: { moduleResolution: "Bundler" } }));
  await writeFile(path.join(root, "main.ts"), "export const value = 1;");

  const cold = await scanRepository(root);
  const warm = await scanRepository(root, cold);
  const coldAgain = await scanRepository(root);
  assert.equal(warm.snapshot.revision, cold.snapshot.revision);
  assert.equal(warm.snapshot.sequence, cold.snapshot.sequence);
  assert.equal(coldAgain.snapshot.revision, cold.snapshot.revision);
  assert.deepEqual(warm.snapshot.diagnostics, cold.snapshot.diagnostics);
});

test("an inherited config syntax error falls back safely and recovers after the config is repaired", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-inherited-config-error-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ extends: "./configs/base", include: ["src"] }));
  await mkdir(path.join(root, "configs"), { recursive: true });
  await writeFile(path.join(root, "configs/base.json"), '{ "compilerOptions": { "baseUrl": "..", "paths": { "@value": ["src/alias.ts"] },');
  await writeFile(path.join(root, "src/main.ts"), 'import { relative } from "./relative"; import { alias } from "@value"; export { relative, alias };');
  await writeFile(path.join(root, "src/relative.ts"), "export const relative = true;");
  await writeFile(path.join(root, "src/alias.ts"), "export const alias = true;");

  const broken = await scanRepository(root);
  assert.ok(broken.snapshot.dependencies.some((edge) => edge.fromId === "src/main.ts" && edge.toId === "src/relative.ts"));
  assert.equal(broken.snapshot.dependencies.some((edge) => edge.fromId === "src/main.ts" && edge.toId === "src/alias.ts"), false);
  assert.ok(broken.snapshot.diagnostics.some((diagnostic) => diagnostic.path === "configs/base.json" && /JSON|配置/.test(diagnostic.message)));

  await writeFile(path.join(root, "configs/base.json"), JSON.stringify({ compilerOptions: { baseUrl: "..", moduleResolution: "Bundler", paths: { "@value": ["src/alias.ts"] } } }));
  const repaired = await scanRepository(root, broken);
  assert.ok(repaired.snapshot.dependencies.some((edge) => edge.fromId === "src/main.ts" && edge.toId === "src/alias.ts"));
  assert.equal(repaired.snapshot.diagnostics.some((diagnostic) => diagnostic.path === "configs/base.json" && /JSON|配置/.test(diagnostic.message)), false);
  assert.equal(repaired.snapshot.sequence, broken.snapshot.sequence + 1);
});

test("a missing package extends chain is recorded consistently on cold and cached scans", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-missing-package-config-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ extends: "@repolens/missing-config" }));
  await writeFile(path.join(root, "main.ts"), "export const value = 1;");

  const cold = await scanRepository(root);
  const warm = await scanRepository(root, cold);
  assert.equal(warm.snapshot.revision, cold.snapshot.revision);
  assert.equal(warm.snapshot.sequence, cold.snapshot.sequence);
  assert.deepEqual(warm.snapshot.diagnostics, cold.snapshot.diagnostics);
});

test("applies nested ignore rules and hard excludes dependency/build directories", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-nested-ignore-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "packages/app/src"), { recursive: true });
  await mkdir(path.join(root, "packages/app/node_modules/pkg"), { recursive: true });
  await mkdir(path.join(root, "packages/app/dist"), { recursive: true });
  await writeFile(path.join(root, "main.ts"), "export {}; ");
  await writeFile(path.join(root, "packages/app/src/keep.ts"), "export {}; ");
  await writeFile(path.join(root, "packages/app/src/private.ts"), "export {}; ");
  await writeFile(path.join(root, "packages/app/src/public.ts"), "export {}; ");
  await writeFile(path.join(root, "packages/app/node_modules/pkg/index.js"), "export {}; ");
  await writeFile(path.join(root, "packages/app/dist/build.js"), "export {}; ");
  await writeFile(path.join(root, "packages/app/.gitignore"), "src/private.ts\nsrc/public.ts\n");
  await writeFile(path.join(root, "packages/app/.repolensignore"), "!src/public.ts\n");
  const indexed = await scanRepository(root);
  const paths = new Set(indexed.snapshot.files.map((file) => file.path));
  assert.equal(paths.has("packages/app/src/private.ts"), false);
  assert.equal(paths.has("packages/app/src/public.ts"), true);
  assert.equal(paths.has("packages/app/node_modules/pkg/index.js"), false);
  assert.equal(paths.has("packages/app/dist/build.js"), false);
});

test("marks type-only imports and re-exports accurately, including mixed imports", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-type-imports-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "main.ts"), [
    'import { type Shape, make } from "./values";',
    'import { type Shape as Other } from "./values";',
    'export type { Shape } from "./values";',
  ].join("\n"));
  await writeFile(path.join(root, "values.ts"), "export type Shape = string; export const make = () => \"ok\";");
  const indexed = await scanRepository(root);
  const edges = indexed.snapshot.dependencies.filter((edge) => edge.fromId === "main.ts");
  assert.deepEqual(edges.map((edge) => edge.typeOnly), [false, true, true]);
});

test("classifies default, namespace, and mixed type re-exports as runtime-capable edges", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-type-shapes-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "main.ts"), [
    'import DefaultValue, { type Shape } from "./values";',
    'import * as Namespace from "./values";',
    'import type DefaultType from "./values";',
    'export { type Shape, make } from "./values";',
    'export { type Shape } from "./values";',
  ].join("\n"));
  await writeFile(path.join(root, "values.ts"), "export type Shape = string; export const make = () => \"ok\"; export default 1;");
  const indexed = await scanRepository(root);
  const edges = indexed.snapshot.dependencies.filter((edge) => edge.fromId === "main.ts");
  assert.deepEqual(edges.map((edge) => edge.typeOnly), [false, false, true, false, true]);
});

test("reuses parsed compiler configuration until its extends chain changes", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-config-cache-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ extends: "./base.json", include: ["src"] }));
  await writeFile(path.join(root, "base.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", moduleResolution: "Bundler", paths: { "@/*": ["src/*"] } } }));
  await writeFile(path.join(root, "src/main.ts"), 'import { value } from "@/value"; export { value };');
  await writeFile(path.join(root, "src/value.ts"), "export const value = 1;");
  const first = await scanRepository(root);
  assert.equal(first.stats.configParseCount, 1);
  assert.equal(first.stats.sourceReadCount, 2);
  await writeFile(path.join(root, "src/value.ts"), "export const value = 2;");
  const sourceUpdate = await scanRepository(root, first, { mode: "incremental", changedPaths: ["src/value.ts"] });
  assert.equal(sourceUpdate.stats.sourceReadCount, 1);
  assert.equal(sourceUpdate.stats.sourceParseCount, 1);
  assert.equal(sourceUpdate.stats.configParseCount, 0);
  assert.ok(sourceUpdate.snapshot.dependencies.some((edge) => edge.toId === "src/value.ts"));
  await writeFile(path.join(root, "base.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", moduleResolution: "Bundler", paths: { "@/*": ["src/*"] } }, exclude: ["unused"] }));
  const configUpdate = await scanRepository(root, sourceUpdate);
  assert.equal(configUpdate.stats.configParseCount, 1);
});

test("verifies source contents even when file metadata is unchanged", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-content-verify-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "main.ts");
  await writeFile(sourcePath, "export const value = 1;\n");
  const first = await scanRepository(root);

  await writeFile(sourcePath, "export const value = 2;\n");
  const current = await stat(sourcePath);
  first.metadata.set("main.ts", { size: current.size, mtimeMs: current.mtimeMs, ctimeMs: current.ctimeMs, ino: current.ino });

  const verified = await scanRepository(root, first);
  assert.equal(verified.sourceCache.get("main.ts"), "export const value = 2;\n");
  assert.notEqual(verified.snapshot.revision, first.snapshot.revision);

  const incremental = await scanRepository(root, first, { mode: "incremental", changedPaths: ["main.ts"] });
  assert.equal(incremental.sourceCache.get("main.ts"), "export const value = 2;\n");
  assert.equal(incremental.stats.sourceReadCount, 1);
  assert.equal(incremental.stats.sourceParseCount, 1);
});

test("revalidates inherited config contents even when config metadata is unchanged", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-config-content-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src/a"), { recursive: true });
  await mkdir(path.join(root, "src/b"), { recursive: true });
  const configPath = path.join(root, "tsconfig.json");
  await writeFile(configPath, JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@value": ["src/a/value.ts"] } } }));
  await writeFile(path.join(root, "src/main.ts"), 'import { value } from "@value"; export { value };');
  await writeFile(path.join(root, "src/a/value.ts"), "export const value = 1;");
  await writeFile(path.join(root, "src/b/value.ts"), "export const value = 2;");
  const first = await scanRepository(root);
  assert.ok(first.snapshot.dependencies.some((edge) => edge.toId === "src/a/value.ts"));

  await writeFile(configPath, JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@value": ["src/b/value.ts"] } } }));
  const current = await stat(configPath);
  const configKey = configPath.replaceAll("\\", "/");
  first.configCache.get(configPath).configFiles.set(configKey, {
    size: current.size,
    mtimeMs: current.mtimeMs,
    ctimeMs: current.ctimeMs,
    contentHash: first.configCache.get(configPath).configFiles.get(configKey).contentHash,
  });

  const updated = await scanRepository(root, first);
  assert.ok(updated.snapshot.dependencies.some((edge) => edge.toId === "src/b/value.ts"));
  assert.equal(updated.stats.configParseCount, 1);
  assert.notEqual(updated.snapshot.revision, first.snapshot.revision);
});

test("invalidates cached compiler options when a missing extends config is added, removed, and restored", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-config-extends-arrives-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ extends: "./base.json" }));
  await writeFile(path.join(root, "src/main.ts"), 'import { value } from "@value"; export { value };');
  await writeFile(path.join(root, "src/value.ts"), "export const value = 1;");
  await writeFile(path.join(root, "src/alternate.ts"), "export const value = 2;");

  const unresolved = await scanRepository(root);
  assert.equal(unresolved.snapshot.dependencies.some((edge) => edge.fromId === "src/main.ts"), false);
  assert.ok(unresolved.snapshot.diagnostics.some((diagnostic) => diagnostic.message.includes("base.json")));

  await writeFile(path.join(root, "base.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@value": ["src/value.ts"] } } }));
  const resolved = await scanRepository(root, unresolved);
  assert.ok(resolved.snapshot.dependencies.some((edge) => edge.fromId === "src/main.ts" && edge.toId === "src/value.ts"));
  assert.notEqual(resolved.snapshot.revision, unresolved.snapshot.revision);
  assert.ok(resolved.stats.configParseCount > 0);
  assert.equal(resolved.snapshot.diagnostics.some((diagnostic) => diagnostic.message.includes("base.json")), false);

  await rm(path.join(root, "base.json"));
  const removed = await scanRepository(root, resolved);
  assert.equal(removed.snapshot.dependencies.some((edge) => edge.fromId === "src/main.ts"), false);
  assert.notEqual(removed.snapshot.revision, resolved.snapshot.revision);
  assert.ok(removed.snapshot.diagnostics.some((diagnostic) => diagnostic.message.includes("base.json")));

  await writeFile(path.join(root, "base.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@value": ["src/alternate.ts"] } } }));
  const restored = await scanRepository(root, removed);
  assert.ok(restored.snapshot.dependencies.some((edge) => edge.fromId === "src/main.ts" && edge.toId === "src/alternate.ts"));
  assert.notEqual(restored.snapshot.revision, removed.snapshot.revision);
});

test("identical configured repositories have the same revision under different temporary roots", async (context) => {
  const roots = await Promise.all([
    mkdtemp(path.join(os.tmpdir(), "repolens-fingerprint-a-")),
    mkdtemp(path.join(os.tmpdir(), "repolens-fingerprint-b-")),
  ]);
  context.after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));
  for (const root of roots) {
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "config"), { recursive: true });
    await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ extends: "./config/base.json" }));
    await writeFile(path.join(root, "config/base.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["../src/*"] } } }));
    await writeFile(path.join(root, "src/main.ts"), 'import { value } from "@/value"; export { value };');
    await writeFile(path.join(root, "src/value.ts"), "export const value = 1;");
  }

  const [left, right] = await Promise.all(roots.map((root) => scanRepository(root)));
  assert.equal(left.snapshot.revision, right.snapshot.revision);
  assert.deepEqual(left.snapshot.dependencies, right.snapshot.dependencies);
  assert.deepEqual(left.snapshot.diagnostics, right.snapshot.diagnostics);

  await Promise.all(roots.map((root) => writeFile(path.join(root, "config/base.json"), "{")));
  const broken = await Promise.all(roots.map((root, index) => scanRepository(root, index === 0 ? left : right)));
  assert.equal(broken[0].snapshot.revision, broken[1].snapshot.revision);
  assert.deepEqual(broken[0].snapshot.diagnostics, broken[1].snapshot.diagnostics);
  assert.ok(broken[0].snapshot.diagnostics.some((diagnostic) => diagnostic.path === "config/base.json"));

  await Promise.all(roots.flatMap((root) => [
    rm(path.join(root, "tsconfig.json")),
    rm(path.join(root, "config/base.json")),
  ]));
  const plain = await Promise.all(roots.map((root) => scanRepository(root)));
  assert.equal(plain[0].snapshot.revision, plain[1].snapshot.revision);
  assert.deepEqual(plain[0].snapshot.diagnostics, plain[1].snapshot.diagnostics);
});

test("publishes a valid empty snapshot after the final source is removed", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-empty-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "only.ts"), "export const value = 1;");
  const first = await scanRepository(root);
  await rm(path.join(root, "only.ts"));
  const empty = await scanRepository(root, first);
  assert.equal(empty.snapshot.files.length, 0);
  assert.equal(empty.sourceCache.size, 0);
  assert.equal(empty.snapshot.id, first.snapshot.id);
  assert.equal(empty.snapshot.sequence, first.snapshot.sequence + 1);
});

test("indexes the 5,000-file limit, reparses only changed source, and rejects file 5,001", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-scale-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const batchSize = 200;
  for (let start = 0; start < 5000; start += batchSize) {
    await Promise.all(Array.from({ length: Math.min(batchSize, 5000 - start) }, (_, offset) => {
      const index = start + offset;
      return writeFile(path.join(root, `file-${String(index).padStart(4, "0")}.ts`), `export const value${index} = ${index};\n`);
    }));
  }

  const first = await scanRepository(root);
  assert.equal(first.stats.candidateCount, 5000);
  assert.equal(first.stats.indexedCount, 5000);
  assert.equal(first.stats.parsedFileCount, 5000);
  await writeFile(path.join(root, "file-0000.ts"), "export const updated = true;\n");
  const second = await scanRepository(root, first, { mode: "incremental", changedPaths: ["file-0000.ts"] });
  assert.equal(second.stats.sourceReadCount, 1);
  assert.equal(second.stats.sourceParseCount, 1);
  assert.equal(second.stats.parsedFileCount, 1);
  assert.equal(second.stats.configParseCount, 0);
  await writeFile(path.join(root, "file-5000.ts"), "export {};\n");
  await assert.rejects(scanRepository(root, second), /超过 5000 个源码文件/);
});

test("indexes a 5,000-file alias repository and reuses inherited config for source-only changes", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-scale-configured-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "config"), { recursive: true });
  await mkdir(path.join(root, "src/core"), { recursive: true });
  await mkdir(path.join(root, "src/generated"), { recursive: true });
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ extends: "./config/base.json", include: ["src"] }));
  await writeFile(path.join(root, "config/base.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", moduleResolution: "Bundler", paths: { "@core/*": ["../src/core/*"] } } }));
  await writeFile(path.join(root, "src/main.ts"), 'import { value } from "@core/value"; export { value };');
  await writeFile(path.join(root, "src/core/value.ts"), "export const value = 1;");
  for (let start = 0; start < 5000 - 2; start += 250) {
    await Promise.all(Array.from({ length: Math.min(250, 5000 - 2 - start) }, (_, offset) => {
      const index = start + offset;
      return writeFile(path.join(root, "src/generated", `file-${String(index).padStart(4, "0")}.ts`), `export const generated${index} = ${index};\n`);
    }));
  }

  const first = await scanRepository(root);
  assert.equal(first.stats.candidateCount, 5000);
  assert.equal(first.stats.configParseCount, 1);
  assert.ok(first.snapshot.dependencies.some((edge) => edge.fromId === "src/main.ts" && edge.toId === "src/core/value.ts"));

  await writeFile(path.join(root, "src/generated/file-0000.ts"), "export const updated = true;\n");
  const updated = await scanRepository(root, first, { mode: "incremental", changedPaths: ["src/generated/file-0000.ts"] });
  assert.equal(updated.stats.sourceReadCount, 1);
  assert.equal(updated.stats.sourceParseCount, 1);
  assert.equal(updated.stats.configParseCount, 0);

  await rm(path.join(root, "src/core/value.ts"));
  await mkdir(path.join(root, "src/alternate"), { recursive: true });
  await writeFile(path.join(root, "src/alternate/value.ts"), "export const value = 2;\n");
  await writeFile(path.join(root, "config/base.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", moduleResolution: "Bundler", paths: { "@core/*": ["../src/alternate/*"] } } }));
  const configChanged = await scanRepository(root, updated);
  assert.equal(configChanged.stats.configParseCount, 1);
  assert.ok(configChanged.snapshot.dependencies.some((edge) => edge.fromId === "src/main.ts" && edge.toId === "src/alternate/value.ts"));
});
