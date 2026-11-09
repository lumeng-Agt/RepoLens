import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { scanRepository } from "../data/localRepository.mjs";
import { rankInvestigationCandidates } from "../data/question-retrieval.mjs";
import { contextLoss } from "../data/retrieval-quality.mjs";
import { prepareAiContext } from "../data/ai-context.mjs";

export async function evaluate(rank = rankInvestigationCandidates, corpusPath = new URL("../fixtures/investigation-retrieval.json", import.meta.url), prepare = prepareAiContext) {
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
        const prepared = prepare({ candidates: ranked.candidates.map(c => c.id), rankedCandidates: ranked.candidates, sourceById: scan.sourceCache, question: task.question, retrievalInsufficient: ranked.retrievalInsufficient });
        const contexts = prepared.scopeRequired ? [] : prepared.sources.map(c => ({path:scan.snapshot.files.find(f => f.id === c.fileId).path, startLine:c.startLine,endLine:c.endLine,characters:c.source.length}));
        const characters = contexts.reduce((sum, c) => sum + c.characters, 0);
        const countRelevant = ranges => contexts.reduce((sum, context) => {
          const file = repository.files.find(f => f.path === context.path);
          return sum + file.source.split(/\r?\n/).slice(context.startLine - 1, context.endLine).reduce((n, line, index) => {
            const number = context.startLine + index;
            return n + (ranges.some(r => r.path === context.path && number >= r.startLine && number <= r.endLine) ? line.length + (number < context.endLine ? 1 : 0) : 0);
          }, 0);
        }, 0);
        const relevantCharacters = countRelevant([...task.required, ...(task.auxiliary ?? [])]);
        const outsideRequiredRatio = characters ? 1 - countRelevant(task.required) / characters : null;
        const auxiliary = task.auxiliary ?? [];
        const auxiliaryCoverage = auxiliary.length ? auxiliary.filter(r => contexts.some(c => c.path === r.path && c.startLine <= r.startLine && c.endLine >= r.endLine)).length / auxiliary.length : null;
        results.push({ repository: repository.repo, language: repository.language, split: repository.split, id: task.id, question: task.question, scopeRequired: prepared.scopeRequired, blockers: prepared.blockers ?? [], outsideRequiredRatio, auxiliaryCoverage, recall5: task.required.filter(r => paths.slice(0, 5).includes(r.path)).length / task.required.length, recall10: task.required.filter(r => paths.slice(0, 10).includes(r.path)).length / task.required.length, necessaryCoverage: task.required.filter(r => contexts.some(c => c.path === r.path)).length / task.required.length, rangeCoverage: task.required.filter(r => contexts.some(c => c.path === r.path && c.startLine <= r.startLine && c.endLine >= r.endLine)).length / task.required.length, irrelevantRatio: characters ? 1 - relevantCharacters / characters : null, contextLoss: contextLoss(prepared.scopeRequired, characters ? 1 - relevantCharacters / characters : null), characters, elapsedMs, contexts });
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }
  const summary = {};
  for (const split of ["tuning", "holdout"]) for (const language of ["all", "typescript", "python", "go"]) {
    const rows = results.filter(r => r.split === split && (language === "all" || language === r.language));
    summary[`${split}/${language}`] = Object.fromEntries(["recall5", "recall10", "necessaryCoverage", "rangeCoverage", "irrelevantRatio", "outsideRequiredRatio", "auxiliaryCoverage", "contextLoss", "characters", "elapsedMs"].map(key => [key, rows.filter(r => r[key] !== null).reduce((sum, r) => sum + r[key], 0) / (rows.filter(r => r[key] !== null).length || NaN)]));
  }
  for (const [key, value] of Object.entries(summary)) {
    const [split, language] = key.split('/');
    const rows = results.filter(r => r.split === split && (language === 'all' || r.language === language));
    value.samples = rows.length;
    value.validSamples = rows.filter(r => !r.scopeRequired).length;
    value.preparationFailureRate = rows.length ? 1 - value.validSamples / rows.length : null;
    for (const metric of Object.keys(value)) if (Number.isNaN(value[metric])) value[metric] = null;
  }
  return { note: "Curated upstream subsets, not whole repository quality. Additional user searches and real model quality not measured.", results, summary };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const rank = process.argv[2] ? (await import(pathToFileURL(path.resolve(process.argv[2])).href)).rankInvestigationCandidates : undefined;
  console.log(JSON.stringify(await evaluate(rank, process.argv[3]), null, 2));
}
