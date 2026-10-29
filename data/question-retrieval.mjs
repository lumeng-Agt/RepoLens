// Small, reviewed query expansions. These are retrieval hints, never semantic evidence.
const TERMS = [
  ["取消", "cancel", "abort"], ["超时", "timeout", "deadline"],
  ["清理", "cleanup", "dispose", "release"], ["保存", "save", "persist", "write"],
  ["配置", "config", "configuration", "settings"], ["错误", "error", "exception"],
];
const STOP = new Set("的了着过是在和与或及并且而则就都也还很太最个些这那我你他她它们有无不没吗呢吧啊呀么什怎");
const ENGLISH_STOP = new Set("how does work why what where the a an is to of for and do can i it this which function".split(" "));
export function splitIdentifier(value) {
  return String(value).replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}
function queryTerms(question) {
  const exact = new Set(); const parts = new Set(); const expanded = new Set();
  for (const match of String(question).matchAll(/[A-Za-z_][\w./-]{1,}|[\u4e00-\u9fff]{2,}/g)) {
    const raw = match[0].toLowerCase();
    if (/^[\u4e00-\u9fff]/.test(raw)) {
      if (![...raw].every(c => STOP.has(c))) exact.add(raw);
      for (let i = 0; i + 1 < raw.length; i++) if (!STOP.has(raw[i]) && !STOP.has(raw[i + 1])) parts.add(raw.slice(i, i + 2));
    } else {
      if (!ENGLISH_STOP.has(raw)) exact.add(raw);
      for (const part of splitIdentifier(match[0])) if (part.length > 1 && !ENGLISH_STOP.has(part)) parts.add(part);
    }
  }
  for (const group of TERMS) if (group.some(t => exact.has(t) || parts.has(t) || (/^[\u4e00-\u9fff]/.test(t) && question.includes(t)))) for (const t of group) if (!exact.has(t) && !parts.has(t)) expanded.add(t);
  return [...[...exact].map(term => ({ term, weight: 7, kind: "exact" })), ...[...parts].filter(t => !exact.has(t)).map(term => ({ term, weight: 4, kind: "part" })), ...[...expanded].map(term => ({ term, weight: 1, kind: "expansion" }))].slice(0, 96);
}
export function rankQuestionCandidates({ files, dependencies, sourceById, entryFileId, question, excludedFileIds = [] }) {
  const excluded = new Set(excludedFileIds); const terms = queryTerms(question);
  const identifiers = new Set(String(question).match(/[A-Za-z_][\w]*/g) ?? []); const direct = new Map([[entryFileId, "当前文件"]]);
  for (const edge of dependencies) {
    if (edge.fromId === entryFileId) direct.set(edge.toId, "当前文件的直接依赖");
    if (edge.toId === entryFileId && !direct.has(edge.fromId)) direct.set(edge.fromId, "直接引用当前文件");
  }
  const documents = files.map(file => `${file.path} ${(file.symbols ?? []).join(" ")} ${sourceById.get(file.id) ?? ""}`.toLowerCase());
  const frequency = new Map(terms.map(({ term }) => [term, documents.filter(doc => doc.includes(term)).length]));
  const candidates = files.filter(file => !excluded.has(file.id)).map(file => {
    const source = sourceById.get(file.id) ?? ""; const lines = source.split(/\r?\n/);
    const rawMetadata = `${file.path} ${file.role ?? ""} ${file.summary ?? ""} ${(file.symbols ?? []).join(" ")}`;
    const metadata = rawMetadata.toLowerCase();
    const normalized = new Set([...splitIdentifier(rawMetadata), ...splitIdentifier(source)]);
    const reasons = []; const matches = []; let matchScore = 0;
    for (const token of terms) {
      const meta = metadata.includes(token.term); const raw = source.toLowerCase().includes(token.term);
      const split = normalized.has(token.term);
      if (!meta && !raw && !split) continue;
      const weight = token.weight * (1 + Math.log(1 + files.length / (1 + frequency.get(token.term))));
      matchScore += weight * (meta ? 2 : 1);
      matches.push({ term: token.term, kind: token.kind });
      if (token.kind === "expansion") reasons.push(`相关术语匹配：${token.term}`);
      else if (token.kind === "part") reasons.push(`拆词或中文关键词：${token.term}`);
    }
    if (terms.some(t => t.kind !== "expansion" && metadata.includes(t.term))) reasons.push("路径、说明或符号匹配问题");
    if (terms.some(t => t.kind !== "expansion" && source.toLowerCase().includes(t.term))) reasons.push("源码包含问题关键词");
    const ranges = (file.symbolDetails ?? []).map(symbol => {
      const name = `${symbol.name.toLowerCase()} ${splitIdentifier(symbol.name).join(" ")}`;
      const body = lines.slice(symbol.startLine - 1, symbol.endLine).join("\n").toLowerCase();
      const nameMatch = terms.some(t => t.kind === "exact" && symbol.name.toLowerCase() === t.term);
      const score = terms.reduce((sum, t) => sum + (name.includes(t.term) ? t.weight * 4 : body.includes(t.term) ? t.weight : 0), 0);
      return { startLine: symbol.startLine, endLine: symbol.endLine, name: symbol.name, score, nameMatch, exactCase: identifiers.has(symbol.name) };
    }).filter(r => r.score > 0).sort((a, b) => b.score - a.score || a.startLine - b.startLine);
    if (ranges.length) reasons.push(`命中符号定义：${ranges.map(r => r.name).join("、")}`);
    const exactRanges = ranges.filter(r => r.nameMatch);
    const ordered = [...(exactRanges.length ? exactRanges : ranges)].sort((a, b) => Number(b.exactCase) - Number(a.exactCase) || b.score - a.score || a.startLine - b.startLine);
    const top = ordered[0];
    const ambiguous = !!top && ordered.some(r => r !== top && r.exactCase === top.exactCase && (r.name === top.name || r.score === top.score) && (r.startLine !== top.startLine || r.endLine !== top.endLine));
    const best = ambiguous ? undefined : top;
    let suggestedRange = best && { startLine: best.startLine, endLine: best.endLine };
    if (!suggestedRange && source && !ranges.length) {
      const rankedLines = lines.map((line, index) => ({ index, score: terms.reduce((sum, t) => sum + (line.toLowerCase().includes(t.term) ? t.weight : 0), 0) })).sort((a, b) => b.score - a.score || a.index - b.index);
      if (rankedLines[0]?.score) suggestedRange = { startLine: Math.max(1, rankedLines[0].index - 8), endLine: Math.min(lines.length, rankedLines[0].index + 13) };
    }
    if (direct.has(file.id)) reasons.push(direct.get(file.id));
    if (!reasons.length) reasons.push("未发现直接匹配，可手动确认");
    return { id: file.id, score: matchScore + (file.id === entryFileId ? 3 : direct.has(file.id) ? 1 : 0), matchScore, reasons: [...new Set(reasons)], matches, ...(suggestedRange ? { suggestedRange } : {}), rangeRequired: ambiguous, alternativeRanges: ranges.filter(r => r !== best).map(({ startLine, endLine, name }) => ({ startLine, endLine, name })) };
  });
  const byId = new Map(files.map(f => [f.id, f.path ?? f.id]));
  candidates.sort((a, b) => b.score - a.score || byId.get(a.id).localeCompare(byId.get(b.id)));
  return { candidates, retrievalInsufficient: !candidates.some(c => c.matchScore > 0), searchSuggestions: [...new Set(terms.map(t => t.term))].slice(0, 6) };
}
export function rankInvestigationCandidates(input) {
  const ranked = rankQuestionCandidates({ ...input, dependencies: [], entryFileId: "" });
  const excluded = new Set(input.excludedFileIds ?? []); const seeds = new Set(ranked.candidates.filter(c => c.matchScore > 0).slice(0, 5).map(c => c.id));
  const matched = new Set(ranked.candidates.filter(c => c.matchScore > 0).map(c => c.id));
  const neighbors = new Map();
  const edges = [...input.dependencies].sort((a, b) => String(a.id ?? a.fromId + a.toId).localeCompare(String(b.id ?? b.fromId + b.toId)));
  for (const edge of edges) {
    const id = seeds.has(edge.fromId) ? edge.toId : seeds.has(edge.toId) ? edge.fromId : null;
    if (!id || matched.has(id) || excluded.has(id) || neighbors.has(id) || neighbors.size >= 10) continue;
    neighbors.set(id, { ...edge, reason: `静态依赖：${edge.fromId} → ${edge.toId}（${edge.resolutionBasis ?? "静态引用"}）` });
  }
  const candidates = ranked.candidates.filter(c => matched.has(c.id) || neighbors.has(c.id)).map(c => neighbors.has(c.id) ? { ...c, score: 0.1, reasons: [neighbors.get(c.id).reason], dependencyEvidence: neighbors.get(c.id) } : c);
  return { ...ranked, candidates: candidates.length ? candidates : ranked.candidates };
}
