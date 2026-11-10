import { parseChatPreferences, type ChatPreferences } from "@/data/chat-preferences.mjs";
import { registerChatPreferenceFlush } from "@/data/chat-preference-lifecycle.mjs";
import { enqueueWorkspacePersistence, markWorkspacePersistencePending, acknowledgeWorkspacePersistenceKey } from "@/data/workspace-persistence.mjs";
import { ChatRetrieval } from "./ChatRetrieval";
import type { ChatAttachment } from "./chat-intent";
import type { ChatIntent } from "@/components/repolens/chat-intent";
import { MAX_CONVERSATIONS, CONVERSATION_CAPACITY_MESSAGE } from "@/data/persistence-limits.mjs";
import { InvestigationCard } from "./InvestigationCard";
import { createInvestigation, appendInvestigationResult, replaceInvestigationResult } from "@/data/investigation.mjs";
import { changeInvestigation, getInvestigationState, getInvestigationEpoch, subscribeInvestigations } from "@/data/investigation-state.mjs";
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, useEffectEvent, Fragment } from "react";
import { localRepositoryProvider, localWorkspaceProvider } from "@/data/providers";
import { generateChatStream, localExplanationProvider, type AiGenerationResult, type AiLineRange, type AiPreviewResponse, type AiQuestionHistoryItem, type AiScopeCandidate } from "@/data/explanation-provider";
import { ChatMarkdown } from "./ChatMarkdown";
import type { AiPreview, AiRouteRecord, FileRecord, RepositorySnapshot, SourceReference } from "@/data/model";
import type { AiMode } from "@/data/explanation-provider";
import { buildAiChatCompletion } from "@/data/ai-chat-completion.mjs";
import { acknowledgeQuestionConversationSave, clearQuestionConversationSaveError, enqueueQuestionConversationSave, failQuestionConversationRead, getQuestionConversationGeneration, getQuestionConversationOperations, getQuestionConversationReadError, getQuestionConversationReadVersion, getQuestionConversationSaveError, getQuestionConversationView, isQuestionConversationClearPending, recordQuestionConversationChanges, restoreQuestionConversations, setQuestionConversationSaveError } from "@/data/question-recovery.mjs";

import type { QaReference, QaMessage, QaConversation } from "./chat-types";
import { ChatToolbar } from "./ChatToolbar";
import { ChatMessage, ChatEvidence } from "./ChatMessage";
import { ChatComposer } from "./ChatComposer";
import { ChatContextPicker } from "./ChatContextPicker";

type PreviewState = { preview: AiPreview; question: string; history: AiQuestionHistoryItem[]; contextKey: string };

function readChatPreferences(key: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? { ok: true, value } : { ok: false };
  } catch { return { ok: false }; }
}

function validConversation(value: unknown): value is QaConversation {
  if (!value || typeof value !== "object") return false;
  const item = value as QaConversation;
  return typeof item.id === "string" && typeof item.title === "string" && Array.isArray(item.messages) && item.messages.every((message) =>
    message && typeof message.id === "string" && ["user", "assistant"].includes(message.role) && typeof message.content === "string" && Array.isArray(message.references) && Array.isArray(message.contextFiles));
}

export function QuestionPanel({ onShowGraph, repository, currentFile, filesById, onOpenReference, backendAvailable = true, active = false, persistenceActive = true, storageBusy = false, clearVersion = 0, additionalFileIds = [], onClearAdditionalFiles, unified = false, intent, onCompleted, onActivateTour, onOpenSettings, onCloseChat, modelSettings, onRelations, savedTourSignatures = [], onSaveTour }: { onShowGraph?: (ids: string[]) => void;
  repository: RepositorySnapshot; currentFile: FileRecord; filesById: Map<string, FileRecord>; onOpenReference: (reference: SourceReference) => void; backendAvailable?: boolean;
  active?: boolean; persistenceActive?: boolean; storageBusy?: boolean; clearVersion?: number;
  additionalFileIds?: string[]; onClearAdditionalFiles?: () => void;
  savedTourSignatures?: string[]; onSaveTour?: (route: AiRouteRecord) => Promise<boolean>;
  unified?: boolean; intent?: ChatIntent; onCompleted?: () => void; onActivateTour?: (route: AiRouteRecord) => void; onOpenSettings?: () => void;
  onRelations?: (fileId: string) => void; onCloseChat?: () => void; modelSettings?: { baseUrl: string; model: string; configured: boolean };
}) {
  const workspaceId = repository.workspaceId ?? repository.id;
  const uiKey = `repolens:chat-ui:${workspaceId}`;
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
  const desktopPreferences = globalThis.__REPOLENS_RUNTIME__?.desktop === true;
  const [initialPreferences] = useState(() => desktopPreferences ? { ok: true as const, value: {} as Record<string, unknown> } : readChatPreferences(uiKey));
  const preferencesReady = useRef(!desktopPreferences && initialPreferences.ok);
  const preferenceSequence = useRef(0);
  const confirmedPreferences = useRef("");
  const pendingPreferenceSignature = useRef("");
  const pendingPreferenceSave = useRef<Promise<unknown>>(Promise.resolve());
  const preferenceBaseline = useRef(initialPreferences.ok ? initialPreferences.value : {});
  const draftTouched = useRef(false);
  const [preferenceError, setPreferenceError] = useState<"read" | "write" | null>(initialPreferences.ok ? null : "read");
  const [question, setQuestionValue] = useState(() => initialPreferences.ok && typeof initialPreferences.value.draft === "string" ? initialPreferences.value.draft : "");
  const questionRef = useRef(question);
  const setQuestion = useCallback((value: string | ((previous: string) => string)) => {
    draftTouched.current = true;
    if (unified && persistenceActive && !preferencesReady.current) markWorkspacePersistencePending(workspaceId, "chat-preferences-recovery", "草稿仅在内存中，请重试恢复后保存。");
    const next = typeof value === "function" ? value(questionRef.current) : value;
    questionRef.current = next; setQuestionValue(next);
  }, [persistenceActive, unified, workspaceId]);
  const [investigationNotices, setInvestigationNotices] = useState<Record<string, string>>({});
  const [investigationDrafts, setInvestigationDrafts] = useState<Record<string, import("@/data/model").Investigation>>({});
  const [activeInvestigation, setActiveInvestigation] = useState<import("@/data/model").Investigation | null>(null);
  const [excludedInvestigationFiles, setExcludedInvestigationFiles] = useState<string[]>([]);
  const [refinementOrigins, setRefinementOrigins] = useState<Record<string, { id: string; fingerprint: string }>>({});
  const [refinementBaseline, setRefinementBaseline] = useState<import("@/data/model").Investigation | null>(null);
  const [refinement, setRefinement] = useState<QaMessage | null>(null);
  const [mode, setMode] = useState<AiMode>("question");
  useEffect(() => {
    if (!clearVersion) return;
    // The parent increments only after a confirmed clear; remove associated in-memory investigation drafts.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRefinementOrigins({}); setRefinementBaseline(null); setRefinement(null); setAttachmentConflict(null); setAttachmentHashes({}); setInvestigationNotices({}); setInvestigationDrafts({}); setActiveInvestigation(null); setExcludedInvestigationFiles([]);
  }, [clearVersion]);
  const [excludedHistory, setExcludedHistory] = useState<string[]>([]);
  const generatingRef = useRef(false);
  const generationSessionRef = useRef("");
  const transcriptRef = useRef<HTMLDivElement>(null);
  const scrollPosition = useRef(0);
  const hasScrollPosition = useRef(false);
  const followLatest = useRef(true);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const [partialTurns, setPartialTurns] = useState<{ id: string; conversationId: string; question: string; answer: string; status: string; afterMessageCount: number; startedAt: number }[]>([]);
  const [streamUnsupported, setStreamUnsupported] = useState(false);
  const [ordinaryResponse, setOrdinaryResponse] = useState(false);
  useEffect(() => {
    if (!unified || !persistenceActive || !preferenceError) return;
    markWorkspacePersistencePending(workspaceId, preferenceError === "read" ? "chat-preferences-recovery" : "chat-preferences", preferenceError === "read" ? "无法恢复聊天草稿；本页修改尚未保存。" : "聊天草稿尚未保存，请重试。");
  }, [persistenceActive, preferenceError, unified, workspaceId]);
  const restorePreferences = useCallback((stored?: unknown) => {
    const parsed = desktopPreferences ? parseChatPreferences(stored) : null;
    const saved = parsed ? (parsed.success ? { ok: true as const, value: parsed.data } : { ok: false as const }) : readChatPreferences(uiKey);
    if (!saved.ok) { preferencesReady.current = false; setPreferenceError("read"); return null; }
    // A retry may restore the initial draft, but never replace input accepted
    // while either the preference read or workspace read was unavailable.
    if (!preferencesReady.current && !draftTouched.current) {
      const restoredDraft = typeof saved.value.draft === "string" ? saved.value.draft : "";
      questionRef.current = restoredDraft;
      setQuestionValue(restoredDraft);
    }
    if (desktopPreferences) { confirmedPreferences.current = JSON.stringify(saved.value); pendingPreferenceSignature.current = ""; }
    preferenceBaseline.current = saved.value;
    if (unified && persistenceActive) {
      if (draftTouched.current && questionRef.current !== (typeof saved.value.draft === "string" ? saved.value.draft : "")) markWorkspacePersistencePending(workspaceId, "chat-preferences", "草稿仅在内存中，正在等待保存。");
      acknowledgeWorkspacePersistenceKey(workspaceId, "chat-preferences-recovery");
    }
    preferencesReady.current = true;
    setPreferenceError(null);
    return saved.value;
  }, [desktopPreferences, persistenceActive, uiKey, unified, workspaceId]);
  const savePreferences = useCallback((selectedId: string, top: number) => {
    if (!persistenceActive || !preferencesReady.current || storageBusy || loadedSessionKeyRef.current !== sessionKey) return;
    const value: ChatPreferences = { ...preferenceBaseline.current, version: 1, activeId: selectedId, draft: questionRef.current, scrollTop: Math.max(0, top) };
    if (!desktopPreferences) {
      try { localStorage.setItem(uiKey, JSON.stringify(value)); acknowledgeWorkspacePersistenceKey(workspaceId, "chat-preferences"); setPreferenceError(null); }
      catch { setPreferenceError("write"); }
      return;
    }
    const signature = JSON.stringify(value);
    if ((!pendingPreferenceSignature.current && signature === confirmedPreferences.current) || signature === pendingPreferenceSignature.current) return;
    const sequence = ++preferenceSequence.current;
    const generation = getQuestionConversationGeneration(workspaceId);
    pendingPreferenceSignature.current = signature;
    const pending = enqueueWorkspacePersistence(workspaceId, async () => {
      if (sequence !== preferenceSequence.current || generation !== getQuestionConversationGeneration(workspaceId)) return { skipped: true };
      await localWorkspaceProvider.saveChatPreferences({ repositoryId: repository.id, workspaceId, persistenceSessionId: repository.persistenceSessionId }, value);
      if (generation !== getQuestionConversationGeneration(workspaceId) || currentWorkspaceIdRef.current !== sessionKey) return;
      confirmedPreferences.current = signature;
      if (sequence === preferenceSequence.current) { pendingPreferenceSignature.current = ""; setPreferenceError(null); }
    }, { key: "chat-preferences" });
    pendingPreferenceSave.current = pending;
    void pending.catch(() => {
      if (sequence === preferenceSequence.current && generation === getQuestionConversationGeneration(workspaceId) && currentWorkspaceIdRef.current === sessionKey) {
        pendingPreferenceSignature.current = ""; setPreferenceError("write");
      }
    });
  }, [desktopPreferences, persistenceActive, repository.id, repository.persistenceSessionId, sessionKey, storageBusy, uiKey, workspaceId]);
  const startPreviewRef = useRef<(question?: string, files?: string[]) => Promise<PreviewState | undefined>>(async () => undefined);
  const [preparingSend, setPreparingSend] = useState(false);
  const sendPreparationBusy = useRef(false);
  const sendPreparationSequence = useRef(0);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [manualFileIds, setManualFileIds] = useState<string[]>([]);
  const [explicitSelection, setExplicitSelection] = useState(false);
  const [stage, setStage] = useState<"idle" | "previewing" | "scope" | "ready" | "generating" | "error">("idle");
  const [message, setMessage] = useState("");
  const [readWarning, setReadWarning] = useState("");
  const readWarningRef = useRef("");
  const [previewState, setPreviewState] = useState<PreviewState | null>(null);
  const [candidates, setCandidates] = useState<AiScopeCandidate[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [ranges, setRanges] = useState<Record<string, AiLineRange>>({});
  const [evidence, setEvidence] = useState<{ messageId: string; referenceIndex: number; fileId: string; startLine: number; source: string; status: "loading" | "loaded" | "error"; error?: string } | null>(null);
  const evidenceSequence = useRef(0);
  const evidenceController = useRef<AbortController | null>(null);
  const evidenceTrigger = useRef<HTMLElement | null>(null);
  const requestSequence = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  const activeRequestContext = useRef("");
  const loadRequestSequence = useRef(0);
  const clearVersionRef = useRef(clearVersion);
  const invalidateRequest = useCallback(() => {
    sendPreparationSequence.current += 1;
    sendPreparationBusy.current = false;
    setPreparingSend(false);
    generatingRef.current = false;
    requestSequence.current += 1;
    requestController.current?.abort();
    requestController.current = null;
    activeRequestContext.current = "";
  }, []);
  const contextKey = `${workspaceId}:${repository.revision ?? repository.version}:${currentFile.id}`;
  const visiblePreviewState = previewState?.contextKey === contextKey ? previewState : null;
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
    readWarningRef.current = "";
    setReadWarning("");
    try {
      let saved: Awaited<ReturnType<typeof localWorkspaceProvider.get>>;
      for (;;) {
        const readVersion = getQuestionConversationReadVersion(workspaceId);
        try { saved = await localWorkspaceProvider.get(workspaceId); }
        catch (error) {
          if (loadRequestSequence.current !== requestId || getQuestionConversationGeneration(workspaceId) !== recoveryGeneration) return;
          if (readVersion !== getQuestionConversationReadVersion(workspaceId)) continue;
          throw error;
        }
        if (loadRequestSequence.current !== requestId || getQuestionConversationGeneration(workspaceId) !== recoveryGeneration) return;
        if (readVersion === getQuestionConversationReadVersion(workspaceId)) break;
        // A save or server-confirmed answer completed after this GET began.
        // Re-read the complete disk baseline, including conversations we had
        // not loaded yet, instead of overwriting it with the older response.
      }
      if (saved.persistenceReady === false) throw new Error(saved.warning ?? "本地保存数据尚未成功读取。");
      const restored = saved.conversations.filter(validConversation).map((item) => ({ ...item, messages: item.messages.map((entry) => ({ ...entry })) }));
      const next = restoreQuestionConversations(workspaceId, restored);
      loadedSessionKeyRef.current = sessionKey;
      let selectedId = next[0]?.id ?? "";
      const ui = restorePreferences(saved.chatPreferences);
      if (ui) {
        if (typeof ui.activeId === "string" && next.some((item) => item.id === ui.activeId)) selectedId = ui.activeId;
        if (!hasScrollPosition.current && Object.hasOwn(ui, "scrollTop") && (!desktopPreferences || saved.chatPreferences != null)) {
          scrollPosition.current = Number(ui.scrollTop) || 0;
          hasScrollPosition.current = true;
        }
      }
      setConversations(next); setActiveId(current => next.some(item => item.id === current) ? current : selectedId); setLoadedSessionKey(sessionKey); setFailedRepositoryId("");
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
  }, [desktopPreferences, persistConversations, sessionKey, workspaceId, restorePreferences]);

  useEffect(() => {
    if (!desktopPreferences || !persistenceActive) return;
    const flush = async () => {
      if (!preferencesReady.current || loadedSessionKeyRef.current !== sessionKey || storageBusy) {
        if (draftTouched.current) throw new Error("草稿尚未保存，请先重试草稿保存再离开。");
        return;
      }
      savePreferences(activeId, scrollPosition.current);
      await pendingPreferenceSave.current;
      const expected = JSON.stringify({ ...preferenceBaseline.current, version: 1, activeId, draft: questionRef.current, scrollTop: Math.max(0, scrollPosition.current) });
      if (expected !== confirmedPreferences.current) throw new Error("草稿尚未保存，请先重试草稿保存再离开。");
    };
    return registerChatPreferenceFlush(flush, async () => {
      if (!preferencesReady.current || loadedSessionKeyRef.current !== sessionKey) await loadWorkspace();
      await flush();
    });
  }, [loadWorkspace, activeId, desktopPreferences, persistenceActive, savePreferences, sessionKey, storageBusy]);

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
  const applyChatIntent = useEffectEvent((next: ChatIntent) => {
    if (next.sessionId && next.sessionId !== repository.persistenceSessionId) return;
    invalidateRequest(); setMode(next.mode); setRefinement(null); setPreviewState(null); setStage("idle");
    if (next.investigation) applyInvestigationIntent(next.investigation); else clearInvestigationIntent();
    if (next.draft !== undefined) setQuestion(next.draft);
    if (next.attachments) attachContext(next.attachments);
    requestAnimationFrame(() => document.getElementById(questionInputId)?.focus());
  });
  useEffect(() => { if (unified && intent && !generatingRef.current) applyChatIntent(intent); }, [intent, unified]);
  useEffect(() => {
    if (!unified || loadedSessionKey !== sessionKey) return;
    savePreferences(activeId, scrollPosition.current);
  }, [unified, activeId, question, loadedSessionKey, sessionKey, savePreferences]);
  useEffect(() => {
    const area = transcriptRef.current;
    if (!active || loadedSessionKey !== sessionKey || !area) return;
    area.scrollTop = hasScrollPosition.current ? scrollPosition.current : area.scrollHeight;
    scrollPosition.current = area.scrollTop;
    followLatest.current = area.scrollHeight - area.scrollTop - area.clientHeight < 64;
    setAwayFromBottom(!followLatest.current);
  }, [active, loadedSessionKey, sessionKey]);

  useEffect(() => {
    if (!unified || !active || loadedSessionKey !== sessionKey || !followLatest.current) return;
    const frame = requestAnimationFrame(() => {
      const area = transcriptRef.current;
      if (area && followLatest.current) area.scrollTop = area.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [unified, active, loadedSessionKey, sessionKey, stage, conversations, partialTurns]);
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
    preferenceSequence.current += 1;
    confirmedPreferences.current = ""; pendingPreferenceSignature.current = ""; pendingPreferenceSave.current = Promise.resolve();
    draftTouched.current = false; scrollPosition.current = 0; hasScrollPosition.current = false;
    preferencesReady.current = true;
    preferenceBaseline.current = {};
    setPreferenceError(null);
    conversationSaveAttempt.current = null;
    invalidateRequest();
    const view = getQuestionConversationView(workspaceId);
    loadedSessionKeyRef.current = sessionKey;
    // The storage clear controller has already invalidated and emptied this workspace.
    setSelectedFiles([]); setManualFileIds([]); setExplicitSelection(false); setScopeOpen(false); setRanges({});
    setConversations(view); setActiveId(view[0]?.id ?? ""); setLoadedSessionKey(sessionKey); setPartialTurns([]);
    setFailedRepositoryId(""); setSaveError(null); setQuestion(""); setPreviewState(null); setCandidates([]); setStage("idle"); setMessage(""); readWarningRef.current = ""; setReadWarning("");
  }, [clearVersion, sessionKey, workspaceId, invalidateRequest, setQuestion]);

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
    setQuestion(priorQuestion);
    setPreviewState(null); setCandidates([]); setStage("idle");
    setMessage("选择要补充的源码，然后重新预览。确认前不会发送内容。");
  };

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

  const taskEntryId = refinement?.route?.entryFileId ?? currentFile.id;
  const startPreview = async (questionText = question, fileIds?: string[]) => {
    if (refinement && !questionText.trim()) return;
    if (refinement && isStale(refinement)) { setStage("error"); setMessage("原结果引用的源码已变化，请重新核对后再调整。"); return; }
    if (unified && mode !== "question" && explicitSelection && !fileIds?.length) { setPreviewState(null); setStage("error"); setMessage("请添加至少一个源码文件。"); return; }
    if (unified && fileIds && fileIds.length > 12) { setPreviewState(null); setStage("scope"); setScopeOpen(true); setMessage("最多发送 12 个文件，请移除多余附件。"); return; }
    if (Object.entries(attachmentHashes).some(([id, hash]) => selectedFiles.includes(id) && filesById.get(id)?.contentHash !== hash)) { setMessage("附件源码已变化，请移除旧附件后重新选择。"); setStage("error"); return; }
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
        ? await localExplanationProvider.previewInvestigation(repository, currentFile.id, trimmed, fileIds, ranges, excludedInvestigationFiles, controller.signal, refinement?.investigation ? { original: refinement.investigation, instruction: questionText } : undefined)
        : mode === "question"
        ? await localExplanationProvider.previewQuestion(repository, currentFile.id, trimmed, history, requestedFileIds, ranges, controller.signal, unified)
        : await localExplanationProvider.preview(repository, taskEntryId, mode, requestedFileIds, undefined, ranges, controller.signal, mode === "route" ? (refinement ? "调整已有阅读路线" : questionText.trim()) : undefined, refinement?.route ? { original: refinement.route, instruction: questionText } : undefined);
      if (requestSequence.current !== id) return;
      if (value.scopeRequired) {
        const preferred = new Set([...(fileIds ?? []), ...(fileIds === undefined ? additionalFileIds : [])]);
        const chosen = [...new Set([...selectedFiles, ...preferred])].filter((fileId) => value.candidates.some((candidate) => candidate.fileId === fileId));
        const sourceFreeConversation = unified && mode === "question" && fileIds?.length === 0;
        const defaultSelection = sourceFreeConversation ? [] : (mode === "question" || mode === "investigation")
          ? chosen.length ? chosen : value.candidates.slice(0, Math.min(12, value.candidates.length)).map((candidate) => candidate.fileId)
          : [currentFile.id, ...chosen.filter((fileId) => fileId !== currentFile.id)].slice(0, 12);
        const nextRanges = Object.fromEntries(value.candidates.map((candidate) => [candidate.fileId, ranges[candidate.fileId] ?? candidate.suggestedRange ?? { startLine: 1, endLine: candidate.lineCount }]));
        setExplicitSelection(true); setCandidates(value.candidates); setSelectedFiles(defaultSelection); setRanges(nextRanges); setStage("scope"); setScopeOpen(true);
        setMessage(value.blockers?.includes("ambiguous_definition") ? "找到多个可能相关的定义，可选择范围后发送。" : value.blockers?.includes("character_limit") ? sourceFreeConversation ? "问题和历史消息超过 60,000 字符，请在上下文中减少携带的历史消息。" : "发送内容超过 60,000 字符。请缩小行范围或移除文件。" : value.retrievalInsufficient ? "自动检索没有找到足够依据。请手动选择与问题相关的文件；最多 12 个文件、总发送内容 60,000 字符。" : "候选源码超出发送范围上限，请选择文件并调整行范围。未发送任何源码。");
      } else if (value.preview.retrievalInsufficient && !fileIds?.length && !(unified && mode === "question")) {
        setStage("error"); setMessage("没有找到足够的源码依据，请添加相关文件后再发送。");
      } else {
        const prepared = { preview: value.preview, question: trimmed, history, contextKey };
        setPreviewState(prepared); setStage("ready"); setMessage("");
        return prepared;
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
    if (!unified || !active || storageBusy || !backendAvailable || !modelSettings?.configured || generatingRef.current || sendPreparationBusy.current || stage === "scope") return;
    const timer = window.setTimeout(() => { if (question.trim() || mode !== "question") void startPreviewRef.current(undefined, explicitSelection ? selectedFiles : undefined); }, 300);
    return () => window.clearTimeout(timer);
    // Stage changes must not schedule another preview; edits and task ownership do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unified, active, storageBusy, backendAvailable, modelSettings, question, mode, contextKey, excludedHistory, additionalFileIds, loadedSessionKey, activeId, ranges, selectedFiles, explicitSelection, stage === "generating"]);

  const cancel = () => {
    generatingRef.current = false;
    invalidateRequest();
    setPartialTurns((turns) => turns.map((turn) => turn.status === "generating" || turn.status === "repairing" || turn.status === "validating" ? { ...turn, status: "incomplete" } : turn));
    setPreviewState(null); setStage("idle"); setMessage(unified ? "已停止，本次请求不再继续。" : "已取消；没有发送未确认的内容。");
  };
  const confirmAndGenerate = async (prepared?: PreviewState) => {
    const state = prepared ?? visiblePreviewState;
    if ((!prepared && stage !== "ready") || !state || generatingRef.current || state.preview.repositoryId !== repository.id || state.preview.revision !== repository.revision || state.preview.entryFileId !== taskEntryId) return;
    if (state.preview.expiresAt <= Date.now()) { setPreviewState(null); setStage("idle"); void startPreview(); return; }
    const id = ++requestSequence.current;
    const controller = new AbortController(); requestController.current = controller;
    activeRequestContext.current = contextKey;
    setStage("generating"); setMessage(""); setStreamUnsupported(false);
    generatingRef.current = true;
    generationSessionRef.current = sessionKey;
    const completionIds = { conversationId: activeId || crypto.randomUUID(), userMessageId: crypto.randomUUID(), answerMessageId: crypto.randomUUID() };
    if (unified) {
      setActiveId(completionIds.conversationId); setQuestion(current => current.trim() === state.question.trim() || mode !== "question" ? "" : current); followLatest.current = true; setAwayFromBottom(false);
      setPartialTurns((turns) => [...turns, { id: completionIds.answerMessageId, conversationId: completionIds.conversationId, question: state.question, answer: "", status: "generating", afterMessageCount: displayMessages.length, startedAt: Date.now() }]);
    }
    const generation = getQuestionConversationGeneration(workspaceId);
    const investigationEpoch = getInvestigationEpoch(workspaceId);
    const originalInvestigation = refinement?.investigation ? refinementBaseline : null;
    const investigationAtSend = activeInvestigation;
    const investigationExclusions = [...excludedInvestigationFiles];
    try {
      const response: AiGenerationResult = unified ? await generateChatStream(state.preview, controller.signal, completionIds, (event) => {
        if (requestSequence.current !== id || generation !== getQuestionConversationGeneration(workspaceId)) return;
        setPartialTurns((turns) => turns.map((turn) => turn.id !== completionIds.answerMessageId ? turn : { ...turn, answer: event.type === "text" ? turn.answer + event.text : event.type === "replace" ? event.text ?? "" : turn.answer, status: event.status ?? turn.status }));
      }, !ordinaryResponse) : await localExplanationProvider.generate(state.preview, controller.signal);
      if (requestSequence.current !== id || generation !== getQuestionConversationGeneration(workspaceId) || response.repositoryId !== repository.id || response.revision !== repository.revision || response.mode !== state.preview.mode) return;
      const result = response.result;
      if (originalInvestigation && state.preview.mode === "investigation") setRefinementOrigins(previous => ({ ...previous, [completionIds.answerMessageId]: { id: originalInvestigation.id, fingerprint: JSON.stringify(originalInvestigation) } }));
      const contextFiles = state.preview.files.map(({ fileId, contentHash, startLine, endLine }) => ({ fileId, contentHash, startLine, endLine }));
      const userMessage: QaMessage = { id: crypto.randomUUID(), role: "user", content: state.question, references: [], contextFiles };
      const answerMessage: QaMessage = {
        id: crypto.randomUUID(), role: "assistant", content: String(result.answer ?? ""),
        references: Array.isArray(result.references) ? result.references as QaReference[] : [], contextFiles,
        claims: Array.isArray(result.claims) ? result.claims as { text: string; referenceIndices: number[] }[] : undefined,
        insufficientEvidence: result.insufficientEvidence === true,
      };
      const completion = unified ? buildAiChatCompletion({ ...state.preview, ...(refinement ? { refinement: { instruction: state.question } } : {}), sources: state.preview.files, question: state.question, excludedFileIds: state.preview.excludedFileIds ?? investigationExclusions }, result, completionIds) : null;
      const messages: QaMessage[] = completion ? (completion.messages as QaMessage[]).map(message => message.route ? { ...message, routePersisted: response.routePersisted } : message) as QaMessage[] : [userMessage, answerMessage];
      const titleSource = completion ? messages[0]?.content ?? state.question : state.question;
      const nextId = completionIds.conversationId;
      const latestConversations: QaConversation[] = getQuestionConversationView(workspaceId);
      const existing = latestConversations.find((item) => item.id === nextId);
      // A workspace read can already contain this server-persisted completion.
      // The completion IDs are shared with the server, so merge rather than append.
      const mergedMessages = [...new Map([...(existing?.messages ?? []), ...messages].map(entry => [entry.id, entry])).values()];
      const next: QaConversation = existing
        ? { ...existing, messages: mergedMessages, updatedAt: Date.now() }
        : { id: nextId, title: titleSource.slice(0, 48), messages, updatedAt: Date.now() };
      const updatedConversations = [next, ...latestConversations.filter((item) => item.id !== nextId)];
      setConversations(updatedConversations);
      // Persist before the user can switch tabs and unmount this panel; a debounced
      // effect alone can be cancelled by the unmount immediately after an answer.
      if (unified && response.chatPersisted) restoreQuestionConversations(workspaceId, updatedConversations);
      else persistConversations(updatedConversations);
      if (response.warning && !(response.chatPersisted && response.routePersisted === false)) setSaveError({ sessionKey, message: response.warning });
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
      setRefinement(null); setActiveId(nextId); if (!unified) setQuestion(""); setPreviewState(null); setStage("idle");
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

  const sendChat = async (questionText = question) => {
    if (generatingRef.current || sendPreparationBusy.current || storageBusy || !backendAvailable || !modelSettings?.configured) return;
    if (mode === "question" && !questionText.trim()) return;
    if (stage === "ready" && visiblePreviewState && visiblePreviewState.preview.expiresAt > Date.now() && (mode !== "question" || visiblePreviewState.question === questionText.trim())) {
      await confirmAndGenerate(); return;
    }
    const sequence = ++sendPreparationSequence.current;
    sendPreparationBusy.current = true; setPreparingSend(true);
    try {
      const prepared = await startPreview(questionText, explicitSelection ? selectedFiles : undefined);
      if (sendPreparationSequence.current !== sequence || !prepared) return;
      sendPreparationBusy.current = false; setPreparingSend(false);
      await confirmAndGenerate(prepared);
    } finally {
      if (sendPreparationSequence.current === sequence) { sendPreparationBusy.current = false; setPreparingSend(false); }
    }
  };

  const createConversation = () => {
    const latest = getQuestionConversationView(workspaceId);
    if (latest.length >= MAX_CONVERSATIONS) { setMessage(CONVERSATION_CAPACITY_MESSAGE); return; }
    cancel(); setRefinement(null); setActiveInvestigation(null); setExcludedInvestigationFiles([]); setExplicitSelection(false); setSelectedFiles([]); setRanges({});
    const next = { id: crypto.randomUUID(), title: "新对话", messages: [], updatedAt: Date.now() };
    const updatedConversations = [next, ...latest];
    setConversations(updatedConversations); persistConversations(updatedConversations); setActiveId(next.id); setMessage("");
  };
  const deleteConversation = () => {
    if (!currentConversation) return;
    cancel(); setActiveInvestigation(null); setExcludedInvestigationFiles([]);
    const remaining = visibleConversations.filter((item) => item.id !== currentConversation.id);
    setConversations(remaining); persistConversations(remaining); setActiveId(remaining[0]?.id ?? ""); setMessage("已删除此问答会话。");
  };
  const changeQuestion = (value: string) => { setQuestion(value); if (!generatingRef.current) { invalidateRequest(); setPreviewState(null); if (stage !== "scope") setStage("idle"); } };


  const chooseTask = (next: AiMode) => {
    if (generatingRef.current || sendPreparationBusy.current) return;
    invalidateRequest(); setRefinementBaseline(null); setRefinement(null); setMode(next); setActiveInvestigation(null); setExcludedInvestigationFiles([]); setPreviewState(null); setStage("idle"); setMessage("");
    if (next !== "question" && next !== "investigation" && explicitSelection && !selectedFiles.includes(currentFile.id)) setSelectedFiles([currentFile.id, ...selectedFiles]);
  };
  const editAsQuestion = (text: string) => {
    if (generatingRef.current || sendPreparationBusy.current || storageBusy) return;
    chooseTask("question"); setQuestion(text);
    requestAnimationFrame(() => document.getElementById(questionInputId)?.focus());
  };
  const attachmentIds = explicitSelection ? selectedFiles : visiblePreviewState?.preview.files.map(file => file.fileId) ?? (mode !== "question" ? [currentFile.id] : []);
  const changeAttachments = (ids: string[], manualId?: string) => {
    if (generatingRef.current || sendPreparationBusy.current || storageBusy) return;
    invalidateRequest(); setPreviewState(null); setSelectedFiles(ids); setExplicitSelection(true);
    setAttachmentHashes(previous => ({ ...Object.fromEntries(Object.entries(previous).filter(([id]) => ids.includes(id) && id !== manualId)), ...(manualId ? { [manualId]: filesById.get(manualId)?.contentHash ?? "" } : {}) }));
    if (manualId) setManualFileIds(previous => [...new Set([...previous, manualId])]);
    if (!ids.length) { setStage("idle"); setMessage(""); }
    else { if (stage !== "scope") setStage("idle"); setMessage(""); }
  };
  const [attachmentConflict, setAttachmentConflict] = useState<ChatAttachment[] | null>(null);
  const [attachmentHashes, setAttachmentHashes] = useState<Record<string, string>>({});
  const attachContext = (items: ChatAttachment[], replace = false) => {
    if (generatingRef.current || storageBusy) return;
    if (items.some(item => !filesById.has(item.fileId) || filesById.get(item.fileId)?.contentHash !== item.contentHash)) { setMessage("源码已变化，请重新选择代码。"); return; }
    if (!replace && items.some(item => ranges[item.fileId] && JSON.stringify(ranges[item.fileId]) !== JSON.stringify(item.startLine ? { startLine: item.startLine, endLine: item.endLine } : undefined))) { setAttachmentConflict(items); return; }
    invalidateRequest(); setPreviewState(null); setExplicitSelection(true);
    setSelectedFiles(previous => [...new Set([...previous, ...items.map(item => item.fileId)])]);
    setManualFileIds(previous => [...new Set([...previous, ...items.map(item => item.fileId)])]);
    setRanges(previous => { const next = { ...previous }; for (const item of items) { if (item.startLine && item.endLine) next[item.fileId] = { startLine: item.startLine, endLine: item.endLine }; else delete next[item.fileId]; } return next; });
    setAttachmentHashes(previous => ({ ...previous, ...Object.fromEntries(items.map(item => [item.fileId, item.contentHash])) }));
    setAttachmentConflict(null); setStage("idle"); setMessage("");
  };
  const continueInvestigation = (record: import("@/data/model").Investigation) => {
    chooseTask("investigation"); setActiveInvestigation(record); setExcludedInvestigationFiles(record.excludedFileIds);
    setQuestion(`${record.question}\n继续调查：${record.questions.map(item => item.question).join("；")}`.slice(0, 12000));
    const ids = [...new Set([...record.contextFiles.map(file => file.fileId), ...record.questions.map(item => item.suggestedFileId).filter((id): id is string => Boolean(id))])].filter(id => filesById.has(id) && !record.excludedFileIds.includes(id));
    setSelectedFiles(ids); setExplicitSelection(ids.length > 0); setRanges({}); setScopeOpen(true);
  };
  const refineResult = (entry: QaMessage) => {
    if (isStale(entry)) { setMessage("源码已变化，请先重新核对结果。"); return; }
    const baseline = entry.investigation ? getInvestigationState(workspaceId).records.find(item => item.id === (investigationDrafts[entry.id]?.id ?? entry.id)) ?? null : null;
    chooseTask(entry.route ? "route" : "investigation"); setRefinementBaseline(baseline); setRefinement(entry); setQuestion("");
    const exclusions = baseline?.excludedFileIds ?? entry.excludedFileIds ?? [];
    setExcludedInvestigationFiles(exclusions);
    const contexts = (baseline?.contextFiles ?? entry.contextFiles).filter(item => !exclusions.includes(item.fileId));
    setSelectedFiles(contexts.map(item => item.fileId)); setExplicitSelection(true);
    setRanges(Object.fromEntries(contexts.filter(item => item.startLine && item.endLine).map(item => [item.fileId, { startLine: item.startLine!, endLine: item.endLine! }])));
    requestAnimationFrame(() => document.getElementById(questionInputId)?.focus());
  };
  const renderMessage = (entry: QaMessage) => {
    if (entry.investigation) {
      const saved = investigationCollection.records.find(item => item.id === (investigationDrafts[entry.id]?.id ?? entry.id));
      const record = saved ?? investigationDrafts[entry.id] ?? { ...createInvestigation({ result: entry.investigation, question: entry.investigationQuestion ?? priorQuestionByMessage.get(entry.id) ?? "调查代码", repository, contextFiles: entry.contextFiles.map(item => ({ ...item, startLine: item.startLine ?? 1, endLine: item.endLine ?? 1 })), excludedFileIds: entry.excludedFileIds ?? [], id: entry.id }), selectionReasons: entry.selectionReasons };
      return <article className="question-message is-assistant" key={entry.id}><strong>调查结果</strong><button type="button" onClick={() => onShowGraph?.(entry.contextFiles.filter(item => filesById.has(item.fileId)).map(item => item.fileId))}>在图谱中查看相关文件</button><button type="button" disabled={storageBusy || stage === "generating"} onClick={() => refineResult(entry)}>调整这份结果</button>{investigationNotices[entry.id] && <p role="status">{investigationNotices[entry.id]}</p>}<InvestigationCard record={record} repository={repository} busy={storageBusy || stage === "generating"} onChange={next => { setInvestigationDrafts(previous => ({ ...previous, [entry.id]: next })); if (saved) changeInvestigation(workspaceId, next); }} onOpen={onOpenReference} onEvidence={(fileId, line) => { const index = entry.references.findIndex(ref => ref.fileId === fileId && ref.startLine === line); if (index >= 0) void showEvidence(entry, entry.references[index], index); }} onRelations={onRelations} onContinue={continueInvestigation}/>
      {refinementOrigins[entry.id] && <button type="button" disabled={storageBusy || isStale(entry)} onClick={() => {
        const origin = refinementOrigins[entry.id]; const latest = getInvestigationState(workspaceId).records.find(item => item.id === origin.id);
        if (!latest || JSON.stringify(latest) !== origin.fingerprint) { setInvestigationNotices(previous => ({ ...previous, [entry.id]: "原调查已修改或删除。请重新调整，或将此结果另存调查。" })); return; }
        changeInvestigation(workspaceId, replaceInvestigationResult(latest, record));
        setRefinementOrigins(previous => { const next = { ...previous }; delete next[entry.id]; return next; });
        setInvestigationNotices(previous => ({ ...previous, [entry.id]: "新结果已应用，人工核对状态已重置。落盘结果请查看保存状态。" }));
      }}>应用到原调查</button>}
      {evidence?.messageId === entry.id && <ChatEvidence evidence={evidence} onClose={() => setEvidence(null)} onOpen={onOpenReference}/>}
      <button type="button" disabled={storageBusy || Boolean(saved)} onClick={() => { if (getInvestigationState(workspaceId).records.length >= 100) { setMessage("每个工作区最多保存 100 条调查。"); return; } setInvestigationDrafts(previous => ({ ...previous, [entry.id]: record })); changeInvestigation(workspaceId, record); }}>{saved ? "已加入调查记录" : "保存调查"}</button><small>保存后，修改会自动写入；保存结果请查看全局状态。</small></article>;
    }
    return <ChatMessage onShowGraph={onShowGraph} onRefine={refineResult} key={entry.id} entry={entry} stale={isStale(entry)} busy={stage === "generating" || storageBusy} evidence={evidence} onEvidence={(item, reference, index) => { void showEvidence(item, reference, index); }} onCloseEvidence={() => { evidenceSequence.current++; evidenceController.current?.abort(); setEvidence(null); evidenceTrigger.current?.focus(); }} onOpen={onOpenReference} onEdit={editAsQuestion} onSupplement={beginSupplement} onTour={onActivateTour} routeSaved={Boolean(entry.route && savedTourSignatures.includes(entry.route.signature))} onSaveTour={onSaveTour}/>;
  };
  const renderPartial = (turn: (typeof partialTurns)[number]) => (<div className="chat-pending-turn" key={turn.id}><article className="question-message is-user"><div className="question-message-heading"><strong>你</strong></div><ChatMarkdown text={turn.question}/></article><article className="question-message is-assistant" aria-busy={turn.status!=="incomplete"}><div className="question-message-heading"><strong>RepoLens</strong><span>{turn.status==="incomplete"?"未完成":turn.status==="repairing"?"正在修正回答格式…":turn.status==="validating"?"正在核对引用…":"正在回答…"}</span></div>{turn.answer ? <ChatMarkdown text={turn.answer}/> : <span className="chat-typing" aria-label="正在生成">···</span>}{turn.status==="incomplete"&&<button className="question-retry" type="button" onClick={()=>{setMode("question");setQuestion(turn.question);setMessage("");}}>继续这次提问</button>}</article></div>);

  return <section className="copilot-chat question-panel" aria-label="源码问答">
    <ChatToolbar conversations={[...partialTurns.filter(turn => turn.status !== "incomplete" && !visibleConversations.some(item => item.id === turn.conversationId)).map(turn => ({ id: turn.conversationId, title: turn.question.slice(0, 48), messages: [], updatedAt: turn.startedAt })), ...visibleConversations]} activeId={activeId} generatingId={partialTurns.find(turn => turn.status !== "incomplete")?.conversationId} busy={storageBusy} onNew={createConversation} onSelect={id => { cancel(); setRefinement(null); setActiveInvestigation(null); setExcludedInvestigationFiles([]); setExplicitSelection(false); setSelectedFiles([]); setRanges({}); setActiveId(id); setMessage(""); }} onDelete={deleteConversation} onClose={onCloseChat}/>
    <div className="chat-persistence-status" aria-live="polite">
      {preferenceError && <div role="alert">{preferenceError === "read" ? "无法读取上次的草稿和聊天位置；本页修改仅在内存中。" : "草稿和聊天位置尚未保存到本机，可以继续输入。"}<button type="button" disabled={storageBusy} onClick={() => { if (desktopPreferences) void loadWorkspace(); else if (restorePreferences()) savePreferences(activeId, scrollPosition.current); }}>重试草稿保存</button></div>}
      {saveError?.sessionKey === sessionKey && <div role="alert">对话尚未保存：{saveError.message}<button type="button" onClick={() => persistConversations(conversations, false, true)}>重试保存</button></div>}
      {failedRepositoryId === workspaceId && <div role="alert">无法读取已保存的问答记录。本页修改尚未保存，原记录不会被覆盖。<button type="button" onClick={() => { void loadWorkspace(); }}>重试读取问答记录</button></div>}
      {readWarning && <div role="status">本地保存提示：{readWarning}<button type="button" onClick={() => { void loadWorkspace(); }}>重试读取</button><button type="button" onClick={() => { readWarningRef.current = ""; setReadWarning(""); persistConversations(conversations, false, true); }}>仍然保存</button></div>}
      {storageBusy && <div role="status">正在清除数据，聊天操作已暂停。</div>}
    </div>
    <div className="copilot-transcript" ref={transcriptRef} role="log" aria-label="聊天消息" aria-live="polite" onScroll={event => { const element=event.currentTarget; hasScrollPosition.current=true; scrollPosition.current=element.scrollTop; followLatest.current=element.scrollHeight-element.scrollTop-element.clientHeight<64; setAwayFromBottom(!followLatest.current); savePreferences(activeId, element.scrollTop); }}>
      {!displayMessages.length && !partialTurns.some(turn=>turn.conversationId===activeId) && <div className="copilot-empty"><h3>有什么想问的？</h3><p>可以直接聊天，也可以一起看代码。</p><div><button type="button" onClick={()=>chooseTask("explanation")}>讲解当前文件</button><button type="button" onClick={()=>chooseTask("route")}>规划阅读路线</button></div></div>}
      {Array.from({length:displayMessages.length+1},(_,index)=><Fragment key={index}>{partialTurns.filter(turn=>turn.conversationId===activeId&&turn.afterMessageCount===index).map(renderPartial)}{displayMessages[index]&&renderMessage(displayMessages[index])}</Fragment>)}

    {!backendAvailable && <p role="alert" className="question-feedback">本地服务已停止，请重启 RepoLens 后再试。</p>}
    </div>
      {message && failedRepositoryId !== workspaceId && !readWarning && <div className="chat-inline-feedback" role={stage==="error"?"alert":"status"}>{message}{streamUnsupported&&<button type="button" onClick={()=>{setOrdinaryResponse(true);setStreamUnsupported(false);setQuestion(partialTurns.at(-1)?.question || "");setStage("idle");setMessage("已选择普通响应，请重新发送。");}}>使用普通响应</button>}</div>}
    <ChatRetrieval active={active} key={`${sessionKey}:${activeId}`} repository={repository} question={question} disabled={storageBusy || stage === "generating" || !modelSettings?.configured} clearVersion={clearVersion} onAttach={attachContext}/>
    {refinement && <div className="chat-inline-feedback">正在调整：{refinement.route?.title ?? "调查结果"}<button type="button" onClick={() => { setRefinement(null); chooseTask("question"); }}>取消调整</button></div>}
    {attachmentConflict && <div role="alert" className="chat-inline-feedback">该文件已有不同的发送范围。<button type="button" onClick={() => attachContext(attachmentConflict, true)}>替换范围</button><button type="button" onClick={() => setAttachmentConflict(null)}>保留原范围</button></div>}
    <ChatComposer files={repository.files} onAttach={attachContext} onNew={createConversation} id={questionInputId} value={question} mode={mode} target={currentFile.path} generating={stage === "generating" || preparingSend} disabled={!backendAvailable || storageBusy || preparingSend} ready={(!refinement || !!question.trim()) && !streamUnsupported && stage !== "scope" && (mode === "explanation" || mode === "route" || !!question.trim())} configured={modelSettings?.configured} model={modelSettings?.model} away={awayFromBottom}
      onLatest={() => { followLatest.current = true; setAwayFromBottom(false); if (transcriptRef.current) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight; }}
      onChange={changeQuestion} onMode={chooseTask} onSettings={onOpenSettings} onSend={() => { void sendChat(); }} onStop={cancel}
      status={preparingSend ? "正在准备发送…" : stage === "previewing" ? "正在整理上下文…" : stage === "scope" ? "请调整发送范围" : !modelSettings?.configured ? "设置模型后即可提问" : undefined}
      context={<ChatContextPicker open={scopeOpen} onOpenChange={setScopeOpen} files={repository.files} currentId={taskEntryId} required={mode !== "question" && mode !== "investigation"} selected={attachmentIds} manualIds={[...manualFileIds, ...additionalFileIds]} preview={visiblePreviewState?.preview} candidates={candidates} ranges={ranges} busy={stage === "generating" || preparingSend || storageBusy}
        selectionMode={mode === "question" ? explicitSelection ? selectedFiles.length ? "manual" : "none" : "auto" : undefined}
        onContextMode={automatic => { if (generatingRef.current || sendPreparationBusy.current || storageBusy) return; invalidateRequest(); setExplicitSelection(!automatic); setSelectedFiles([]); setManualFileIds([]); setRanges({}); setPreviewState(null); setScopeOpen(false); setStage("idle"); setMessage(""); }}
        history={mode === "question" ? displayMessages.filter(entry => !isStale(entry)).slice(-6).map(entry => ({ ...entry, selected: !excludedHistory.includes(entry.id) })) : []}
        characters={visiblePreviewState?.preview.characters} endpoint={visiblePreviewState?.preview.baseUrl || modelSettings?.baseUrl}
        onSelect={changeAttachments} onRange={(id, range) => { setAttachmentHashes(previous => ({ ...previous, [id]: filesById.get(id)?.contentHash ?? "" })); invalidateRequest(); setSelectedFiles(attachmentIds); setExplicitSelection(true); setPreviewState(null); setRanges(previous => ({ ...previous, [id]: range })); if (stage !== "scope") setStage("idle"); }}
        onHistory={(id, checked) => { invalidateRequest(); setPreviewState(null); setExcludedHistory(previous => checked ? previous.filter(item => item !== id) : [...previous, id]); setStage("idle"); }}
        needsApply={stage === "scope"} onApply={() => { setScopeOpen(false); setExplicitSelection(true); void startPreview(question, selectedFiles); }}/>} />
  </section>;

}
