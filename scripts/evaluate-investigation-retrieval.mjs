import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { scanRepository } from "../data/localRepository.mjs";
import { rankInvestigationCandidates } from "../data/question-retrieval.mjs";
import { prepareAiContext } from "../data/ai-context.mjs";

export async function evaluate(rank = rankInvestigationCandidates, corpusPath = new URL("../fixtures/investigation-retrieval.json", import.meta.url)) {
  const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
  const results = [];
  for (const repository of corpus.repositories) {
    const root = await mkdtemp(path.join(os.tmpdir(), "repolens-evaluation-"));
    try {
      for (const file of repository.files.filter(f => repository.paths.includes(f.path))) {
        const target = path.join(root, file.path); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, file.source);
      }
      const scan = await scanRepository(root);
      for (const task of repository.cases) {
        const start = performance.now();
        const ranked = rank({ files: scan.snapshot.files, dependencies: scan.snapshot.dependencies, sourceById: scan.sourceCache, question: task.question });
        const elapsedMs = performance.now() - start;
        const usable = ranked.retrievalInsufficient ? [] : ranked.candidates.filter(c => c.score > 0);
        const paths = usable.map(c => scan.snapshot.files.find(f => f.id === c.id)?.path);
        const prepared = prepareAiContext({ candidates: ranked.candidates.map(c => c.id), rankedCandidates: ranked.candidates, sourceById: scan.sourceCache, question: task.question, retrievalInsufficient: ranked.retrievalInsufficient });
        const contexts = prepared.scopeRequired ? [] : prepared.sources.map(c => ({path:scan.snapshot.files.find(f => f.id === c.fileId).path, startLine:c.startLine,endLine:c.endLine,characters:c.source.length}));
        const characters = contexts.reduce((sum, c) => sum + c.characters, 0);
        const relevantCharacters = contexts.reduce((sum, c) => sum + task.required.filter(r => r.path === c.path).reduce((n, r) => {
          const file = repository.files.find(f => f.path === c.path); return n + file.source.split(/\r?\n/).slice(Math.max(c.startLine, r.startLine) - 1, Math.min(c.endLine, r.endLine)).join("\n").length;
        }, 0), 0);
        results.push({ repository: repository.repo, language: repository.language, split: repository.split, id: task.id, question: task.question, scopeRequired: prepared.scopeRequired, recall5: task.required.filter(r => paths.slice(0, 5).includes(r.path)).length / task.required.length, recall10: task.required.filter(r => paths.slice(0, 10).includes(r.path)).length / task.required.length, necessaryCoverage: task.required.filter(r => contexts.some(c => c.path === r.path)).length / task.required.length, rangeCoverage: task.required.filter(r => contexts.some(c => c.path === r.path && c.startLine <= r.startLine && c.endLine >= r.endLine)).length / task.required.length, irrelevantRatio: characters ? 1 - relevantCharacters / characters : null, characters, elapsedMs, contexts });
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }
  const summary = {};
  for (const split of ["tuning", "holdout"]) for (const language of ["all", "typescript", "python", "go"]) {
    const rows = results.filter(r => r.split === split && (language === "all" || language === r.language));
    summary[`${split}/${language}`] = Object.fromEntries(["recall5", "recall10", "necessaryCoverage", "rangeCoverage", "irrelevantRatio", "characters", "elapsedMs"].map(key => [key, rows.filter(r => r[key] !== null).reduce((sum, r) => sum + r[key], 0) / Math.max(1, rows.filter(r => r[key] !== null).length)]));
  }
  return { note: "Curated upstream subsets, not whole repository quality. Additional user searches and real model quality not measured.", results, summary };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const rank = process.argv[2] ? (await import(pathToFileURL(path.resolve(process.argv[2])).href)).rankInvestigationCandidates : undefined;
  console.log(JSON.stringify(await evaluate(rank, process.argv[3]), null, 2));
}
