import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import type { RepositorySnapshot, RevisionComparison, Investigation } from "@/data/model";
import { suggestChangeChecks } from "@/data/change-investigation.mjs";
import { changeInvestigation, getInvestigationState, subscribeInvestigations } from "@/data/investigation-state.mjs";

export function ChangeChecks({ repository, comparison, onSelectFile }: { repository: RepositorySnapshot; comparison: RevisionComparison; onSelectFile: (id: string) => void }) {
  const workspaceId = repository.workspaceId ?? repository.id;
  const { records } = useSyncExternalStore(useCallback(fn => subscribeInvestigations(workspaceId, fn), [workspaceId]), useCallback(() => getInvestigationState(workspaceId), [workspaceId]), useCallback(() => getInvestigationState(workspaceId), [workspaceId]));
  const suggestions = useMemo(() => suggestChangeChecks(repository, comparison.files), [repository, comparison]);
  const [checks, setChecks] = useState<Record<string, "pending" | "checked" | "irrelevant">>({});
  const [savedId, setSavedId] = useState(""); const [feedback, setFeedback] = useState("");
  const [visibleCount, setVisibleCount] = useState(100);
  const current = records.find(record => record.id === savedId);
  const changedPaths = new Set(comparison.files.flatMap(file => [file.path, file.oldPath].filter(Boolean)));
  const affected = records.filter(record => record.items.some(item => item.references.some(ref => changedPaths.has(repository.files.find(file => file.id === ref.fileId)?.path ?? ref.fileId))));
  const save = () => {
    if (current) return;
    if (records.length >= 100) { setFeedback("每个工作区最多保存 100 条调查。"); return; }
    const included = suggestions.candidates.filter(item => checks[item.fileId] !== "irrelevant");
    if (included.length > 200) { setFeedback(`有 ${included.length} 个候选；每条调查最多 200 项。请缩小比较范围，或将无关项标为“不相关”。`); return; }
    const now = Date.now(); const id = crypto.randomUUID();
    const relevantIds = new Set([...suggestions.candidates.map(item => item.fileId), ...comparison.files.map(change => repository.files.find(file => file.path === change.path)?.id).filter((id): id is string => Boolean(id))]);
    const record: Investigation = { id, title: `变更检查 ${comparison.baseCommit.slice(0, 8)} → ${comparison.headCommit === "WORKTREE" ? "工作区" : comparison.headCommit.slice(0, 8)}`, question: "这次改动还需要检查哪些位置？", summary: comparison.files.map(file => `${file.status}: ${file.path}`).join("\n"), workspaceId, repositoryName: repository.name,
      ...(repository.origin ? { ref: repository.origin.resolvedRef, commit: repository.origin.commit } : {}),
      items: included.map(item => ({ id: item.fileId, title: item.path, responsibility: item.kind === "test" ? "测试候选" : "使用方候选", reason: item.reasons.join("；"), basis: item.edgeIds.length ? "static-dependency" as const : "retrieval-match" as const, references: [{ fileId: item.fileId, startLine: repository.dependencies.find(edge => item.edgeIds.includes(edge.id) && edge.fromId === item.fileId)?.reference.line ?? 1 }] })),
      questions: suggestions.limitations.map(question => ({ question })), excludedFileIds: [], verifiedItemIds: [], checks,
      contextFiles: repository.files.filter(file => relevantIds.has(file.id)).map(file => ({ fileId: file.id, contentHash: file.contentHash ?? "", startLine: 1, endLine: Number.MAX_SAFE_INTEGER })), createdAt: now, updatedAt: now };
    // Line ranges for static checks are narrowed to the actual import location; no source content is exported.
    record.contextFiles = record.contextFiles.map(file => ({ ...file, endLine: Math.max(1, ...record.items.flatMap(item => item.references.filter(ref => ref.fileId === file.fileId).map(ref => ref.startLine))) }));
    if (changeInvestigation(workspaceId, record)) { setSavedId(id); setFeedback("已加入调查记录；保存状态请查看全局提示。"); }
  };
  return <section className="change-checks" aria-label="建议检查"><h3>建议检查 · {suggestions.candidates.length}</h3><p>候选按当前静态图整理，可加入调查逐项核对。</p>
    <ul>{suggestions.candidates.slice(0, visibleCount).map(item => <li key={item.fileId}><div><button type="button" onClick={() => onSelectFile(item.fileId)}>{item.path}</button><small>{item.kind === "test" ? "测试候选" : "使用方候选"} · {item.reasons.join("；")}</small>{item.dependencyPath.length > 0 && <details><summary>静态依赖路径</summary><ol>{item.edgeIds.map(edgeId => { const edge = repository.dependencies.find(edge => edge.id === edgeId)!; return <li key={edgeId}><button type="button" onClick={() => onSelectFile(edge.fromId)}>{edge.fromId} → {edge.toId}</button><small>{edge.resolutionBasis ?? edge.kind ?? "静态引用"} · 第 {edge.reference.line} 行</small></li>; })}</ol></details>}</div>
      <select aria-label={`${item.path} 检查状态`} value={(current?.checks ?? checks)[item.fileId] ?? "pending"} onChange={event => { const value = event.target.value as "pending" | "checked" | "irrelevant"; const next = { ...(current?.checks ?? checks), [item.fileId]: value }; setChecks(next); if (current) changeInvestigation(workspaceId, { ...current, checks: next, updatedAt: Date.now() }); }}><option value="pending">待检查</option><option value="checked">已检查</option><option value="irrelevant">不相关</option></select></li>)}</ul>
    {!suggestions.candidates.length && <p>当前图没有找到使用方候选；这不表示没有影响。</p>}
    {suggestions.candidates.length > visibleCount && <button type="button" onClick={() => setVisibleCount(count => count + 100)}>再显示 100 项（共 {suggestions.candidates.length} 项）</button>}
    <button type="button" disabled={Boolean(current)} onClick={save}>{current ? "已加入调查" : "加入调查记录"}</button>{feedback && <p role="status">{feedback}</p>}
    <details open><summary>分析限制</summary><ul>{suggestions.limitations.map(text => <li key={text}>{text}</li>)}</ul></details>
    <h4>需要复核的调查 · {affected.length}</h4>{affected.map(record => <p key={record.id}>{record.title} · 依据涉及变更文件，请在调查记录中复核。</p>)}
  </section>;
}
