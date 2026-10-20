import { rankQuestionCandidates } from "./question-retrieval.mjs";

/** Build a deterministic candidate set from static dependency edges. */
export function collectAiCandidates(snapshot, entryFileId, mode) {
  if (!snapshot.files.some((file) => file.id === entryFileId)) throw new Error("目标文件已不存在，请重新选择文件。");
  const selected = new Set([entryFileId]);
  if (mode === "explanation") {
    for (const edge of snapshot.dependencies) if (edge.fromId === entryFileId) selected.add(edge.toId);
  } else {
    const queue = [entryFileId];
    while (queue.length) {
      const id = queue.shift();
      for (const edge of snapshot.dependencies) {
        if (edge.fromId === id && !selected.has(edge.toId)) { selected.add(edge.toId); queue.push(edge.toId); }
      }
    }
  }
  return [...selected].sort((a, b) => a.localeCompare(b));
}

/** Rank route context against the user's reading goal while keeping the entry and graph candidates available. */
export function rankGoalCandidates(snapshot, entryFileId, goal, sourceById) {
  const graphCandidates = collectAiCandidates(snapshot, entryFileId, "route");
  const allowed = new Set(graphCandidates);
  const ranking = rankQuestionCandidates({ files: snapshot.files, dependencies: snapshot.dependencies, sourceById, entryFileId, question: goal });
  const candidates = ranking.candidates.filter((candidate) => allowed.has(candidate.id));
  const entry = candidates.find((candidate) => candidate.id === entryFileId);
  const ranked = candidates.filter((candidate) => candidate.id !== entryFileId).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  const matched = ranked.filter((candidate) => candidate.score > 3);
  const selected = [entryFileId, ...matched.map((candidate) => candidate.id)];
  for (const candidate of ranked) {
    if (selected.length >= Math.min(3, candidates.length)) break;
    if (!selected.includes(candidate.id)) selected.push(candidate.id);
  }
  return {
    candidates: [entry, ...ranked].filter(Boolean),
    selectedFileIds: selected,
    retrievalInsufficient: ranking.retrievalInsufficient,
  };
}

/** Keep explicit user-selected question files available for a fresh preview, even when retrieval did not rank them. */
export function questionCandidateIds(snapshot, entryFileId, question, sourceById, requestedFileIds = []) {
  const ranked = rankQuestionCandidates({ files: snapshot.files, dependencies: snapshot.dependencies, sourceById, entryFileId, question });
  const known = new Set(snapshot.files.map((file) => file.id));
  const ids = [...ranked.candidates.map((candidate) => candidate.id)];
  for (const id of requestedFileIds) if (known.has(id) && !ids.includes(id)) ids.push(id);
  return { candidates: ids, ranking: ranked.candidates, retrievalInsufficient: ranked.retrievalInsufficient };
}

/** Select, validate, and slice the exact source ranges approved for a preview. */
export function selectAiContext({ fileIds, candidateIds, entryFileId, ranges = {}, sourceById, requireEntry = true }) {
  const allowed = new Set(candidateIds);
  if (!Array.isArray(fileIds) || (requireEntry && !fileIds.includes(entryFileId)) || fileIds.some((id) => !allowed.has(id))) throw new Error("选择范围已变化，请重新预览。");
  const sources = [...new Set(fileIds)].sort((a, b) => a.localeCompare(b)).map((fileId) => {
    const fullSource = sourceById.get(fileId);
    if (fullSource === undefined) throw new Error("预览中的文件已不存在，请重新选择。");
    const lines = fullSource.split("\n");
    const requestedRange = ranges[fileId] ?? { startLine: 1, endLine: lines.length };
    const startLine = requestedRange.startLine;
    const endLine = requestedRange.endLine;
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine > lines.length) throw new Error(`文件 ${fileId} 的行范围无效。`);
    return { fileId, source: lines.slice(startLine - 1, endLine).join("\n"), contentHash: undefined, startLine, endLine };
  });
  return { sources, characters: sources.reduce((sum, item) => sum + item.source.length, 0) };
}
