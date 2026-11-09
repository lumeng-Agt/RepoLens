"use client";
import { flushChatPreferences, retryChatPreferences } from "@/data/chat-preference-lifecycle.mjs";
import type { ChatIntent } from "@/components/repolens/chat-intent";

import {
  MarkerType,
  ReactFlowProvider,
  type Edge,
  type ReactFlowInstance,
  useNodesState,
} from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import { separateOverlappingGraphNodes } from "@/data/graph-layout.mjs";
import { getReadingTourStatus } from "@/data/reading-route-state.mjs";
import {
  BookOpenText,
  ArrowLeft,
  ArrowRight,
  Folder,
  GitBranch,
  ListTree,
  Search,
  Waypoints,
  BookOpen,
  ChevronDown,
  Settings2,
  MessageSquare,
} from "lucide-react";
import { InvestigationPanel } from "@/components/repolens/InvestigationPanel";
import { clearInvestigationMemory, invalidateInvestigationTasks, knownInvestigationWorkspaces, registerInvestigationSession, restoreInvestigations, failInvestigationRead } from "@/data/investigation-state.mjs";
import { WorkspaceOverview } from "@/components/repolens/WorkspaceOverview";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useLayoutEffect,
} from "react";
import { localRepositoryProvider, localWorkspaceProvider, sampleRepositoryProvider, type LocalWorkspaceState, type RepositoryCommand, type WorkspaceSession } from "@/data/providers";
import { localExplanationProvider, type AiLineRange, type AiMode, type AiScopeCandidate } from "@/data/explanation-provider";
import { aiWorkflowReducer, initialAiWorkflowState } from "@/data/ai-workflow.mjs";
import { aiContextIsStale, aiResultIsStale } from "@/data/ai-result.mjs";
import { createAiRouteRecord } from "@/data/ai-route.mjs";
import { createRepositorySessionGate } from "@/data/repository-session.mjs";
import { createOpenRequestGate } from "@/data/open-request-gate.mjs";
import type { AiResultRecord } from "@/components/repolens/AiResultView";
import { TourBar } from "@/components/repolens/TourBar";
import { GraphPanel, type GraphNode } from "@/components/repolens/GraphPanel";
import { DirectoryPanel } from "@/components/repolens/DirectoryPanel";
import { FileDetailsPanel } from "@/components/repolens/FileDetailsPanel";
import { AiChatSidebar } from "@/components/repolens/AiChatSidebar";
import { parseTourProgress } from "@/data/tour-progress.mjs";
import { createProgressSessionGate } from "@/data/progress-session.mjs";
import { clearAllQuestionConversations, clearQuestionConversationWorkspace } from "@/data/question-recovery.mjs";
import { enqueueWorkspacePersistence } from "@/data/workspace-persistence.mjs";
import { acknowledgeReadingArtifactJournal, applyReadingArtifactJournal, createReadingArtifactJournal, hasReadingArtifactOperations, readingArtifactJournalCheckpoint, stageReadingArtifactChanges, type ReadingArtifactJournal } from "@/data/reading-artifact-journal.mjs";
import { useWorkspacePersistenceStatus } from "@/data/useWorkspacePersistenceStatus";
import { emptyNavigationHistory, moveNavigationHistory, pushNavigationHistory } from "@/data/navigation-history.mjs";
import { initialNavigationState, navigationReducer, type StateUpdate } from "@/data/navigation-state.mjs";
import { QuickOpenDialog } from "@/components/repolens/QuickOpenDialog";
import { UsageGuideNotice, UsageGuidePanel } from "@/components/repolens/UsageGuide";
import { RepositoryHome } from "@/components/repolens/RepositoryHome";
import { ModelSettingsDialog } from "@/components/repolens/ModelSettingsDialog";
import { useModelSettings } from "@/hooks/useModelSettings";
import { useWorkspacePersistence } from "@/hooks/useWorkspacePersistence";
import { completeUsageGuideTask, createDefaultUsageGuidePreferences, hasExistingBrowserUse, hasExistingWorkspaceUse, normalizeUsageGuidePreferences, type UsageGuidePreferences, type UsageGuideTaskId } from "@/data/usage-guide.mjs";
import { afterLayoutMeasurements, DEFAULT_WORKSPACE_LAYOUT, normalizeWorkspaceLayout, updateWorkspaceLayout, workspaceInnerLayout, workspaceOuterLayout } from "@/data/workspace-layout.mjs";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import type { GroupImperativeHandle } from "react-resizable-panels";
import type {
  FileRecord,
  AiPreview,
  RepositorySnapshot,
  ReadingNote,
  SourceReference,
  AiRouteRecord,
  TourStep,
} from "@/data/model";
import {
  useRepositorySession,
  BOOT_SNAPSHOT,
  repositoryWorkspaceId,
  repositoryOpenErrorMessage,
  nodePositionSessionKey,
  nodePositionSignature,
  workspaceSession,
} from "@/hooks/useRepositorySession";
import { useGraphCoordinates, layoutGraph } from "@/hooks/useGraphCoordinates";
import { useWorkspaceLayout, WORKSPACE_LAYOUT_STORAGE_KEY, WORKSPACE_LAYOUT_PERSISTENCE_ID } from "@/hooks/useWorkspaceLayout";
import "@xyflow/react/dist/style.css";

type MobileView = "files" | "graph" | "details";
const progressMemory = new Map<string, string>();
const USAGE_GUIDE_STORAGE_KEY = "repolens:usage-guide:v1";

function routeSignature(tour: TourStep[]) {
  const value = JSON.stringify(tour.map((step) => [step.title, step.focusFileId, step.description, step.reference.fileId, step.reference.line, step.reference.endLine ?? null]));
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(36);
}
function progressKey(repository: RepositorySnapshot, tour: TourStep[], stableRouteSignature?: string) { return `repolens:${repositoryWorkspaceId(repository)}:${repository.source === "sample" ? repository.version : stableRouteSignature ?? routeSignature(tour)}`; }

function readTourProgress(key: string) {
  const memoryValue = progressMemory.get(key);
  if (memoryValue !== undefined) return memoryValue;
  try {
    const stored = window.localStorage.getItem(key);
    if (stored) return stored;
  } catch {
    // Some embedded browser previews disable localStorage; keep a same-origin cookie fallback.
  }
  const cookieKey = key.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
  const cookie = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${cookieKey}=`));
  if (cookie) return decodeURIComponent(cookie.slice(cookieKey.length + 1));
  return null;
}

function readBrowserUsageGuide() {
  try {
    const raw = window.localStorage.getItem(USAGE_GUIDE_STORAGE_KEY);
    let stored: unknown = null;
    if (raw !== null) stored = JSON.parse(raw);
    const keys = Array.from({ length: window.localStorage.length }, (_, index) => window.localStorage.key(index) ?? "");
    return { available: true, present: raw !== null, stored, existingUse: hasExistingBrowserUse(keys) };
  } catch (error) {
    return { available: false, present: false, stored: null, existingUse: false, message: error instanceof Error ? error.message : "浏览器本地存储不可用。" };
  }
}

function writeTourProgress(key: string, value: string) {
  progressMemory.set(key, value);
  try {
    window.localStorage.setItem(key, value);
    if (window.localStorage.getItem(key) === value) return true;
  } catch {
    // Fall through to a same-origin cookie when localStorage is unavailable.
  }
  const cookieKey = key.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
  try {
    document.cookie = `${cookieKey}=${encodeURIComponent(value)}; Path=/; Max-Age=31536000; SameSite=Lax`;
    const cookie = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${cookieKey}=`));
    return cookie?.slice(cookieKey.length + 1) === encodeURIComponent(value);
  } catch { return false; }
}

function traceProgress(event: string, key: string, generation: number, details: Record<string, string | number | null> = {}) {
  if (typeof window === "undefined" || new URLSearchParams(window.location.search).get("repolensDebugProgress") !== "1") return;
  window.dispatchEvent(new CustomEvent("repolens:progress-trace", { detail: { event, key, generation, ...details, at: performance.now() } }));
}

const EMPTY_FILE: FileRecord = { id: "", path: "", name: "没有源码文件", kind: "typescript", role: "空仓库", summary: "添加 JS/TS 源码后重新扫描。", imports: [] };

function AppShell() {
  useEffect(() => window.repoLens?.onBeforeClose?.(() => flushChatPreferences()), []);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatGraphTarget, setChatGraphTarget] = useState("");
  const [chatGraphIds, setChatGraphIds] = useState<string[]>([]);
  const [chatIntent, setChatIntent] = useState<ChatIntent>({ id: 0, mode: "question" });
  const openAiChat = useCallback((mode: AiMode = "question") => { setChatOpen(true); setChatIntent((previous) => ({ id: previous.id + 1, mode })); }, []);
  const [navigation, dispatchNavigation] = useReducer(navigationReducer, initialNavigationState);
  const restoreWorkspaceStateRef = useRef<(snapshot: RepositorySnapshot, saved: LocalWorkspaceState) => string | undefined>(() => undefined);
  const onSnapshotAppliedRef = useRef<(snapshot: RepositorySnapshot) => void>(() => {});
  const onUpdatedSnapshotAppliedRef = useRef<(snapshot: RepositorySnapshot) => void>(() => {});
  const { selectedFileId, tourIndex, focusedLine, focusOrigin, focusRouteSignature, completedSteps, graphDirectory } = navigation;
  const setSelectedFileId = useCallback((value: StateUpdate<string>) => dispatchNavigation({ type: "select", value }), []);
  const setTourIndex = useCallback((value: StateUpdate<number>) => dispatchNavigation({ type: "tour", value }), []);
  const setFocusedLine = useCallback((value: StateUpdate<SourceReference | null>) => dispatchNavigation({ type: "reference", value }), []);
  const setCompletedSteps = useCallback((value: StateUpdate<string[]>) => dispatchNavigation({ type: "completed", value }), []);
  const setGraphDirectory = useCallback((value: string) => dispatchNavigation({ type: "directory", value }), []);
  const [detailTab, setDetailTab] = useState("guide");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchQuestionScope, setSearchQuestionScope] = useState<{ workspaceId: string; fileIds: string[] }>({ workspaceId: "", fileIds: [] });
  const [quickOpen, setQuickOpen] = useState(false);
  const [layoutMode, setLayoutMode] = useState<"structure" | "reading">("structure");
  const [browserProgressSaveFailures, setBrowserProgressSaveFailures] = useState(new Set<string>());
  const tourToggleButtonRef = useRef<HTMLButtonElement>(null);
  const wasTourBarVisibleRef = useRef(false);
  const [tourVisibilityOverride, setTourVisibilityOverride] = useState<{ signature: string; open: boolean } | null>(null);
  const [navigationHistory, setNavigationHistory] = useState(emptyNavigationHistory);
  const [desktopMode] = useState(() => Boolean(globalThis.__REPOLENS_RUNTIME__?.desktop));
  const [guidePreferences, setGuidePreferences] = useState<UsageGuidePreferences>(() => createDefaultUsageGuidePreferences());
  const guidePreferencesRef = useRef(guidePreferences);
  const [guideReady, setGuideReady] = useState(false);
  const guidePersistenceAllowedRef = useRef(false);
  const [guideStorageMessage, setGuideStorageMessage] = useState("");
  const [showGuideWelcome, setShowGuideWelcome] = useState(true);
  const [guidePanelOpen, setGuidePanelOpen] = useState(false);
  const [guideNoticeAvailable, setGuideNoticeAvailable] = useState(false);
  const [guideRepoRequest, setGuideRepoRequest] = useState(0);
  const guideButtonRef = useRef<HTMLButtonElement>(null);
  const repositoryMenuRef = useRef<HTMLDetailsElement>(null);
  const guideInitializedRef = useRef(false);
  const guideSaveSequenceRef = useRef(0);
  const guideWriteQueueRef = useRef<Promise<void>>(Promise.resolve());
  const guideTourPracticeRef = useRef<{ workspaceId: string; sessionVersion: number; origin: { fileId: string; line?: number }; destination: { fileId: string; line: number }; visited: boolean; returned: boolean } | null>(null);
  const guideNavigationRef = useRef<{ repositoryId: string; sessionVersion: number; fileId: string; dependency: boolean } | null>(null);
  const savedDataClearActiveRef = useRef(false);
  const [savedDataClearBusy, setSavedDataClearBusy] = useState(false);
  const [workspacePersistenceReadyKeys, setWorkspacePersistenceReadyKeys] = useState(new Set<string>());
  const [workspaceReadFailures, setWorkspaceReadFailures] = useState(new Set<string>());
  const [nodePositionsReadyKey, setNodePositionsReadyKey] = useState<string | null>(null);
  const [aiWorkflow, dispatchAiWorkflow] = useReducer(aiWorkflowReducer, initialAiWorkflowState);
  const handleDispatchAiMessage = useCallback((message: string) => dispatchAiWorkflow({ type: "message", message }), []);

  const {
    repository,
    setRepository,
    recentRepositories,
    setRecentRepositories,
    repoPath,
    setRepoPath,
    repoBusy,
    setRepoBusy,
    repoMessage,
    setRepoMessage,
    desktopBackendError,
    repositorySessionVersion,
    setRepositorySessionVersion,
    repositoryGate,
    repositoryReads,
    beginRepositorySession,
    applySnapshot,
    applyUpdatedSnapshot,
    openRepositoryPath,
    openRepository,
    closeRepository,
    closeRepositoryRef,
    cancelPendingRepositoryOpen,
    rescanRepository,
    removeRecentRepository,
    nextRepositoryCommand,
    isCurrentRepositoryCommand,
  } = useRepositorySession({
    desktopMode,
    savedDataClearBusy,
    isSavedDataClearBusy: () => savedDataClearActiveRef.current,
    onClearAiContext: () => clearAiContext(),
    onSnapshotApplied: (snapshot) => onSnapshotAppliedRef.current(snapshot),
    onUpdatedSnapshotApplied: (snapshot) => onUpdatedSnapshotAppliedRef.current(snapshot),
    onRestoreWorkspaceState: (snapshot, saved) => restoreWorkspaceStateRef.current(snapshot, saved),
    onGuideTaskCompleted: (task) => completeGuideTask(task),
    onCloseGuidePanel: () => {
      setShowGuideWelcome(false);
      setGuidePanelOpen(false);
      updateGuidePreferences((p) => ({ ...p, welcomeHandled: true, checklistOpen: false, noticeDismissed: true }));
      setGuideNoticeAvailable(false);
    },
    onLoadSampleStart: () => {
      setSearchQuery("");
      setCollapsedFolders([]);
      setTourIndex(0);
      setCompletedSteps([]);
      setFocusedLine(null);
      setShowAllGraph(false);
      setGraphDirectory("");
      setDetailTab("guide");
      setMobileView("graph");
    },
    workspacePersistenceReadyKeys,
    setWorkspacePersistenceReadyKeys,
    setWorkspaceReadFailures,
    setNodePositionsReadyKey,
    onDispatchAiMessage: handleDispatchAiMessage,
  });
  const questionExtraFileIds = searchQuestionScope.workspaceId === repositoryWorkspaceId(repository) ? searchQuestionScope.fileIds : [];
  const [loadedSource, setLoadedSource] = useState<{ fileId: string; repositoryId: string; revision?: string; text: string } | null>(null);
  const [sourceLoad, setSourceLoad] = useState<{ key: string; status: "loading" | "loaded" | "error"; message?: string } | null>(null);

  const { aiMessage, pendingAiMode, aiPreview, aiCandidates, selectedAiFiles, selectedAiRanges } = {
    aiMessage: aiWorkflow.message,
    pendingAiMode: ["ready", "error"].includes(aiWorkflow.status) && aiWorkflow.candidates.length ? aiWorkflow.mode as AiMode : null,
    aiPreview: aiWorkflow.preview as AiPreview | null,
    aiCandidates: aiWorkflow.candidates as AiScopeCandidate[],
    selectedAiFiles: aiWorkflow.selectedFiles as string[],
    selectedAiRanges: aiWorkflow.ranges as Record<string, AiLineRange>,
  };
  const aiBusy = aiWorkflow.status === "previewing" || aiWorkflow.status === "generating";
  const aiRequestSequence = useRef(0);
  const aiAbortController = useRef<AbortController | null>(null);
  const aiContextRef = useRef("");
  const clearAiContext = useCallback((preserveScope?: boolean) => {
    const requestId = ++aiRequestSequence.current;
    dispatchAiWorkflow({ type: "invalidate", requestId, preserveScope });
    const controller = aiAbortController.current;
    aiAbortController.current = null;
    controller?.abort();
  }, []);
  const {
    modelSettingsOpen,
    openModelSettingsDialog,
    closeModelSettingsDialog,
    aiSettingsDraft,
    aiSettingsSaved,
    aiSettingsDirty,
    aiSettingsFeedback,
    aiSettingsBusy,
    aiSettingsRevision,
    currentAiSettingsReadError,
    currentAiSettingsSaveError,
    aiSettings,
    editAiSettings,
    saveAiSettings,
  } = useModelSettings({
    repositoryId: repository.id,
    repositorySource: repository.source,
    repositorySessionVersion,
    onClearAiContext: clearAiContext,
    onDispatchAiMessage: (message) => dispatchAiWorkflow({ type: "message", message }),
  });
  const persistGuidePreferences = useCallback((preferences: UsageGuidePreferences): Promise<boolean> => {
    if (!guidePersistenceAllowedRef.current) return Promise.resolve(false);
    if (!desktopMode) {
      try {
        window.localStorage.setItem(USAGE_GUIDE_STORAGE_KEY, JSON.stringify(preferences));
        setGuideStorageMessage("");
        return Promise.resolve(true);
      } catch (error) {
        guidePersistenceAllowedRef.current = false;
        setGuideStorageMessage(`无法保存使用指南进度；本次仅在当前页面保留：${error instanceof Error ? error.message : "浏览器存储不可用。"}`);
        return Promise.resolve(false);
      }
    }
    const requestId = ++guideSaveSequenceRef.current;
    const operation = guideWriteQueueRef.current.then(async () => {
      if (requestId !== guideSaveSequenceRef.current) return;
      await localWorkspaceProvider.saveGuidePreferences(preferences);
    });
    guideWriteQueueRef.current = operation.catch(() => undefined);
    return operation.then(() => {
      if (requestId === guideSaveSequenceRef.current) setGuideStorageMessage("");
      return true;
    }).catch((error: Error) => {
      if (requestId === guideSaveSequenceRef.current) setGuideStorageMessage(`无法保存使用指南进度；本次仅在当前页面保留：${error.message}`);
      return false;
    });
  }, [desktopMode]);
  const updateGuidePreferences = useCallback((value: UsageGuidePreferences | ((current: UsageGuidePreferences) => UsageGuidePreferences)) => {
    const next = typeof value === "function" ? value(guidePreferencesRef.current) : value;
    guidePreferencesRef.current = next;
    setGuidePreferences(next);
    if (guideReady) void persistGuidePreferences(next);
    return next;
  }, [guideReady, persistGuidePreferences]);
  const initializeGuidePreferences = useCallback((stored: unknown, present: boolean, hasExistingUse: boolean, storageReady: boolean, warning?: string) => {
    if (guideInitializedRef.current) return;
    guideInitializedRef.current = true;
    const normalized = present ? normalizeUsageGuidePreferences(stored) : null;
    const invalidStoredValue = present && !normalized;
    const blocked = !storageReady || invalidStoredValue;
    let next = normalized ?? createDefaultUsageGuidePreferences();
    if (blocked) {
      next = { ...createDefaultUsageGuidePreferences(), welcomeHandled: true, noticeDismissed: true };
      setGuideStorageMessage(warning ?? (invalidStoredValue ? "无法读取使用指南进度。本次修改未保存，原记录未被覆盖。" : "无法读取已保存的使用指南进度。本次修改未保存。"));
    } else if (!present && hasExistingUse) {
      next = { ...next, welcomeHandled: true, noticeDismissed: false };
      setGuideNoticeAvailable(true);
    }
    guidePreferencesRef.current = next;
    setGuidePreferences(next);
    guidePersistenceAllowedRef.current = !blocked;
    setShowGuideWelcome(true);
    setGuideNoticeAvailable(next.welcomeHandled && !next.noticeDismissed);
    setGuidePanelOpen(false);
    setGuideReady(true);
    if (!blocked && !present && hasExistingUse) void persistGuidePreferences(next);
  }, [persistGuidePreferences]);
  const completeGuideTask = useCallback((task: UsageGuideTaskId) => {
    updateGuidePreferences((previous) => completeUsageGuideTask(previous, task));
  }, [updateGuidePreferences]);
  const settingsSessionRef = useRef({ repositoryId: repository.id, sessionVersion: repositorySessionVersion });
  useEffect(() => { settingsSessionRef.current = { repositoryId: repository.id, sessionVersion: repositorySessionVersion }; }, [repository.id, repositorySessionVersion]);
  const [mobileView, setMobileView] = useState<MobileView>("graph");
  const [narrowLayout, setNarrowLayout] = useState(false);
  const [workspaceViewportWidth, setWorkspaceViewportWidth] = useState(0);
  const tourStepsRef = useRef<HTMLDivElement>(null);
  const [collapsedFolders, setCollapsedFolders] = useState<string[]>([]);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [showAllGraph, setShowAllGraph] = useState(false);
  const [compactGraph, setCompactGraph] = useState(false);
  const compactGraphRef = useRef(compactGraph);
  useLayoutEffect(() => { compactGraphRef.current = compactGraph; }, [compactGraph]);
  const [flow, setFlow] = useState<ReactFlowInstance<GraphNode> | null>(null);
  const graphCanvasRef = useRef<HTMLDivElement>(null);
  const [graphReady, setGraphReady] = useState(false);
  const [graphSizeRevision, setGraphSizeRevision] = useState(0);
  const graphResizeRequest = useRef(0);
  const codeViewportRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const filesById = useMemo(() => new Map(repository.files.map((file) => [file.id, file])), [repository.files]);
  const workspaceId = repositoryWorkspaceId(repository);
  const chatDocked = workspaceViewportWidth >= 1280;
  const {
    workspaceLayoutPreferences,
    setWorkspaceLayoutPreferences,
    workspaceLayoutReady,
    setWorkspaceLayoutReady,
    workspaceLayoutInitializedRef,
    browserLayoutSaveError,
    setBrowserLayoutSaveError,
    chatGroupRef,
    chatContainerRef,
    workspaceOuterGroupRef,
    workspaceInnerGroupRef,
    saveWorkspaceLayoutPreferences,
    handleWorkspaceOuterLayoutChanged,
    handleWorkspaceInnerLayoutChanged,
    resetWorkspaceColumnLayout,
  } = useWorkspaceLayout({
    desktopMode,
    savedDataClearBusy,
    layoutMode,
    showGuideWelcome,
    chatOpen,
    chatDocked,
    workspaceViewportWidth,
    narrowLayout,
    onSetRepoMessage: setRepoMessage,
  });
  const {
    nodes,
    setNodes,
    edges,
    onNodesChange,
    nodePositions,
    setNodePositions,
    nodePositionsRef,
    nodePositionsPersisted,
    dirtyNodePositions,
    pendingNodePositionRestore,
    activeNodePositionKeyRef,
  } = useGraphCoordinates({
    repository,
    workspaceId,
    selectedFileId,
    showAllGraph,
    compactGraph,
    graphDirectory,
    layoutVersion,
    desktopMode,
    savedDataClearBusy,
    workspacePersistenceReadyKeys,
    onSetRepoMessage: setRepoMessage,
    nodePositionSessionKey,
    nodePositionSignature,
    workspaceSession,
    bootSnapshotId: BOOT_SNAPSHOT.id,
    nodePositionsReadyKey,
    setNodePositionsReadyKey,
  });

  const activeProgressKeyRef = useRef("");

  const {
    readingNotesByWorkspace,
    setReadingNotesByWorkspace,
    savedToursByWorkspace,
    setSavedToursByWorkspace,
    readingNotesRef,
    savedToursRef,
    aiResultsByFile,
    setAiResultsByFile,
    aiRoutesByRepository,
    setAiRoutesByRepository,
    readingArtifactJournals,
    savedDataClearGeneration,
    savedDataClearGenerationRef,
    questionClearVersion,
    chatClearingTarget,
    chatClearVersions,
    chatClearAllVersion,
    restoreWorkspaceState,
    saveReadingNotes,
    saveTours,
    persistReadingArtifactJournal,
    retryWorkspaceRestore,
    retryReadingArtifactSave,
    clearCurrentSavedData,
    clearAllSavedData,
    clearRetryPending,
    retrySavedDataClear,
  } = useWorkspacePersistence({
    repository,
    workspaceId,
    repositorySessionVersion,
    desktopMode,
    repoBusy,
    savedDataClearBusy,
    setSavedDataClearBusy,
    onClearAiContext: clearAiContext,
    onSetRepoMessage: setRepoMessage,
    repositoryGate,
    workspacePersistenceReadyKeys,
    setWorkspacePersistenceReadyKeys,
    workspaceReadFailures,
    setWorkspaceReadFailures,
    nodePositionsRef,
    setNodePositions,
    nodePositionsPersisted,
    dirtyNodePositions,
    pendingNodePositionRestore,
    setNodePositionsReadyKey,
    setRecentRepositories,
    progressMemory,
    workspaceLayoutReady,
    workspaceLayoutInitializedRef,
    workspaceLayoutPreferences,
    setWorkspaceLayoutPreferences,
    setWorkspaceLayoutReady,
    setBrowserLayoutSaveError,
    setBrowserProgressSaveFailures,
    initializeGuidePreferences,
    guidePreferencesRef,
    setGuidePreferences,
    setShowGuideWelcome,
    setGuidePanelOpen,
    setGuideNoticeAvailable,
    setGuideStorageMessage,
    guideTourPracticeRef,
    guideNavigationRef,
    guideSaveSequenceRef,
    guideWriteQueueRef,
    setTourIndex,
    setCompletedSteps,
    setTourVisibilityOverride,
    savedDataClearActiveRef,
    getActiveProgressKey: () => activeProgressKeyRef.current,
    tourIndex,
    completedSteps,
  });
  const currentReadingNotes = readingNotesByWorkspace.get(workspaceId) ?? [];
  const currentSavedTours = savedToursByWorkspace.get(workspaceId) ?? [];
  const persistenceStatus = useWorkspacePersistenceStatus(workspaceId);
  const layoutPersistenceStatus = useWorkspacePersistenceStatus(WORKSPACE_LAYOUT_PERSISTENCE_ID);
  const activePersistenceKey = nodePositionSessionKey(repository);
  const browserPreferencesUnsaved = Boolean(browserLayoutSaveError || browserProgressSaveFailures.size);
  const layoutSaveFailed = layoutPersistenceStatus.phase === "memory";
  const saveStatusLabel = savedDataClearBusy ? "正在清除" : browserPreferencesUnsaved || layoutSaveFailed || workspaceReadFailures.has(activePersistenceKey) || persistenceStatus.phase === "memory" ? "尚未保存" : !workspacePersistenceReadyKeys.has(activePersistenceKey) ? "正在恢复数据" : persistenceStatus.phase === "saving" || layoutPersistenceStatus.phase === "saving" ? "保存中" : persistenceStatus.phase === "clearing" ? "正在清除" : "已保存";
  const saveStatusDetail = browserPreferencesUnsaved ? "阅读进度或栏目宽度尚未保存到浏览器；可重试保存。" : layoutPersistenceStatus.error || (workspaceReadFailures.has(activePersistenceKey) ? "无法读取已保存数据；本页修改尚未保存，原记录不会被覆盖。" : persistenceStatus.error || (saveStatusLabel === "尚未保存" ? "本页修改尚未保存到本地。" : saveStatusLabel));
  const retryBrowserPreferences = useCallback(() => {
    const failures = new Set<string>();
    for (const key of browserProgressSaveFailures) {
      const value = progressMemory.get(key);
      if (value && !writeTourProgress(key, value)) failures.add(key);
    }
    setBrowserProgressSaveFailures(failures);
    let layoutFailed = false;
    if (browserLayoutSaveError) {
      try { window.localStorage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, JSON.stringify(workspaceLayoutPreferences)); setBrowserLayoutSaveError(""); }
      catch (error) { layoutFailed = true; setBrowserLayoutSaveError(error instanceof Error ? error.message : "浏览器存储不可用。"); }
    }
    setRepoMessage(failures.size || layoutFailed ? "浏览器存储仍不可用，阅读进度或栏目宽度尚未保存。" : "阅读进度和栏目宽度已保存。");
  }, [browserLayoutSaveError, browserProgressSaveFailures, workspaceLayoutPreferences]);
  const currentFile = filesById.get(selectedFileId) ?? repository.files[0] ?? EMPTY_FILE;
  const aiResult = aiResultsByFile.get(`${workspaceId}:${currentFile.id}`) ?? null;
  const aiStale = aiResultIsStale(aiResult, repository);
  const sourceKey = `${repository.id}:${repository.revision ?? repository.version}:${currentFile?.id ?? ""}`;
  const sourceMatches = loadedSource?.fileId === currentFile?.id && loadedSource.repositoryId === repository.id && loadedSource.revision === repository.revision;
  const sourceText = repository.source === "local" ? (sourceMatches ? loadedSource?.text ?? "" : "") : currentFile?.source ?? "";
  const sourceStatus = repository.source === "local" ? (sourceMatches ? "loaded" : sourceLoad?.key === sourceKey ? sourceLoad.status : "loading") : "loaded";
  useEffect(() => {
    const pending = guideNavigationRef.current;
    if (!pending) return;
    if (pending.repositoryId !== repository.id || pending.sessionVersion !== repositorySessionVersion) { guideNavigationRef.current = null; return; }
    if (sourceStatus !== "loaded" || currentFile.id !== pending.fileId) return;
    completeGuideTask("source");
    if (pending.dependency) completeGuideTask("dependencies");
    guideNavigationRef.current = null;
  }, [completeGuideTask, currentFile.id, repository.id, repositorySessionVersion, sourceStatus]);
  const aiContextKey = `${workspaceId}:${repository.revision ?? repository.version}:${currentFile?.id ?? ""}:${aiSettingsRevision}`;
  useLayoutEffect(() => { aiContextRef.current = aiContextKey; }, [aiContextKey]);
  useLayoutEffect(() => { settingsSessionRef.current = { repositoryId: repository.id, sessionVersion: repositorySessionVersion }; }, [repository.id, repositorySessionVersion]);
  const aiRoute = aiRoutesByRepository.get(workspaceId) ?? null;
  const aiRouteStale = aiRoute ? !getReadingTourStatus(aiRoute, new Map(repository.files.map(file => [file.id, file]))).readable : false;
  const activeTour = aiRoute?.steps ?? repository.tour;
  const activeRouteSignature = aiRoute?.signature ?? routeSignature(activeTour);
  const activeProgressKey = progressKey(repository, activeTour, aiRoute?.signature);
  useLayoutEffect(() => { activeProgressKeyRef.current = activeProgressKey; }, [activeProgressKey]);
  const activeTourRef = useRef(activeTour);
  useLayoutEffect(() => { activeTourRef.current = activeTour; }, [activeTour]);
  const progressSession = useRef(createProgressSessionGate());
  const [progressReadyKey, setProgressReadyKey] = useState<string | null>(null);
  const activeProgressSessionKey = `${activeProgressKey}:${repositorySessionVersion}`;
  const graphCanMount = progressReadyKey === activeProgressSessionKey && (!narrowLayout || mobileView === "graph");
  const lastProgressRepoSessionVersion = useRef(repositorySessionVersion);
  const graphFocusRequest = useRef(0);
  const graphSizeRef = useRef({ width: 0, height: 0 });
  const currentTour = activeTour[tourIndex];
  const tourProgressRestored = progressReadyKey === activeProgressSessionKey;
  const activeRouteCompleted = Boolean(activeTour.length && tourProgressRestored && completedSteps.includes(activeTour[activeTour.length - 1].id));
  const tourVisibilityKey = `${workspaceId}:${activeRouteSignature}:${repositorySessionVersion}`;
  const tourVisibilityForCurrentRoute = tourVisibilityOverride?.signature === tourVisibilityKey ? tourVisibilityOverride.open : !activeRouteCompleted;
  const tourBarVisible = activeTour.length > 0 && tourVisibilityForCurrentRoute;
  useEffect(() => {
    if (wasTourBarVisibleRef.current && !tourBarVisible) tourToggleButtonRef.current?.focus();
    wasTourBarVisibleRef.current = tourBarVisible;
  }, [tourBarVisible]);
  const graphDirectories = useMemo(() => [...new Set(repository.files.flatMap((file) => {
    const parts = file.path.split("/");
    return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
  }))].sort((a, b) => a.localeCompare(b)), [repository.files]);
  const scopedGraphFiles = useMemo(() => repository.files.filter((file) => !graphDirectory || file.id.startsWith(`${graphDirectory}/`)), [repository.files, graphDirectory]);
  const scopedGraphIds = useMemo(() => new Set(scopedGraphFiles.map((file) => file.id)), [scopedGraphFiles]);
  const graphNeighborIds = useMemo(() => [...new Set(repository.dependencies.filter((edge) => scopedGraphIds.has(edge.fromId) && scopedGraphIds.has(edge.toId) && (edge.fromId === currentFile.id || edge.toId === currentFile.id)).flatMap((edge) => [edge.fromId, edge.toId]))].filter((id) => id !== currentFile.id), [repository.dependencies, scopedGraphIds, currentFile.id]);
  const graphVisibleCount = showAllGraph ? scopedGraphFiles.length : scopedGraphFiles.length ? Math.min(100, 1 + graphNeighborIds.length) : 0;
  const graphCandidateCount = scopedGraphFiles.length ? 1 + graphNeighborIds.length : 0;
  const graphHiddenCount = showAllGraph ? 0 : Math.max(0, graphCandidateCount - graphVisibleCount);

  useEffect(() => {
    restoreWorkspaceStateRef.current = restoreWorkspaceState;
  }, [restoreWorkspaceState]);

  useEffect(() => {
    let cancelled = false;
    const epoch = beginRepositorySession();
    const restoreGeneration = savedDataClearGenerationRef.current;
    const storedGuide = desktopMode ? null : readBrowserUsageGuide();
    sampleRepositoryProvider.getSnapshot().then(async (snapshot) => {
      let warning: string | undefined;
      if (cancelled || !repositoryGate.current.isCurrent(epoch) || savedDataClearActiveRef.current || restoreGeneration !== savedDataClearGenerationRef.current) return;
      if (storedGuide) initializeGuidePreferences(storedGuide.stored, storedGuide.present, storedGuide.existingUse, storedGuide.available, storedGuide.message);
      try {
        const saved = await localWorkspaceProvider.get(repositoryWorkspaceId(snapshot));
        if (cancelled || !repositoryGate.current.isCurrent(epoch) || savedDataClearActiveRef.current || restoreGeneration !== savedDataClearGenerationRef.current) return;
        if (desktopMode) warning = restoreWorkspaceState(snapshot, saved);
        else if (saved.persistenceReady !== false) setRecentRepositories(saved.recentRepositories);
      }
      catch (error) {
        if (cancelled || !repositoryGate.current.isCurrent(epoch) || savedDataClearActiveRef.current || restoreGeneration !== savedDataClearGenerationRef.current) return;
        if (desktopMode) {
          const failedKey = nodePositionSessionKey(snapshot);
          setWorkspacePersistenceReadyKeys((current) => { const next = new Set(current); next.delete(failedKey); return next; });
          setWorkspaceReadFailures((current) => new Set(current).add(failedKey));
          setNodePositionsReadyKey((current) => current === failedKey ? null : current);
        }
        warning = error instanceof Error ? error.message : "无法读取保存数据。";
        if (desktopMode) initializeGuidePreferences(null, false, false, false, warning);
      }
      if (cancelled || !repositoryGate.current.activate(epoch, snapshot)) return;
      setRepositorySessionVersion((version) => version + 1);
      setRepository(snapshot);
      setSelectedFileId(snapshot.files[0]?.id ?? "");
      if (warning) setRepoMessage(`保存数据读取失败；原记录不会被覆盖：${warning}`);
    }).catch((error: Error) => {
      if (!cancelled && repositoryGate.current.isCurrent(epoch)) {
        if (storedGuide) initializeGuidePreferences(storedGuide.stored, storedGuide.present, storedGuide.existingUse, storedGuide.available, storedGuide.message);
        setRepoMessage(error.message);
      }
    });
    return () => { cancelled = true; };
  }, [beginRepositorySession, desktopMode, initializeGuidePreferences, restoreWorkspaceState, setSelectedFileId]);

  useLayoutEffect(() => {
    const updateLayout = () => {
      setNarrowLayout((previous) => previous === (window.innerWidth <= 860) ? previous : window.innerWidth <= 860);
      setWorkspaceViewportWidth(window.innerWidth);
    };
    updateLayout();
    window.addEventListener("resize", updateLayout);
    return () => window.removeEventListener("resize", updateLayout);
  }, []);

  useEffect(() => {
    const canvas = graphCanvasRef.current;
    if (!canvas) return;
    let frame = 0;
    let pendingSize = { width: 0, height: 0 };
    let stableFrames = 0;
    const measureGraphSize = () => {
      frame = 0;
      const bounds = canvas.getBoundingClientRect();
      const previous = graphSizeRef.current;
      if (bounds.width <= 0 || bounds.height <= 0) {
        pendingSize = { width: 0, height: 0 };
        stableFrames = 0;
        if (previous.width > 0 || previous.height > 0) {
          graphSizeRef.current = { width: 0, height: 0 };
          setGraphReady(false);
        }
        return;
      }
      const matchesPending = Math.abs(pendingSize.width - bounds.width) < 1 && Math.abs(pendingSize.height - bounds.height) < 1;
      stableFrames = matchesPending ? stableFrames + 1 : 0;
      pendingSize = { width: bounds.width, height: bounds.height };
      if (stableFrames < 2) {
        frame = requestAnimationFrame(measureGraphSize);
        return;
      }
      const changed = Math.abs(previous.width - bounds.width) >= 1 || Math.abs(previous.height - bounds.height) >= 1;
      if (changed) {
        graphSizeRef.current = { width: bounds.width, height: bounds.height };
        setGraphSizeRevision((revision) => revision + 1);
      }
      setGraphReady(true);
      setCompactGraph((value) => value === (bounds.width <= 480) ? value : bounds.width <= 480);
    };
    const updateGraphSize = () => {
      if (frame) cancelAnimationFrame(frame);
      stableFrames = 0;
      frame = requestAnimationFrame(measureGraphSize);
    };
    updateGraphSize();
    const observer = new ResizeObserver(updateGraphSize);
    observer.observe(canvas);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [showGuideWelcome]);

  useEffect(() => {
    const forceRestore = lastProgressRepoSessionVersion.current !== repositorySessionVersion;
    lastProgressRepoSessionVersion.current = repositorySessionVersion;
    const token = progressSession.current.begin(activeProgressKey, forceRestore);
    const key = activeProgressKey;
    const sessionKey = `${key}:${repositorySessionVersion}`;
    traceProgress("restore-start", key, token.generation);
    const frame = window.requestAnimationFrame(() => {
      if (progressSession.current.current().generation !== token.generation) return;
      setTourIndex(0); setCompletedSteps([]); setFocusedLine(null);
      try {
        const raw = readTourProgress(key);
        const tour = activeTourRef.current;
        const progress = parseTourProgress(raw, tour);
        if (progress) {
          const restoredStep = tour[progress.stepIndex];
          dispatchNavigation({ type: "restore-progress", stepIndex: progress.stepIndex, completedSteps: progress.completedSteps, step: restoredStep, routeSignature: activeRouteSignature, routeStale: aiRouteStale });
          setDetailTab(aiRouteStale ? "guide" : "source"); setMobileView("details");
          if (aiRouteStale) setRepoMessage("此 AI 阅读路线引用的源码已变化；已恢复步骤和完成记录，旧行号定位已停用。");
        } else if (aiRoute && tour[0] && !aiRouteStale) {
          dispatchNavigation({ type: "restart-tour", step: tour[0], routeSignature: activeRouteSignature });
          setDetailTab("source"); setMobileView("details");
        }
        traceProgress("restore-complete", key, token.generation, { outcome: progress ? "restored" : "initial", stepIndex: progress?.stepIndex ?? 0 });
      } catch {
        traceProgress("restore-complete", key, token.generation, { outcome: "damaged", stepIndex: 0 });
        window.setTimeout(() => setRepoMessage("无法读取已保存的阅读进度，本次从第一步开始。"), 0);
      }
      progressSession.current.complete(token);
      setProgressReadyKey(sessionKey);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeProgressKey, activeRouteSignature, aiRoute, aiRouteStale, repositorySessionVersion, setFocusedLine, setCompletedSteps, setTourIndex]);

  useEffect(() => {
    if (!progressSession.current.canSave(activeProgressKey)) return;
    const value = JSON.stringify({ stepIndex: tourIndex, completedSteps });
    const saved = writeTourProgress(activeProgressKey, value);
    if (!desktopMode) {
      const clearGeneration = savedDataClearGenerationRef.current;
      queueMicrotask(() => {
        if (clearGeneration !== savedDataClearGenerationRef.current) return;
        setBrowserProgressSaveFailures((previous) => {
          if (previous.has(activeProgressKey) === !saved) return previous;
          const next = new Set(previous);
          if (saved) next.delete(activeProgressKey); else next.add(activeProgressKey);
          return next;
        });
      });
    }
    traceProgress("save", activeProgressKey, progressSession.current.current().generation, { outcome: saved ? "persistent" : "memory-only", stepIndex: tourIndex });
    if (!saved) window.setTimeout(() => setRepoMessage("浏览器存储不可用，本次阅读进度尚未保存到本地。"), 0);
    if (desktopMode && !savedDataClearBusy && repository.id !== BOOT_SNAPSHOT.id && workspacePersistenceReadyKeys.has(nodePositionSessionKey(repository))) {
      void enqueueWorkspacePersistence(workspaceId, () => localWorkspaceProvider.saveProgress(workspaceSession(repository), activeProgressKey, value), { key: `progress:${activeProgressKey}` }).catch((error: Error) => setRepoMessage(`阅读进度尚未保存到本地：${error.message}`));
    }
  }, [tourIndex, completedSteps, activeProgressKey, desktopMode, repository, repository.id, workspacePersistenceReadyKeys, savedDataClearBusy, workspaceId]);

  useEffect(() => {
    const reference = focusedLine;
    if (!reference || reference.fileId !== currentFile.id || detailTab !== "source") return;
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(`source-line-${reference.line}`);
      if (target && codeViewportRef.current) {
        const viewport = codeViewportRef.current;
        viewport.scrollTo({ top: Math.max(0, target.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop - 115), behavior: "smooth" });
      } else if (codeViewportRef.current && sourceText.length > 0) {
        // Long files render only visible rows; move the viewport first so the
        // requested source line is mounted by the virtual list.
        codeViewportRef.current.scrollTo({ top: Math.max(0, 45 + (reference.line - 1) * 24 - 115), behavior: "smooth" });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [currentFile.id, focusedLine, detailTab, sourceText]);

  useEffect(() => {
    let cancelled = false;
    if (repository.source === "local" && currentFile && detailTab === "source") {
      const controller = new AbortController();
      const fileId = currentFile.id; const revision = repository.revision; const repositoryId = repository.id; const key = `${repositoryId}:${revision ?? ""}:${fileId}`;
      localRepositoryProvider.getSource(repositoryId, revision, fileId, controller.signal).then((value) => { if (!cancelled) { setLoadedSource({ fileId, repositoryId, revision, text: value }); setSourceLoad({ key, status: "loaded" }); } }).catch((error: Error) => { if (!cancelled && error.name !== "AbortError") { setSourceLoad({ key, status: "error", message: error.message }); setRepoMessage(error.message); } });
      return () => { cancelled = true; controller.abort(); };
    }
    return () => { cancelled = true; };
  }, [currentFile, repository.id, repository.source, repository.revision, detailTab]);

  const changeAiScope = useCallback((selectedFiles: string[], ranges: Record<string, AiLineRange>) => {
    const requestId = ++aiRequestSequence.current;
    dispatchAiWorkflow({ type: "scopeChanged", requestId, selectedFiles, ranges });
    const controller = aiAbortController.current;
    aiAbortController.current = null;
    controller?.abort();
  }, []);

  useEffect(() => {
    onSnapshotAppliedRef.current = (snapshot) => {
      const initialDirectory = snapshot.origin?.kind === "github" ? snapshot.origin.subdirectory : "";
      const scopedFiles = [...snapshot.files].filter((file) => !initialDirectory || file.id.startsWith(`${initialDirectory}/`)).sort((a, b) => a.path.localeCompare(b.path));
      const restoredFileId = initialDirectory
        ? scopedFiles[0]?.id ?? snapshot.files[0]?.id ?? ""
        : snapshot.files.some((file) => file.id === selectedFileId) ? selectedFileId : snapshot.files[0]?.id ?? "";
      const graphDirectory = initialDirectory && scopedFiles.length ? initialDirectory : "";
      dispatchNavigation({ type: "snapshot", selectedFileId: restoredFileId, graphDirectory, clearFocus: true, resetTour: true });
      clearAiContext(); setSearchQuery(""); setCollapsedFolders([]); setShowAllGraph(false);
      setDetailTab("guide"); setMobileView("files");
    };
  }, [clearAiContext, selectedFileId]);

  useEffect(() => {
    onUpdatedSnapshotAppliedRef.current = (snapshot) => {
      const previousFile = filesById.get(selectedFileId);
      const sortedFiles = [...snapshot.files].sort((a, b) => a.path.localeCompare(b.path));
      const nextFile = sortedFiles.find((file) => file.id === selectedFileId) ?? sortedFiles[0];
      let nextDirectory = graphDirectory;
      if (!nextFile || (nextDirectory && !snapshot.files.some((file) => file.id.startsWith(`${nextDirectory}/`)))) nextDirectory = "";
      if (nextFile && nextDirectory && !nextFile.id.startsWith(`${nextDirectory}/`)) nextDirectory = "";
      const contentChanged = previousFile && nextFile && previousFile.contentHash !== nextFile.contentHash;
      const previousReferenceFile = focusedLine ? filesById.get(focusedLine.fileId) : undefined;
      const nextReferenceFile = focusedLine ? snapshot.files.find((file) => file.id === focusedLine.fileId) : undefined;
      const referenceChanged = Boolean(focusedLine && (!previousReferenceFile || !nextReferenceFile || previousReferenceFile.contentHash !== nextReferenceFile.contentHash));
      const routeExpired = Boolean(aiRoute && !aiRouteStale && (aiRoute.stale || aiContextIsStale(aiRoute.contextFiles, snapshot)));
      const expiredRouteFocus = routeExpired && focusOrigin === "route" && focusRouteSignature === aiRoute?.signature;
      clearAiContext();
      dispatchNavigation({ type: "snapshot", selectedFileId: nextFile?.id ?? "", graphDirectory: nextDirectory, clearFocus: referenceChanged || !nextFile || expiredRouteFocus, resetTour: false });
      setLoadedSource(null);
      setRepoMessage(expiredRouteFocus ? "阅读路线引用的源码已变化，旧行号已清除；路线说明仍可查看。" : referenceChanged ? "定位到的源码已变化，旧行号已清除。" : contentChanged ? "当前文件已变化，旧 AI 确认已清除。" : snapshot.files.length ? "本地索引已更新。" : "仓库中已没有可分析的源码文件。");
    };
  }, [aiRoute, aiRouteStale, clearAiContext, filesById, focusOrigin, focusRouteSignature, focusedLine, graphDirectory, selectedFileId, setRepoMessage]);



  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)) return;
      event.preventDefault();
      searchInputRef.current?.focus();
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  const focusTreeFile = useCallback((fileId: string) => {
    setCollapsedFolders([]);
    window.requestAnimationFrame(() => document.getElementById(`tree-file-${fileId}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  }, []);
  const focusGraphFile = useCallback((fileId: string) => {
    const request = ++graphFocusRequest.current;
    let attempts = 0;
    const locate = () => {
      if (request !== graphFocusRequest.current) return;
      const canvas = graphCanvasRef.current;
      const bounds = canvas?.getBoundingClientRect();
      const allNodes = flow?.getNodes() ?? [];
      const selected = allNodes.find((node) => node.id === fileId);
      const selectedWidth = selected?.measured?.width ?? selected?.width;
      const selectedHeight = selected?.measured?.height ?? selected?.height;
      if (!flow || !bounds || bounds.width <= 0 || bounds.height <= 0 || !selected || !selectedWidth || !selectedHeight) {
        if (attempts++ < 120) requestAnimationFrame(locate);
        return;
      }
      const adjacent = repository.dependencies.filter((edge) => edge.fromId === fileId || edge.toId === fileId).flatMap((edge) => [edge.fromId, edge.toId]);
      const ids = new Set([fileId, ...adjacent]);
      const dimensions = (node: GraphNode) => ({
        x: node.position.x,
        y: node.position.y,
        width: node.measured?.width ?? node.width ?? (compactGraphRef.current ? 140 : 160),
        height: node.measured?.height ?? node.height ?? (compactGraphRef.current ? 60 : 68),
      });
      const isFiniteBox = (box: ReturnType<typeof dimensions>) => [box.x, box.y, box.width, box.height].every(Number.isFinite) && box.width > 0 && box.height > 0;
      if (!isFiniteBox(dimensions(selected))) {
        if (attempts++ < 120) requestAnimationFrame(locate);
        return;
      }
      const boxFor = (targets: GraphNode[]) => {
        const values = targets.map(dimensions);
        const left = Math.min(...values.map((value) => value.x));
        const top = Math.min(...values.map((value) => value.y));
        const right = Math.max(...values.map((value) => value.x + value.width));
        const bottom = Math.max(...values.map((value) => value.y + value.height));
        return { x: (left + right) / 2, y: (top + bottom) / 2, width: right - left, height: bottom - top };
      };
      const neighbors = allNodes.filter((node) => node.id !== fileId && ids.has(node.id) && isFiniteBox(dimensions(node)));
      let targets = [selected, ...neighbors];
      let box = boxFor(targets);
      const fitZoom = Math.min((bounds.width - 48) / box.width, (bounds.height - 48) / box.height);
      if (fitZoom < 0.85 && neighbors.length) { targets = [selected]; box = boxFor(targets); }
      if (!Number.isFinite(box.x) || !Number.isFinite(box.y) || !Number.isFinite(box.width) || !Number.isFinite(box.height) || box.width <= 0 || box.height <= 0) {
        box = boxFor([selected]);
        targets = [selected];
      }
      const requestedZoom = Math.min(bounds.width - 48, bounds.height - 48) > 0 ? Math.min((bounds.width - 48) / box.width, (bounds.height - 48) / box.height) : 0.85;
      const zoom = Number.isFinite(requestedZoom) ? Math.max(0.85, Math.min(1.25, requestedZoom)) : 0.85;
      if (!Number.isFinite(box.x) || !Number.isFinite(box.y)) return;
      flow.setCenter(box.x, box.y, { zoom, duration: 0 });
    };
    requestAnimationFrame(locate);
  }, [flow, repository.dependencies]);

  useEffect(() => {
    if (!graphSizeRevision || !graphCanMount || !flow || !selectedFileId) return;
    const request = ++graphResizeRequest.current;
    let frame = 0;
    let attempts = 0;
    let lastViewport: { x: number; y: number; zoom: number } | null = null;
    let stableViewportFrames = 0;
    const preserveVisibleNode = () => {
      if (request !== graphResizeRequest.current) return;
      const canvas = graphCanvasRef.current;
      const bounds = canvas?.getBoundingClientRect();
      const nodeElement = canvas && [...canvas.querySelectorAll<HTMLElement>(".react-flow__node")].find((node) => node.dataset.id === selectedFileId);
      const nodeBounds = nodeElement?.getBoundingClientRect();
      if (!bounds || !nodeBounds || bounds.width <= 0 || bounds.height <= 0 || nodeBounds.width <= 0 || nodeBounds.height <= 0) {
        if (attempts++ < 120) frame = requestAnimationFrame(preserveVisibleNode);
        return;
      }
      const currentViewport = flow.getViewport();
      if (lastViewport && Math.abs(lastViewport.x - currentViewport.x) < 0.01 && Math.abs(lastViewport.y - currentViewport.y) < 0.01 && Math.abs(lastViewport.zoom - currentViewport.zoom) < 0.0001) {
        stableViewportFrames += 1;
      } else {
        stableViewportFrames = 0;
      }
      lastViewport = currentViewport;
      if (stableViewportFrames < 3) {
        if (attempts++ < 120) frame = requestAnimationFrame(preserveVisibleNode);
        return;
      }
      const margin = 24;
      const width = bounds.width - margin * 2;
      const height = bounds.height - margin * 2;
      if (nodeBounds.width > width || nodeBounds.height > height) {
        focusGraphFile(selectedFileId);
        return;
      }
      const deltaX = nodeBounds.left < bounds.left + margin
        ? bounds.left + margin - nodeBounds.left
        : nodeBounds.right > bounds.right - margin ? bounds.right - margin - nodeBounds.right : 0;
      const deltaY = nodeBounds.top < bounds.top + margin
        ? bounds.top + margin - nodeBounds.top
        : nodeBounds.bottom > bounds.bottom - margin ? bounds.bottom - margin - nodeBounds.bottom : 0;
      if (deltaX || deltaY) {
        flow.setViewport({ ...currentViewport, x: currentViewport.x + deltaX, y: currentViewport.y + deltaY }, { duration: 0 });
      }
    };
    frame = requestAnimationFrame(preserveVisibleNode);
    return () => {
      graphResizeRequest.current += 1;
      cancelAnimationFrame(frame);
    };
  }, [flow, graphCanMount, graphSizeRevision, selectedFileId, focusGraphFile]);

  useEffect(() => {
    if (flow && selectedFileId) focusGraphFile(selectedFileId);
  }, [flow, selectedFileId, repository.revision, focusGraphFile]);
  useEffect(() => {
    if (graphCanMount) return;
    graphFocusRequest.current += 1;
  }, [graphCanMount]);
  const recordNavigation = useCallback((destination: { fileId: string; line?: number; endLine?: number }) => {
    const current = { fileId: selectedFileId, ...(focusedLine?.fileId === selectedFileId ? { line: focusedLine.line, ...(focusedLine.endLine ? { endLine: focusedLine.endLine } : {}) } : {}) };
    setNavigationHistory((history) => pushNavigationHistory(history, current, destination));
  }, [selectedFileId, focusedLine]);
  const selectFile = useCallback((fileId: string, view: MobileView = "details", directoryOverride?: string) => {
    guideNavigationRef.current = { repositoryId: repository.id, sessionVersion: repositorySessionVersion, fileId, dependency: false };
    if (fileId === currentFile.id && sourceStatus === "loaded") { completeGuideTask("source"); guideNavigationRef.current = null; }
    recordNavigation({ fileId });
    clearAiContext();
    const nextDirectory = directoryOverride !== undefined ? directoryOverride : graphDirectory && !fileId.startsWith(`${graphDirectory}/`) ? "" : graphDirectory;
    dispatchNavigation({ type: "select-file", fileId, directory: nextDirectory });
    setDetailTab(layoutMode === "reading" ? "source" : "guide");
    setMobileView(view);
    setSearchQuery(""); focusTreeFile(fileId); focusGraphFile(fileId);
  }, [clearAiContext, completeGuideTask, currentFile.id, focusTreeFile, focusGraphFile, graphDirectory, layoutMode, recordNavigation, repository.id, repositorySessionVersion, sourceStatus]);

  const openReference = useCallback((reference: SourceReference) => {
    const dependency = repository.dependencies.some((edge) => (edge.fromId === currentFile.id || edge.toId === currentFile.id) && edge.reference.fileId === reference.fileId && edge.reference.line === reference.line);
    guideNavigationRef.current = { repositoryId: repository.id, sessionVersion: repositorySessionVersion, fileId: reference.fileId, dependency };
    if (reference.fileId === currentFile.id && sourceStatus === "loaded") {
      completeGuideTask("source"); if (dependency) completeGuideTask("dependencies"); guideNavigationRef.current = null;
    }
    recordNavigation({ fileId: reference.fileId, line: reference.line, ...(reference.endLine ? { endLine: reference.endLine } : {}) });
    clearAiContext();
    const nextDirectory = graphDirectory && !reference.fileId.startsWith(`${graphDirectory}/`) ? "" : graphDirectory;
    dispatchNavigation({ type: "reference-navigation", reference, directory: nextDirectory });
    setDetailTab("source");
    setMobileView("details");
    setSearchQuery(""); focusTreeFile(reference.fileId); focusGraphFile(reference.fileId);
  }, [clearAiContext, completeGuideTask, currentFile.id, focusTreeFile, focusGraphFile, graphDirectory, recordNavigation, repository.dependencies, repository.id, repositorySessionVersion, sourceStatus]);

  const openTourReference = useCallback((reference: SourceReference) => {
    guideNavigationRef.current = { repositoryId: repository.id, sessionVersion: repositorySessionVersion, fileId: reference.fileId, dependency: false };
    if (reference.fileId === currentFile.id && sourceStatus === "loaded") { completeGuideTask("source"); guideNavigationRef.current = null; }
    recordNavigation({ fileId: reference.fileId, line: reference.line, ...(reference.endLine ? { endLine: reference.endLine } : {}) });
    clearAiContext();
    const nextDirectory = graphDirectory && !reference.fileId.startsWith(`${graphDirectory}/`) ? "" : graphDirectory;
    dispatchNavigation({ type: "reference-navigation", reference, directory: nextDirectory, origin: "route", routeSignature: activeRouteSignature });
    setDetailTab("source"); setMobileView("details"); setSearchQuery("");
    focusTreeFile(reference.fileId); focusGraphFile(reference.fileId);
  }, [activeRouteSignature, clearAiContext, completeGuideTask, currentFile.id, focusTreeFile, focusGraphFile, graphDirectory, recordNavigation, repository.id, repositorySessionVersion, sourceStatus]);

  const navigateHistory = useCallback((direction: -1 | 1) => {
    const moved = moveNavigationHistory(navigationHistory, direction);
    if (!moved.location || !filesById.has(moved.location.fileId)) return;
    setNavigationHistory(moved.state);
    clearAiContext();
    const location = moved.location;
    const practice = guideTourPracticeRef.current;
    if (practice && direction === -1 && practice.workspaceId === workspaceId && practice.sessionVersion === repositorySessionVersion && location.fileId === practice.origin.fileId && (practice.origin.line === undefined ? location.line === undefined : location.line === practice.origin.line)) practice.returned = true;
    guideNavigationRef.current = { repositoryId: repository.id, sessionVersion: repositorySessionVersion, fileId: location.fileId, dependency: false };
    if (location.fileId === currentFile.id && sourceStatus === "loaded") { completeGuideTask("source"); guideNavigationRef.current = null; }
    const nextDirectory = graphDirectory && !location.fileId.startsWith(`${graphDirectory}/`) ? "" : graphDirectory;
    if (location.line) {
      dispatchNavigation({ type: "reference-navigation", reference: { fileId: location.fileId, line: location.line, ...(location.endLine ? { endLine: location.endLine } : {}) }, directory: nextDirectory });
      setDetailTab("source");
    } else {
      dispatchNavigation({ type: "select-file", fileId: location.fileId, directory: nextDirectory });
      setDetailTab(layoutMode === "reading" ? "source" : "guide");
    }
    setMobileView("details"); setSearchQuery("");
    focusTreeFile(location.fileId); focusGraphFile(location.fileId);
  }, [navigationHistory, filesById, clearAiContext, completeGuideTask, currentFile.id, graphDirectory, layoutMode, focusTreeFile, focusGraphFile, repository.id, repositorySessionVersion, sourceStatus, workspaceId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "p") {
        event.preventDefault(); setQuickOpen(true);
      } else if (event.altKey && event.key === "ArrowLeft") {
        event.preventDefault(); navigateHistory(-1);
      } else if (event.altKey && event.key === "ArrowRight") {
        event.preventDefault(); navigateHistory(1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigateHistory]);

  const goToStep = useCallback((index: number, markCurrentComplete = false) => {
    const nextIndex = Math.max(0, Math.min(activeTour.length - 1, index));
    if (!activeTour.length || aiRouteStale || savedDataClearBusy) return;
    const step = activeTour[nextIndex];
    if (nextIndex !== tourIndex && activeTour.length > 1) {
      guideTourPracticeRef.current = {
        workspaceId,
        sessionVersion: repositorySessionVersion,
        origin: { fileId: selectedFileId, ...(focusedLine?.fileId === selectedFileId ? { line: focusedLine.line } : {}) },
        destination: { fileId: step.reference.fileId, line: step.reference.line },
        visited: false,
        returned: false,
      };
    }
    recordNavigation({ fileId: step.reference.fileId, line: step.reference.line, ...(step.reference.endLine ? { endLine: step.reference.endLine } : {}) });
    clearAiContext();
    dispatchNavigation({ type: "route-step", stepIndex: nextIndex, step, routeSignature: activeRouteSignature, ...(markCurrentComplete ? { completedStepId: activeTour[tourIndex].id } : {}) });
    setShowAllGraph(false);
    setDetailTab("source");
    setMobileView("details");
    setSearchQuery(""); focusTreeFile(step.focusFileId); focusGraphFile(step.focusFileId);
  }, [tourIndex, activeTour, activeRouteSignature, aiRouteStale, clearAiContext, focusTreeFile, focusGraphFile, savedDataClearBusy, recordNavigation, workspaceId, repositorySessionVersion, selectedFileId, focusedLine]);

  const resetTour = useCallback(() => {
    if (!activeTour.length || aiRouteStale || savedDataClearBusy) return;
    clearAiContext();
    setShowAllGraph(false);
    dispatchNavigation({ type: "restart-tour", step: activeTour[0], routeSignature: activeRouteSignature });
    setDetailTab("source");
    setMobileView("details");
    setSearchQuery(""); focusTreeFile(activeTour[0].focusFileId); focusGraphFile(activeTour[0].focusFileId);
  }, [activeTour, activeRouteSignature, aiRouteStale, clearAiContext, focusTreeFile, focusGraphFile, savedDataClearBusy]);

  useEffect(() => {
    const practice = guideTourPracticeRef.current;
    if (!practice) return;
    if (practice.workspaceId !== workspaceId || practice.sessionVersion !== repositorySessionVersion) { guideTourPracticeRef.current = null; return; }
    if (sourceStatus === "loaded" && selectedFileId === practice.destination.fileId && focusedLine?.fileId === practice.destination.fileId && focusedLine.line === practice.destination.line) practice.visited = true;
    if (practice.visited && practice.returned) { guideTourPracticeRef.current = null; completeGuideTask("tour"); }
  }, [completeGuideTask, focusedLine, repositorySessionVersion, selectedFileId, sourceStatus, workspaceId]);

  const resetGraph = useCallback(() => {
    if (savedDataClearBusy) return;
    setNodePositions((previous) => new Map([...previous].filter(([id]) => !id.startsWith(`${workspaceId}:`))));
    setLayoutVersion((version) => version + 1);
    window.requestAnimationFrame(() => focusGraphFile(currentFile.id));
  }, [currentFile.id, focusGraphFile, workspaceId, savedDataClearBusy]);



  const activateSavedTour = useCallback((route: AiRouteRecord) => {
    if (!getReadingTourStatus(route, new Map(repository.files.map(file => [file.id, file]))).readable) { setRepoMessage("这条路线的源码依据不完整、已变化或尚未校验；请编辑并重新校验后再开始。"); return; }
    clearAiContext();
    setAiRoutesByRepository((previous) => JSON.stringify(previous.get(workspaceId)) === JSON.stringify(route) ? previous : new Map(previous).set(workspaceId, route));
    if (route.signature !== activeRouteSignature) dispatchNavigation({ type: "restart-tour", step: route.steps[0], routeSignature: route.signature });
    setTourVisibilityOverride({ signature: `${workspaceId}:${route.signature}:${repositorySessionVersion}`, open: true });
    setDetailTab("source"); setMobileView("details"); setRepoMessage("");
    const restoreKey = nodePositionSessionKey(repository);
    if (!desktopMode || (workspacePersistenceReadyKeys.has(restoreKey) && !workspaceReadFailures.has(restoreKey))) {
      void enqueueWorkspacePersistence(workspaceId, () => localWorkspaceProvider.saveAiRoute(workspaceSession(repository), route)).catch((error: Error) => {
        setRepoMessage(`路线已打开，但未能保存为当前路线：${error.message}`);
      });
    } else setRepoMessage("阅读路线已打开；保存数据恢复完成后才会写入本地。");
  }, [activeRouteSignature, repositorySessionVersion, clearAiContext, desktopMode, repository, workspaceId, workspacePersistenceReadyKeys, workspaceReadFailures]);

  const locateCurrentGraph = useCallback(() => {
    focusGraphFile(currentFile.id);
  }, [focusGraphFile, currentFile.id]);
  const toggleGraphScope = useCallback(() => {
    const next = !showAllGraph; setShowAllGraph(next);
    if (next) window.setTimeout(() => flow?.fitView({ padding: 0.2, minZoom: 0.08, maxZoom: 0.8, duration: 320 }), 100);
    else window.setTimeout(() => focusGraphFile(currentFile.id), 100);
  }, [showAllGraph, flow, focusGraphFile, currentFile.id]);

  const handleNodeClick = useCallback((_: React.MouseEvent, node: GraphNode) => {
    selectFile(node.id, "details");
  }, [selectFile]);

  useEffect(() => {
    const container = tourStepsRef.current;
    if (!container) return;
    const revealCurrent = () => {
      const activeStep = container.querySelector<HTMLElement>(".tour-step.is-current");
      if (!activeStep) return;
      const containerRect = container.getBoundingClientRect();
      const stepRect = activeStep.getBoundingClientRect();
      if (stepRect.left < containerRect.left) container.scrollTo({ left: container.scrollLeft + stepRect.left - containerRect.left, behavior: "smooth" });
      else if (stepRect.right > containerRect.right) container.scrollTo({ left: container.scrollLeft + stepRect.right - containerRect.right, behavior: "smooth" });
    };
    const frame = requestAnimationFrame(revealCurrent);
    window.addEventListener("resize", revealCurrent);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("resize", revealCurrent); };
  }, [tourIndex, activeTour.length]);

  const closeUsageGuidePanel = useCallback(() => {
    setGuidePanelOpen(false);
    updateGuidePreferences((previous) => ({ ...previous, checklistOpen: false }));
  }, [updateGuidePreferences]);
  const openRepositoryHome = useCallback(async () => {
    closeUsageGuidePanel();
    setGuideNoticeAvailable(false);
    if (repository.source === "local") await closeRepositoryRef.current();
    setRepoMessage("");
    setShowGuideWelcome(true);
  }, [closeUsageGuidePanel, repository.source, setRepoMessage]);
  const openUsageGuidePanel = useCallback(() => {
    setShowGuideWelcome(false);
    setGuidePanelOpen(true);
    setGuideNoticeAvailable(false);
    updateGuidePreferences((previous) => ({ ...previous, checklistOpen: true, noticeDismissed: true }));
  }, [updateGuidePreferences]);
  const openUsageGuideFromHome = useCallback(() => {
    setGuidePanelOpen(true);
    setGuideNoticeAvailable(false);
    updateGuidePreferences((previous) => ({ ...previous, checklistOpen: true, noticeDismissed: true }));
  }, [updateGuidePreferences]);

  const openGuideWelcome = useCallback(() => {
    void openRepositoryHome();
  }, [openRepositoryHome]);
  const handleTryExample = useCallback(() => {
    setShowGuideWelcome(false);
    setGuidePanelOpen(true);
    setTourVisibilityOverride(null);
    updateGuidePreferences((previous) => ({ ...previous, welcomeHandled: true, checklistOpen: true, noticeDismissed: true }));
    if (repository.source === "local") void closeRepositoryRef.current();
    else cancelPendingRepositoryOpen();
  }, [cancelPendingRepositoryOpen, repository.source, updateGuidePreferences]);
  const openSampleFromMenu = useCallback(() => {
    setShowGuideWelcome(false);
    setGuidePanelOpen(false);
    setTourVisibilityOverride(null);
    setMobileView("graph");
    setDetailTab("guide");
    setGuideNoticeAvailable(false);
    updateGuidePreferences((previous) => ({ ...previous, welcomeHandled: true, checklistOpen: false, noticeDismissed: true }));
    if (repository.source === "local") void closeRepositoryRef.current();
    else cancelPendingRepositoryOpen();
  }, [cancelPendingRepositoryOpen, repository.source, updateGuidePreferences]);
  const handleOpenRepositoryFromGuide = useCallback(() => {
    setShowGuideWelcome(true);
    setGuidePanelOpen(false);
    updateGuidePreferences((previous) => ({ ...previous, welcomeHandled: true, checklistOpen: false, noticeDismissed: true }));
    setGuideNoticeAvailable(false);
    if (repository.source === "local") void openRepositoryHome().then(() => setGuideRepoRequest((request) => request + 1));
    else setGuideRepoRequest((request) => request + 1);
  }, [openRepositoryHome, repository.source, updateGuidePreferences]);
  const dismissGuideNotice = useCallback(() => {
    setGuideNoticeAvailable(false);
    updateGuidePreferences((previous) => ({ ...previous, noticeDismissed: true }));
  }, [updateGuidePreferences]);
  const resetUsageGuide = useCallback(() => {
    const reset = createDefaultUsageGuidePreferences();
    updateGuidePreferences(reset);
    setGuidePanelOpen(false);
    setShowGuideWelcome(true);
  }, [updateGuidePreferences]);
  const startUsageGuideTask = useCallback((task: UsageGuideTaskId | "practice-example") => {
    closeUsageGuidePanel();
    if (task === "source") { setDetailTab("source"); setMobileView("details"); setQuickOpen(true); return; }
    if (task === "dependencies") {
      setDetailTab("guide"); setMobileView("details");
      window.requestAnimationFrame(() => document.querySelector(".relation-section")?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
      return;
    }
    if (task === "tour") {
      const nextIndex = tourIndex < activeTour.length - 1 ? tourIndex + 1 : Math.max(0, tourIndex - 1);
      goToStep(nextIndex, nextIndex > tourIndex);
      return;
    }
    if (task === "note") {
      setDetailTab("guide"); setMobileView("details");
      window.requestAnimationFrame(() => document.querySelector(".reading-artifacts")?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
      return;
    }
    if (task === "repository") { handleOpenRepositoryFromGuide(); return; }
    if (task === "practice-example") {
      if (repository.source === "local") void closeRepositoryRef.current();
      else setRepoMessage("当前已在示例仓库中；可从阅读路线继续练习。");
    }
  }, [activeTour.length, closeUsageGuidePanel, goToStep, handleOpenRepositoryFromGuide, repository.source, tourIndex]);
  useEffect(() => {
    if (!guideRepoRequest) return;
    const frame = window.requestAnimationFrame(() => document.getElementById("repository-path")?.focus());
    if (desktopMode) {
      void window.repoLens?.selectDirectory().then((selectedPath) => { if (selectedPath) setRepoPath(selectedPath); })
        .catch((error: unknown) => setRepoMessage(error instanceof Error ? error.message : "无法选择本地目录。"));
    }
    return () => window.cancelAnimationFrame(frame);
  }, [desktopMode, guideRepoRequest]);


  const chatModelSettings = useMemo(() => ({ ...aiSettingsSaved, configured: aiSettings.configured }), [aiSettingsSaved, aiSettings.configured]);
  const previewAi = async (mode: AiMode, fileIds?: string[], goal?: string) => {
    if (savedDataClearBusy) return;
    if (desktopBackendError) { setRepoMessage(desktopBackendError); return; }
    if (!aiSettings.configured) { clearAiContext(); dispatchAiWorkflow({ type: "message", message: "请先填写模型服务地址、模型名称和密钥，再预览发送范围。" }); return; }
    const contextKey = aiContextKey;
    const preserveScope = aiWorkflow.mode === mode && aiCandidates.length > 0;
    clearAiContext(preserveScope);
    const requestId = ++aiRequestSequence.current;
    const requestContext = JSON.stringify([contextKey, mode, goal ?? null, fileIds ?? null, graphDirectory, selectedAiRanges]);
    const controller = new AbortController();
    aiAbortController.current = controller;
    dispatchAiWorkflow({ type: "start", requestId, stage: "previewing", contextKey: requestContext, mode, preserveScope });
    try {
      const value = await localExplanationProvider.preview(repository, currentFile.id, mode, fileIds, graphDirectory || undefined, selectedAiRanges, controller.signal, goal);
      if (aiRequestSequence.current !== requestId || aiContextRef.current !== contextKey) return;
      if (value.scopeRequired) {
        const previousFiles = selectedAiFiles.filter((id) => value.candidates.some((file) => file.fileId === id));
        const selectedFiles = previousFiles.includes(currentFile.id) ? previousFiles : [currentFile.id, ...previousFiles];
        const ranges = Object.fromEntries(value.candidates.map((file) => [file.fileId, selectedAiRanges[file.fileId] ?? file.suggestedRange ?? { startLine: 1, endLine: file.lineCount }]));
        dispatchAiWorkflow({ type: "scopeRequired", requestId, contextKey: requestContext, candidates: value.candidates, selectedFiles, ranges, message: `发送范围超过上限（最多 ${value.maxFiles} 个文件、${value.maxCharacters.toLocaleString()} 字符）。请缩小范围后重新预览。` });
        return;
      }
      dispatchAiWorkflow({ type: "previewReady", requestId, contextKey: requestContext, preview: value.preview });
    } catch (error) { if (aiRequestSequence.current === requestId && aiContextRef.current === contextKey && (error as Error).name !== "AbortError") dispatchAiWorkflow({ type: "failed", requestId, contextKey: requestContext, message: error instanceof Error ? error.message : "无法预览发送范围。" }); }
    finally { if (aiAbortController.current === controller) aiAbortController.current = null; }
  };
  const generateAi = async () => {
    const preview = aiPreview;
    if (savedDataClearBusy) return;
    if (desktopBackendError) { setRepoMessage(desktopBackendError); return; }
    if (aiWorkflow.status !== "ready" || !aiWorkflow.mode || !preview || preview.mode !== aiWorkflow.mode || preview.repositoryId !== repository.id || preview.entryFileId !== currentFile.id || preview.revision !== repository.revision) return;
    const savedWorkspaceSession = workspaceSession(repository);
    const contextKey = aiContextKey;
    const requestContext = JSON.stringify([contextKey, preview.id, preview.mode]);
    const requestId = ++aiRequestSequence.current;
    const controller = new AbortController(); aiAbortController.current = controller;
    dispatchAiWorkflow({ type: "start", requestId, stage: "generating", contextKey: requestContext, mode: preview.mode, preview });
    dispatchAiWorkflow({ type: "message", message: "正在生成并检查源码引用…" });
    try {
      const value = await localExplanationProvider.generate(preview, controller.signal);
      if (aiRequestSequence.current !== requestId || aiContextRef.current !== contextKey || value.repositoryId !== repository.id || value.revision !== repository.revision || value.entryFileId !== currentFile.id || value.mode !== preview.mode) return;
      const contextFiles = preview.files.map((file) => ({ fileId: file.fileId, contentHash: file.contentHash }));
      let finalMessage: string;
      if (value.mode === "route") {
        const nextRoute = createAiRouteRecord({
          repositoryId: value.repositoryId,
          entryFileId: value.entryFileId,
          revision: value.revision,
          title: String(value.result.title),
          goal: preview.goal,
          steps: value.result.steps as { fileId: string; purpose: string; references: { fileId: string; startLine: number; endLine?: number }[] }[],
          contextFiles,
        }, (fileId: string) => filesById.get(fileId)?.name ?? fileId);
        setAiRoutesByRepository((previous) => new Map(previous).set(workspaceId, nextRoute));
        const routeSaved = await saveTours([...(savedToursRef.current.get(workspaceId) ?? []).filter((route) => route.signature !== nextRoute.signature), nextRoute]);
        const restoreKey = nodePositionSessionKey(repository);
        if (routeSaved && (!desktopMode || (workspacePersistenceReadyKeys.has(restoreKey) && !workspaceReadFailures.has(restoreKey)))) {
          try {
            const saved = await enqueueWorkspacePersistence(workspaceId, () => localWorkspaceProvider.saveAiRoute(savedWorkspaceSession, nextRoute as AiRouteRecord));
            if (saved && "skipped" in saved && saved.skipped) return;
          }
          catch (error) { setRepoMessage(`路线已生成，但未能保存当前路线：${error instanceof Error ? error.message : "存储不可用。"}`); }
        } else setRepoMessage("阅读路线已生成；保存数据恢复完成前，不会写入本地。");
        if (aiRequestSequence.current !== requestId || aiContextRef.current !== contextKey) return;
        setSearchQuery(""); setCollapsedFolders([]);
        finalMessage = routeSaved ? "AI 阅读路线已生成；选中步骤即可定位文件和源码。" : "路线已生成，但尚未保存。请检查保存提示；原有路线未删除。";
      } else {
        const result: AiResultRecord = { ...value.result, __repositoryId: value.repositoryId, __entryFileId: value.entryFileId, __revision: value.revision, __mode: "explanation", __contextFiles: contextFiles };
        setAiResultsByFile((previous) => new Map(previous).set(`${workspaceId}:${value.entryFileId}`, result));
        if (desktopMode) {
          try {
            const saved = await enqueueWorkspacePersistence(workspaceId, () => localWorkspaceProvider.saveAiResult(savedWorkspaceSession, value.entryFileId, result));
            if (saved && "skipped" in saved && saved.skipped) return;
          }
          catch (error) { setRepoMessage(`讲解已生成，但未能写入桌面保存数据：${error instanceof Error ? error.message : "存储不可用。"}`); }
        }
        if (aiRequestSequence.current !== requestId || aiContextRef.current !== contextKey) return;
        finalMessage = "讲解已生成，引用中的文件和行号已校验。";
      }
      dispatchAiWorkflow({ type: "message", message: finalMessage });
      dispatchAiWorkflow({ type: "succeeded", requestId, contextKey: requestContext, message: finalMessage });
    } catch (error) { if (aiRequestSequence.current === requestId && aiContextRef.current === contextKey) dispatchAiWorkflow({ type: "failed", requestId, contextKey: requestContext, message: error instanceof Error ? error.name === "AbortError" ? "已取消模型请求。" : error.message : "生成失败。" }); }
    finally { if (aiRequestSequence.current === requestId && aiAbortController.current === controller) aiAbortController.current = null; }
  };

  const repositoryHome = <>
    <RepositoryHome clearBlocked={savedDataClearBusy} onRetryClear={clearRetryPending ? () => void retrySavedDataClear() : undefined} path={repoPath} busy={repoBusy || savedDataClearBusy} desktop={desktopMode} message={repoMessage} recentRepositories={recentRepositories} guideButtonRef={guideButtonRef} ready={guideReady} onPathChange={setRepoPath}
      onPickDirectory={() => { void window.repoLens?.selectDirectory().then((selectedPath) => { if (selectedPath) setRepoPath(selectedPath); }).catch((error: unknown) => setRepoMessage(error instanceof Error ? error.message : "无法选择本地目录。")); }}
      onOpen={openRepository} onOpenRecent={(location) => { setRepoPath(location); void openRepositoryPath(location); }} onRemoveRecent={(id) => removeRecentRepository(id)} onTryExample={handleTryExample} onOpenGuide={openUsageGuideFromHome} onOpenSettings={openModelSettingsDialog} />
    <UsageGuidePanel open={guidePanelOpen} completedTaskIds={guidePreferences.completedTaskIds} repositoryName={repository.name} hasDependencies={repository.dependencies.length > 0} hasTour={activeTour.length > 1} canAddNote={repository.source === "local"} returnFocusRef={guideButtonRef} onClose={closeUsageGuidePanel} onStartTask={startUsageGuideTask} onOpenWelcome={openGuideWelcome} onResetProgress={resetUsageGuide} storageMessage={guideStorageMessage} />
    <ModelSettingsDialog open={modelSettingsOpen} available={!desktopBackendError} busy={aiSettingsBusy} configured={aiSettingsSaved.configured} dirty={aiSettingsDirty} values={aiSettingsDraft} readError={currentAiSettingsReadError} saveError={currentAiSettingsSaveError} feedback={aiSettingsFeedback} onChange={(key, value) => editAiSettings({ [key]: value })} onSubmit={saveAiSettings} onClose={closeModelSettingsDialog} />
  </>;

  return (<>
    {guideReady && showGuideWelcome && repositoryHome}
    <main hidden={showGuideWelcome} className={`app-shell${activeTour.length ? "" : " is-analysis-only"}${layoutMode === "reading" ? " is-reading-mode" : ""}${activeTour.length > 0 && !tourBarVisible ? " is-tour-hidden" : ""}`} data-app-ready={guideReady ? "true" : "false"}>
      <a className="skip-link" href="#repository-workspace">跳到仓库工作区</a>
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true"><GitBranch size={17} /></span>
          <span className="brand-name">Repo<span>Lens</span></span>
          <span className="brand-divider" />
          <span className="product-caption">仓库导览</span>
        </div>
        <div className="repo-context">
          <span className="repo-context-icon"><Folder size={15} /></span>
          <span className="repo-context-name">{repository.name}</span>
          <span className="sample-badge"><span />{repository.origin?.kind === "github" ? "GitHub 远端" : repository.source === "local" ? "本地仓库" : "示例仓库"}</span>
          {currentFile.path && <><span className="repo-breadcrumb-separator">/</span><span className="repo-context-file" title={currentFile.path}>{currentFile.path}</span></>}
        </div>
        <div className="topbar-end">
          <div className="workspace-nav-actions" aria-label="源码导航">
            <button type="button" className="repo-action icon-action" aria-label="后退" title="后退（Alt+←）" disabled={navigationHistory.index <= 0} onClick={() => navigateHistory(-1)}><ArrowLeft size={15} /></button>
            <button type="button" className="repo-action icon-action" aria-label="前进" title="前进（Alt+→）" disabled={navigationHistory.index < 0 || navigationHistory.index >= navigationHistory.entries.length - 1} onClick={() => navigateHistory(1)}><ArrowRight size={15} /></button>
            <button type="button" className="repo-action quick-open-action" onClick={() => setQuickOpen(true)} title="快速打开（Ctrl/Cmd+P）"><Search size={14} /><span>快速打开</span><kbd>Ctrl P</kbd></button>
            <div className="layout-switch" aria-label="工作区布局">
              <button type="button" className={layoutMode === "reading" ? "is-active" : ""} aria-pressed={layoutMode === "reading"} onClick={() => { setLayoutMode("reading"); setDetailTab("source"); }}>阅读</button>
              <button type="button" className={layoutMode === "structure" ? "is-active" : ""} aria-pressed={layoutMode === "structure"} onClick={() => { setLayoutMode("structure"); setDetailTab("guide"); }}>结构</button>
            </div>
            {activeTour.length > 0 && <button ref={tourToggleButtonRef} type="button" className={`repo-action route-visibility-trigger${tourBarVisible ? " is-active" : ""}`} aria-label={tourBarVisible ? "收起阅读路线" : "阅读路线"} title={tourBarVisible ? "收起阅读路线" : "阅读路线"} aria-expanded={tourBarVisible} aria-controls="reading-tour-bar" onClick={() => setTourVisibilityOverride({ signature: tourVisibilityKey, open: !tourBarVisible })}><BookOpenText size={14} /><span>{tourBarVisible ? "收起路线" : "阅读路线"}</span></button>}
            <button type="button" className={`repo-action ai-chat-trigger${chatOpen ? " is-active" : ""}`} aria-label={chatOpen ? "关闭 AI 聊天" : "打开 AI 聊天"} title={chatOpen ? "关闭 AI 聊天" : "打开 AI 聊天"} aria-expanded={chatOpen} aria-controls="ai-chat-panel" onClick={() => { if (chatOpen) setChatOpen(false); else openAiChat(); }}><MessageSquare size={14} /><span>AI</span></button>
            <button ref={guideButtonRef} type="button" className="repo-action usage-guide-trigger" aria-label="使用指南" title="使用指南" disabled={!guideReady} onClick={openUsageGuidePanel}><BookOpen size={14} /><span>使用指南</span></button>
          </div>
          <button type="button" className="repo-action settings-trigger" aria-label="模型设置" title="模型设置" onClick={openModelSettingsDialog}><Settings2 size={15} /><span>模型设置</span></button>
          {savedDataClearBusy && repository.source !== "local" && !desktopMode && !browserPreferencesUnsaved && <span className="workspace-save-status is-busy" role="status" aria-label="正在清除本地数据">正在清除本地数据…</span>}
          {(repository.source === "local" || desktopMode || browserPreferencesUnsaved || clearRetryPending) && <><span className={`workspace-save-status is-${saveStatusLabel === "已保存" ? "saved" : saveStatusLabel === "正在恢复数据" || saveStatusLabel === "保存中" || saveStatusLabel === "正在清除" ? "busy" : "memory"}`} role="status" aria-label={`本地保存状态：${saveStatusLabel}`} title={saveStatusDetail}>{saveStatusLabel}</span>{workspaceReadFailures.has(activePersistenceKey) && <button type="button" className="repo-action" disabled={savedDataClearBusy} onClick={() => void retryWorkspaceRestore()}>重试恢复</button>}{clearRetryPending && <button type="button" className="repo-action" disabled={savedDataClearBusy && !clearRetryPending} onClick={() => void retrySavedDataClear()}>重试清除</button>}{!clearRetryPending && (persistenceStatus.phase === "memory" || layoutSaveFailed || browserPreferencesUnsaved) && <button type="button" className="repo-action" disabled={savedDataClearBusy || (!browserPreferencesUnsaved && !layoutSaveFailed && !workspacePersistenceReadyKeys.has(activePersistenceKey))} onClick={() => { if (browserPreferencesUnsaved) retryBrowserPreferences(); if (persistenceStatus.phase === "memory") void retryChatPreferences().catch(() => {}); if (persistenceStatus.phase === "memory" || layoutSaveFailed) void retryReadingArtifactSave(); }}>重试保存</button>}</>}
          <details className="repo-menu" ref={repositoryMenuRef}>
            <summary aria-label="仓库菜单"><Folder size={15} /><span>仓库</span><ChevronDown size={13} /></summary>
            <div className="repo-menu-popover">
              <div className="repo-menu-heading"><strong>{repository.name}</strong><span>{repository.origin?.kind === "github" ? repository.origin.resolvedRef : repository.source === "local" ? "本地仓库" : "内置示例"}</span></div>
              <button type="button" onClick={() => { repositoryMenuRef.current?.removeAttribute("open"); void openRepositoryHome(); }}>返回首页</button>
              <button type="button" onClick={() => { repositoryMenuRef.current?.removeAttribute("open"); openSampleFromMenu(); }}>打开示例</button>
              {repository.source === "local" && <button type="button" disabled={repoBusy || savedDataClearBusy || Boolean(desktopBackendError)} onClick={() => { repositoryMenuRef.current?.removeAttribute("open"); void rescanRepository(); }}>{repository.origin?.kind === "github" ? "检查远端更新" : "重新扫描"}</button>}
              {desktopMode && repository.source === "local" && <button type="button" disabled={repoBusy || savedDataClearBusy || Boolean(desktopBackendError)} onClick={() => { repositoryMenuRef.current?.removeAttribute("open"); void clearCurrentSavedData(); }}>清除此仓库的阅读记录</button>}
              <button type="button" disabled={repoBusy || savedDataClearBusy || Boolean(desktopBackendError)} onClick={() => { repositoryMenuRef.current?.removeAttribute("open"); void clearAllSavedData(); }}>清除全部 RepoLens 保存数据</button>
            </div>
          </details>
        </div>
      </header>
      {desktopBackendError && <div className="desktop-backend-alert" role="alert">本地服务不可用：{desktopBackendError}</div>}
      {guideNoticeAvailable && !guidePreferences.noticeDismissed && <UsageGuideNotice onOpen={openUsageGuidePanel} onDismiss={dismissGuideNotice} />}
      <UsageGuidePanel open={guidePanelOpen} completedTaskIds={guidePreferences.completedTaskIds} repositoryName={repository.name} hasDependencies={repository.dependencies.length > 0} hasTour={activeTour.length > 1} canAddNote={repository.source === "local"} returnFocusRef={guideButtonRef} onClose={closeUsageGuidePanel} onStartTask={startUsageGuideTask} onOpenWelcome={openGuideWelcome} onResetProgress={resetUsageGuide} storageMessage={guideStorageMessage} />
      <ModelSettingsDialog open={modelSettingsOpen} available={!desktopBackendError} busy={aiSettingsBusy} configured={aiSettingsSaved.configured} dirty={aiSettingsDirty} values={aiSettingsDraft} readError={currentAiSettingsReadError} saveError={currentAiSettingsSaveError} feedback={aiSettingsFeedback} onChange={(key, value) => editAiSettings({ [key]: value })} onSubmit={saveAiSettings} onClose={closeModelSettingsDialog} />

      <nav className="mobile-tabs" aria-label="工作区面板">
        <button aria-pressed={mobileView === "files"} className={mobileView === "files" ? "is-active" : ""} onClick={() => setMobileView("files")}>
          <ListTree size={15} />文件
        </button>
        <button aria-pressed={mobileView === "graph"} className={mobileView === "graph" ? "is-active" : ""} onClick={() => { setMobileView("graph"); focusGraphFile(currentFile.id); }}>
          <Waypoints size={15} />依赖图
        </button>
        <button aria-pressed={mobileView === "details"} className={mobileView === "details" ? "is-active" : ""} onClick={() => setMobileView("details")}>
          <BookOpenText size={15} />详情
        </button>
        <button type="button" aria-label="快速打开文件" onClick={() => setQuickOpen(true)}>
          <Search size={15} />打开
        </button>
      </nav>


      <WorkspaceOverview investigationEntry={repository.source === "local" && <InvestigationPanel key={workspaceId} repository={repository} busy={savedDataClearBusy} onOpen={openReference} onRelations={fileId => { setLayoutMode("structure"); selectFile(fileId, "graph"); }} onContinue={investigation => { setChatOpen(true); setChatIntent(previous => ({ id: previous.id + 1, mode: "investigation", investigation })); }} />} clearVersion={questionClearVersion} repository={repository} stepCount={activeTour.length} compact notes={currentReadingNotes} tours={currentSavedTours} results={[...aiResultsByFile.entries()].filter(([key, value]) => key.startsWith(`${workspaceId}:`) && value.__repositoryId === repository.id).map(([, value]) => value)} statusMessage={guideReady && showGuideWelcome ? "" : repoMessage} onDismissMessage={() => setRepoMessage("")} onSelectFile={(fileId) => selectFile(fileId, "details")} />

      <section id="repository-workspace" className={`workspace-grid${layoutMode === "reading" ? " is-reading-mode" : ""}${chatOpen ? " is-chat-open" : ""}`}>
        <div className="workspace-chat-columns" ref={chatContainerRef}>
        <ResizablePanelGroup id="chat-columns" orientation="horizontal" groupRef={chatGroupRef} defaultLayout={{ reader: 100, assistant: 0 }} onLayoutChanged={(layout, meta) => { if (!meta.isUserInteraction || !chatOpen || !chatDocked) return; const width = (chatContainerRef.current?.getBoundingClientRect().width ?? 0) - (chatContainerRef.current?.querySelector(".chat-resize-handle")?.getBoundingClientRect().width ?? 0); if (width) saveWorkspaceLayoutPreferences({ ...workspaceLayoutPreferences, chatWidth: Math.max(320, Math.min(800, Math.round(width * layout.assistant / 100))) }); }}>
        <ResizablePanel id="reader" minSize={chatDocked && chatOpen ? "752px" : 0}><div className="workspace-reader">
        <ResizablePanelGroup
          id="workspace-columns"
          className="workspace-panels"
          orientation="horizontal"
          defaultLayout={workspaceOuterLayout(workspaceLayoutPreferences, layoutMode)}
          groupRef={workspaceOuterGroupRef}
          onLayoutChanged={handleWorkspaceOuterLayoutChanged}
          disabled={savedDataClearBusy || !workspaceLayoutReady}
          data-layout-ready={workspaceLayoutReady ? "true" : "false"}
          data-preferred-layout={JSON.stringify(workspaceOuterLayout(workspaceLayoutPreferences, layoutMode))}
          resizeTargetMinimumSize={{ fine: 12, coarse: 30 }}
        >
        <ResizablePanel id="files" style={{ overflow: "hidden" }} className={`workspace-panel-content${narrowLayout && mobileView !== "files" ? " mobile-panel-hidden" : ""}`} defaultSize={layoutMode === "reading" ? "28%" : "22%"} minSize={180}>
          <DirectoryPanel
          repository={repository}
          mobileView={mobileView}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          selectedFileId={selectedFileId}
          collapsedFolders={collapsedFolders}
          onToggleFolder={(path) => setCollapsedFolders((previous) => previous.includes(path) ? previous.filter((item) => item !== path) : [...previous, path])}
          onSelectFile={(file) => selectFile(file.id, "details")}
          onOpenSearchResult={(fileId, line) => openReference({ fileId, line })}
          onAddSearchResult={(fileIds) => {
            const targetWorkspaceId = repositoryWorkspaceId(repository);
            const nextFileIds = [...new Set([...(searchQuestionScope.workspaceId === targetWorkspaceId ? searchQuestionScope.fileIds : []), ...fileIds])];
            if (nextFileIds.length > 12) { setRepoMessage("问答范围最多包含 12 个文件。请减少已选文件后再添加。"); return; }
            setSearchQuestionScope({ workspaceId: targetWorkspaceId, fileIds: nextFileIds });
            const firstFileId = fileIds[0];
            if (firstFileId) { selectFile(firstFileId, "details"); openAiChat("question"); }
          }}
          searchInputRef={searchInputRef}
          />
        </ResizablePanel>
        <ResizableHandle id="files-graph-resize" className="workspace-resize-handle" disableDoubleClick onDoubleClick={resetWorkspaceColumnLayout} title={layoutMode === "reading" ? "拖动调整文件目录与源码详情宽度；双击恢复默认宽度" : "拖动调整文件目录与结构区域宽度；双击恢复默认宽度"} aria-label={layoutMode === "reading" ? "调整文件目录与源码详情宽度" : "调整文件目录与结构区域宽度"} />

        <ResizablePanel id="content" style={{ overflow: "hidden" }} className={`workspace-panel-content${narrowLayout && mobileView === "files" ? " mobile-panel-hidden" : ""}`} defaultSize={layoutMode === "reading" ? "72%" : "78%"} minSize={layoutMode === "structure" ? 572 : 280}>
          <ResizablePanelGroup
            id="workspace-graph-details"
            className="workspace-details-panels"
            orientation="horizontal"
            defaultLayout={workspaceInnerLayout(workspaceLayoutPreferences, layoutMode)}
            groupRef={workspaceInnerGroupRef}
            onLayoutChanged={handleWorkspaceInnerLayoutChanged}
            disabled={layoutMode === "reading" || savedDataClearBusy || !workspaceLayoutReady}
            resizeTargetMinimumSize={{ fine: 12, coarse: 30 }}
          >
        <ResizablePanel id="graph" style={{ overflow: "hidden" }} className={`workspace-panel-content${narrowLayout && mobileView !== "graph" ? " mobile-panel-hidden" : ""}`} defaultSize="61.54%" minSize={280}>
          <GraphPanel highlightedFileIds={chatGraphTarget === `${workspaceId}:${repository.revision}:${chatClearAllVersion}:${chatClearVersions[workspaceId] ?? 0}` ? chatGraphIds : []} onAnalyze={(ids, label) => { setChatOpen(true); setChatIntent(previous => ({ id: previous.id + 1, mode: "question", sessionId: repository.persistenceSessionId, draft: `请分析这些静态依赖关系：${label}。请区分静态引用与推断。`, attachments: ids.map(id => ({ fileId: id, contentHash: filesById.get(id)?.contentHash ?? "" })) })); }}
          mobileView={mobileView}
          directory={graphDirectory}
          directories={graphDirectories}
          graphLabel={!showAllGraph ? `当前文件及其直接关联 · ${graphVisibleCount}/${graphCandidateCount} 个节点` : `${scopedGraphFiles.length} 个文件 · ${repository.dependencies.filter((edge) => scopedGraphIds.has(edge.fromId) && scopedGraphIds.has(edge.toId)).length} 条静态引用`}
          scopedFileCount={scopedGraphFiles.length}
          hiddenCount={graphHiddenCount}
          showAll={showAllGraph}
          graphReady={graphReady}
          graphActive={graphCanMount}
          disabled={savedDataClearBusy}
          canvasRef={graphCanvasRef}
          nodes={nodes}
          edges={edges}
          repository={repository}
          currentFileId={currentFile.id}
          onOpenReference={openReference}
          onNodesChange={onNodesChange}
          onNodeClick={handleNodeClick}
          onInit={setFlow}
          onDirectoryChange={(directory) => {
            const scopedFiles = repository.files.filter((file) => !directory || file.id.startsWith(`${directory}/`)).sort((a, b) => a.path.localeCompare(b.path));
            const target = scopedFiles.some((file) => file.id === currentFile.id) ? currentFile : scopedFiles[0];
            clearAiContext(); setShowAllGraph(false);
            dispatchNavigation({ type: "directory-select", value: directory, fileId: target?.id ?? "", preserveFocus: target?.id === currentFile.id });
            setMobileView("graph"); setSearchQuery("");
            if (target && target.id !== currentFile.id) { setDetailTab("guide"); focusTreeFile(target.id); }
            if (target) focusGraphFile(target.id);
          }}
          onToggleScope={toggleGraphScope}
          onLocateCurrent={locateCurrentGraph}
          onResetLayout={resetGraph}
          />
        </ResizablePanel>
        <ResizableHandle id="graph-details-resize" className="workspace-resize-handle" disableDoubleClick onDoubleClick={resetWorkspaceColumnLayout} title="拖动调整依赖图与源码详情宽度；双击恢复默认宽度" aria-label="调整依赖图与源码详情宽度" />

        <ResizablePanel id="details" style={{ overflow: "hidden" }} className={`workspace-panel-content${narrowLayout && mobileView !== "details" ? " mobile-panel-hidden" : ""}`} defaultSize="30%" minSize={280}>
          <FileDetailsPanel
          repository={repository}
          backendAvailable={!desktopBackendError}
          currentFile={currentFile}
          filesById={filesById}
          mobileView={mobileView}
          detailTab={detailTab}
          savedDataClearGeneration={savedDataClearGeneration}
          savedDataClearBusy={savedDataClearBusy}
          onDetailTabChange={setDetailTab}
          onOpenAi={() => openAiChat("question")}
          onOpenReference={openReference}
          aiSettings={aiSettings}
          onOpenModelSettings={openModelSettingsDialog}
          onOpenRepository={() => { void openRepositoryHome(); }}
          canOpenRepository={guideReady && !repoBusy && !savedDataClearBusy}
          onChatSelection={(start, end) => {
            if (end < 0) { openReference({ fileId: currentFile.id, line: start, endLine: -end }); setDetailTab("guide"); requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[aria-label="阅读笔记内容"]')?.focus()); return; }
            setChatOpen(true); setChatIntent(previous => ({ id: previous.id + 1, mode: "question", sessionId: repository.persistenceSessionId, ...(start < 0 ? { draft: "解释这段代码" } : {}), attachments: [{ fileId: currentFile.id, contentHash: currentFile.contentHash ?? "", startLine: Math.abs(start), endLine: end }] }));
          }}
          onPreviewAi={(mode) => openAiChat(mode)}
          aiBusy={aiBusy}
          aiPreview={aiPreview}
          aiCandidates={aiCandidates}
          pendingAiMode={pendingAiMode}
          selectedAiFiles={selectedAiFiles}
          selectedAiRanges={selectedAiRanges}
          onToggleAiFile={(fileId, checked) => changeAiScope(checked ? [...new Set([...selectedAiFiles, fileId])] : selectedAiFiles.filter((id) => id !== fileId), selectedAiRanges)}
          onAiRangeChange={(fileId, range) => changeAiScope(selectedAiFiles, { ...selectedAiRanges, [fileId]: range })}
          onGenerateAi={generateAi}
          onCancelAi={() => { clearAiContext(); dispatchAiWorkflow({ type: "message", message: aiBusy ? "已取消模型请求。" : "已取消发送范围确认。" }); }}
          aiMessage={aiMessage}
          aiResult={aiResult}
          aiStale={aiStale}
          sourceText={sourceText}
          sourceStatus={sourceStatus}
          sourceError={sourceLoad?.message}
          focusedLine={focusedLine}
          onClearFocus={() => setFocusedLine(null)}
          codeViewportRef={codeViewportRef}
          readingNotes={currentReadingNotes}
          savedTours={currentSavedTours}
          sessionVersion={repositorySessionVersion}
          onSaveReadingNotes={saveReadingNotes}
          onSaveTours={saveTours}
          onActivateTour={activateSavedTour}
          onGuideNoteCreated={() => completeGuideTask("note")}
          />
        </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
        </ResizablePanelGroup>
        </div>
        </ResizablePanel>
        <ResizableHandle className="workspace-resize-handle chat-resize-handle" hidden={!chatOpen || !chatDocked} aria-label="调整 AI 栏宽度" title="拖动调整 AI 栏宽度；双击恢复默认" onDoubleClick={() => saveWorkspaceLayoutPreferences({ ...workspaceLayoutPreferences, chatWidth: 360 })} />
        <ResizablePanel id="assistant" minSize={chatOpen && chatDocked ? "320px" : 0} maxSize={chatOpen && chatDocked ? "45%" : 0}>
        <div className="ai-chat-drawer" hidden={!chatOpen}>
          <AiChatSidebar onShowGraph={ids => { setChatGraphTarget(`${workspaceId}:${repository.revision}:${chatClearAllVersion}:${chatClearVersions[workspaceId] ?? 0}`); setChatGraphIds(ids); setLayoutMode("structure"); setMobileView("graph"); }} savedTourSignatures={(savedToursByWorkspace.get(workspaceId) ?? []).map(route => route.signature)} onSaveTour={route => saveTours([...(savedToursRef.current.get(workspaceId) ?? []).filter(item => item.signature !== route.signature), route])} onRelations={fileId => { setLayoutMode("structure"); selectFile(fileId, "graph"); }} open={chatOpen} repository={repository} currentFile={currentFile} intent={chatIntent} available={!desktopBackendError} clearingTarget={chatClearingTarget} clearVersions={chatClearVersions} clearAllVersion={chatClearAllVersion} extraFileIds={questionExtraFileIds} modelSettings={chatModelSettings} onClose={() => setChatOpen(false)} onSettings={openModelSettingsDialog} onOpenRepository={() => { void openRepositoryHome(); }} onOpenReference={openReference} onActivateTour={activateSavedTour} onCompleted={(id) => { if (id !== workspaceId) return; const completionSession = repositorySessionVersion; const completionGeneration = savedDataClearGenerationRef.current; void localWorkspaceProvider.get(id).then((saved) => { if (saved.persistenceReady === false || savedDataClearActiveRef.current || completionGeneration !== savedDataClearGenerationRef.current || completionSession !== settingsSessionRef.current.sessionVersion || repository.id !== settingsSessionRef.current.repositoryId) return; setAiResultsByFile((previous) => { const next = new Map(previous); for (const [fileId, result] of Object.entries(saved.aiResults)) next.set(`${id}:${fileId}`, result as AiResultRecord); return next; }); setSavedToursByWorkspace((previous) => { const next = new Map(previous); const journal = readingArtifactJournals.current.get(id) ?? createReadingArtifactJournal<ReadingNote, AiRouteRecord>(); const merged = applyReadingArtifactJournal(saved.savedTours ?? [], journal, "tours"); next.set(id, merged); savedToursRef.current = next; return next; }); }).catch(() => {}); }} />
        </div>
        </ResizablePanel></ResizablePanelGroup></div>
      </section>

      <TourBar
        id="reading-tour-bar"
        hidden={activeTour.length > 0 && !tourBarVisible}
        repository={activeTour === repository.tour ? repository : { ...repository, tour: activeTour }}
        stepIndex={tourIndex}
        completedSteps={completedSteps}
        stepsRef={tourStepsRef}
        disabled={aiRouteStale || savedDataClearBusy}
        onGoToStep={goToStep}
        onComplete={() => {
          if (!currentTour) return;
          setCompletedSteps((previous) => previous.includes(currentTour.id) ? previous : [...previous, currentTour.id]);
          setTourVisibilityOverride({ signature: tourVisibilityKey, open: false });
        }}
        onReset={() => {
          resetTour();
          setTourVisibilityOverride({ signature: tourVisibilityKey, open: true });
        }}
        onOpenReference={openTourReference}
      />
      <QuickOpenDialog open={quickOpen} files={repository.files} onOpenChange={setQuickOpen} onSelectFile={(file) => selectFile(file.id, "details")} />
    </main></>
  );
}

export default function Home() {
  return <ReactFlowProvider><AppShell /></ReactFlowProvider>;
}
