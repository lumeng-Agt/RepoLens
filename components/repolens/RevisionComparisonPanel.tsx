import { WorkspaceDialog } from "./WorkspaceDialog";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { GitCompareArrows } from "lucide-react";
import type { RepositorySnapshot, RevisionComparison } from "@/data/model";
import type { AiResultRecord } from "@/components/repolens/AiResultView";
import type { AiRouteRecord, ReadingNote } from "@/data/model";
import { localRepositoryProvider } from "@/data/providers";
import { findRevisionImpacts } from "@/data/revision-impact.mjs";
import { readingBaselineHeadRef } from "@/data/revision-baseline.mjs";

const statusText = { added: "新增", modified: "修改", deleted: "删除", renamed: "重命名" } as const;
export function RevisionComparisonPanel({ repository, notes, tours, results, onSelectFile }: { repository: RepositorySnapshot; notes: ReadingNote[]; tours: AiRouteRecord[]; results: AiResultRecord[]; onSelectFile: (fileId: string) => void }) {
  const [mode, setMode] = useState<"working-tree" | "commits" | "baseline">(repository.origin?.kind === "github" ? "commits" : "working-tree");
  const [baseRef, setBaseRef] = useState(""); const [headRef, setHeadRef] = useState("");
  const workspaceId = repository.workspaceId ?? repository.id;
  const baselineKey = `repolens:reading-baseline:${workspaceId}`;
  const [baselineOverride, setBaselineOverride] = useState<{ key: string; commit: string } | null>(null);
  const [result, setResult] = useState<RevisionComparison | null>(null);
  const [resultContext, setResultContext] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "error">("idle"); const [stateContext, setStateContext] = useState("");
  const [error, setError] = useState(""); const [errorContext, setErrorContext] = useState("");
  const [errorCode, setErrorCode] = useState(""); const [errorCodeContext, setErrorCodeContext] = useState("");
  const [fetchOpen, setFetchOpen] = useState(false); const [fetchTarget, setFetchTarget] = useState(""); const [fetchSlot, setFetchSlot] = useState<"base" | "head">("head");
  const [fetching, setFetching] = useState(false); const [fetchError, setFetchError] = useState(""); const [fetchedCommit, setFetchedCommit] = useState("");
  const requestSequence = useRef(0); const requestController = useRef<AbortController | null>(null); const contextRef = useRef("");
  const currentRevision = repository.revision ?? repository.version;
  const contextKey = `${repository.id}:${workspaceId}:${currentRevision}`;
  useLayoutEffect(() => { contextRef.current = contextKey; }, [contextKey]);
  const isLoading = state === "loading" && stateContext === contextKey;
  const currentError = errorContext === contextKey ? error : "";
  const currentErrorCode = errorCodeContext === contextKey ? errorCode : "";
  const activeMode = repository.origin?.kind === "github" && mode === "working-tree" ? "commits" : mode;
  const filesByPath = useMemo(() => new Map(repository.files.map((file) => [file.path, file.id])), [repository.files]);
  const visibleResult = resultContext === contextKey && result?.revision === currentRevision ? result : null;
  const impacts = useMemo(() => visibleResult ? findRevisionImpacts({ changes: visibleResult.files, files: repository.files, notes, tours, results }) : null, [notes, repository.files, results, tours, visibleResult]);
  const baseline = useMemo(() => {
    if (baselineOverride?.key === baselineKey) return baselineOverride.commit;
    try { return typeof window === "undefined" ? "" : window.localStorage.getItem(baselineKey) ?? ""; }
    catch { return ""; }
  }, [baselineKey, baselineOverride]);
  useEffect(() => () => {
    requestSequence.current += 1;
    requestController.current?.abort();
    requestController.current = null;
  }, [contextKey]);
  const compare = async () => {
    requestController.current?.abort();
    const requestId = ++requestSequence.current;
    const requestContext = contextKey;
    const controller = new AbortController(); requestController.current = controller;
    setState("loading"); setStateContext(requestContext); setError(""); setErrorContext(requestContext); setErrorCode(""); setErrorCodeContext(requestContext); setFetchOpen(false); setFetchError("");
    try {
      const compareMode = activeMode === "working-tree" ? "working-tree" : "commits";
      const value = await localRepositoryProvider.compare({ repositoryId: repository.id, revision: currentRevision, mode: compareMode, ...(activeMode === "commits" ? { baseRef, headRef } : activeMode === "baseline" ? { baseRef: baseline, headRef: readingBaselineHeadRef(repository) } : {}) }, controller.signal);
      if (requestSequence.current !== requestId || contextRef.current !== requestContext || controller.signal.aborted) return;
      setResult(value); setResultContext(requestContext); setState("idle"); setStateContext(requestContext);
    } catch (cause) {
      if ((cause as Error)?.name === "AbortError" || requestSequence.current !== requestId || contextRef.current !== requestContext) return;
      setState("error"); setStateContext(requestContext); setError(cause instanceof Error ? cause.message : "无法比较版本。"); setErrorContext(requestContext); setErrorCode(String((cause as Error & { code?: string })?.code ?? "")); setErrorCodeContext(requestContext);
    } finally { if (requestController.current === controller) requestController.current = null; }
  };
  const fetchMissingHistory = async () => {
    if (repository.origin?.kind !== "github" || !repository.persistenceSessionId || !fetchTarget.trim()) return;
    requestController.current?.abort();
    const requestId = ++requestSequence.current;
    const requestContext = contextKey;
    const controller = new AbortController(); requestController.current = controller;
    setFetching(true); setFetchError(""); setFetchedCommit("");
    try {
      const fetched = await localRepositoryProvider.fetchHistory({ repositoryId: repository.id, workspaceId, persistenceSessionId: repository.persistenceSessionId, revision: currentRevision, target: fetchTarget.trim() }, controller.signal);
      if (requestSequence.current !== requestId || contextRef.current !== requestContext || controller.signal.aborted) return;
      if (activeMode === "baseline") {
        setBaselineOverride({ key: baselineKey, commit: fetched.commit });
        try { window.localStorage.setItem(baselineKey, fetched.commit); } catch { setFetchError("版本已获取，但无法保存阅读基线；获取结果仍可复制使用。"); }
      } else if (fetchSlot === "base") setBaseRef(fetched.commit);
      else setHeadRef(fetched.commit);
      setFetchedCommit(fetched.commit); setFetchOpen(false); setError(""); setErrorContext(requestContext); setErrorCode(""); setErrorCodeContext(requestContext); setResult(null); setResultContext(""); setState("idle"); setStateContext(requestContext);
    } catch (cause) {
      if ((cause as Error)?.name === "AbortError" || requestSequence.current !== requestId || contextRef.current !== requestContext) return;
      setFetchError(cause instanceof Error ? cause.message : "无法获取 GitHub 版本。");
    } finally { if (requestController.current === controller) { requestController.current = null; setFetching(false); } }
  };
  const markBaseline = () => {
    const commit = repository.origin?.kind === "github" ? repository.origin.commit : visibleResult?.mode === "working-tree" ? visibleResult.baseCommit : "";
    if (!commit) return;
    try { window.localStorage.setItem(baselineKey, commit); setBaselineOverride({ key: baselineKey, commit }); setError(""); setErrorContext(contextKey); }
    catch { setError("无法保存阅读基线；请检查本地存储是否可用。"); setErrorContext(contextKey); }
  };
  return <section className="revision-comparison" aria-label="变更阅读">
    <h2><GitCompareArrows size={15} />变更阅读</h2>
    <p>按文件原始内容比较，不运行仓库配置的内容转换器。比较只读取本机已有对象；GitHub 缺少所需版本时，可单独确认获取，不会改变当前索引快照。</p>
    <div className="revision-controls"><select aria-label="比较类型" value={activeMode} onChange={(event) => { requestSequence.current += 1; requestController.current?.abort(); setMode(event.target.value as typeof mode); setResult(null); setResultContext(""); setState("idle"); setStateContext(contextKey); setError(""); setErrorContext(contextKey); setErrorCode(""); setErrorCodeContext(contextKey); setFetchOpen(false); }}><option value="working-tree" disabled={repository.origin?.kind === "github"}>本地工作区与 HEAD</option><option value="commits">指定两个提交</option><option value="baseline">{repository.origin?.kind === "github" ? "当前提交与阅读基线" : "当前 HEAD 与阅读基线"}</option></select>{activeMode === "commits" && <><input aria-label="起始提交" value={baseRef} onChange={(event) => { setBaseRef(event.target.value); setResult(null); }} placeholder="起始提交或 ref" /><input aria-label="目标提交" value={headRef} onChange={(event) => { setHeadRef(event.target.value); setResult(null); }} placeholder="目标提交或 ref" /></>}{activeMode === "baseline" && <span className="revision-baseline-value">{baseline ? `基线 ${baseline.slice(0, 12)}` : "尚未标记阅读基线"}</span>}<button type="button" onClick={() => void compare()} disabled={isLoading || activeMode === "commits" && (!baseRef.trim() || !headRef.trim()) || activeMode === "baseline" && !baseline}>{isLoading ? "正在比较…" : "比较"}</button>{repository.origin?.kind === "github" && <button type="button" onClick={markBaseline}>{baseline ? "更新为当前提交" : "将当前提交设为阅读基线"}</button>}</div>
    {currentError && <p role="alert">{currentError}</p>}
    {currentErrorCode === "REVISION_OBJECT_MISSING" && repository.origin?.kind === "github" && <button type="button" onClick={() => { setFetchTarget(activeMode === "commits" ? (headRef || baseRef) : baseline); setFetchSlot("head"); setFetchError(""); setFetchOpen(true); }}>获取所需版本</button>}
    {fetchedCommit && <p role="status">已获取版本 {fetchedCommit.slice(0, 12)}。请重新比较以查看结果。</p>}
    {fetchOpen && <WorkspaceDialog onDismiss={() => { requestSequence.current += 1; requestController.current?.abort(); setFetchOpen(false); setFetching(false); }} className="revision-fetch-dialog" aria-labelledby="revision-fetch-title"><h3 id="revision-fetch-title">获取 GitHub 版本</h3><p>仓库：{repository.origin?.url}</p><label htmlFor="revision-fetch-target">完整分支、标签或提交 SHA</label><input id="revision-fetch-target" value={fetchTarget} onChange={(event) => setFetchTarget(event.target.value)} placeholder="refs/heads/feature/example 或完整 SHA" disabled={fetching} />{activeMode === "commits" && <label htmlFor="revision-fetch-slot">将提交用于</label>}{activeMode === "commits" && <select id="revision-fetch-slot" value={fetchSlot} onChange={(event) => setFetchSlot(event.target.value as "base" | "head")} disabled={fetching}><option value="base">起始版本</option><option value="head">目标版本</option></select>}<p>只获取所选版本及比较需要的对象，不切换当前仓库。</p>{fetchError && <p role="alert">{fetchError}</p>}<button type="button" onClick={() => void fetchMissingHistory()} disabled={fetching || !fetchTarget.trim()}>{fetching ? "正在获取…" : "确认获取"}</button><button type="button" onClick={() => { requestSequence.current += 1; requestController.current?.abort(); setFetchOpen(false); setFetching(false); }}>取消</button></WorkspaceDialog>}
    {visibleResult && <><strong>{visibleResult.files.length} 个变更文件 · {visibleResult.baseCommit.slice(0, 12)} → {visibleResult.headCommit === "WORKTREE" ? "工作区" : visibleResult.headCommit.slice(0, 12)}</strong>{visibleResult.mode === "working-tree" && <button type="button" onClick={markBaseline}>将 HEAD 标记为阅读基线</button>}<ul className="revision-file-list">{visibleResult.files.map((file, index) => { const id = filesByPath.get(file.path); const incoming = id ? repository.dependencies.filter((edge) => edge.toId === id).length : 0; return <li key={`${file.status}:${file.path}:${index}`}><button type="button" disabled={!id} onClick={() => id && onSelectFile(id)}><span>{statusText[file.status]}</span><code>{file.oldPath ? `${file.oldPath} → ` : ""}{file.path}</code>{incoming > 0 && <small>有 {incoming} 个文件静态引用此文件，建议复核</small>}</button></li>; })}</ul><details className="revision-diff"><summary>查看只读逐行差异（最多 2 MiB）</summary><pre>{visibleResult.diff || "此比较范围没有文本差异。"}</pre></details><section className="revision-impacts" aria-label="受影响的阅读记录"><strong>需要重新核对的记录 · {impacts?.total ?? 0}</strong>{impacts?.total ? <ul>{[...impacts.notes, ...impacts.tours, ...impacts.results].map((item) => { const fileId = item.paths.map((path) => filesByPath.get(path)).find((candidate): candidate is string => Boolean(candidate)); return <li key={`${item.kind}:${item.id}`}><span>{item.kind === "note" ? "笔记" : item.kind === "tour" ? "路线" : "AI 讲解"}</span><div><strong>{item.title || "未命名记录"}</strong><small>涉及：{item.paths.join("、")}</small></div>{fileId && <button type="button" onClick={() => onSelectFile(fileId)}>查看文件</button>}</li>; })}</ul> : <p>当前保存的笔记、路线和讲解没有关联到这批变更文件。</p>}<small>匹配依据是记录关联的文件路径；这是静态提示，不代表运行时影响。</small></section></>}
  </section>;
}
