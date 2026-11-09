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
/** Shared production/evaluation preview preparation; never calls a model. */
export function prepareAiContext({ candidates, rankedCandidates = [], fileIds, ranges = {}, sourceById, entryFileId, requireEntry = false, question = '', history = [], retrievalInsufficient = false, questionLike = true }) {
  // The candidate pool is a picker, not a request to send every match.
  const positive = rankedCandidates.filter(c => c.score > 0);
  const strongest = positive[0]?.score ?? 0;
  const defaults = positive.filter(c => c.score >= strongest * 0.5).slice(0, 5).map(c => c.id);
  if (requireEntry && !defaults.includes(entryFileId)) defaults.unshift(entryFileId);
  const requested = fileIds ?? (questionLike ? (defaults.length ? defaults : candidates.slice(0, 12)) : candidates);
  const effectiveRanges = { ...ranges };
  for (const candidate of rankedCandidates) if (!effectiveRanges[candidate.id] && candidate.suggestedRange) effectiveRanges[candidate.id] = candidate.suggestedRange;
  const selected = selectAiContext({fileIds: requested, candidateIds: candidates, entryFileId, ranges: effectiveRanges, sourceById, requireEntry});
  const totalCharacters = selected.characters + (questionLike ? String(question).length + history.reduce((sum, item) => sum + item.content.length, 0) : 0);
  const unresolvedRange = requested.some(id => rankedCandidates.find(c => c.id === id)?.rangeRequired && !ranges[id]);
  const blockers = [];
  if (!selected.sources.length || (questionLike && !fileIds && retrievalInsufficient)) blockers.push("insufficient_evidence");
  if (selected.sources.length > 12 || (questionLike && !fileIds && !rankedCandidates.length && candidates.length > 12)) blockers.push("file_limit");
  if (totalCharacters > 60_000) blockers.push("character_limit");
  if (unresolvedRange) blockers.push("ambiguous_definition");
  return { ...selected, totalCharacters, scopeRequired: blockers.length > 0, blockers };
}

/** Automatic context is helpful, not a prerequisite for having a conversation. */
export function prepareConversationContext(options) {
  const withoutSource = (contextNotice) => {
    const totalCharacters = String(options.question ?? "").length + (options.history ?? []).reduce((sum, item) => sum + item.content.length, 0);
    const blockers = totalCharacters > 60_000 ? ["character_limit"] : [];
    return { sources: [], characters: 0, totalCharacters, blockers, scopeRequired: blockers.length > 0, contextNotice };
  };
  if (options.fileIds?.length === 0) return withoutSource("本次仅发送问题和所选历史，不附带源码。");
  const currentFileQuestion = /当前(?:文件|代码)|这个文件|这(?:段|份|个)(?:的)?代码|解释(?:一下)?代码|\b(?:explain|describe)\s+(?:this|the current)\s+(?:code|file)\b/i.test(String(options.question ?? ""));
  const selected = options.fileIds === undefined && currentFileQuestion && options.candidates.includes(options.entryFileId)
    ? prepareAiContext({ ...options, fileIds: [options.entryFileId], rankedCandidates: [] })
    : prepareAiContext(options);
  if (options.fileIds === undefined && selected.scopeRequired) {
    return withoutSource(options.retrievalInsufficient ? "未找到直接相关的代码，本次不附带源码。可以继续聊天，或按需补充文件。" : "相关代码的范围需要进一步确认，本次不附带源码。可以先讨论，再按需补充文件。");
  }
  return selected;
}
