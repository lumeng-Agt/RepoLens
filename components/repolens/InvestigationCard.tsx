import type { Investigation, RepositorySnapshot, SourceReference } from "@/data/model";
import { investigationItemIsStale } from "@/data/investigation.mjs";

export function InvestigationCard({ record, repository, busy, onChange, onOpen, onEvidence, onRelations, onContinue }: {
  record: Investigation; repository: RepositorySnapshot; busy: boolean; onChange: (record: Investigation) => void;
  onOpen: (reference: SourceReference) => void; onEvidence?: (fileId: string, line: number) => void;
  onRelations?: (fileId: string) => void; onContinue: (record: Investigation) => void;
}) {
  const visible = record.items.filter(item => !item.references.every(ref => record.excludedFileIds.includes(ref.fileId)));
  return <section className="investigation-card" aria-label="调查结果">
    <p>{record.summary}</p><small>以下是候选位置；需要核对源码后判断是否应当修改。</small>
    <h4>相关实现与候选位置 · {visible.length}</h4>
    {visible.map(item => {
      const stale = investigationItemIsStale(item, record, repository.files);
      const referencedIds = new Set(item.references.map(ref => ref.fileId));
      const relations = repository.dependencies.filter(edge => referencedIds.has(edge.fromId) || referencedIds.has(edge.toId));
      return <article key={item.id} className="investigation-item"><strong>{item.title}</strong><small>{item.responsibility} · {item.basis === "static-dependency" ? "静态关系候选" : item.basis === "retrieval-match" ? "检索命中" : "模型推断"}{stale ? " · 依据需要复核" : ""}</small><p>{item.reason}</p>
        <div className="question-references">{item.references.map((ref, index) => <button type="button" key={`${ref.fileId}:${index}`} disabled={stale || busy} title={ref.fileId} onClick={() => onEvidence ? onEvidence(ref.fileId, ref.startLine) : onOpen({ fileId: ref.fileId, line: ref.startLine, endLine: ref.endLine })}>{ref.fileId.split("/").pop()}:{ref.startLine}{ref.endLine ? `–${ref.endLine}` : ""}</button>)}</div>
        {item.references.map(ref => record.selectionReasons?.[ref.fileId]?.length ? <small key={`reason:${ref.fileId}`}>检索依据：{record.selectionReasons[ref.fileId].join("、")}</small> : null)}
        {!!relations.length && <details><summary>静态依赖依据 · {relations.length}</summary>{relations.slice(0, 20).map(edge => <div key={edge.id}><button type="button" disabled={busy || stale} onClick={() => onOpen(edge.reference)}>{edge.fromId} → {edge.toId}</button><small>{edge.resolutionBasis ?? edge.kind ?? "静态引用"} · 导入声明，不表示实际调用</small></div>)}{relations.length > 20 && <small>另有 {relations.length - 20} 条，请在图谱中查看。</small>}{onRelations && <button type="button" onClick={() => onRelations(item.references[0].fileId)}>在图谱中查看关系</button>}</details>}
        <div className="investigation-item-actions">{typeof window !== "undefined" && window.repoLens && repository.source === "local" && !repository.origin && item.references.map((ref, index) => <button key={`editor:${index}`} type="button" disabled={stale || busy} onClick={() => { const file = repository.files.find(f => f.id === ref.fileId); if (file) void window.repoLens?.openInEditor({ repositoryId: repository.id, revision: repository.revision ?? repository.version, persistenceSessionId: repository.persistenceSessionId, fileId: file.id, contentHash: file.contentHash ?? "", line: ref.startLine }).catch((error: Error) => window.alert(error.message)); }}>在 VS Code 中打开{item.references.length > 1 ? ` ${index + 1}` : ""}</button>)}<label><input type="checkbox" checked={record.verifiedItemIds.includes(item.id)} disabled={busy || stale} onChange={event => onChange({ ...record, verifiedItemIds: event.target.checked ? [...record.verifiedItemIds, item.id] : record.verifiedItemIds.filter(id => id !== item.id) })}/>我已核对结论</label><button type="button" disabled={busy} onClick={() => onChange({ ...record, excludedFileIds: [...new Set([...record.excludedFileIds, ...item.references.map(ref => ref.fileId)])] })}>排除此项文件</button></div>
        {record.checks && <label>检查状态<select aria-label={`${item.title} 检查状态`} disabled={busy} value={record.checks[item.id] ?? "pending"} onChange={event => onChange({ ...record, checks: { ...record.checks, [item.id]: event.target.value as "pending" | "checked" | "irrelevant" } })}><option value="pending">待检查</option><option value="checked">已检查</option><option value="irrelevant">不相关</option></select></label>}
      </article>;
    })}
    {!visible.length && <p>没有可展示的候选。可以补充文件，或撤销排除后继续调查。</p>}
    {!!record.excludedFileIds.length && <details><summary>已排除文件 · {record.excludedFileIds.length}</summary>{record.excludedFileIds.map(id => <div key={id}><code>{id}</code><button type="button" disabled={busy} onClick={() => onChange({ ...record, excludedFileIds: record.excludedFileIds.filter(file => file !== id) })}>撤销排除</button></div>)}</details>}
    <h4>待确认与下一步</h4>{record.questions.length ? <ul>{record.questions.map((item, index) => <li key={index}>{item.question}{item.suggestedFileId && <small>建议补读：{item.suggestedFileId}（尚未作为本条结论依据）</small>}</li>)}</ul> : <p>尚未记录待确认问题。可继续提问补充。</p>}
    <button type="button" disabled={busy} onClick={() => onContinue(record)}>继续调查</button>
  </section>;
}
