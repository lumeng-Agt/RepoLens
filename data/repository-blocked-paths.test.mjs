import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cleanupGitHubRepository, prepareGitHubRepository } from "./githubRepository.mjs";
import { scanRepository } from "./localRepository.mjs";
import { rankQuestionCandidates } from "./question-retrieval.mjs";
import { searchRepositoryContent } from "./repository-search.mjs";
import { repositoryPathIsBlocked } from "./repository-files.mjs";

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

const MARKER = "BLOCKED_MARKER_9f3a";
// Tree entries whose names differ only by case from the blocked list must be treated like the lower-case forms.
const BLOCKED = ["Node_Modules/pkg/index.ts", "VENDOR/lib.ts", "Dist/out.ts", "src/.ENV/secret.ts", ".Env.local.ts", "src/Build/gen.ts", "src/__PYCACHE__/x.py"];

async function blockedRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), "repolens-blocked-paths-"));
  const work = path.join(root, "work");
  const bare = path.join(root, "remote.git");
  await mkdir(work);
  git(work, "init");
  git(work, "config", "user.name", "RepoLens Test");
  git(work, "config", "user.email", "test@example.invalid");
  await mkdir(path.join(work, "src"), { recursive: true });
  await writeFile(path.join(work, "src", "main.ts"), "export const visible = 1;\n");
  for (const relative of BLOCKED) {
    await mkdir(path.dirname(path.join(work, relative)), { recursive: true });
    await writeFile(path.join(work, relative), `export const secret = "${MARKER}";\n`);
  }
  git(work, "add", "-f", ".");
  git(work, "commit", "-m", "initial");
  git(work, "branch", "-M", "main");
  git(root, "init", "--bare", bare);
  git(work, "remote", "add", "origin", bare);
  git(work, "push", "origin", "main");
  git(root, "--git-dir", bare, "symbolic-ref", "HEAD", "refs/heads/main");
  return { root, work, bare };
}

test("path blocking is case-insensitive for every path segment", () => {
  for (const relative of BLOCKED) assert.equal(repositoryPathIsBlocked(relative), true, relative);
  assert.equal(repositoryPathIsBlocked("src/main.ts"), false);
});

test("blocked case variants never reach GitHub checkout, the index, search or AI candidates", async (context) => {
  const previous = process.env.REPOLENS_TEMP_ROOT;
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "repolens-blocked-app-"));
  process.env.REPOLENS_TEMP_ROOT = tempRoot;
  const repo = await blockedRepository();
  context.after(async () => {
    if (previous === undefined) delete process.env.REPOLENS_TEMP_ROOT; else process.env.REPOLENS_TEMP_ROOT = previous;
    await rm(repo.root, { recursive: true, force: true });
    await rm(tempRoot, { recursive: true, force: true });
  });
  // Sanity: the bare repository really contains every blocked variant.
  const listed = git(repo.root, "--git-dir", repo.bare, "ls-tree", "-r", "--name-only", "main").split("\n");
  for (const relative of BLOCKED) assert.ok(listed.includes(relative), `fixture contains ${relative}`);

  const opened = await prepareGitHubRepository("https://github.com/acme/demo", null, { gitRemoteOverride: repo.bare });
  context.after(() => cleanupGitHubRepository(opened));
  await access(path.join(opened.root, "src", "main.ts"));
  // Nothing blocked was materialised, i.e. its blob was never read from the mirror.
  for (const relative of BLOCKED) await assert.rejects(access(path.join(opened.root, ...relative.split("/"))), relative);

  const scan = await scanRepository(opened.root);
  const indexed = scan.snapshot.files.map((file) => file.path);
  assert.deepEqual(indexed, ["src/main.ts"]);
  assert.equal([...scan.sourceCache.values()].some((source) => source.includes(MARKER)), false);

  const search = await searchRepositoryContent({ files: scan.snapshot.files, sourceById: scan.sourceCache, input: { query: MARKER, revision: "r" } });
  assert.equal(search.total, 0);
  const ranked = rankQuestionCandidates({ files: scan.snapshot.files, dependencies: scan.snapshot.dependencies, sourceById: scan.sourceCache, entryFileId: scan.snapshot.files[0].id, question: `where is ${MARKER} secret` });
  assert.equal(JSON.stringify(ranked).includes("secret.ts"), false);
});

test("the local scanner excludes the same case variants from a working tree", async (context) => {
  const repo = await blockedRepository();
  context.after(() => rm(repo.root, { recursive: true, force: true }));
  const scan = await scanRepository(repo.work);
  // Case-insensitive file systems may fold names, but nothing blocked may be indexed either way.
  assert.equal(scan.snapshot.files.some((file) => BLOCKED.includes(file.path)), false);
  assert.equal([...scan.sourceCache.values()].some((source) => source.includes(MARKER)), false);
});
