const testPath = path => /(^|[/_.-])(tests?|specs?)([/_.-]|$)|_test\.go$|^test_/i.test(path);

/** File-level suggestions, never a call graph or a test coverage claim. */
export function suggestChangeChecks(snapshot, changes) {
  const files = new Map(snapshot.files.map(file => [file.id, file]));
  const byPath = new Map(snapshot.files.map(file => [file.path, file.id]));
  const changed = new Set(changes.map(change => byPath.get(change.path)).filter(Boolean));
  const candidates = new Map();
  const incoming = new Map();
  for (const edge of [...snapshot.dependencies].sort((a, b) => a.id.localeCompare(b.id))) { if (!incoming.has(edge.toId)) incoming.set(edge.toId, []); incoming.get(edge.toId).push(edge); }
  const add = (id, reason, path, edgeIds = []) => {
    if (!files.has(id) || changed.has(id)) return;
    const existing = candidates.get(id);
    if (existing) { if (!existing.reasons.includes(reason)) existing.reasons.push(reason); return; }
    candidates.set(id, { fileId: id, path: files.get(id).path, kind: testPath(files.get(id).path) ? "test" : "consumer", reasons: [reason], dependencyPath: path, edgeIds });
  };
  for (const target of [...changed].sort()) {
    const queue = [{ id: target, path: [target], edges: [] }]; const seen = new Set([target]);
    while (queue.length) {
      const current = queue.shift();
      for (const edge of incoming.get(current.id) ?? []) {
        if (seen.has(edge.fromId)) continue;
        seen.add(edge.fromId);
        const path = [edge.fromId, ...current.path]; const edges = [edge.id, ...current.edges];
        add(edge.fromId, path.length === 2 ? "直接静态引用变更文件" : "沿静态依赖间接引用变更文件", path, edges);
        queue.push({ id: edge.fromId, path, edges });
      }
    }
    const file = files.get(target); const stem = file.name.replace(/\.[^.]+$/, "").toLowerCase();
    const symbols = new Set((file.symbols ?? []).map(name => name.toLowerCase()));
    for (const candidate of snapshot.files.filter(file => testPath(file.path))) {
      if (stem.length >= 3 && candidate.path.toLowerCase().includes(stem)) add(candidate.id, `测试路径包含文件名：${stem}`, []);
      const specifierMatch = candidate.imports?.some(item => item.targetPath === file.path || item.targetPath === target);
      if (specifierMatch) add(candidate.id, "测试导入指向变更文件", []);
      const common = (candidate.symbols ?? []).filter(symbol => symbols.has(symbol.toLowerCase()));
      if (common.length) add(candidate.id, `符号名称重合：${common.join("、")}（需人工核对）`, []);
    }
  }
  const limitations = ["按当前快照的文件依赖分析；候选不代表实际调用、接口兼容或测试覆盖。"];
  if (changes.some(change => change.status === "deleted" || !byPath.has(change.path))) limitations.push("包含已删除或当前未索引的文件，无法列全旧版本使用方。");
  if (snapshot.unresolved?.length) limitations.push(`当前有 ${snapshot.unresolved.length} 条未解析或外部引用，潜在影响范围可能不完整。`);
  if (snapshot.dependencies.some(edge => edge.kind === "dynamic")) limitations.push("动态引用只能包含当前已静态解析的关系。");
  return { candidates: [...candidates.values()].sort((a, b) => a.path.localeCompare(b.path)), limitations };
}
