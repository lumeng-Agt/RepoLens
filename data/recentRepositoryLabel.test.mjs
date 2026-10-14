import test from "node:test";
import assert from "node:assert/strict";
import { recentRepositoryOpenLocation, recentRepositoryTargetLabel } from "./recent-repository-label.mjs";

test("recent repository labels identify GitHub branches, tags, commits, and subdirectories", () => {
  const common = { kind: "github", name: "demo", location: "https://github.com/acme/demo", commit: "a".repeat(40) };
  assert.equal(recentRepositoryTargetLabel({ ...common, resolvedRef: "refs/heads/feature/test", subdirectory: "src/app" }), "分支 feature/test · src/app");
  assert.equal(recentRepositoryTargetLabel({ ...common, resolvedRef: "refs/tags/v0.1.0" }), "标签 v0.1.0");
  assert.equal(recentRepositoryTargetLabel({ ...common, resolvedRef: "b".repeat(40), commit: "b".repeat(40) }), `提交 ${"b".repeat(12)}`);
  assert.equal(recentRepositoryTargetLabel({ ...common, resolvedRef: "refs/heads/main" }), "分支 main");
  assert.equal(recentRepositoryTargetLabel({ kind: "github", location: common.location }), "默认分支");
});

test("local recent repositories keep their path label", () => {
  assert.equal(recentRepositoryTargetLabel({ kind: "local", location: "D:/code/demo" }), "D:/code/demo");
});

test("recent GitHub entries reconstruct a trusted namespaced ref for old ambiguous URLs", () => {
  const entry = {
    kind: "github",
    location: "https://github.com/acme/demo/tree/release/src",
    resolvedRef: "refs/tags/release",
    subdirectory: "src",
  };
  assert.equal(recentRepositoryOpenLocation(entry), "https://github.com/acme/demo/tree/refs/tags/release/src");
  assert.equal(recentRepositoryOpenLocation({ ...entry, resolvedRef: "refs/heads/release" }), "https://github.com/acme/demo/tree/refs/heads/release/src");
  assert.equal(recentRepositoryOpenLocation({ ...entry, resolvedRef: "a".repeat(40), commit: "a".repeat(40) }), `https://github.com/acme/demo/tree/${"a".repeat(40)}/src`);
});

test("recent GitHub entries do not guess a branch or tag when the old ref is ambiguous", () => {
  const entry = { kind: "github", location: "https://github.com/acme/demo/tree/release/src", requestedRef: "release", subdirectory: "src" };
  assert.equal(recentRepositoryOpenLocation(entry), entry.location);
});
