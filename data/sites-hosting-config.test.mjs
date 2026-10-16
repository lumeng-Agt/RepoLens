import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readSitesHostingConfig } from "./sites-hosting-config.mjs";

test("source startup defaults to empty local bindings when optional hosting config is absent", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repolens-hosting-config-"));
  try {
    assert.deepEqual(await readSitesHostingConfig(path.join(directory, ".openai", "hosting.json")), { d1: null, r2: null });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("optional hosting config preserves explicitly configured bindings", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repolens-hosting-config-"));
  try {
    const configPath = path.join(directory, "hosting.json");
    await writeFile(configPath, JSON.stringify({ d1: "APP_DB", r2: "ASSETS" }));
    assert.deepEqual(await readSitesHostingConfig(configPath), { d1: "APP_DB", r2: "ASSETS" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
