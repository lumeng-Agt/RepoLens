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
