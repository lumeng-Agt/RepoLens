const TOKEN_PATTERN = /[A-Za-z_][\w./-]{1,}|[\u4e00-\u9fff]{2,}/g;
const CJK_PATTERN = /^[\u4e00-\u9fff]/;
// Chinese has no word boundaries, so a whole sentence becomes one token and can
// only match source verbatim. Two-character windows are added for recall; windows
// made of function words are dropped so common phrasing does not rank every file.
const CJK_STOP_CHARS = new Set("的了着过是在和与或及并且而则就都也还很太最个些这那我你他她它们有无不没吗呢吧啊呀么什怎");
const MAX_TOKENS = 96;

function tokenizeQuestion(question) {
  const tokens = [];
  const seen = new Set();
  const push = (value) => {
    if (!value || seen.has(value) || tokens.length >= MAX_TOKENS) return;
    seen.add(value);
    tokens.push(value);
  };
  for (const match of String(question).matchAll(TOKEN_PATTERN)) {
    const raw = match[0];
    if (!CJK_PATTERN.test(raw)) { push(raw.toLowerCase()); continue; }
    push(raw);
    for (let index = 0; index + 2 <= raw.length; index += 1) {
      const bigram = raw.slice(index, index + 2);
      if (CJK_STOP_CHARS.has(bigram[0]) || CJK_STOP_CHARS.has(bigram[1])) continue;
      push(bigram);
    }
  }
  return tokens;
}

/** Rank files for a question and explain each inclusion decision. */
export function rankQuestionCandidates({ files, dependencies, sourceById, entryFileId, question }) {
  const tokens = tokenizeQuestion(question);
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
      return normalizedName === token || ((token.length >= 3 || CJK_PATTERN.test(token)) && normalizedName.includes(token));
    }));
    const source = (sourceById.get(file.id) ?? "").toLowerCase();
    for (const token of tokens) {
      // A Chinese two-character window is a weaker signal than a whole English
      // identifier, so it contributes less to the score.
      const metadataWeight = CJK_PATTERN.test(token) ? 4 : 7;
      const sourceHits = source.split(token).length - 1;
      if (searchable.includes(token)) { score += metadataWeight; metadataMatch = true; }
      if (sourceHits) { score += CJK_PATTERN.test(token) ? Math.min(sourceHits * 2, 6) : Math.min(sourceHits, 4); sourceMatch = true; }
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

/** A requirement has no privileged current file. Expand real matches by one static edge only. */
export function rankInvestigationCandidates({ files, dependencies, sourceById, question }) {
  const ranked = rankQuestionCandidates({ files, dependencies: [], sourceById, entryFileId: "", question });
  const matched = new Set(ranked.candidates.filter(candidate => candidate.score > 0).map(candidate => candidate.id));
  const neighbors = new Map();
  for (const edge of dependencies) {
    if (matched.has(edge.fromId) && !matched.has(edge.toId)) neighbors.set(edge.toId, "静态依赖：被关键词命中文件引用");
    if (matched.has(edge.toId) && !matched.has(edge.fromId)) neighbors.set(edge.fromId, "静态依赖：引用关键词命中文件");
  }
  const candidates = ranked.candidates.filter(candidate => matched.has(candidate.id) || neighbors.has(candidate.id)).map(candidate => neighbors.has(candidate.id)
    ? { ...candidate, score: 1, reasons: [neighbors.get(candidate.id)] } : candidate);
  candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return { candidates: candidates.length ? candidates : ranked.candidates, retrievalInsufficient: !matched.size };
}
