import { useCallback, useRef, useState } from "react";
import { localWorkspaceProvider, isWorkspaceCopyCleanupPending } from "@/data/providers";
import { markWorkspacePersistencePending, acknowledgeWorkspaceCopyCleanup, getKnownWorkspacePersistenceIds } from "@/data/workspace-persistence.mjs";
import { clearAllQuestionConversations, clearQuestionConversationWorkspace } from "@/data/question-recovery.mjs";
import { clearInvestigationMemory, invalidateInvestigationTasks, knownInvestigationWorkspaces } from "@/data/investigation-state.mjs";
import { createReadingArtifactJournal } from "@/data/reading-artifact-journal.mjs";
import { DEFAULT_WORKSPACE_LAYOUT } from "@/data/workspace-layout.mjs";
import { createDefaultUsageGuidePreferences } from "@/data/usage-guide.mjs";
import { nodePositionSessionKey, workspaceSession } from "@/hooks/useRepositorySession";
import { WORKSPACE_LAYOUT_STORAGE_KEY } from "@/hooks/useWorkspaceLayout";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { AiResultRecord } from "@/components/repolens/AiResultView";
import type { AiRouteRecord, ReadingNote } from "@/data/model";
import type { ReadingArtifactJournal } from "@/data/reading-artifact-journal.mjs";
import { stageBrowserProgressClear, USAGE_GUIDE_STORAGE_KEY } from "@/data/browser-workspace";
import type { UseWorkspacePersistenceOptions } from "./useWorkspacePersistence";

type WorkspaceClearOptions = Pick<UseWorkspacePersistenceOptions,
  "desktopMode" |
  "dirtyNodePositions" |
  "guideNavigationRef" |
  "guidePreferencesRef" |
  "guideSaveSequenceRef" |
  "guideTourPracticeRef" |
  "guideWriteQueueRef" |
  "nodePositionsPersisted" |
  "onSetRepoMessage" |
  "progressMemory" |
  "repoBusy" |
  "repository" |
  "setBrowserLayoutSaveError" |
  "setBrowserProgressSaveFailures" |
  "setCompletedSteps" |
  "setGuideNoticeAvailable" |
  "setGuidePanelOpen" |
  "setGuidePreferences" |
  "setGuideStorageMessage" |
  "setNodePositions" |
  "setRecentRepositories" |
  "setShowGuideWelcome" |
  "setTourIndex" |
  "setTourVisibilityOverride" |
  "setWorkspaceLayoutPreferences" |
  "setWorkspaceLayoutReady" |
  "workspaceId" |
  "workspaceLayoutInitializedRef"
> & {
  readingNotesRef: RefObject<Map<string, ReadingNote[]>>;
  savedToursRef: RefObject<Map<string, AiRouteRecord[]>>;
  savedDataClearBusy: boolean;
  savedDataClearActiveRef: RefObject<boolean>;
  savedDataClearGenerationRef: RefObject<number>;
  setSavedDataClearGeneration: Dispatch<SetStateAction<number>>;
  setSavedDataClearBusy: Dispatch<SetStateAction<boolean>>;
  setAiResultsByFile: Dispatch<SetStateAction<Map<string, AiResultRecord>>>;
  setAiRoutesByRepository: Dispatch<SetStateAction<Map<string, AiRouteRecord>>>;
  setReadingNotesByWorkspace: Dispatch<SetStateAction<Map<string, ReadingNote[]>>>;
  setSavedToursByWorkspace: Dispatch<SetStateAction<Map<string, AiRouteRecord[]>>>;
  readingArtifactJournals: RefObject<Map<string, ReadingArtifactJournal<ReadingNote, AiRouteRecord>>>;
};

export function useWorkspaceClear({
  desktopMode, dirtyNodePositions, guideNavigationRef, guidePreferencesRef, guideSaveSequenceRef,
  guideTourPracticeRef, guideWriteQueueRef, nodePositionsPersisted, onSetRepoMessage,
  progressMemory, readingArtifactJournals, readingNotesRef, repoBusy, repository,
  savedDataClearActiveRef, savedDataClearBusy, savedDataClearGenerationRef, savedToursRef, setAiResultsByFile,
  setAiRoutesByRepository, setBrowserLayoutSaveError, setBrowserProgressSaveFailures, setCompletedSteps, setGuideNoticeAvailable,
  setGuidePanelOpen, setGuidePreferences, setGuideStorageMessage, setNodePositions, setReadingNotesByWorkspace,
  setRecentRepositories, setSavedDataClearBusy, setSavedDataClearGeneration, setSavedToursByWorkspace, setShowGuideWelcome,
  setTourIndex, setTourVisibilityOverride, setWorkspaceLayoutPreferences, setWorkspaceLayoutReady, workspaceId,
  workspaceLayoutInitializedRef,
}: WorkspaceClearOptions) {
  const [questionClearVersion, setQuestionClearVersion] = useState(0);
  const [chatClearingTarget, setChatClearingTarget] = useState<string | null>(null);
  const [chatClearVersions, setChatClearVersions] = useState<Record<string, number>>({});
  const [chatClearAllVersion, setChatClearAllVersion] = useState(0);

  const pendingClearScope = useRef<"all" | "current">("all");
  const pendingClearWorkspace = useRef(workspaceId);
  const [clearRetryPending, setClearRetryPending] = useState(false);

  const copyCleanupBusyRef = useRef(false);
  const retryCopyCleanup = useCallback(async (scope: "all" | "current") => {
    if (copyCleanupBusyRef.current) return;
    copyCleanupBusyRef.current = true;
    setClearRetryPending(false);
    try {
      const result = scope === "all" ? await localWorkspaceProvider.clearAll() : await localWorkspaceProvider.clearRepository(workspaceSession(repository));
      const warning = result.ok ? "" : result.warning ?? "保存副本未能清理，请重试。";
      acknowledgeWorkspaceCopyCleanup(scope === "all" ? [...new Set([...getKnownWorkspacePersistenceIds(), ...knownInvestigationWorkspaces(), ...readingNotesRef.current.keys(), ...savedToursRef.current.keys(), workspaceId])] : [workspaceId], warning);
      setClearRetryPending(!result.ok);
      onSetRepoMessage(warning || "剩余保存副本已清理，新阅读记录已保留。");
    } catch (error) {
      setClearRetryPending(true);
      onSetRepoMessage(`保存副本清理未完成，新阅读记录已保留：${error instanceof Error ? error.message : "请重试。"}`);
    } finally { copyCleanupBusyRef.current = false; }
  }, [repository, workspaceId, onSetRepoMessage, readingNotesRef, savedToursRef]);

  const clearCurrentSavedData = useCallback(async () => {
    if (copyCleanupBusyRef.current) return;
    if (!desktopMode || repository.id === "sample-loading" || (savedDataClearBusy && !clearRetryPending) || repoBusy) return;
    if (isWorkspaceCopyCleanupPending(workspaceSession(repository))) return retryCopyCleanup("current");
    savedDataClearActiveRef.current = true;
    savedDataClearGenerationRef.current += 1;
    setSavedDataClearGeneration(savedDataClearGenerationRef.current);
    setSavedDataClearBusy(true);
    invalidateInvestigationTasks(workspaceId);
    setChatClearingTarget(workspaceId);
    pendingClearScope.current = "current";
    pendingClearWorkspace.current = workspaceId;
    setClearRetryPending(false);
    let preserveMemory = false;
    let clearWarning = "";
    let clearUnknown = false;
    try {
      await clearQuestionConversationWorkspace(workspaceId, async () => {
        const restoreBrowserProgress = stageBrowserProgressClear(workspaceId);
        try {
          const result = await localWorkspaceProvider.clearRepository(workspaceSession(repository));
          clearWarning = result.warning ?? "";
          preserveMemory = Boolean(result.preserveMemory);
          if (preserveMemory) restoreBrowserProgress();
          return { ...result, ok: result.ok || result.cleared?.workspace === true };
        } catch (error) {
          restoreBrowserProgress();
          throw error;
        }
      });
      if (preserveMemory) { setClearRetryPending(Boolean(clearWarning)); onSetRepoMessage(clearWarning || "剩余保存副本已清理，新阅读记录已保留。"); return; }
      clearInvestigationMemory(workspaceId);
      setAiResultsByFile((previous) => new Map([...previous].filter(([key]) => !key.startsWith(`${workspaceId}:`))));
      setAiRoutesByRepository((previous) => {
        const next = new Map(previous);
        next.delete(workspaceId);
        return next;
      });
      setReadingNotesByWorkspace((previous) => {
        const next = new Map(previous);
        next.delete(workspaceId);
        readingNotesRef.current = next;
        return next;
      });
      setSavedToursByWorkspace((previous) => {
        const next = new Map(previous);
        next.delete(workspaceId);
        savedToursRef.current = next;
        return next;
      });
      readingArtifactJournals.current.set(workspaceId, createReadingArtifactJournal<ReadingNote, AiRouteRecord>());
      setNodePositions((previous) => new Map([...previous].filter(([key]) => !key.startsWith(`${workspaceId}:`))));
      nodePositionsPersisted.current.delete(nodePositionSessionKey(repository));
      dirtyNodePositions.current.delete(workspaceId);
      for (const key of progressMemory.keys()) {
        if (key.startsWith(`repolens:${workspaceId}:`)) progressMemory.delete(key);
      }
      setTourIndex(0);
      setCompletedSteps([]);
      setTourVisibilityOverride(null);
      setQuestionClearVersion((value) => value + 1);
      setRecentRepositories((previous) =>
        previous.filter((item) => (item.workspaceId ?? item.id) !== workspaceId)
      );
      setChatClearVersions((previous) => ({ ...previous, [workspaceId]: (previous[workspaceId] ?? 0) + 1 }));
      setClearRetryPending(Boolean(clearWarning));
      if (clearWarning) markWorkspacePersistencePending(workspaceId, "clear-copies", clearWarning);
      onSetRepoMessage(clearWarning || "已清除此仓库的问答、阅读记录、生成结果、进度和图谱位置。");
    } catch (error) {
      setClearRetryPending(true);
      clearUnknown = Boolean((error as { clearUnknown?: boolean }).clearUnknown);
      onSetRepoMessage(`无法清除此仓库的保存数据：${error instanceof Error ? error.message : "本地存储不可用。"}`);
    } finally {
      savedDataClearActiveRef.current = clearUnknown;
      setSavedDataClearBusy(clearUnknown);
      setChatClearingTarget(null);
    }
  }, [
    retryCopyCleanup,
    clearRetryPending,
    desktopMode,
    dirtyNodePositions,
    nodePositionsPersisted,
    onSetRepoMessage,
    progressMemory,
    repoBusy,
    repository,
    savedDataClearBusy,
    setCompletedSteps,
    setNodePositions,
    setRecentRepositories,
    setTourIndex,
    setTourVisibilityOverride,
    workspaceId,
    savedDataClearActiveRef,
    savedDataClearGenerationRef,
    setSavedDataClearGeneration,
    setSavedDataClearBusy,
    setAiResultsByFile,
    setAiRoutesByRepository,
    setReadingNotesByWorkspace,
    setSavedToursByWorkspace,
    readingArtifactJournals,
    readingNotesRef,
    savedToursRef,
  ]);

  const clearAllSavedData = useCallback(async () => {
    if ((savedDataClearBusy && !clearRetryPending) || repoBusy) return;
    if (copyCleanupBusyRef.current) return;
    if (isWorkspaceCopyCleanupPending()) return retryCopyCleanup("all");
    savedDataClearActiveRef.current = true;
    savedDataClearGenerationRef.current += 1;
    setSavedDataClearGeneration(savedDataClearGenerationRef.current);
    setSavedDataClearBusy(true);
    for (const id of knownInvestigationWorkspaces()) invalidateInvestigationTasks(id);
    setChatClearingTarget("*");
    guideSaveSequenceRef.current += 1;
    await guideWriteQueueRef.current;
    pendingClearScope.current = "all";
    setClearRetryPending(false);
    let preserveMemory = false;
    let clearUnknown = false;
    try {
      let guideClearWarning = "";
      let backendClearWarning = "";
      await clearAllQuestionConversations(
        async () => {
          const restoreBrowserProgress = stageBrowserProgressClear();
          try {
            const result = await localWorkspaceProvider.clearAll();
            backendClearWarning = result.warning ?? "";
            guideClearWarning = backendClearWarning;
            preserveMemory = Boolean(result.preserveMemory);
            if (preserveMemory) restoreBrowserProgress();
            return { ...result, ok: result.ok || result.cleared?.workspace === true };
          } catch (error) {
            restoreBrowserProgress();
            throw error;
          }
        },
        [workspaceId]
      );
      if (preserveMemory) { setClearRetryPending(Boolean(guideClearWarning)); onSetRepoMessage(guideClearWarning || "剩余保存副本已清理，新阅读记录已保留。"); return; }
      if (!desktopMode) {
        try {
          window.localStorage.removeItem(USAGE_GUIDE_STORAGE_KEY);
          window.localStorage.removeItem(WORKSPACE_LAYOUT_STORAGE_KEY);
          setGuideStorageMessage("");
        } catch (error) {
          guideClearWarning = `应用数据已清除，但浏览器未允许移除部分偏好设置：${
            error instanceof Error ? error.message : "存储不可用。"
          }`;
        }
      }
      setChatClearAllVersion((value) => value + 1);
      for (const id of knownInvestigationWorkspaces()) clearInvestigationMemory(id);
      setRecentRepositories([]);
      setAiResultsByFile(new Map());
      setAiRoutesByRepository(new Map());
      setReadingNotesByWorkspace(new Map());
      readingNotesRef.current = new Map();
      setSavedToursByWorkspace(new Map());
      savedToursRef.current = new Map();
      setNodePositions(new Map());
      readingArtifactJournals.current.clear();
      progressMemory.clear();
      nodePositionsPersisted.current.clear();
      dirtyNodePositions.current.clear();
      setTourIndex(0);
      setCompletedSteps([]);
      setTourVisibilityOverride(null);
      setQuestionClearVersion((value) => value + 1);
      setClearRetryPending(Boolean(guideClearWarning));
      if (guideClearWarning) markWorkspacePersistencePending(workspaceId, "clear-copies", guideClearWarning);
      onSetRepoMessage(guideClearWarning || "已清除全部 RepoLens 本地保存数据。");
      setWorkspaceLayoutPreferences(DEFAULT_WORKSPACE_LAYOUT);
      workspaceLayoutInitializedRef.current = true;
      setWorkspaceLayoutReady(true);
      setBrowserLayoutSaveError("");
      setBrowserProgressSaveFailures(new Set());
      const freshGuide = createDefaultUsageGuidePreferences();
      guidePreferencesRef.current = freshGuide;
      setGuidePreferences(freshGuide);
      setShowGuideWelcome(true);
      setGuidePanelOpen(false);
      setGuideNoticeAvailable(false);
      setGuideStorageMessage(guideClearWarning === backendClearWarning ? "" : guideClearWarning);
      guideTourPracticeRef.current = null;
      guideNavigationRef.current = null;
    } catch (error) {
      setClearRetryPending(true);
      clearUnknown = Boolean((error as { clearUnknown?: boolean }).clearUnknown);
      onSetRepoMessage(`无法清除全部保存数据：${error instanceof Error ? error.message : "本地存储不可用。"}`);
    } finally {
      savedDataClearActiveRef.current = clearUnknown;
      setSavedDataClearBusy(clearUnknown);
      setChatClearingTarget(null);
    }
  }, [
    retryCopyCleanup,
    clearRetryPending,
    desktopMode,
    dirtyNodePositions,
    guideNavigationRef,
    guidePreferencesRef,
    guideSaveSequenceRef,
    guideTourPracticeRef,
    guideWriteQueueRef,
    nodePositionsPersisted,
    onSetRepoMessage,
    progressMemory,
    repoBusy,
    savedDataClearBusy,
    setBrowserLayoutSaveError,
    setBrowserProgressSaveFailures,
    setCompletedSteps,
    setGuideNoticeAvailable,
    setGuidePanelOpen,
    setGuidePreferences,
    setGuideStorageMessage,
    setNodePositions,
    setRecentRepositories,
    setShowGuideWelcome,
    setTourIndex,
    setTourVisibilityOverride,
    setWorkspaceLayoutPreferences,
    setWorkspaceLayoutReady,
    workspaceId,
    workspaceLayoutInitializedRef,
    savedDataClearActiveRef,
    savedDataClearGenerationRef,
    setSavedDataClearGeneration,
    setSavedDataClearBusy,
    setAiResultsByFile,
    setAiRoutesByRepository,
    setReadingNotesByWorkspace,
    readingNotesRef,
    setSavedToursByWorkspace,
    savedToursRef,
    readingArtifactJournals,
  ]);

  return { questionClearVersion, chatClearingTarget, chatClearVersions, chatClearAllVersion,
    clearCurrentSavedData, clearAllSavedData, clearRetryPending,
    retrySavedDataClear: () => {
      if (pendingClearScope.current === "current" && pendingClearWorkspace.current !== workspaceId) { onSetRepoMessage("请先返回未完成清除的仓库，再重试。"); return; }
      return pendingClearScope.current === "all" ? clearAllSavedData() : clearCurrentSavedData();
    },
  };
}
