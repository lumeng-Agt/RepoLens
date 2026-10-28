import "./investigation.css";
import { useEffect, useRef, useState } from "react";
import type { Investigation, RepositorySnapshot, SourceReference } from "@/data/model";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { InvestigationCard } from "./InvestigationCard";
import { useInvestigationRecords } from "./useInvestigationRecords";
import { exportInvestigations, parseInvestigationImport, mergeInvestigationImport } from "@/data/investigation.mjs";
import { getInvestigationEpoch, getInvestigationState } from "@/data/investigation-state.mjs";
import { localRepositoryProvider } from "@/data/providers";

function download(text: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type })); const a = document.createElement("a"); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function InvestigationPanel({ repository, busy, onContinue, onOpen, onRelations }: {
  repository: RepositorySnapshot; busy: boolean; onContinue: (record: Investigation) => void;
  onOpen: (ref: SourceReference) => void; onRelations: (fileId: string) => void;
}) {
  const collection = useInvestigationRecords(repository, busy);
  const workspaceId = repository.workspaceId ?? repository.id;
  const sessionKey = `${workspaceId}:${repository.persistenceSessionId}:${repository.revision}`;
  const [open, setOpen] = useState(false); const [selectedId, setSelectedId] = useState("");
  const [selectedExports, setSelectedExports] = useState<string[]>([]);
  const [incoming, setIncoming] = useState<Investigation[] | null>(null); const [importFingerprint, setImportFingerprint] = useState("");
  const [crossRef, setCrossRef] = useState(false); const [error, setError] = useState(""); const [validating, setValidating] = useState(false);
  const [evidence, setEvidence] = useState<{ title: string; text: string } | null>(null);
  const importEpoch = useRef(0);
  const operation = useRef(0); const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    operation.current++; controller.current?.abort();
    // Repository changes and clear barriers invalidate the entire import preview.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIncoming(null); setValidating(false); setEvidence(null);
  }, [sessionKey, busy]);
  useEffect(() => () => { operation.current++; controller.current?.abort(); }, []);
  const cancel = () => { operation.current++; controller.current?.abort(); setIncoming(null); setValidating(false); setEvidence(null); setOpen(false); };
  const record = collection.records.find(item => item.id === selectedId) ?? collection.records[0];
  const preview = incoming ? mergeInvestigationImport(collection.records, incoming, workspaceId, () => "preview-copy") : null;
  const mismatch = incoming?.some(item => item.workspaceId !== workspaceId || item.ref !== repository.origin?.resolvedRef);
  const loadImport = async (file: File) => {
    const seq = ++operation.current; const epoch = getInvestigationEpoch(workspaceId);
    if (file.size > 2_000_000) { setError("导入文件超过 2 MB，请减少调查记录。"); return; }
    try {
      const records = parseInvestigationImport(await file.text());
      if (seq !== operation.current || epoch !== getInvestigationEpoch(workspaceId)) return;
      importEpoch.current = epoch; setIncoming(records); setCrossRef(false); setError(""); setImportFingerprint(JSON.stringify(getInvestigationState(workspaceId).records));
    } catch { if (seq === operation.current) setError("无法读取调查文件；请使用 RepoLens 导出的有效 JSON。"); }
  };
  const confirmImport = async () => {
    if (!incoming || busy || !collection.loaded || mismatch && !crossRef) return;
    if (importEpoch.current !== getInvestigationEpoch(workspaceId)) { setIncoming(null); setError("调查状态已变化，请重新选择导入文件。"); return; }
    const seq = ++operation.current; const epoch = getInvestigationEpoch(workspaceId); const snapshot = JSON.stringify(getInvestigationState(workspaceId).records);
    if (snapshot !== importFingerprint) { setImportFingerprint(snapshot); setError("现有调查已变化，请核对更新后的冲突数量，再确认导入。"); return; }
    const abort = new AbortController(); controller.current?.abort(); controller.current = abort; setValidating(true); setError("");
    try {
      // Read only indexed sources from the current repository; imported paths never become filesystem paths.
      const indexed = new Map(repository.files.map(file => [file.id, file]));
      const checked = new Map<string, number>();
      for (const item of incoming) for (const ref of item.items.flatMap(entry => entry.references)) {
        if (!indexed.has(ref.fileId) || checked.has(ref.fileId)) continue;
        const source = await localRepositoryProvider.getSource(repository.id, repository.revision, ref.fileId, abort.signal);
        checked.set(ref.fileId, source.split("\n").length);
      }
      if (seq !== operation.current || epoch !== getInvestigationEpoch(workspaceId) || abort.signal.aborted) return;
      const latest = getInvestigationState(workspaceId).records;
      if (JSON.stringify(latest) !== snapshot) { setImportFingerprint(JSON.stringify(latest)); setError("校验期间记录已变化，请重新确认导入。"); return; }
      // Only files cited by an item are read for line counts. A context file that
      // no item cites still matches by content hash, so it must not be dropped
      // here — dropping it rewrote the record and turned an identical import into
      // a conflict copy.
      const validContext = (context: Investigation["contextFiles"][number]) => {
        const count = checked.get(context.fileId);
        return indexed.get(context.fileId)?.contentHash === context.contentHash && context.startLine >= 1 && context.endLine >= context.startLine && (count === undefined || context.endLine <= count);
      };
      const validated = incoming.map(item => ({ ...item,
        contextFiles: item.contextFiles.filter(validContext),
        items: item.items.map(candidate => ({ ...candidate, ...(candidate.contextFiles ? { contextFiles: candidate.contextFiles.filter(validContext) } : {}) })),
      }));
      const merged = mergeInvestigationImport(latest, validated, workspaceId);
      const expected = mergeInvestigationImport(latest, incoming, workspaceId);
      if (merged.conflicts !== expected.conflicts || merged.skipped !== expected.skipped) { setIncoming(validated); setError("引用核验更新了冲突结果，请核对后再次确认。"); return; }
      if (merged.records.length > 100) throw new Error("每个工作区最多保存 100 条调查，请减少导入数量。");
      for (const item of merged.records) if (!latest.some(existing => existing.id === item.id)) collection.update(item);
      setIncoming(null); setSelectedId(merged.records.at(-1)?.id ?? "");
    } catch (cause) { if (seq === operation.current && !abort.signal.aborted) setError(cause instanceof Error ? cause.message : "导入校验失败。"); }
    finally { if (seq === operation.current) setValidating(false); }
  };
  return <div className="investigation-entry"><button type="button" onClick={() => setOpen(true)}>调查记录{collection.records.length ? ` · ${collection.records.length}` : ""}</button>
    {(collection.pending > 0 || collection.error) && <span role="status">调查{collection.error ? "保存或读取失败" : "尚未保存"}<button type="button" disabled={busy} onClick={() => void collection.retry()}>重试</button></span>}
    {open && <WorkspaceDialog className="investigation-dialog" aria-label="调查记录" onDismiss={cancel}><header><h2>调查记录</h2><button type="button" onClick={cancel}>关闭</button></header>
      {!collection.loaded && <p role="alert">调查记录尚未读取成功；本页修改仅保留在内存中。<button type="button" onClick={() => void collection.read()}>重试读取</button></p>}
      {collection.error && <p role="alert">{collection.error}<button type="button" onClick={() => void collection.retry()}>重试</button></p>}
      <p role="status">{collection.pending ? "调查尚未保存" : collection.saving ? "正在保存调查…" : collection.loaded ? "调查已恢复；新修改会自动保存" : "正在读取调查…"}</p>
      <div className="investigation-workspace"><nav aria-label="已保存的调查">{collection.records.map(item => <div key={item.id}><label><input type="checkbox" aria-label={`导出 ${item.title}`} checked={selectedExports.includes(item.id)} onChange={event => setSelectedExports(event.target.checked ? [...selectedExports, item.id] : selectedExports.filter(id => id !== item.id))}/></label><button type="button" aria-current={record?.id === item.id} onClick={() => { setSelectedId(item.id); setEvidence(null); }}>{item.title}</button></div>)}{!collection.records.length && <p>还没有保存调查。在聊天中选择“定位改动位置”，生成后点击“保存调查”。</p>}</nav>
      {record && <main><label>调查标题<input aria-label="调查标题" value={record.title} disabled={busy} onChange={event => { if (event.target.value.trim()) collection.update({ ...record, title: event.target.value }); }}/></label><p>{record.question}</p>
        <InvestigationCard record={record} repository={repository} busy={busy} onChange={collection.update} onOpen={ref => { cancel(); onOpen(ref); }} onEvidence={(fileId, line) => {
          const ref = record.items.flatMap(item => item.references).find(ref => ref.fileId === fileId && ref.startLine === line); if (!ref) return;
          const seq = ++operation.current; const abort = new AbortController(); controller.current?.abort(); controller.current = abort;
          setEvidence({ title: `${fileId}:${line}`, text: "正在读取…" });
          void localRepositoryProvider.getSource(repository.id, repository.revision, fileId, abort.signal).then(source => { if (seq === operation.current) setEvidence({ title: `${fileId}:${line}`, text: source.split("\n").slice(line - 1, Math.min(ref.endLine ?? line, line + 39)).map((value, index) => `${line + index}  ${value}`).join("\n") }); }).catch(cause => { if (seq === operation.current) setEvidence({ title: `${fileId}:${line}`, text: cause.message }); });
        }} onRelations={id => { cancel(); onRelations(id); }} onContinue={value => { cancel(); onContinue(value); }}/>
        {evidence && <aside className="question-evidence"><strong>{evidence.title}</strong><pre>{evidence.text}</pre><button type="button" onClick={() => setEvidence(null)}>关闭证据</button></aside>}
        <details><summary>编辑结论与待确认事项</summary><label>调查摘要<textarea value={record.summary} disabled={busy} onChange={event => collection.update({ ...record, summary: event.target.value })}/></label><label>待确认问题（每行一条；编辑后清除原建议路径）<textarea value={record.questions.map(item => item.question).join("\n")} disabled={busy} onChange={event => collection.update({ ...record, questions: event.target.value.split("\n").filter(Boolean).map(question => ({ question })) })}/></label></details>
        <details><summary>删除调查</summary><p>只删除这条调查，保留聊天、笔记及源码。</p><button type="button" disabled={busy} onClick={() => collection.remove(record.id)}>确认删除调查</button></details>
      </main>}</div>
      <footer><button type="button" disabled={!selectedExports.length} onClick={() => download(exportInvestigations(collection.records.filter(item => selectedExports.includes(item.id)), "markdown"), "RepoLens-调查.md", "text/markdown;charset=utf-8")}>导出 Markdown</button><button type="button" disabled={!selectedExports.length} onClick={() => download(exportInvestigations(collection.records.filter(item => selectedExports.includes(item.id)), "json"), "RepoLens-调查.json", "application/json")}>导出 JSON</button><label>导入 JSON<input aria-label="导入调查 JSON" type="file" accept=".json,application/json" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (file) void loadImport(file); event.target.value = ""; }}/></label><small>默认不包含源码正文；摘要和用户文字仍可能包含代码摘录。</small></footer>
      {incoming && <section aria-label="调查导入预览"><h3>导入预览</h3><p>{incoming.length} 条调查 · {preview?.conflicts} 个冲突保留为副本 · {preview?.skipped} 条相同记录跳过</p><ul>{incoming.map(item => <li key={item.id}>{item.repositoryName} · {item.ref || "本地工作区"} · {item.title}</li>)}</ul>{mismatch && <label><input type="checkbox" checked={crossRef} onChange={event => setCrossRef(event.target.checked)}/>确认将这些调查导入当前仓库／ref；所有依据重新核验</label>}<button type="button" disabled={busy || validating || !collection.loaded || Boolean(mismatch && !crossRef)} onClick={() => void confirmImport()}>{validating ? "正在核验引用…" : "确认导入"}</button><button type="button" onClick={() => { operation.current++; controller.current?.abort(); setIncoming(null); setValidating(false); }}>取消导入</button></section>}
      {error && <p role="alert">{error}</p>}
    </WorkspaceDialog>}
  </div>;
}
