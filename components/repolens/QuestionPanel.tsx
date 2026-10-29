import { InvestigationCard } from "./InvestigationCard";
import { createInvestigation, appendInvestigationResult } from "@/data/investigation.mjs";
import { changeInvestigation, getInvestigationState, getInvestigationEpoch, subscribeInvestigations } from "@/data/investigation-state.mjs";
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, useEffectEvent, Fragment, type FormEvent } from "react";
import { localRepositoryProvider, localWorkspaceProvider } from "@/data/providers";
import { generateChatStream, localExplanationProvider, type AiGenerationResult, type AiLineRange, type AiPreviewResponse, type AiQuestionHistoryItem, type AiScopeCandidate } from "@/data/explanation-provider";
import { ChatMarkdown } from "./ChatMarkdown";
import type { AiPreview, AiRouteRecord, FileRecord, RepositorySnapshot, SourceReference } from "@/data/model";
import type { AiMode } from "@/data/explanation-provider";
import { AiResultView } from "./AiResultView";
import { buildAiChatCompletion } from "@/data/ai-chat-completion.mjs";
import { acknowledgeQuestionConversationSave, clearQuestionConversationSaveError, enqueueQuestionConversationSave, failQuestionConversationRead, getQuestionConversationGeneration, getQuestionConversationOperations, getQuestionConversationReadError, getQuestionConversationSaveError, getQuestionConversationView, isQuestionConversationClearPending, recordQuestionConversationChanges, restoreQuestionConversations, setQuestionConversationSaveError } from "@/data/question-recovery.mjs";

import type { QaReference, QaMessage, QaConversation } from "./chat-types";
import { ChatToolbar } from "./ChatToolbar";
import { ChatMessage, ChatEvidence } from "./ChatMessage";
import { ChatComposer } from "./ChatComposer";
import { ChatContextPicker } from "./ChatContextPicker";

type PreviewState = { preview: AiPreview; question: string; history: AiQuestionHistoryItem[]; contextKey: string };

function validConversation(value: unknown): value is QaConversation {
  if (!value || typeof value !== "object") return false;
  const item = value as QaConversation;
  return typeof item.id === "string" && typeof item.title === "string" && Array.isArray(item.messages) && item.messages.every((message) =>
    message && typeof message.id === "string" && ["user", "assistant"].includes(message.role) && typeof message.content === "string" && Array.isArray(message.references) && Array.isArray(message.contextFiles));
}

export function QuestionPanel({ repository, currentFile, filesById, onOpenReference, backendAvailable = true, active = false, storageBusy = false, clearVersion = 0, additionalFileIds = [], onClearAdditionalFiles, unified = false, intent, onCompleted, onActivateTour, onOpenSettings, onCloseChat, modelSettings, onRelations }: {
  repository: RepositorySnapshot; currentFile: FileRecord; filesById: Map<string, FileRecord>; onOpenReference: (reference: SourceReference) => void; backendAvailable?: boolean;
  active?: boolean; storageBusy?: boolean; clearVersion?: number;
  additionalFileIds?: string[]; onClearAdditionalFiles?: () => void;
  unified?: boolean; intent?: { id: number; mode: AiMode; investigation?: import("@/data/model").Investigation }; onCompleted?: () => void; onActivateTour?: (route: AiRouteRecord) => void; onOpenSettings?: () => void;
  onRelations?: (fileId: string) => void; onCloseChat?: () => void; modelSettings?: { baseUrl: string; model: string; configured: boolean };
}) {
  const workspaceId = repository.workspaceId ?? repository.id;
  const investigationCollection = useSyncExternalStore(useCallback(listener => subscribeInvestigations(workspaceId, listener), [workspaceId]), useCallback(() => getInvestigationState(workspaceId), [workspaceId]), useCallback(() => getInvestigationState(workspaceId), [workspaceId]));
  const questionInputId = useId();
  const sessionKey = `${workspaceId}:${repository.persistenceSessionId ?? ""}`;
  const currentWorkspaceIdRef = useRef(sessionKey);
  useEffect(() => { currentWorkspaceIdRef.current = sessionKey; }, [sessionKey]);
  const [conversations, setConversations] = useState<QaConversation[]>(() => getQuestionConversationView(workspaceId));
  const [activeId, setActiveId] = useState("");
  const [loadedSessionKey, setLoadedSessionKey] = useState("");
  const loadedSessionKeyRef = useRef("");
  useEffect(() => { loadedSessionKeyRef.current = loadedSessionKey; }, [loadedSessionKey]);
  const [failedRepositoryId, setFailedRepositoryId] = useState(() => getQuestionConversationReadError(workspaceId) ? workspaceId : "");
  const [saveError, setSaveError] = useState(() => {
    const error = getQuestionConversationSaveError(workspaceId);
    return error ? { sessionKey, message: error } : null;
  });
  const [question, setQuestion] = useState("");
  const [investigationNotices, setInvestigationNotices] = useState<Record<string, string>>({});
  const [investigationDrafts, setInvestigationDrafts] = useState<Record<string, import("@/data/model").Investigation>>({});
  const [activeInvestigation, setActiveInvestigation] = useState<import("@/data/model").Investigation | null>(null);
  const [excludedInvestigationFiles, setExcludedInvestigationFiles] = useState<string[]>([]);
  const [mode, setMode] = useState<AiMode>("question");
  useEffect(() => {
    if (!clearVersion) return;
    // The parent increments only after a confirmed clear; remove associated in-memory investigation drafts.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInvestigationNotices({}); setInvestigationDrafts({}); setActiveInvestigation(null); setExcludedInvestigationFiles([]);
  }, [clearVersion]);
  const [excludedHistory, setExcludedHistory] = useState<string[]>([]);
  const generatingRef = useRef(false);
  const generationSessionRef = useRef("");
  const transcriptRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const consentRef = useRef<HTMLElement>(null);
  const uiKey = `repolens:chat-ui:${workspaceId}`;
  const scrollPosition = useRef(0);
  const followLatest = useRef(true);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const [partialTurns, setPartialTurns] = useState<{ id: string; conversationId: string; question: string; answer: string; status: string; afterMessageCount: number; startedAt: number }[]>([]);
  const [streamUnsupported, setStreamUnsupported] = useState(false);
  const [ordinaryResponse, setOrdinaryResponse] = useState(false);
  const questionRef = useRef(question);
  useEffect(() => { questionRef.current = question; }, [question]);
  const startPreviewRef = useRef<(question?: string, files?: string[]) => Promise<void>>(async () => {});
  const [scopeOpen, setScopeOpen] = useState(false);
  const [manualFileIds, setManualFileIds] = useState<string[]>([]);
  const [explicitSelection, setExplicitSelection] = useState(false);
  const [supplementQuestion, setSupplementQuestion] = useState("");
  const [supplementFileIds, setSupplementFileIds] = useState<string[]>([]);
  const [supplementFilter, setSupplementFilter] = useState("");
  const [stage, setStage] = useState<"idle" | "previewing" | "scope" | "ready" | "generating" | "error">("idle");
  const [message, setMessage] = useState("");
  const [readWarning, setReadWarning] = useState("");
  const readWarningRef = useRef("");
  const [previewState, setPreviewState] = useState<PreviewState | null>(null);
  const [searchSuggestions, setSearchSuggestions] = useState<string[]>([]);
  const [supplementalResults, setSupplementalResults] = useState<{ fileId: string; line: number; text: string }[]>([]);
  const supplementalRequest = useRef<AbortController | null>(null);
  useEffect(() => () => supplementalRequest.current?.abort(), [repository.id, repository.revision]);
  const [candidates, setCandidates] = useState<AiScopeCandidate[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [ranges, setRanges] = useState<Record<string, AiLineRange>>({});
  const [evidence, setEvidence] = useState<{ messageId: string; referenceIndex: number; fileId: string; startLine: number; source: string; status: "loading" | "loaded" | "error"; error?: string } | null>(null);
  const evidenceSequence = useRef(0);
  const evidenceController = useRef<AbortController | null>(null);
  const evidenceTrigger = useRef<HTMLElement | null>(null);
  const [scopeContextKey, setScopeContextKey] = useState("");
  const requestSequence = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  const activeRequestContext = useRef("");
  const loadRequestSequence = useRef(0);
  const clearVersionRef = useRef(clearVersion);
  const invalidateRequest = useCallback(() => {
    generatingRef.current = false;
    requestSequence.current += 1;
    requestController.current?.abort();
    requestController.current = null;
    activeRequestContext.current = "";
  }, []);
  const contextKey = `${workspaceId}:${repository.revision ?? repository.version}:${currentFile.id}`;
  const visiblePreviewState = previewState?.contextKey === contextKey ? previewState : null;
  const visibleScope = stage === "scope" && scopeContextKey === contextKey;
  const filesSignature = repository.files.map((file) => `${file.id}:${file.contentHash ?? ""}`).join("\n");
  const visibleConversations = loadedSessionKey === sessionKey ? conversations : getQuestionConversationView(workspaceId);
  const currentConversation = visibleConversations.find((item) => item.id === activeId) ?? null;
  const conversationSaveAttempt = useRef<{ key: string; status: "pending" | "failed" | "saved" } | null>(null);
  const persistConversations = useCallback((value: QaConversation[], afterRestore = false, force = false) => {
    if (isQuestionConversationClearPending(workspaceId)) return;
    // Keep the operation journal even when a warning pauses disk writes.
    const view = recordQuestionConversationChanges(workspaceId, value);
    if (readWarningRef.current && !force) {
      setMessage(`本地保存提示：${readWarningRef.current}`);
      return;
    }
    if (loadedSessionKeyRef.current !== sessionKey && !afterRestore) {
      setMessage("无法读取已保存的问答记录。本页修改尚未保存，原记录不会被覆盖。");
      return;
    }
    const operations = getQuestionConversationOperations(workspaceId);
    if (!operations.length) return;
    const throughSequence = operations[operations.length - 1].sequence;
    const key = `${sessionKey}:${getQuestionConversationGeneration(workspaceId)}:${throughSequence}:${JSON.stringify(view)}`;
    const previousAttempt = conversationSaveAttempt.current;
    if (previousAttempt?.key === key && (previousAttempt.status === "pending" || !force && !afterRestore)) return;
    const attempt = { key, status: "pending" as "pending" | "failed" | "saved" };
    conversationSaveAttempt.current = attempt;
    clearQuestionConversationSaveError(workspaceId);
    setSaveError(null);
    const save = enqueueQuestionConversationSave(workspaceId, async () => {
      await localWorkspaceProvider.saveConversations({ repositoryId: repository.id, workspaceId, persistenceSessionId: repository.persistenceSessionId }, view);
      const latest = acknowledgeQuestionConversationSave(workspaceId, view, throughSequence);
      attempt.status = "saved";
      if (currentWorkspaceIdRef.current === sessionKey) {
        setConversations(latest);
        setSaveError(null);
        setMessage("");
      }
    });
    void save.catch((error: Error) => {
      attempt.status = "failed";
      setQuestionConversationSaveError(workspaceId, error.message);
      if (currentWorkspaceIdRef.current === sessionKey) setSaveError({ sessionKey, message: error.message });
    });
  }, [repository.id, repository.persistenceSessionId, sessionKey, workspaceId]);

  const loadWorkspace = useCallback(async () => {
    const requestId = ++loadRequestSequence.current;
    const recoveryGeneration = getQuestionConversationGeneration(workspaceId);
    loadedSessionKeyRef.current = "";
    setLoadedSessionKey("");
    setActiveId("");
    readWarningRef.current = "";
    setReadWarning("");
    try {
      const saved = await localWorkspaceProvider.get(workspaceId);
      if (loadRequestSequence.current !== requestId || getQuestionConversationGeneration(workspaceId) !== recoveryGeneration) return;
      if (saved.persistenceReady === false) throw new Error(saved.warning ?? "本地保存数据尚未成功读取。");
      const restored = saved.conversations.filter(validConversation).map((item) => ({ ...item, messages: item.messages.map((entry) => ({ ...entry })) }));
      const next = restoreQuestionConversations(workspaceId, restored);
      loadedSessionKeyRef.current = sessionKey;
      let selectedId = next[0]?.id ?? "";
      try { const ui = JSON.parse(localStorage.getItem(uiKey) ?? "null"); if (next.some((item) => item.id === ui?.activeId)) selectedId = ui.activeId; scrollPosition.current = Number(ui?.scrollTop) || 0; if (typeof ui?.draft === "string") setQuestion(ui.draft); } catch { /* Preference failures do not block chat. */ }
      setConversations(next); setActiveId(selectedId); setLoadedSessionKey(sessionKey); setFailedRepositoryId("");
      readWarningRef.current = saved.warning ?? "";
      setReadWarning(saved.warning ?? "");
      setMessage("");
      if (getQuestionConversationOperations(workspaceId).length) persistConversations(next, true);
    } catch (error) {
      if (loadRequestSequence.current !== requestId || getQuestionConversationGeneration(workspaceId) !== recoveryGeneration || (error as Error).name === "AbortError") return;
      const detail = error instanceof Error ? error.message : "读取失败";
      setConversations(failQuestionConversationRead(workspaceId, detail));
      setFailedRepositoryId(workspaceId);
      setMessage(`无法读取已保存的问答记录：${detail}。本页修改尚未保存，原记录不会被覆盖。`);
    }
  }, [persistConversations, sessionKey, workspaceId, uiKey]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadWorkspace(); }, 0);
    return () => { window.clearTimeout(timer); loadRequestSequence.current += 1; };
  }, [loadWorkspace, repository.id]);

  useEffect(() => {
    if (unified && generatingRef.current && generationSessionRef.current === sessionKey && !storageBusy) return;
    invalidateRequest();
    evidenceSequence.current += 1;
    evidenceController.current?.abort(); evidenceController.current = null;
    // Leaving the tab, changing context, or clearing saved data releases request state immediately.
    /* eslint-disable react-hooks/set-state-in-effect */
    setPreviewState(null); setCandidates([]); setStage("idle"); setEvidence(null);
    setPartialTurns(turns=>turns.map(turn=>turn.status!=="incomplete"?{...turn,status:"incomplete"}:turn));
    if (active && !storageBusy) setMessage("");
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [active, currentFile.id, invalidateRequest, repository.id, repository.revision, repository.source, sessionKey, storageBusy, workspaceId, unified]);
  useEffect(() => () => invalidateRequest(), [invalidateRequest]);
  const applyInvestigationIntent = useEffectEvent((record: import("@/data/model").Investigation) => {
    setActiveInvestigation(record); setExcludedInvestigationFiles(record.excludedFileIds);
    setQuestion(`${record.question}\n继续调查：${record.questions.map(item => item.question).join("；")}`.slice(0, 12000));
    const ids = [...new Set([...record.contextFiles.map(file => file.fileId), ...record.questions.map(item => item.suggestedFileId).filter((id): id is string => Boolean(id))])].filter(id => filesById.has(id) && !record.excludedFileIds.includes(id));
    setSelectedFiles(ids); setExplicitSelection(ids.length > 0); setRanges({});
  });
  const clearInvestigationIntent = useEffectEvent(() => { setActiveInvestigation(null); setExcludedInvestigationFiles([]); });
  useEffect(() => {
    if (!unified || !intent || generatingRef.current) return;
    invalidateRequest(); setMode(intent.mode); setPreviewState(null); setStage("idle");
    // Parent navigation intents intentionally hydrate the composer once, like selecting a saved conversation.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (intent.investigation) applyInvestigationIntent(intent.investigation);
    else clearInvestigationIntent();
  }, [intent, unified, invalidateRequest]);
  useEffect(() => {
    if (!unified || loadedSessionKey !== sessionKey) return;
    try { localStorage.setItem(uiKey, JSON.stringify({ activeId, draft: question, scrollTop: scrollPosition.current })); } catch { /* Chat works in memory when preferences are unavailable. */ }
  }, [unified, uiKey, activeId, question, loadedSessionKey, sessionKey]);
  useEffect(() => { const scrollArea = transcriptRef.current; if (active && scrollArea) scrollArea.scrollTop = scrollPosition.current; }, [active, loadedSessionKey]);

  useEffect(() => {
    if (!unified || !active || !followLatest.current) return;
    const frame = requestAnimationFrame(() => {
      const area = transcriptRef.current;
      if (area) area.scrollTop = area.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [unified, active, stage, conversations, partialTurns]);
  const storageBusyRef = useRef(false);
  useEffect(() => {
    if (storageBusy) {
      storageBusyRef.current = true;
      loadRequestSequence.current += 1;
      return;
    }
    if (!storageBusyRef.current) return;
    storageBusyRef.current = false;
    void loadWorkspace();
  }, [loadWorkspace, storageBusy]);

  useEffect(() => {
    if (clearVersionRef.current === clearVersion) return;
    clearVersionRef.current = clearVersion;
    conversationSaveAttempt.current = null;
    invalidateRequest();
    const view = getQuestionConversationView(workspaceId);
    loadedSessionKeyRef.current = sessionKey;
    // The storage clear controller has already invalidated and emptied this workspace.
    setSelectedFiles([]); setManualFileIds([]); setExplicitSelection(false); setScopeOpen(false); setRanges({});
    setConversations(view); setActiveId(view[0]?.id ?? ""); setLoadedSessionKey(sessionKey); setPartialTurns([]);
    setFailedRepositoryId(""); setSaveError(null); setQuestion(""); setPreviewState(null); setCandidates([]); setStage("idle"); setMessage(""); readWarningRef.current = ""; setReadWarning("");
  }, [clearVersion, sessionKey, workspaceId, invalidateRequest]);

  useEffect(() => window.repoLens?.onBackendStatus(({ available }) => {
    if (available) return;
    generatingRef.current = false;
    requestSequence.current += 1;
    requestController.current?.abort(); requestController.current = null;
    activeRequestContext.current = "";
    setPreviewState(null); setCandidates([]); setStage("error");
    setPartialTurns(turns => turns.map(turn => ({ ...turn, status: "incomplete" })));
    setMessage("本地索引服务已停止；问答请求已取消。请关闭并重新启动 RepoLens。");
  }), []);

  const isStale = useCallback((entry: QaMessage) => entry.stale === true || entry.contextFiles.some((context) => filesById.get(context.fileId)?.contentHash !== context.contentHash), [filesById]);
  const showEvidence = async (entry: QaMessage, reference: QaReference, referenceIndex: number) => {
    if (isStale(entry)) return;
    evidenceTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const context = entry.contextFiles.find((item) => item.fileId === reference.fileId);
    if (!context || !context.startLine || !context.endLine || reference.startLine < context.startLine || (reference.endLine ?? reference.startLine) > context.endLine) {
      setEvidence({ messageId: entry.id, referenceIndex, fileId: reference.fileId, startLine: reference.startLine, source: "", status: "error", error: "此引用超出了生成时确认的发送范围。" });
      return;
    }
    const requestId = ++evidenceSequence.current;
    evidenceController.current?.abort(); const controller = new AbortController(); evidenceController.current = controller;
    setEvidence({ messageId: entry.id, referenceIndex, fileId: reference.fileId, startLine: reference.startLine, source: "", status: "loading" });
    try {
      const source = await localRepositoryProvider.getSource(repository.id, repository.revision, reference.fileId, controller.signal);
      if (evidenceSequence.current !== requestId || isStale(entry)) return;
      const lines = source.split("\n"); const endLine = Math.min(reference.endLine ?? reference.startLine, reference.startLine + 39);
      setEvidence({ messageId: entry.id, referenceIndex, fileId: reference.fileId, startLine: reference.startLine, source: lines.slice(reference.startLine - 1, endLine).map((line, index) => `${reference.startLine + index}  ${line}`).join("\n"), status: "loaded" });
    } catch (error) { if (evidenceSequence.current === requestId && (error as Error).name !== "AbortError") setEvidence({ messageId: entry.id, referenceIndex, fileId: reference.fileId, startLine: reference.startLine, source: "", status: "error", error: error instanceof Error ? error.message : "无法读取引用证据。" }); }
  };
  const displayMessages = useMemo(() => currentConversation?.messages ?? [], [currentConversation]);
  const priorQuestionByMessage = useMemo(() => {
    const result = new Map<string, string>();
    let priorQuestion = "";
    for (const entry of displayMessages) {
      if (entry.role === "user") priorQuestion = entry.content;
      else if (priorQuestion) result.set(entry.id, priorQuestion);
    }
    return result;
  }, [displayMessages]);
  const beginSupplement = (entry: QaMessage) => {
    const priorQuestion = priorQuestionByMessage.get(entry.id);
    if (!priorQuestion) return;
    invalidateRequest();
    setEvidence(null);
    if (unified) {
      setQuestion(priorQuestion); setMode("question");
      const ids = [...new Set(entry.contextFiles.map(item => item.fileId))].filter(id => filesById.has(id)).slice(0, 12);
      setSelectedFiles(ids); setManualFileIds(ids); setExplicitSelection(true); setScopeOpen(true);
      setPreviewState(null); setStage("idle"); setMessage("");
      return;
    }
    setSupplementQuestion(priorQuestion);
    setSupplementFileIds([...new Set(entry.contextFiles.map((context) => context.fileId))].slice(0, 12));
    setSupplementFilter("");
    setQuestion(priorQuestion);
    setPreviewState(null); setCandidates([]); setStage("idle");
    setMessage("选择要补充的源码，然后重新预览。确认前不会发送内容。");
  };
  const visibleSupplementFiles = useMemo(() => {
    const query = supplementFilter.trim().toLocaleLowerCase();
    return [...repository.files].filter((file) => !query || file.path.toLocaleLowerCase().includes(query)).sort((left, right) => left.path.localeCompare(right.path));
  }, [repository.files, supplementFilter]);

  const persistStaleReferences = useEffectEvent(() => {
    // A delayed effect must use the journal's latest view, never an older render's list.
    let changed = false;
    const current = getQuestionConversationView(workspaceId).map(conversation => ({
      ...conversation,
      messages: conversation.messages.map(entry => {
        if (entry.stale || !isStale(entry)) return entry;
        changed = true;
        return { ...entry, stale: true };
      }),
    }));
    if (changed) { setConversations(current); persistConversations(current); }
  });
  useEffect(() => {
    if (loadedSessionKey !== sessionKey) return;
    const timer = window.setTimeout(() => { persistStaleReferences(); }, 250);
    return () => window.clearTimeout(timer);
  }, [conversations, filesSignature, loadedSessionKey, sessionKey]);

  const startPreview = async (questionText = question, fileIds?: string[]) => {
    if (unified && explicitSelection && !fileIds?.length) { setPreviewState(null); setStage("error"); setMessage("请添加至少一个源码文件。"); return; }
    if (unified && fileIds && fileIds.length > 12) { setPreviewState(null); setStage("scope"); setScopeOpen(true); setMessage("最多发送 12 个文件，请移除多余附件。"); return; }
    const trimmed = mode === "explanation" ? `讲解文件：${currentFile.path}` : mode === "route" ? questionText.trim() || `从 ${currentFile.path} 开始阅读` : questionText.trim();
    if (!trimmed || generatingRef.current) return;
    const active = visibleConversations.find((item) => item.id === activeId) ?? currentConversation;
    const history = (active?.messages ?? []).filter((entry) => !isStale(entry)).slice(-6).filter((entry) => !excludedHistory.includes(entry.id)).map(({ role, content }) => ({ role, content }));
    const id = ++requestSequence.current;
    requestController.current?.abort();
    const controller = new AbortController(); requestController.current = controller;
    activeRequestContext.current = contextKey;
    if (!unified) setPreviewState(null); setStage("previewing"); setMessage(unified ? "" : "正在整理相关源码范围，尚未发送给模型。");
    try {
      const requestedFileIds = mode === "question" ? fileIds ?? (additionalFileIds.length ? additionalFileIds : undefined) : fileIds;
      const value: AiPreviewResponse = mode === "investigation"
        ? await localExplanationProvider.previewInvestigation(repository, currentFile.id, trimmed, fileIds, ranges, excludedInvestigationFiles, controller.signal)
        : mode === "question"
        ? await localExplanationProvider.previewQuestion(repository, currentFile.id, trimmed, history, requestedFileIds, ranges, controller.signal)
        : await localExplanationProvider.preview(repository, currentFile.id, mode, requestedFileIds, undefined, ranges, controller.signal, mode === "route" ? questionText.trim() : undefined);
      if (requestSequence.current !== id) return;
      if (value.scopeRequired) {
        const preferred = new Set([...(fileIds ?? []), ...(fileIds === undefined ? additionalFileIds : [])]);
        const chosen = [...new Set([...selectedFiles, ...preferred])].filter((fileId) => value.candidates.some((candidate) => candidate.fileId === fileId));
        const defaultSelection = (mode === "question" || mode === "investigation")
          ? chosen.length ? chosen : value.candidates.slice(0, Math.min(12, value.candidates.length)).map((candidate) => candidate.fileId)
          : [currentFile.id, ...chosen.filter((fileId) => fileId !== currentFile.id)].slice(0, 12);
        const nextRanges = Object.fromEntries(value.candidates.map((candidate) => [candidate.fileId, ranges[candidate.fileId] ?? candidate.suggestedRange ?? { startLine: 1, endLine: candidate.lineCount }]));
        setSearchSuggestions(value.searchSuggestions ?? []); setSupplementalResults([]); setExplicitSelection(true); setCandidates(value.candidates); setSelectedFiles(defaultSelection); setRanges(nextRanges); setScopeContextKey(contextKey); setStage("scope"); setScopeOpen(true);
        setMessage(value.retrievalInsufficient ? "自动检索没有找到足够依据。请手动选择与问题相关的文件；最多 12 个文件、总发送内容 60,000 字符。" : "候选源码超出发送范围上限，请选择文件并调整行范围。未发送任何源码。");
      } else if (value.preview.retrievalInsufficient && !fileIds?.length) {
        setStage("error"); setMessage("没有找到足够的源码依据，请添加相关文件后再发送。");
      } else {
        setPreviewState({ preview: value.preview, question: trimmed, history, contextKey }); setStage("ready"); setMessage("");
      }
    } catch (error) {
      if (requestSequence.current === id && (error as Error).name !== "AbortError") { setStage("error"); setMessage(error instanceof Error ? error.message : "无法预览发送范围。请先在“讲解”页配置模型服务。"); }
    } finally { if (requestController.current === controller) requestController.current = null; }
  };
  useEffect(() => { startPreviewRef.current = startPreview; });

  useEffect(() => {
    if (unified && !generatingRef.current) { invalidateRequest(); setPreviewState(null); setStage("idle"); }
  }, [modelSettings, unified, invalidateRequest]);

  useEffect(() => {
    if (!unified || !active || storageBusy || !backendAvailable || !modelSettings?.configured || generatingRef.current || stage === "scope") return;
    const timer = window.setTimeout(() => { if (question.trim() || mode !== "question") void startPreviewRef.current(undefined, explicitSelection ? selectedFiles : undefined); }, 300);
    return () => window.clearTimeout(timer);
    // Stage changes must not schedule another preview; edits and task ownership do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unified, active, storageBusy, backendAvailable, modelSettings, question, mode, contextKey, excludedHistory, additionalFileIds, loadedSessionKey, activeId, ranges, selectedFiles, explicitSelection, stage === "generating"]);

  const submitQuestion = (event: FormEvent) => { event.preventDefault(); void startPreview(); };
  const cancel = () => {
    generatingRef.current = false;
    invalidateRequest();
    setPartialTurns((turns) => turns.map((turn) => turn.status === "generating" || turn.status === "repairing" || turn.status === "validating" ? { ...turn, status: "incomplete" } : turn));
    setPreviewState(null); setStage("idle"); setMessage(unified ? "已停止，当前回答未完成。" : "已取消；没有发送未确认的内容。");
  };
  const confirmAndGenerate = async () => {
    const state = visiblePreviewState;
    if (stage !== "ready" || !state || generatingRef.current || state.preview.repositoryId !== repository.id || state.preview.revision !== repository.revision || state.preview.entryFileId !== currentFile.id) return;
    if (state.preview.expiresAt <= Date.now()) { setPreviewState(null); setStage("idle"); void startPreview(); return; }
    const id = ++requestSequence.current;
    const controller = new AbortController(); requestController.current = controller;
    activeRequestContext.current = contextKey;
    setStage("generating"); setMessage(""); setStreamUnsupported(false);
    generatingRef.current = true;
    generationSessionRef.current = sessionKey;
    const completionIds = { conversationId: activeId || crypto.randomUUID(), userMessageId: crypto.randomUUID(), answerMessageId: crypto.randomUUID() };
    if (unified) {
      setActiveId(completionIds.conversationId); setQuestion(""); followLatest.current = true; setAwayFromBottom(false);
      setPartialTurns((turns) => [...turns, { id: completionIds.answerMessageId, conversationId: completionIds.conversationId, question: state.question, answer: "", status: "generating", afterMessageCount: displayMessages.length, startedAt: Date.now() }]);
    }
    const generation = getQuestionConversationGeneration(workspaceId);
    const investigationEpoch = getInvestigationEpoch(workspaceId);
    const investigationAtSend = activeInvestigation;
    const investigationExclusions = [...excludedInvestigationFiles];
    try {
      const response: AiGenerationResult = unified ? await generateChatStream(state.preview, controller.signal, completionIds, (event) => {
        if (requestSequence.current !== id || generation !== getQuestionConversationGeneration(workspaceId)) return;
        setPartialTurns((turns) => turns.map((turn) => turn.id !== completionIds.answerMessageId ? turn : { ...turn, answer: event.type === "text" ? turn.answer + event.text : event.type === "replace" ? event.text ?? "" : turn.answer, status: event.status ?? turn.status }));
      }, !ordinaryResponse) : await localExplanationProvider.generate(state.preview, controller.signal);
      if (requestSequence.current !== id || generation !== getQuestionConversationGeneration(workspaceId) || response.repositoryId !== repository.id || response.revision !== repository.revision || response.mode !== state.preview.mode) return;
      const result = response.result;
      const contextFiles = state.preview.files.map(({ fileId, contentHash, startLine, endLine }) => ({ fileId, contentHash, startLine, endLine }));
      const userMessage: QaMessage = { id: crypto.randomUUID(), role: "user", content: state.question, references: [], contextFiles };
      const answerMessage: QaMessage = {
        id: crypto.randomUUID(), role: "assistant", content: String(result.answer ?? ""),
        references: Array.isArray(result.references) ? result.references as QaReference[] : [], contextFiles,
        claims: Array.isArray(result.claims) ? result.claims as { text: string; referenceIndices: number[] }[] : undefined,
        insufficientEvidence: result.insufficientEvidence === true,
      };
      const completion = unified ? buildAiChatCompletion({ ...state.preview, sources: state.preview.files, question: state.question, excludedFileIds: state.preview.excludedFileIds ?? investigationExclusions }, result, completionIds) : null;
      const messages: QaMessage[] = completion ? completion.messages as QaMessage[] : [userMessage, answerMessage];
      const titleSource = completion ? messages[0]?.content ?? state.question : state.question;
      const nextId = completionIds.conversationId;
      const latestConversations: QaConversation[] = getQuestionConversationView(workspaceId);
      const existing = latestConversations.find((item) => item.id === nextId);
      const next: QaConversation = existing
        ? { ...existing, messages: [...existing.messages, ...messages], updatedAt: Date.now() }
        : { id: nextId, title: titleSource.slice(0, 48), messages, updatedAt: Date.now() };
      const updatedConversations = [next, ...latestConversations.filter((item) => item.id !== nextId)].slice(0, 100);
      setConversations(updatedConversations);
      // Persist before the user can switch tabs and unmount this panel; a debounced
      // effect alone can be cancelled by the unmount immediately after an answer.
      if (unified && response.chatPersisted) restoreQuestionConversations(workspaceId, updatedConversations);
      else persistConversations(updatedConversations);
      if (response.warning) setSaveError({ sessionKey, message: response.warning });
      if (state.preview.mode === "investigation" && investigationAtSend && investigationEpoch === getInvestigationEpoch(workspaceId)) {
        const latest = getInvestigationState(workspaceId).records.find(item => item.id === investigationAtSend.id);
        if (latest) {
          const nextResult = result as unknown as import("@/data/model").InvestigationResult;
          try {
          const updated = appendInvestigationResult(latest, nextResult, contextFiles, investigationExclusions, Object.fromEntries(state.preview.files.map(file => [file.fileId, file.reasons ?? []])));
          changeInvestigation(workspaceId, updated); setActiveInvestigation(updated);
          } catch {
            setInvestigationNotices(previous => ({ ...previous, [completionIds.answerMessageId]: "本次结果已保留在聊天中；原调查的内容已达上限，请将本次结果另存调查。" }));
          }
        }
      }
      onCompleted?.();
      setActiveId(nextId); if (!unified) setQuestion(""); setPreviewState(null); setStage("idle");
      if (unified) setMode("question");
      setPartialTurns((turns) => turns.filter((turn) => turn.id !== completionIds.answerMessageId));
      onClearAdditionalFiles?.();
      setMessage(response.cached ? "来自本地缓存" : "");
    } catch (error) {
      if (requestSequence.current === id) {
        setPartialTurns((turns) => turns.map((turn) => turn.id === completionIds.answerMessageId ? { ...turn, status: "incomplete" } : turn));
        if ((error as Error).name !== "AbortError") { setStage("error"); setMessage(error instanceof Error ? (unified ? error.message.replace(/重新预览发送范围/g, "重新发送") : error.message) : "问答请求失败。"); setStreamUnsupported((error as { code?: string }).code === "STREAM_UNSUPPORTED"); }
      }
    } finally { if (requestController.current === controller) { requestController.current = null; generatingRef.current = false; } }
  };

  const createConversation = () => {
    cancel(); setActiveInvestigation(null); setExcludedInvestigationFiles([]); setExplicitSelection(false); setSelectedFiles([]); setRanges({});
    const next = { id: crypto.randomUUID(), title: "新对话", messages: [], updatedAt: Date.now() };
    const updatedConversations = [next, ...visibleConversations].slice(0, 100);
    setConversations(updatedConversations); persistConversations(updatedConversations); setActiveId(next.id); setMessage("");
  };
  const deleteConversation = () => {
    if (!currentConversation) return;
    cancel(); setActiveInvestigation(null); setExcludedInvestigationFiles([]);
    const remaining = visibleConversations.filter((item) => item.id !== currentConversation.id);
    setConversations(remaining); persistConversations(remaining); setActiveId(remaining[0]?.id ?? ""); setMessage("已删除此问答会话。");
  };
  const retryMessage = (text: string) => { setQuestion(text); void startPreview(text); };
  const changeQuestion = (value: string) => { setQuestion(value); if (!generatingRef.current) { invalidateRequest(); setPreviewState(null); if (stage !== "scope") setStage("idle"); } };
  const updateScope = (nextFiles: string[], nextRanges = ranges) => { setSelectedFiles(nextFiles); setRanges(nextRanges); setPreviewState(null); setStage("scope"); };


  const chooseTask = (next: AiMode) => {
    if (generatingRef.current) return;
    invalidateRequest(); setMode(next); setActiveInvestigation(null); setExcludedInvestigationFiles([]); setPreviewState(null); setStage("idle"); setMessage("");
    if (next !== "question" && next !== "investigation" && explicitSelection && !selectedFiles.includes(currentFile.id)) setSelectedFiles([currentFile.id, ...selectedFiles]);
  };
  const editAsQuestion = (text: string) => {
    if (generatingRef.current || storageBusy) return;
    chooseTask("question"); setQuestion(text);
    requestAnimationFrame(() => document.getElementById(questionInputId)?.focus());
  };
  const attachmentIds = explicitSelection ? selectedFiles : visiblePreviewState?.preview.files.map(file => file.fileId) ?? (mode !== "question" ? [currentFile.id] : []);
  const changeAttachments = (ids: string[], manualId?: string) => {
    if (generatingRef.current || storageBusy) return;
    invalidateRequest(); setPreviewState(null); setSelectedFiles(ids); setExplicitSelection(true);
    if (manualId) setManualFileIds(previous => [...new Set([...previous, manualId])]);
    if (!ids.length) { setStage("error"); setMessage("请添加至少一个源码文件。"); }
    else { if (stage !== "scope") setStage("idle"); setMessage(""); }
  };
  const continueInvestigation = (record: import("@/data/model").Investigation) => {
    chooseTask("investigation"); setActiveInvestigation(record); setExcludedInvestigationFiles(record.excludedFileIds);
    setQuestion(`${record.question}\n继续调查：${record.questions.map(item => item.question).join("；")}`.slice(0, 12000));
    const ids = [...new Set([...record.contextFiles.map(file => file.fileId), ...record.questions.map(item => item.suggestedFileId).filter((id): id is string => Boolean(id))])].filter(id => filesById.has(id) && !record.excludedFileIds.includes(id));
    setSelectedFiles(ids); setExplicitSelection(ids.length > 0); setRanges({}); setScopeOpen(true);
  };
  const renderMessage = (entry: QaMessage) => {
    if (entry.investigation) {
      const saved = investigationCollection.records.find(item => item.id === (investigationDrafts[entry.id]?.id ?? entry.id));
      const record = saved ?? investigationDrafts[entry.id] ?? { ...createInvestigation({ result: entry.investigation, question: entry.investigationQuestion ?? priorQuestionByMessage.get(entry.id) ?? "调查代码", repository, contextFiles: entry.contextFiles.map(item => ({ ...item, startLine: item.startLine ?? 1, endLine: item.endLine ?? 1 })), excludedFileIds: entry.excludedFileIds ?? [], id: entry.id }), selectionReasons: entry.selectionReasons };
      return <article className="question-message is-assistant" key={entry.id}><strong>调查结果</strong>{investigationNotices[entry.id] && <p role="status">{investigationNotices[entry.id]}</p>}<InvestigationCard record={record} repository={repository} busy={storageBusy || stage === "generating"} onChange={next => { setInvestigationDrafts(previous => ({ ...previous, [entry.id]: next })); if (saved) changeInvestigation(workspaceId, next); }} onOpen={onOpenReference} onEvidence={(fileId, line) => { const index = entry.references.findIndex(ref => ref.fileId === fileId && ref.startLine === line); if (index >= 0) void showEvidence(entry, entry.references[index], index); }} onRelations={onRelations} onContinue={continueInvestigation}/>
      {evidence?.messageId === entry.id && <ChatEvidence evidence={evidence} onClose={() => setEvidence(null)} onOpen={onOpenReference}/>}
      <button type="button" disabled={storageBusy || Boolean(saved)} onClick={() => { if (getInvestigationState(workspaceId).records.length >= 100) { setMessage("每个工作区最多保存 100 条调查。"); return; } setInvestigationDrafts(previous => ({ ...previous, [entry.id]: record })); changeInvestigation(workspaceId, record); }}>{saved ? "已加入调查记录" : "保存调查"}</button><small>保存后，修改会自动写入；保存结果请查看全局状态。</small></article>;
    }
    return <ChatMessage key={entry.id} entry={entry} stale={isStale(entry)} busy={stage === "generating" || storageBusy} evidence={evidence} onEvidence={(item, reference, index) => { void showEvidence(item, reference, index); }} onCloseEvidence={() => { evidenceSequence.current++; evidenceController.current?.abort(); setEvidence(null); evidenceTrigger.current?.focus(); }} onOpen={onOpenReference} onEdit={editAsQuestion} onSupplement={beginSupplement} onTour={onActivateTour}/>;
  };
  const renderPartial = (turn: (typeof partialTurns)[number]) => (<div className="chat-pending-turn" key={turn.id}><article className="question-message is-user"><div className="question-message-heading"><strong>你</strong></div><ChatMarkdown text={turn.question}/></article><article className="question-message is-assistant" aria-busy={turn.status!=="incomplete"}><div className="question-message-heading"><strong>RepoLens</strong><span>{turn.status==="incomplete"?"未完成":turn.status==="repairing"?"正在修正回答格式…":turn.status==="validating"?"正在核对引用…":"正在回答…"}</span></div>{turn.answer ? <ChatMarkdown text={turn.answer}/> : <span className="chat-typing" aria-label="正在生成">···</span>}{turn.status==="incomplete"&&<button className="question-retry" type="button" onClick={()=>{setQuestion(turn.question);setMode("question");setMessage("");}}>重新提问</button>}</article></div>);

  if (unified) return <section className="copilot-chat question-panel" aria-label="源码问答">
    <ChatToolbar conversations={[...partialTurns.filter(turn => turn.status !== "incomplete" && !visibleConversations.some(item => item.id === turn.conversationId)).map(turn => ({ id: turn.conversationId, title: turn.question.slice(0, 48), messages: [], updatedAt: turn.startedAt })), ...visibleConversations]} activeId={activeId} generatingId={partialTurns.find(turn => turn.status !== "incomplete")?.conversationId} busy={storageBusy} onNew={createConversation} onSelect={id => { cancel(); setActiveInvestigation(null); setExcludedInvestigationFiles([]); setExplicitSelection(false); setSelectedFiles([]); setRanges({}); setActiveId(id); setMessage(""); }} onDelete={deleteConversation} onClose={onCloseChat}/>
    <div className="chat-persistence-status" aria-live="polite">
      {saveError?.sessionKey === sessionKey && <div role="alert">对话尚未保存：{saveError.message}<button type="button" onClick={() => persistConversations(conversations, false, true)}>重试保存</button></div>}
      {failedRepositoryId === workspaceId && <div role="alert">无法读取已保存的问答记录。本页修改尚未保存，原记录不会被覆盖。<button type="button" onClick={() => { void loadWorkspace(); }}>重试读取问答记录</button></div>}
      {readWarning && <div role="status">本地保存提示：{readWarning}<button type="button" onClick={() => { void loadWorkspace(); }}>重试读取</button><button type="button" onClick={() => { readWarningRef.current = ""; setReadWarning(""); persistConversations(conversations, false, true); }}>仍然保存</button></div>}
      {storageBusy && <div role="status">正在清除数据，聊天操作已暂停。</div>}
    </div>
    <div className="copilot-transcript" ref={transcriptRef} role="log" aria-label="聊天消息" aria-live="polite" onScroll={event => { const element=event.currentTarget; scrollPosition.current=element.scrollTop; followLatest.current=element.scrollHeight-element.scrollTop-element.clientHeight<64; setAwayFromBottom(!followLatest.current); try { localStorage.setItem(uiKey,JSON.stringify({activeId,draft:questionRef.current,scrollTop:element.scrollTop})); } catch { /* Local preference failure does not block reading. */ } }}>
      {!displayMessages.length && !partialTurns.some(turn=>turn.conversationId===activeId) && <div className="copilot-empty"><h3>想了解这份代码的哪一部分？</h3><div><button type="button" onClick={()=>chooseTask("explanation")}>讲解当前文件</button><button type="button" onClick={()=>chooseTask("route")}>规划阅读路线</button></div></div>}
      {Array.from({length:displayMessages.length+1},(_,index)=><Fragment key={index}>{partialTurns.filter(turn=>turn.conversationId===activeId&&turn.afterMessageCount===index).map(renderPartial)}{displayMessages[index]&&renderMessage(displayMessages[index])}</Fragment>)}

    {!backendAvailable && <p role="alert" className="question-feedback">本地服务已停止，请重启 RepoLens 后再试。</p>}
      {message && failedRepositoryId !== workspaceId && !readWarning && <div className="chat-inline-feedback" role={stage==="error"?"alert":"status"}>{message}{streamUnsupported&&<button type="button" onClick={()=>{setOrdinaryResponse(true);setStreamUnsupported(false);setQuestion(partialTurns.at(-1)?.question || "");setStage("idle");setMessage("已选择普通响应，请重新发送。");}}>使用普通响应</button>}</div>}
    </div>
    <ChatComposer id={questionInputId} value={question} mode={mode} target={currentFile.path} generating={stage === "generating"} disabled={!backendAvailable || storageBusy} ready={stage === "ready" && !!visiblePreviewState} configured={modelSettings?.configured} model={modelSettings?.model} away={awayFromBottom}
      onLatest={() => { followLatest.current = true; setAwayFromBottom(false); if (transcriptRef.current) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight; }}
      onChange={changeQuestion} onMode={chooseTask} onSettings={onOpenSettings} onSend={() => { void confirmAndGenerate(); }} onStop={cancel}
      status={stage === "previewing" ? "正在整理上下文…" : stage === "scope" ? "请调整发送范围" : !modelSettings?.configured ? "设置模型后即可提问" : undefined}
      context={<ChatContextPicker open={scopeOpen} onOpenChange={setScopeOpen} files={repository.files} currentId={currentFile.id} required={mode !== "question" && mode !== "investigation"} selected={attachmentIds} manualIds={[...manualFileIds, ...additionalFileIds]} preview={visiblePreviewState?.preview} candidates={candidates} ranges={ranges} busy={stage === "generating" || storageBusy}
        history={mode === "question" ? displayMessages.filter(entry => !isStale(entry)).slice(-6).map(entry => ({ ...entry, selected: !excludedHistory.includes(entry.id) })) : []}
        characters={visiblePreviewState?.preview.characters} endpoint={visiblePreviewState?.preview.baseUrl || modelSettings?.baseUrl}
        onSelect={changeAttachments} onRange={(id, range) => { invalidateRequest(); setSelectedFiles(attachmentIds); setExplicitSelection(true); setPreviewState(null); setRanges(previous => ({ ...previous, [id]: range })); if (stage !== "scope") setStage("idle"); }}
        onHistory={(id, checked) => { invalidateRequest(); setPreviewState(null); setExcludedHistory(previous => checked ? previous.filter(item => item !== id) : [...previous, id]); setStage("idle"); }}
        needsApply={stage === "scope"} onApply={() => { setScopeOpen(false); setExplicitSelection(true); void startPreview(question, selectedFiles); }}/>} />
  </section>;

  return <>
    {!backendAvailable && <p role="alert" className="question-feedback">本地服务已停止，问答请求已取消。请重新启动 RepoLens 后再试。</p>}
    {readWarning && <div className="question-feedback" role="status">本地保存提示：{readWarning}。问答仍可查看，但在确认前不会自动覆盖已有记录。<button type="button" className="question-retry" onClick={() => { void loadWorkspace(); }}>重试读取</button><button type="button" className="question-retry" onClick={() => { readWarningRef.current = ""; setReadWarning(""); persistConversations(conversations, false, true); }}>仍然保存</button></div>}
    {failedRepositoryId === workspaceId && <div className="question-feedback" role="alert">无法读取已保存的问答记录。本页修改尚未保存，原记录不会被覆盖。<button type="button" className="question-retry" onClick={() => { void loadWorkspace(); }}>重试读取问答记录</button></div>}
    {saveError?.sessionKey === sessionKey && <div className="question-feedback" role="alert">问答仍可继续，但会话未保存：{saveError.message}<button type="button" className="question-retry" onClick={() => persistConversations(conversations, false, true)}>重试保存</button></div>}
    {storageBusy && <p className="question-feedback" role="status">正在清除本地保存数据，问答操作已暂停。</p>}
    <fieldset disabled={!backendAvailable || storageBusy} style={{ border: 0, margin: 0, minWidth: 0, padding: 0 }}>
    <section ref={panelRef} onScroll={(event) => { if (!unified) return; scrollPosition.current = event.currentTarget.scrollTop; try { localStorage.setItem(uiKey, JSON.stringify({ activeId, draft: question, scrollTop: scrollPosition.current })); } catch { /* Keep the position in memory. */ } }} className="question-panel" aria-label="源码问答">
    {additionalFileIds.length > 0 && <div className="question-feedback" role="status">已从源码搜索加入 {additionalFileIds.length} 个候选文件。预览时仍需核对发送范围。<button type="button" onClick={onClearAdditionalFiles}>清除候选</button></div>}
    <div className="question-toolbar">
      <label><span className="sr-only">问答会话</span><select aria-label="问答会话" value={activeId} onChange={(event) => { cancel(); setActiveId(event.target.value); }}>
        {!visibleConversations.length && <option value="">新对话</option>}
        {visibleConversations.map((item) => <option key={item.id} value={item.id}>{item.title || "新对话"}</option>)}
      </select></label>
      <button type="button" onClick={createConversation}>新对话</button>
      {currentConversation && <button type="button" onClick={deleteConversation}>删除对话</button>}
    </div>
    {unified && <div className="chat-task-actions"><button type="button" disabled={stage === "generating"} onClick={() => { cancel(); setMode("explanation"); }}>讲解当前文件</button><button type="button" disabled={stage === "generating"} onClick={() => { cancel(); setMode("route"); }}>规划阅读路线</button><button type="button" onClick={onOpenSettings}>配置模型</button></div>}
    <div className="question-messages" ref={transcriptRef} onScroll={(event) => { scrollPosition.current = event.currentTarget.scrollTop; if (unified) { try { localStorage.setItem(uiKey, JSON.stringify({ activeId, draft: question, scrollTop: scrollPosition.current })); } catch { /* Remain usable in memory. */ } } }} aria-live="polite">
      {stage === "generating" && <p role="status" className="question-generating">正在生成回答…</p>}
      {!displayMessages.length && stage !== "generating" && <p className="question-empty">可以询问当前仓库的行为、依赖或实现细节。回答只读，不会运行或修改项目。</p>}
      {displayMessages.map((entry) => <article className={`question-message is-${entry.role}${isStale(entry) ? " is-stale" : ""}`} key={entry.id}>
        <div className="question-message-heading"><strong>{entry.role === "user" ? "你" : "RepoLens 回答"}</strong>{isStale(entry) && <span>依据源码已变化，回答过期</span>}</div>
        {entry.explanation && <AiResultView result={entry.explanation} files={filesById} stale={isStale(entry)} onOpenReference={onOpenReference} />}
        {entry.route && <section className="chat-route-result"><strong>{entry.route.title}</strong><ol>{entry.route.steps.map((step) => <li key={step.id}><button type="button" disabled={isStale(entry)} onClick={() => onOpenReference(step.reference)}>{step.title}</button><p>{step.description}</p></li>)}</ol><button type="button" disabled={isStale(entry)} onClick={() => onActivateTour?.(entry.route!)}>开始阅读这条路线</button></section>}
        {!entry.explanation && !entry.route && <p className="question-message-body">{entry.content}</p>}
        {entry.claims?.map((claim, claimIndex) => <p className="question-claim" key={`${entry.id}:claim:${claimIndex}`}>{claim.text} <span>{claim.referenceIndices.map((referenceIndex) => <button key={referenceIndex} type="button" disabled={isStale(entry) || !entry.references[referenceIndex]} onClick={() => { const reference = entry.references[referenceIndex]; if (reference) void showEvidence(entry, reference, referenceIndex); }}>证据 {referenceIndex + 1}</button>)}</span></p>)}
        {entry.insufficientEvidence && <small className="question-insufficient">已标记为无法从本次源码范围判断。</small>}
        {entry.role === "assistant" && <button type="button" className="question-retry" onClick={() => beginSupplement(entry)}>引用不足，补充文件</button>}
        {!entry.explanation && !entry.route && entry.references.length > 0 && <div className="question-references">{entry.references.map((reference, index) => <span key={`${reference.fileId}:${reference.startLine}:${index}`}><button disabled={isStale(entry)} onClick={() => onOpenReference({ fileId: reference.fileId, line: reference.startLine, ...(reference.endLine ? { endLine: reference.endLine } : {}) })}>{reference.fileId} · 第 {reference.startLine}–{reference.endLine ?? reference.startLine} 行</button><button type="button" disabled={isStale(entry)} onClick={() => void showEvidence(entry, reference, index)}>查看证据 {index + 1}</button></span>)}</div>}
        {entry.role === "user" && <button type="button" className="question-retry" onClick={() => retryMessage(entry.content)}>重新预览此问题</button>}
      </article>)}
    </div>
    {evidence && <aside className="question-evidence" aria-label="回答证据"><div><strong>证据对照 · {evidence.fileId}:{evidence.startLine}</strong><button type="button" onClick={() => setEvidence(null)}>关闭</button></div>{evidence.status === "loading" ? <p>正在读取已确认范围内的源码…</p> : evidence.status === "error" ? <p role="alert">{evidence.error}</p> : <><pre>{evidence.source}</pre><button type="button" onClick={() => onOpenReference({ fileId: evidence.fileId, line: evidence.startLine })}>跳转到完整源码</button><small>引用可以定位不等于结论已得到证实。请核对源码是否支持回答。</small></>}</aside>}
    {supplementQuestion && <section className="question-supplement" aria-label="补充问答源码范围"><strong>补充源码后重新预览</strong><p>问题：{supplementQuestion}</p><label>筛选文件<input aria-label="筛选补充文件" value={supplementFilter} onChange={(event) => setSupplementFilter(event.target.value)} placeholder="输入路径关键词" /></label><div>{visibleSupplementFiles.map((file) => {
      const checked = supplementFileIds.includes(file.id);
      return <label key={`supplement:${file.id}`}><input type="checkbox" checked={checked} disabled={!checked && supplementFileIds.length >= 12} onChange={(event) => setSupplementFileIds((current) => event.target.checked ? [...current, file.id] : current.filter((id) => id !== file.id))} /><span>{file.path}</span></label>;
    })}</div><small>已选 {supplementFileIds.length}/12 个文件。选择后会重新生成发送预览。</small><button type="button" disabled={!supplementFileIds.length || stage === "previewing" || stage === "generating"} onClick={() => { const prompt = supplementQuestion; setSupplementQuestion(""); void startPreview(prompt, supplementFileIds); }}>重新预览补充范围</button><button type="button" onClick={() => setSupplementQuestion("")}>取消</button></section>}
    <form className="question-input-form" onSubmit={submitQuestion}>
      {unified && <label>任务<select aria-label="AI 任务" value={mode} disabled={stage === "generating" || stage === "previewing"} onChange={(event) => { cancel(); setMode(event.target.value as AiMode); }}><option value="question">提问或追问</option><option value="explanation">讲解当前文件</option><option value="route">生成阅读路线</option></select></label>}
      {unified && <small className="chat-entry">{stage === "generating" ? "当前任务使用确认时的文件和范围；关闭面板仍会继续。" : `当前文件：${currentFile.path}`}</small>}
      {mode === "explanation" ? <p className="chat-entry">讲解当前文件；发送前会显示文件和行范围。</p> : <>
        <label htmlFor={questionInputId}>{mode === "route" ? "阅读目标（可选）" : "提问或追问"}</label>
        <textarea id={questionInputId} value={question} maxLength={12000} onChange={(event) => changeQuestion(event.target.value)} placeholder={mode === "route" ? "例如：理解数据保存流程" : `关于 ${currentFile.path}，我想了解…`} disabled={stage === "generating" || stage === "previewing"} />
      </>}
      <div className="question-actions">
        <button type="submit" disabled={mode === "question" && !question.trim() || stage === "generating" || stage === "previewing"}>预览发送范围</button>
        {(stage === "previewing" || stage === "generating" || stage === "ready" || stage === "scope") && <button type="button" className="question-cancel" onClick={cancel}>{unified && stage === "generating" ? "停止" : "取消"}</button>}
      </div>
    </form>
    {unified && mode === "question" && <details className="chat-history"><summary>携带的历史消息 · {displayMessages.filter((entry) => !isStale(entry)).slice(-6).filter((entry) => !excludedHistory.includes(entry.id)).length} 条</summary>{displayMessages.filter((entry) => !isStale(entry)).slice(-6).map((entry) => <label key={entry.id}><input type="checkbox" checked={!excludedHistory.includes(entry.id)} disabled={stage === "generating"} onChange={(event) => { setExcludedHistory((previous) => event.target.checked ? previous.filter((id) => id !== entry.id) : [...previous, entry.id]); setPreviewState(null); if (stage === "ready") setStage("idle"); }} /><span title={entry.content.slice(0, 500)}>{entry.role === "user" ? "你" : "AI"} · {entry.content.length.toLocaleString()} 字符</span></label>)}<small>问题 {question.length.toLocaleString()} 字符 · 已选历史 {displayMessages.filter((entry) => !isStale(entry)).slice(-6).filter((entry) => !excludedHistory.includes(entry.id)).reduce((sum, entry) => sum + entry.content.length, 0).toLocaleString()} 字符。源码计入预览总数，上限 60,000；可取消历史或缩小源码范围。</small></details>}
    {visibleScope && candidates.length > 0 && <section className="question-scope" aria-label="调整问答发送范围">
      <strong>选择相关源码（最多 12 个文件）</strong>
      <div className="question-candidate-list">{!!searchSuggestions.length && <details><summary>补充搜索</summary>{searchSuggestions.map(term => <button type="button" key={term} onClick={() => {
        supplementalRequest.current?.abort(); const controller = new AbortController(); supplementalRequest.current = controller;
        void localRepositoryProvider.searchContent({ repositoryId: repository.id, revision: repository.revision ?? "", query: term }, controller.signal).then(value => { if (!controller.signal.aborted) setSupplementalResults(value.results.map(match => ({ fileId: match.fileId, line: match.line, text: match.text }))); }).catch(error => { if (!controller.signal.aborted) setMessage(error.message); });
      }}>{term}</button>)}{supplementalResults.map((result, index) => <button type="button" key={index} onClick={() => onOpenReference({ fileId: result.fileId, line: result.line })}>{result.fileId}:{result.line} · {result.text}</button>)}</details>}
      {candidates.map((candidate) => {
        const selected = selectedFiles.includes(candidate.fileId);
        const range = ranges[candidate.fileId] ?? candidate.suggestedRange ?? { startLine: 1, endLine: candidate.lineCount };
        return <label key={candidate.fileId}>
          <input type="checkbox" checked={selected} disabled={(!selected && selectedFiles.length >= 12) || (mode !== "question" && candidate.fileId === currentFile.id)} onChange={(event) => updateScope(event.target.checked ? [...selectedFiles, candidate.fileId] : selectedFiles.filter((item) => item !== candidate.fileId))} />
          <span>{candidate.fileId}</span>{!!candidate.alternativeRanges?.length && <select aria-label={`${candidate.fileId} 候选片段`} value="" onChange={event => { const chosen = candidate.alternativeRanges?.[Number(event.target.value)]; if (chosen) updateScope(selectedFiles, { ...ranges, [candidate.fileId]: { startLine: chosen.startLine, endLine: chosen.endLine } }); }}><option value="">选择命中片段或调整下方行范围</option>{candidate.alternativeRanges.map((r, index) => <option key={index} value={index}>{r.name} · {r.startLine}–{r.endLine}</option>)}</select>}<small>{candidate.lineCount} 行 · {candidate.characters.toLocaleString()} 字符{candidate.reasons?.length ? ` · ${candidate.reasons.join("、")}` : ""}</small>
          {selected && <span className="ai-range-fields"><input aria-label={`${candidate.fileId} 起始行`} type="number" min={1} max={candidate.lineCount} value={range.startLine} onChange={(event) => updateScope(selectedFiles, { ...ranges, [candidate.fileId]: { ...range, startLine: Number(event.target.value) } })} />至<input aria-label={`${candidate.fileId} 结束行`} type="number" min={range.startLine} max={candidate.lineCount} value={range.endLine} onChange={(event) => updateScope(selectedFiles, { ...ranges, [candidate.fileId]: { ...range, endLine: Number(event.target.value) } })} /></span>}
          {selected && candidate.oversizedLines.some((line) => line >= range.startLine && line <= range.endLine) && <small role="alert">范围包含不能发送的超长行，请缩小范围。</small>}
        </label>;
      })}</div>
      <button type="button" onClick={() => { void startPreview(question, selectedFiles); }} disabled={(mode === "question" && !question.trim()) || !selectedFiles.length || candidates.some((candidate) => selectedFiles.includes(candidate.fileId) && candidate.oversizedLines.some((line) => line >= (ranges[candidate.fileId]?.startLine ?? 1) && line <= (ranges[candidate.fileId]?.endLine ?? candidate.lineCount)))}>重新预览所选内容</button>
    </section>}
    {visiblePreviewState && stage === "ready" && <section ref={consentRef} className="question-consent" aria-label="问答发送确认">
      <strong>发送前确认</strong>
      <button type="button" onClick={() => { void confirmAndGenerate(); }}>确认发送并获取引用回答</button>
      <p>服务：{visiblePreviewState.preview.baseUrl} · 模型：{visiblePreviewState.preview.model} · 携带历史 {visiblePreviewState.history.length} 条 · 总字符 {visiblePreviewState.preview.characters.toLocaleString()}{visiblePreviewState.preview.tokenEstimate === undefined ? "" : ` · 约 ${visiblePreviewState.preview.tokenEstimate.toLocaleString()} token`}</p>
      {unified && <p>任务：{visiblePreviewState.preview.mode === "question" ? "问答" : visiblePreviewState.preview.mode === "route" ? "阅读路线" : "文件讲解"} · 入口：{visiblePreviewState.preview.entryFileId} · {visiblePreviewState.preview.mode === "question"
        ? `问题／历史／源码：${visiblePreviewState.question.length}／${visiblePreviewState.history.reduce((sum, item) => sum + item.content.length, 0)}／${Math.max(0, visiblePreviewState.preview.characters - visiblePreviewState.question.length - visiblePreviewState.history.reduce((sum, item) => sum + item.content.length, 0))} 字符`
        : `发送源码：${visiblePreviewState.preview.characters.toLocaleString()} 字符`}</p>}
      {visiblePreviewState.preview.tokenEstimate !== undefined && <small className="token-estimate-note">Token 数为粗略估算，因模型分词规则不同，不代表实际计费量。</small>}
      <blockquote>{visiblePreviewState.question}</blockquote>
      <ul>{visiblePreviewState.preview.files.map((file) => <li key={file.fileId}>{file.fileId}（第 {file.startLine}–{file.endLine} 行）{file.reasons?.length ? ` · ${file.reasons.join("、")}` : ""}</li>)}</ul>
      {visiblePreviewState.preview.retrievalInsufficient && <p role="alert">自动检索依据不足；请确认所选源码确实适合回答。</p>}

    </section>}
    {message && <p className="question-feedback" role={stage === "error" ? "alert" : "status"}>{message}</p>}
    </section>
    </fieldset>
  </>;
}
