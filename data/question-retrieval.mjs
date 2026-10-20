const TOKEN_PATTERN = /[A-Za-z_][\w./-]{1,}|[\u4e00-\u9fff]{2,}/g;

/** Rank files for a question and explain each inclusion decision. */
export function rankQuestionCandidates({ files, dependencies, sourceById, entryFileId, question }) {
  const tokens = [...new Set((String(question).match(TOKEN_PATTERN) ?? []).map((token) => token.toLowerCase()))].slice(0, 80);
  const directReasons = new Map([[entryFileId, "当前文件"]]);
  for (const edge of dependencies) {
    if (edge.fromId === entryFileId) directReasons.set(edge.toId, "当前文件的直接依赖");
    if (edge.toId === entryFileId && !directReasons.has(edge.fromId)) directReasons.set(edge.fromId, "直接引用当前文件");
  }

  const candidates = files.map((file) => {
    const symbolDetails = file.symbolDetails ?? [];
    const searchable = `${file.path} ${file.role ?? ""} ${file.summary ?? ""} ${(file.symbols ?? []).join(" ")} ${symbolDetails.map((symbol) => symbol.name).join(" ")}`.toLowerCase();
    const reasons = [];
    let score = 0;
    if (directReasons.has(file.id)) {
      score += file.id === entryFileId ? 8 : 3;
      reasons.push(directReasons.get(file.id));
    }
    let metadataMatch = false;
    let sourceMatch = false;
    const matchedSymbols = symbolDetails.filter((symbol) => tokens.some((token) => {
      const normalizedName = symbol.name.toLowerCase();
      return normalizedName === token || (token.length >= 3 && normalizedName.includes(token));
    }));
    const source = (sourceById.get(file.id) ?? "").toLowerCase();
    for (const token of tokens) {
      if (searchable.includes(token)) { score += 7; metadataMatch = true; }
      const sourceHits = source.split(token).length - 1;
      if (sourceHits) { score += Math.min(sourceHits, 4); sourceMatch = true; }
    }
    if (metadataMatch) reasons.push("路径、说明或符号匹配问题");
    if (sourceMatch) reasons.push("源码包含问题关键词");
    if (matchedSymbols.length) reasons.push(`命中符号定义：${matchedSymbols.map((symbol) => symbol.name).join("、")}`);
    if (reasons.length === 0) reasons.push("未发现直接匹配，可手动确认");
    const suggestedRange = matchedSymbols.length ? {
      startLine: Math.min(...matchedSymbols.map((symbol) => symbol.startLine)),
      endLine: Math.max(...matchedSymbols.map((symbol) => symbol.endLine)),
    } : null;
    return { id: file.id, score, reasons, ...(suggestedRange ? { suggestedRange } : {}) };
  });

  const matched = candidates.some((item) => item.score > (item.id === entryFileId ? 8 : directReasons.has(item.id) ? 3 : 0));
  candidates.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  return { candidates, retrievalInsufficient: !tokens.length || !matched };
}
