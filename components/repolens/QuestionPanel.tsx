import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { localWorkspaceProvider } from "@/data/providers";
import { localExplanationProvider, type AiGenerationResult, type AiLineRange, type AiPreviewResponse, type AiQuestionHistoryItem, type AiScopeCandidate } from "@/data/explanation-provider";
import type { AiPreview, FileRecord, RepositorySnapshot, SourceReference } from "@/data/model";

type QaReference = { fileId: string; startLine: number; endLine?: number };
type QaMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  references: QaReference[];
  contextFiles: { fileId: string; contentHash: string }[];
  insufficientEvidence?: boolean;
  stale?: boolean;
};
type QaConversation = { id: string; title: string; messages: QaMessage[]; updatedAt: number };
type PreviewState = { preview: AiPreview; question: string; history: AiQuestionHistoryItem[]; contextKey: string };

function validConversation(value: unknown): value is QaConversation {
  if (!value || typeof value !== "object") return false;
  const item = value as QaConversation;
  return typeof item.id === "string" && typeof item.title === "string" && Array.isArray(item.messages) && item.messages.every((message) =>
    message && typeof message.id === "string" && ["user", "assistant"].includes(message.role) && typeof message.content === "string" && Array.isArray(message.references) && Array.isArray(message.contextFiles));
}

export function QuestionPanel({ repository, currentFile, filesById, onOpenReference }: {
  repository: RepositorySnapshot; currentFile: FileRecord; filesById: Map<string, FileRecord>; onOpenReference: (reference: SourceReference) => void;
}) {
  const [conversations, setConversations] = useState<QaConversation[]>([]);
  const [activeId, setActiveId] = useState("");
  const [loadedRepositoryId, setLoadedRepositoryId] = useState("");
  const [question, setQuestion] = useState("");
  const [stage, setStage] = useState<"idle" | "previewing" | "scope" | "ready" | "generating" | "error">("idle");
  const [message, setMessage] = useState("");
  const [previewState, setPreviewState] = useState<PreviewState | null>(null);
  const [candidates, setCandidates] = useState<AiScopeCandidate[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [ranges, setRanges] = useState<Record<string, AiLineRange>>({});
  const [scopeContextKey, setScopeContextKey] = useState("");
  const requestSequence = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  const activeRequestContext = useRef("");
  const contextKey = `${repository.id}:${repository.revision ?? repository.version}:${currentFile.id}`;
  const visiblePreviewState = previewState?.contextKey === contextKey ? previewState : null;
  const visibleScope = stage === "scope" && scopeContextKey === contextKey;
  const currentConversation = conversations.find((item) => item.id === activeId) ?? null;
  const filesSignature = repository.files.map((file) => `${file.id}:${file.contentHash ?? ""}`).join("\n");

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    void localWorkspaceProvider.get(repository.id, controller.signal).then((saved) => {
      if (cancelled) return;
      const restored = saved.conversations.filter(validConversation).map((item) => ({ ...item, messages: item.messages.map((entry) => ({ ...entry })) }));
      setConversations(restored);
      setActiveId(restored[0]?.id ?? "");
      setLoadedRepositoryId(repository.id);
      if (saved.warning) setMessage(`无法读取部分本地问答记录：${saved.warning}`);
    }).catch((error: Error) => {
      if (!cancelled && error.name !== "AbortError") { setLoadedRepositoryId(repository.id); setMessage(`本地问答记录不可用：${error.message}`); }
    });
    return () => { cancelled = true; controller.abort(); };
  }, [repository.id]);

  useEffect(() => {
    requestSequence.current += 1;
    requestController.current?.abort(); requestController.current = null;
    activeRequestContext.current = "";
    // Context switches intentionally reset an unconfirmed range and release busy UI immediately.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPreviewState(null); setCandidates([]); setStage("idle");
    if (repository.source === "local") setMessage("");
  }, [repository.id, repository.revision, repository.source, currentFile.id]);

  const isStale = useCallback((entry: QaMessage) => entry.stale === true || entry.contextFiles.some((context) => filesById.get(context.fileId)?.contentHash !== context.contentHash), [filesById]);
  const displayMessages = useMemo(() => currentConversation?.messages ?? [], [currentConversation]);

  useEffect(() => {
    if (loadedRepositoryId !== repository.id) return;
    const timer = window.setTimeout(() => {
      const current = conversations.map((conversation) => ({
        ...conversation,
        messages: conversation.messages.map((entry) => isStale(entry) ? { ...entry, stale: true } : entry),
      }));
      void localWorkspaceProvider.saveConversations(repository.id, current).catch((error: Error) => setMessage(`问答仍可使用，但未能保存：${error.message}`));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [conversations, filesSignature, isStale, loadedRepositoryId, repository.id]);

  const startPreview = async (questionText = question, fileIds?: string[]) => {
    const trimmed = questionText.trim();
    if (!trimmed) { setMessage("先输入一个问题。"); return; }
    const active = conversations.find((item) => item.id === activeId) ?? currentConversation;
    const history = (active?.messages ?? []).filter((entry) => !isStale(entry)).slice(-6).map(({ role, content }) => ({ role, content }));
    const id = ++requestSequence.current;
    requestController.current?.abort();
    const controller = new AbortController(); requestController.current = controller;
    activeRequestContext.current = contextKey;
    setPreviewState(null); setStage("previewing"); setMessage("正在本地整理相关源码范围；尚未向模型发送内容。");
    try {
      const value: AiPreviewResponse = await localExplanationProvider.previewQuestion(repository, currentFile.id, trimmed, history, fileIds, ranges, controller.signal);
      if (requestSequence.current !== id) return;
      if (value.scopeRequired) {
        const chosen = selectedFiles.filter((fileId) => value.candidates.some((candidate) => candidate.fileId === fileId));
        const defaultSelection = chosen.length ? chosen : value.candidates.slice(0, Math.min(12, value.candidates.length)).map((candidate) => candidate.fileId);
        const nextRanges = Object.fromEntries(value.candidates.map((candidate) => [candidate.fileId, ranges[candidate.fileId] ?? { startLine: 1, endLine: candidate.lineCount }]));
        setCandidates(value.candidates); setSelectedFiles(defaultSelection); setRanges(nextRanges); setScopeContextKey(contextKey); setStage("scope");
        setMessage(value.retrievalInsufficient ? "自动检索没有找到足够依据。请手动选择与问题相关的文件；最多 12 个文件、总发送内容 60,000 字符。" : "候选源码超出发送范围上限，请选择文件并调整行范围。未发送任何源码。");
      } else {
        setPreviewState({ preview: value.preview, question: trimmed, history, contextKey }); setStage("ready"); setMessage("");
      }
    } catch (error) {
      if (requestSequence.current === id && (error as Error).name !== "AbortError") { setStage("error"); setMessage(error instanceof Error ? error.message : "无法预览问答范围。请先在讲解页配置模型服务。"); }
    } finally { if (requestController.current === controller) requestController.current = null; }
  };

  const submitQuestion = (event: FormEvent) => { event.preventDefault(); void startPreview(); };
  const cancel = () => {
    requestSequence.current += 1; requestController.current?.abort(); requestController.current = null;
    activeRequestContext.current = "";
    setPreviewState(null); setStage("idle"); setMessage("已取消；没有发送未确认的内容。");
  };
  const confirmAndGenerate = async () => {
    const state = visiblePreviewState;
    if (!state || state.preview.repositoryId !== repository.id || state.preview.revision !== repository.revision || state.preview.entryFileId !== currentFile.id) return;
    const id = ++requestSequence.current;
    const controller = new AbortController(); requestController.current = controller;
    activeRequestContext.current = contextKey;
    setStage("generating"); setMessage("已确认发送，正在等待带引用的回答…");
    try {
      const response: AiGenerationResult = await localExplanationProvider.generate(state.preview, controller.signal);
      if (requestSequence.current !== id || response.repositoryId !== repository.id || response.revision !== repository.revision || response.mode !== "question") return;
      const result = response.result;
      const contextFiles = state.preview.files.map(({ fileId, contentHash }) => ({ fileId, contentHash }));
      const userMessage: QaMessage = { id: crypto.randomUUID(), role: "user", content: state.question, references: [], contextFiles };
      const answerMessage: QaMessage = {
        id: crypto.randomUUID(), role: "assistant", content: String(result.answer ?? ""),
        references: Array.isArray(result.references) ? result.references as QaReference[] : [], contextFiles,
        insufficientEvidence: result.insufficientEvidence === true,
      };
      const nextId = activeId || crypto.randomUUID();
      setConversations((previous) => {
        const existing = previous.find((item) => item.id === nextId);
        const next: QaConversation = existing
          ? { ...existing, messages: [...existing.messages, userMessage, answerMessage], updatedAt: Date.now() }
          : { id: nextId, title: state.question.slice(0, 48), messages: [userMessage, answerMessage], updatedAt: Date.now() };
        return [next, ...previous.filter((item) => item.id !== nextId)].slice(0, 100);
      });
      setActiveId(nextId); setQuestion(""); setPreviewState(null); setStage("idle");
      setMessage(response.cached ? "回答已从本地服务缓存恢复。" : "回答已保存到此设备；源码仅按本次确认发送。引用可以定位，但仍需人工判断解释是否准确。");
    } catch (error) {
      if (requestSequence.current === id && (error as Error).name !== "AbortError") { setStage("error"); setMessage(error instanceof Error ? error.message : "问答请求失败。"); }
    } finally { if (requestController.current === controller) requestController.current = null; }
  };

  const createConversation = () => {
    cancel();
    const next = { id: crypto.randomUUID(), title: "新对话", messages: [], updatedAt: Date.now() };
    setConversations((previous) => [next, ...previous]); setActiveId(next.id); setMessage("");
  };
  const deleteConversation = () => {
    if (!currentConversation) return;
    cancel();
    const remaining = conversations.filter((item) => item.id !== currentConversation.id);
    setConversations(remaining); setActiveId(remaining[0]?.id ?? ""); setMessage("已删除此问答会话。");
  };
  const retryMessage = (text: string) => { setQuestion(text); void startPreview(text); };
  const changeQuestion = (value: string) => { setQuestion(value); setPreviewState(null); if (stage === "ready") setStage("idle"); };
  const updateScope = (nextFiles: string[], nextRanges = ranges) => { setSelectedFiles(nextFiles); setRanges(nextRanges); setPreviewState(null); setStage("scope"); };

  return <section className="question-panel" aria-label="源码问答">
    <div className="question-toolbar">
      <label><span className="sr-only">问答会话</span><select aria-label="问答会话" value={activeId} onChange={(event) => { cancel(); setActiveId(event.target.value); }}>
        {!conversations.length && <option value="">新问答</option>}
        {conversations.map((item) => <option key={item.id} value={item.id}>{item.title || "新问答"}</option>)}
      </select></label>
      <button type="button" onClick={createConversation}>新对话</button>
      {currentConversation && <button type="button" onClick={deleteConversation}>删除对话</button>}
    </div>
    <div className="question-messages" aria-live="polite">
      {!displayMessages.length && <p className="question-empty">可以询问当前仓库的行为、依赖或实现细节。回答只读，不会运行或修改项目。</p>}
      {displayMessages.map((entry) => <article className={`question-message is-${entry.role}${isStale(entry) ? " is-stale" : ""}`} key={entry.id}>
        <div className="question-message-heading"><strong>{entry.role === "user" ? "你" : "RepoLens 回答"}</strong>{isStale(entry) && <span>依据源码已变化，回答过期</span>}</div>
        <p className="question-message-body">{entry.content}</p>
        {entry.insufficientEvidence && <small className="question-insufficient">已标记为无法从本次源码范围判断。</small>}
        {entry.references.length > 0 && <div className="question-references">{entry.references.map((reference, index) => <button key={`${reference.fileId}:${reference.startLine}:${index}`} disabled={isStale(entry)} onClick={() => onOpenReference({ fileId: reference.fileId, line: reference.startLine, ...(reference.endLine ? { endLine: reference.endLine } : {}) })}>{reference.fileId} · 第 {reference.startLine}–{reference.endLine ?? reference.startLine} 行</button>)}</div>}
        {entry.role === "user" && <button type="button" className="question-retry" onClick={() => retryMessage(entry.content)}>重新预览此问题</button>}
      </article>)}
    </div>
    <form className="question-input-form" onSubmit={submitQuestion}>
      <label htmlFor="repository-question">提问或追问</label>
      <textarea id="repository-question" value={question} maxLength={12000} onChange={(event) => changeQuestion(event.target.value)} placeholder={`关于 ${currentFile.path}，我想了解…`} disabled={stage === "generating" || stage === "previewing"} />
      <div className="question-actions">
        <button type="submit" disabled={!question.trim() || stage === "generating" || stage === "previewing"}>预览发送范围</button>
        {(stage === "previewing" || stage === "generating" || stage === "ready" || stage === "scope") && <button type="button" className="question-cancel" onClick={cancel}>取消</button>}
      </div>
    </form>
    {visibleScope && candidates.length > 0 && <section className="question-scope" aria-label="调整问答发送范围">
      <strong>选择相关源码（最多 12 个文件）</strong>
      <div className="question-candidate-list">{candidates.map((candidate) => {
        const selected = selectedFiles.includes(candidate.fileId);
        const range = ranges[candidate.fileId] ?? { startLine: 1, endLine: candidate.lineCount };
        return <label key={candidate.fileId}>
          <input type="checkbox" checked={selected} disabled={!selected && selectedFiles.length >= 12} onChange={(event) => updateScope(event.target.checked ? [...selectedFiles, candidate.fileId] : selectedFiles.filter((item) => item !== candidate.fileId))} />
          <span>{candidate.fileId}</span><small>{candidate.lineCount} 行 · {candidate.characters.toLocaleString()} 字符</small>
          {selected && <span className="ai-range-fields"><input aria-label={`${candidate.fileId} 起始行`} type="number" min={1} max={candidate.lineCount} value={range.startLine} onChange={(event) => updateScope(selectedFiles, { ...ranges, [candidate.fileId]: { ...range, startLine: Number(event.target.value) } })} />至<input aria-label={`${candidate.fileId} 结束行`} type="number" min={range.startLine} max={candidate.lineCount} value={range.endLine} onChange={(event) => updateScope(selectedFiles, { ...ranges, [candidate.fileId]: { ...range, endLine: Number(event.target.value) } })} /></span>}
          {selected && candidate.oversizedLines.some((line) => line >= range.startLine && line <= range.endLine) && <small role="alert">范围包含不能发送的超长行，请缩小范围。</small>}
        </label>;
      })}</div>
      <button type="button" onClick={() => { void startPreview(question, selectedFiles); }} disabled={!question.trim() || !selectedFiles.length || candidates.some((candidate) => selectedFiles.includes(candidate.fileId) && candidate.oversizedLines.some((line) => line >= (ranges[candidate.fileId]?.startLine ?? 1) && line <= (ranges[candidate.fileId]?.endLine ?? candidate.lineCount)))}>重新预览所选内容</button>
    </section>}
    {visiblePreviewState && stage === "ready" && <section className="question-consent" aria-label="问答发送确认">
      <strong>确认发送这次问答</strong>
      <p>服务：{visiblePreviewState.preview.baseUrl} · 模型：{visiblePreviewState.preview.model} · 携带历史 {visiblePreviewState.history.length} 条 · 总字符 {visiblePreviewState.preview.characters.toLocaleString()}</p>
      <blockquote>{visiblePreviewState.question}</blockquote>
      <ul>{visiblePreviewState.preview.files.map((file) => <li key={file.fileId}>{file.fileId}（第 {file.startLine}–{file.endLine} 行）</li>)}</ul>
      {visiblePreviewState.preview.retrievalInsufficient && <p role="alert">自动检索依据不足；请确认所选源码确实适合回答。</p>}
      <button type="button" onClick={() => { void confirmAndGenerate(); }}>确认发送并获取引用回答</button>
    </section>}
    {message && <p className="question-feedback" role={stage === "error" ? "alert" : "status"}>{message}</p>}
  </section>;
}
