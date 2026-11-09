import test from "node:test";
import assert from "node:assert/strict";
import {
  searchRepositoryContent,
  partitionSearchFiles,
  SEARCH_BATCH_MAX_FILES,
  SEARCH_BATCH_MAX_BYTES,
} from "./repository-search.mjs";

test("partitionSearchFiles respects 50 files and 2 MiB UTF-8 byte boundary", () => {
  // 1. File count boundary: 120 small files should produce 3 batches (50, 50, 20)
  const files120 = Array.from({ length: 120 }, (_, i) => ({
    id: `f/${i}.ts`,
    path: `f/${i}.ts`,
    language: "ts",
  }));
  const source120 = new Map(files120.map((f) => [f.id, "const x = 1;\n"]));
  const batchesCount = partitionSearchFiles(files120, source120);
  assert.equal(batchesCount.length, 3);
  assert.equal(batchesCount[0].length, 50);
  assert.equal(batchesCount[1].length, 50);
  assert.equal(batchesCount[2].length, 20);

  // 2. Byte boundary: single large files > 2 MiB or accumulating to > 2 MiB
  const halfMb = "x".repeat(1024 * 1024 / 2); // 0.5 MiB
  const filesBig = Array.from({ length: 6 }, (_, i) => ({
    id: `big/${i}.ts`,
    path: `big/${i}.ts`,
    language: "ts",
  }));
  const sourceBig = new Map(filesBig.map((f) => [f.id, halfMb]));
  // 4 files = 2 MiB, 5th would exceed 2 MiB, so batch 1 has 4 files, batch 2 has 2 files
  const batchesBig = partitionSearchFiles(filesBig, sourceBig);
  assert.equal(batchesBig.length, 2);
  assert.equal(batchesBig[0].length, 4);
  assert.equal(batchesBig[1].length, 2);
});

// Helper to simulate old unbatched file-by-file search for parity & benchmark
async function unbatchedSearch({ files, sourceById, input }) {
  // Baseline implementation: linear scan matching repository-search logic
  const results = [];
  let total = 0;
  const regex = input.regex
    ? new RegExp(input.query, input.matchCase ? "g" : "gi")
    : null;
  const needle = input.matchCase ? input.query : input.query.toLowerCase();

  const sortedFiles = files
    .filter((f) => sourceById.has(f.id))
    .sort((a, b) => a.path.localeCompare(b.path));

  for (const file of sortedFiles) {
    const src = sourceById.get(file.id);
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let matched = false;
      if (regex) {
        regex.lastIndex = 0;
        matched = regex.test(line);
      } else {
        matched = input.matchCase
          ? line.includes(needle)
          : line.toLowerCase().includes(needle);
      }
      if (matched) {
        if (total < 100) {
          results.push({ fileId: file.id, line: i + 1 });
        }
        total++;
        if (total >= 10000) break;
      }
    }
    if (total >= 10000) break;
  }
  return { total, results };
}

function generateFixture(fileCount) {
  const files = [];
  const sourceById = new Map();
  for (let i = 0; i < fileCount; i++) {
    const id = `src/module_${String(i).padStart(4, "0")}.ts`;
    files.push({ id, path: id, language: "typescript" });
    // Add matches occasionally: every 10th file has TARGET_TOKEN
    const hasToken = i % 10 === 0;
    const body = [
      `// Module ${i}`,
      `export function processData_${i}() {`,
      hasToken ? `  const TARGET_TOKEN = "found_${i}";` : `  const value = ${i};`,
      `  return value || TARGET_TOKEN;`,
      `}`,
    ].join("\n");
    sourceById.set(id, body);
  }
  return { files, sourceById };
}

test("batch search parity and performance across 100, 1000, 5000 files", async () => {
  const counts = [100, 1000, 5000];
  const benchmarkReport = [];

  for (const count of counts) {
    const { files, sourceById } = generateFixture(count);
    const baseline = await unbatchedSearch({
      files,
      sourceById,
      input: { query: "TARGET_TOKEN", matchCase: true },
    });

    const durations = [];
    let batchedResult;
    // 3 runs each
    for (let run = 0; run < 3; run++) {
      const start = performance.now();
      batchedResult = await searchRepositoryContent({
        files,
        sourceById,
        input: { query: "TARGET_TOKEN", matchCase: true, revision: `run-${run}` },
      });
      durations.push(performance.now() - start);
    }

    // Verify exact parity
    assert.equal(batchedResult.total, baseline.total);
    assert.equal(batchedResult.results.length, baseline.results.length);
    for (let j = 0; j < baseline.results.length; j++) {
      assert.equal(batchedResult.results[j].fileId, baseline.results[j].fileId);
      assert.equal(batchedResult.results[j].line, baseline.results[j].line);
    }

    const expectedBatches = Math.ceil(count / SEARCH_BATCH_MAX_FILES);
    const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
    benchmarkReport.push({
      files: count,
      batches: expectedBatches,
      avgDurationMs: Math.round(avgDuration),
      runs: durations.map(d => Math.round(d)),
    });
  }

  // Ensure 5000 files completed reasonably fast
  assert.ok(benchmarkReport[2].avgDurationMs < 3000, `5000 files took ${benchmarkReport[2].avgDurationMs}ms, should be < 3000ms`);
});

test("batch search cancels promptly during large repository scan", async () => {
  const { files, sourceById } = generateFixture(2000);
  const controller = new AbortController();
  // Abort shortly after start
  setTimeout(() => controller.abort(), 20);

  await assert.rejects(
    searchRepositoryContent({
      files,
      sourceById,
      input: { query: "TARGET_TOKEN", revision: "cancel-test" },
      signal: controller.signal,
    }),
    { name: "AbortError" }
  );
});
