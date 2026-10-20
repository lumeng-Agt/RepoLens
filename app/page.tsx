"use client";

import {
  MarkerType,
  ReactFlowProvider,
  type Edge,
  type ReactFlowInstance,
  useNodesState,
} from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import { separateOverlappingGraphNodes } from "@/data/graph-layout.mjs";
import {
  BookOpenText,
  ArrowLeft,
  ArrowRight,
  Folder,
  GitBranch,
  ListTree,
  Search,
  Waypoints,
  Sparkles,
  BookOpen,
} from "lucide-react";
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
import { parseTourProgress } from "@/data/tour-progress.mjs";
import { createProgressSessionGate } from "@/data/progress-session.mjs";
import { clearAllQuestionConversations, clearQuestionConversationWorkspace } from "@/data/question-recovery.mjs";
import { enqueueWorkspacePersistence } from "@/data/workspace-persistence.mjs";
import { acknowledgeReadingArtifactJournal, applyReadingArtifactJournal, createReadingArtifactJournal, hasReadingArtifactOperations, readingArtifactJournalCheckpoint, stageReadingArtifactChanges, type ReadingArtifactJournal } from "@/data/reading-artifact-journal.mjs";
import { useWorkspacePersistenceStatus } from "@/data/useWorkspacePersistenceStatus";
import { emptyNavigationHistory, moveNavigationHistory, pushNavigationHistory } from "@/data/navigation-history.mjs";
import { initialNavigationState, navigationReducer, type StateUpdate } from "@/data/navigation-state.mjs";
import { QuickOpenDialog } from "@/components/repolens/QuickOpenDialog";
import { UsageGuideNotice, UsageGuidePanel, UsageGuideWelcome } from "@/components/repolens/UsageGuide";
import { completeUsageGuideTask, createDefaultUsageGuidePreferences, hasExistingBrowserUse, hasExistingWorkspaceUse, normalizeUsageGuidePreferences, type UsageGuidePreferences, type UsageGuideTaskId } from "@/data/usage-guide.mjs";
import type {
  FileRecord,
  AiPreview,
  RepositorySnapshot,
  ReadingNote,
  SourceReference,
  AiRouteRecord,
  TourStep,
} from "@/data/model";
import "@xyflow/react/dist/style.css";

type MobileView = "files" | "graph" | "details";
const progressMemory = new Map<string, string>();
const USAGE_GUIDE_STORAGE_KEY = "repolens:usage-guide:v1";

const BOOT_SNAPSHOT: RepositorySnapshot = { id: "sample-loading", version: "loading", name: "RepoLens", description: "正在载入示例仓库", files: [], dependencies: [], tour: [], source: "sample" };

function routeSignature(tour: TourStep[]) {
  const value = JSON.stringify(tour.map((step) => [step.title, step.focusFileId, step.description, step.reference.fileId, step.reference.line, step.reference.endLine ?? null]));
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(36);
}
function repositoryWorkspaceId(repository: RepositorySnapshot) { return repository.workspaceId ?? repository.id; }
function nodePositionSessionKey(repository: RepositorySnapshot) { return repositoryWorkspaceId(repository) + ":" + (repository.persistenceSessionId ?? repository.id); }
function nodePositionSignature(positions: Record<string, { x: number; y: number }>) {
  return JSON.stringify(Object.fromEntries(Object.entries(positions).sort(([left], [right]) => left.localeCompare(right))));
}
function workspaceSession(repository: RepositorySnapshot): WorkspaceSession {
  return { repositoryId: repository.id, workspaceId: repositoryWorkspaceId(repository), persistenceSessionId: repository.persistenceSessionId };
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

function stageBrowserProgressClear(workspaceId?: string) {
  const localPrefix = workspaceId ? `repolens:${workspaceId}:` : "repolens:";
  const cookiePrefix = workspaceId ? `repolens_${workspaceId.replaceAll(/[^a-zA-Z0-9_-]/g, "_")}_` : "repolens_";
  const localEntries: [string, string][] = [];
  const cookieEntries: [string, string][] = [];
  for (const key of Object.keys(window.localStorage)) {
    if (!key.startsWith(localPrefix)) continue;
    const value = window.localStorage.getItem(key);
    if (value !== null) localEntries.push([key, value]);
  }
  for (const part of document.cookie.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name.startsWith(cookiePrefix)) cookieEntries.push([name, value.join("=")]);
  }
  const restore = () => {
    for (const [key, value] of localEntries) window.localStorage.setItem(key, value);
    for (const [name, value] of cookieEntries) document.cookie = `${name}=${value}; Path=/; Max-Age=31536000; SameSite=Lax`;
  };
  try {
    for (const [key] of localEntries) window.localStorage.removeItem(key);
    for (const [name] of cookieEntries) document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
    const remainingLocal = localEntries.some(([key]) => window.localStorage.getItem(key) !== null);
    const remainingCookies = cookieEntries.some(([name]) => document.cookie.split(";").some((part) => part.trim().startsWith(`${name}=`)));
    if (remainingLocal || remainingCookies) throw new Error("浏览器中的阅读进度未能清除。");
  } catch (error) {
    try { restore(); } catch { /* Keep the original clearing error and report it to the user. */ }
    throw new Error(`无法清除浏览器中的阅读进度：${error instanceof Error ? error.message : String(error)}`);
  }
  return restore;
}

function traceProgress(event: string, key: string, generation: number, details: Record<string, string | number | null> = {}) {
  if (typeof window === "undefined" || new URLSearchParams(window.location.search).get("repolensDebugProgress") !== "1") return;
  window.dispatchEvent(new CustomEvent("repolens:progress-trace", { detail: { event, key, generation, ...details, at: performance.now() } }));
}

function layoutGraph(
  snapshot: RepositorySnapshot,
  selectedId: string,
  showAll = false,
  compact = false,
  directory = "",
  nodePositions: Map<string, { x: number; y: number }> = new Map(),
): { nodes: GraphNode[]; edges: Edge[] } {
  const inDirectory = (id: string) => !directory || id.startsWith(`${directory}/`);
  const scopedFiles = snapshot.files.filter((file) => inDirectory(file.id));
  const scopedIds = new Set(scopedFiles.map((file) => file.id));
  const neighborhood = [...new Set(snapshot.dependencies.filter((edge) => scopedIds.has(edge.fromId) && scopedIds.has(edge.toId) && (edge.fromId === selectedId || edge.toId === selectedId)).flatMap((edge) => [edge.fromId, edge.toId]))].filter((id) => id !== selectedId).sort((a, b) => a.localeCompare(b));
  const visibleIds = showAll ? scopedIds : new Set([selectedId, ...neighborhood].slice(0, 100));
  const visibleFiles = snapshot.files.filter((file) => visibleIds.has(file.id));
  const visibleDependencies = snapshot.dependencies.filter((edge) => visibleIds.has(edge.fromId) && visibleIds.has(edge.toId));
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: compact ? "TB" : "LR", nodesep: compact ? 8 : 38, ranksep: compact ? 28 : 74, marginx: compact ? 10 : 34, marginy: compact ? 12 : 32 });

  for (const file of visibleFiles) {
    graph.setNode(file.id, { width: compact ? 140 : 160, height: compact ? 60 : 68 });
  }
  for (const dependency of visibleDependencies) {
    graph.setEdge(dependency.fromId, dependency.toId);
  }
  dagre.layout(graph);

  const nodes: GraphNode[] = visibleFiles.map((file) => {
    const position = graph.node(file.id);
    return {
      id: file.id,
      type: "fileCard",
      deletable: false,
      measured: { width: compact ? 140 : 160, height: compact ? 60 : 68 },
      position: nodePositions.get(`${repositoryWorkspaceId(snapshot)}:${file.id}`) ?? { x: position.x - (compact ? 70 : 80), y: position.y - (compact ? 30 : 34) },
      data: { file, selected: file.id === selectedId, compact },
      selected: file.id === selectedId,
    };
  });

  const edges: Edge[] = visibleDependencies.map((dependency) => {
    const importsFromCurrent = dependency.fromId === selectedId;
    const importsCurrent = dependency.toId === selectedId;
    const connected = importsFromCurrent || importsCurrent;
    return {
      id: dependency.id,
      deletable: false,
      source: dependency.fromId,
      target: dependency.toId,
      type: "smoothstep",
      animated: false,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: importsFromCurrent ? "var(--thread-outgoing)" : importsCurrent ? "var(--thread-incoming)" : "var(--border-strong)" },
      style: {
        stroke: importsFromCurrent ? "var(--thread-outgoing)" : importsCurrent ? "var(--thread-incoming)" : "var(--border-strong)",
        strokeWidth: connected ? 1.8 : 1.15,
        opacity: connected ? 1 : 0.2,
      },
    };
  });
  return { nodes, edges };
}

const EMPTY_FILE: FileRecord = { id: "", path: "", name: "没有源码文件", kind: "typescript", role: "空仓库", summary: "添加 JS/TS 源码后重新扫描。", imports: [] };

function AppShell() {
  const [repository, setRepository] = useState<RepositorySnapshot>(BOOT_SNAPSHOT);
  const [recentRepositories, setRecentRepositories] = useState<LocalWorkspaceState["recentRepositories"]>([]);
  const repositoryCommandIssuer = useRef<{ clientId: string; intentSequence: number } | null>(null);
  if (repositoryCommandIssuer.current == null) repositoryCommandIssuer.current = { clientId: globalThis.crypto.randomUUID(), intentSequence: 0 };
  const nextRepositoryCommand = (): RepositoryCommand => {
    const issuer = repositoryCommandIssuer.current!;
    issuer.intentSequence += 1;
    return { clientId: issuer.clientId, intentSequence: issuer.intentSequence };
  };
  const isCurrentRepositoryCommand = (command: RepositoryCommand) => repositoryCommandIssuer.current?.clientId === command.clientId && repositoryCommandIssuer.current.intentSequence === command.intentSequence;
  const repositoryGate = useRef(createRepositorySessionGate());
  const repositoryReads = useRef(new Set<AbortController>());
  const openRequestGate = useRef(createOpenRequestGate());
  const openRequestController = useRef<AbortController | null>(null);
  const [repositorySessionVersion, setRepositorySessionVersion] = useState(0);
  const applyUpdatedSnapshotRef = useRef<(snapshot: RepositorySnapshot, epoch: number) => boolean>(() => false);
  const beginRepositorySession = useCallback(() => {
    for (const controller of repositoryReads.current) controller.abort();
    repositoryReads.current.clear();
    return repositoryGate.current.begin();
  }, []);
  const [navigation, dispatchNavigation] = useReducer(navigationReducer, initialNavigationState);
  const { selectedFileId, tourIndex, focusedLine, focusOrigin, focusRouteSignature, completedSteps, graphDirectory } = navigation;
  const setSelectedFileId = useCallback((value: StateUpdate<string>) => dispatchNavigation({ type: "select", value }), []);
  const setTourIndex = useCallback((value: StateUpdate<number>) => dispatchNavigation({ type: "tour", value }), []);
  const setFocusedLine = useCallback((value: StateUpdate<SourceReference | null>) => dispatchNavigation({ type: "reference", value }), []);
  const setCompletedSteps = useCallback((value: StateUpdate<string[]>) => dispatchNavigation({ type: "completed", value }), []);
  const setGraphDirectory = useCallback((value: string) => dispatchNavigation({ type: "directory", value }), []);
  const [detailTab, setDetailTab] = useState("guide");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchQuestionScope, setSearchQuestionScope] = useState<{ workspaceId: string; fileIds: string[] }>({ workspaceId: "", fileIds: [] });
  const questionExtraFileIds = searchQuestionScope.workspaceId === repositoryWorkspaceId(repository) ? searchQuestionScope.fileIds : [];
  const [quickOpen, setQuickOpen] = useState(false);
  const [layoutMode, setLayoutMode] = useState<"structure" | "reading">("structure");
  const [navigationHistory, setNavigationHistory] = useState(emptyNavigationHistory);
  const [repoPath, setRepoPath] = useState("");
  const [desktopMode] = useState(() => Boolean(globalThis.__REPOLENS_RUNTIME__?.desktop));
  const [guidePreferences, setGuidePreferences] = useState<UsageGuidePreferences>(() => createDefaultUsageGuidePreferences());
  const guidePreferencesRef = useRef(guidePreferences);
  const [guideReady, setGuideReady] = useState(false);
  const guidePersistenceAllowedRef = useRef(false);
  const [guideStorageMessage, setGuideStorageMessage] = useState("");
  const [showGuideWelcome, setShowGuideWelcome] = useState(false);
  const [guidePanelOpen, setGuidePanelOpen] = useState(false);
  const [guideNoticeAvailable, setGuideNoticeAvailable] = useState(false);
  const [guideRepoRequest, setGuideRepoRequest] = useState(0);
  const guideButtonRef = useRef<HTMLButtonElement>(null);
  const guideInitializedRef = useRef(false);
  const guideSaveSequenceRef = useRef(0);
  const guideWriteQueueRef = useRef<Promise<void>>(Promise.resolve());
  const closeRepositoryRef = useRef<() => Promise<void>>(async () => {});
  const guideTourPracticeRef = useRef<{ workspaceId: string; sessionVersion: number; origin: { fileId: string; line?: number }; destination: { fileId: string; line: number }; visited: boolean; returned: boolean } | null>(null);
  const guideNavigationRef = useRef<{ repositoryId: string; sessionVersion: number; fileId: string; dependency: boolean } | null>(null);
  const [desktopBackendError, setDesktopBackendError] = useState("");
  const [repoBusy, setRepoBusy] = useState(false);
  const [savedDataClearBusy, setSavedDataClearBusy] = useState(false);
  const [savedDataClearGeneration, setSavedDataClearGeneration] = useState(0);
  const savedDataClearGenerationRef = useRef(0);
  const savedDataClearActiveRef = useRef(false);
  const [questionClearVersion, setQuestionClearVersion] = useState(0);
  const [repoMessage, setRepoMessage] = useState("");
  const [loadedSource, setLoadedSource] = useState<{ fileId: string; repositoryId: string; revision?: string; text: string } | null>(null);
  const [sourceLoad, setSourceLoad] = useState<{ key: string; status: "loading" | "loaded" | "error"; message?: string } | null>(null);
  const [aiSettingsDraft, setAiSettingsDraft] = useState({ baseUrl: "", model: "", apiKey: "" });
  const [aiSettingsSaved, setAiSettingsSaved] = useState({ baseUrl: "", model: "", configured: false });
  const [aiSettingsDirty, setAiSettingsDirty] = useState(false);
  const [aiSettingsReadError, setAiSettingsReadError] = useState<{ repositoryId: string; sessionVersion: number; message: string } | null>(null);
  const [aiSettingsSaveError, setAiSettingsSaveError] = useState<{ repositoryId: string; sessionVersion: number; message: string } | null>(null);
  const aiSettingsDirtyRef = useRef(false);
  const [aiSettingsReadySession, setAiSettingsReadySession] = useState<{ repositoryId: string; sessionVersion: number } | null>(null);
  const [aiSettingsBusy, setAiSettingsBusy] = useState(false);
  const [aiResultsByFile, setAiResultsByFile] = useState<Map<string, AiResultRecord>>(() => new Map());
  const [aiRoutesByRepository, setAiRoutesByRepository] = useState<Map<string, AiRouteRecord>>(() => new Map());
  const [readingNotesByWorkspace, setReadingNotesByWorkspace] = useState<Map<string, ReadingNote[]>>(() => new Map());
  const readingNotesRef = useRef(readingNotesByWorkspace);
  useLayoutEffect(() => { readingNotesRef.current = readingNotesByWorkspace; }, [readingNotesByWorkspace]);
  const [savedToursByWorkspace, setSavedToursByWorkspace] = useState<Map<string, AiRouteRecord[]>>(() => new Map());
  const savedToursRef = useRef(savedToursByWorkspace);
  useLayoutEffect(() => { savedToursRef.current = savedToursByWorkspace; }, [savedToursByWorkspace]);
  const readingArtifactJournals = useRef(new Map<string, ReadingArtifactJournal<ReadingNote, AiRouteRecord>>());
  const [aiWorkflow, dispatchAiWorkflow] = useReducer(aiWorkflowReducer, initialAiWorkflowState);
  const { aiMessage, pendingAiMode, aiPreview, aiCandidates, selectedAiFiles, selectedAiRanges } = {
    aiMessage: aiWorkflow.message,
    pendingAiMode: ["ready", "error"].includes(aiWorkflow.status) && aiWorkflow.candidates.length ? aiWorkflow.mode as AiMode : null,
    aiPreview: aiWorkflow.preview as AiPreview | null,
    aiCandidates: aiWorkflow.candidates as AiScopeCandidate[],
    selectedAiFiles: aiWorkflow.selectedFiles as string[],
    selectedAiRanges: aiWorkflow.ranges as Record<string, AiLineRange>,
  };
  const currentAiSettingsReadError = aiSettingsReadError?.repositoryId === repository.id && aiSettingsReadError.sessionVersion === repositorySessionVersion ? aiSettingsReadError.message : null;
  const currentAiSettingsSaveError = aiSettingsSaveError?.repositoryId === repository.id && aiSettingsSaveError.sessionVersion === repositorySessionVersion ? aiSettingsSaveError.message : null;
  const aiBusy = aiWorkflow.status === "previewing" || aiWorkflow.status === "generating";
  const aiSettingsSessionReady = repository.source !== "local" || (aiSettingsReadySession?.repositoryId === repository.id && aiSettingsReadySession.sessionVersion === repositorySessionVersion);
  const aiSettings = {
    ...aiSettingsDraft,
    configured: aiSettingsSaved.configured && !aiSettingsDirty && aiSettingsSessionReady && !aiSettingsBusy,
  };
  const persistGuidePreferences = useCallback((preferences: UsageGuidePreferences): Promise<boolean> => {
    if (!guidePersistenceAllowedRef.current) return Promise.resolve(false);
    if (!desktopMode) {
      try {
        window.localStorage.setItem(USAGE_GUIDE_STORAGE_KEY, JSON.stringify(preferences));
        setGuideStorageMessage("");
        return Promise.resolve(true);
      } catch (error) {
        guidePersistenceAllowedRef.current = false;
        setGuideStorageMessage(`使用指南只保存在当前页面：${error instanceof Error ? error.message : "浏览器存储不可用。"}`);
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
      if (requestId === guideSaveSequenceRef.current) setGuideStorageMessage(`使用指南只保存在当前页面：${error.message}`);
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
      setGuideStorageMessage(warning ?? (invalidStoredValue ? "使用指南记录格式无效；为保护原记录，本次只在内存中使用。" : "使用指南记录读取失败；本次只在内存中使用。"));
    } else if (!present && hasExistingUse) {
      next = { ...next, welcomeHandled: true, noticeDismissed: false };
      setGuideNoticeAvailable(true);
    }
    guidePreferencesRef.current = next;
    setGuidePreferences(next);
    guidePersistenceAllowedRef.current = !blocked;
    setShowGuideWelcome(!next.welcomeHandled);
    setGuideNoticeAvailable(next.welcomeHandled && !next.noticeDismissed);
    setGuidePanelOpen(next.checklistOpen);
    setGuideReady(true);
    if (!blocked && !present && hasExistingUse) void persistGuidePreferences(next);
  }, [persistGuidePreferences]);
  const completeGuideTask = useCallback((task: UsageGuideTaskId) => {
    updateGuidePreferences((previous) => completeUsageGuideTask(previous, task));
  }, [updateGuidePreferences]);
  const [aiSettingsRevision, setAiSettingsRevision] = useState(0);
  const aiSettingsDraftRevision = useRef(0);
  const aiSettingsSaveSequence = useRef(0);
  const aiSettingsReadSequence = useRef(0);
  const aiSettingsBusyRef = useRef(false);
  const settingsSessionRef = useRef({ repositoryId: repository.id, sessionVersion: repositorySessionVersion });
  const aiRequestSequence = useRef(0);
  const aiAbortController = useRef<AbortController | null>(null);
  const aiContextRef = useRef("");
  const [mobileView, setMobileView] = useState<MobileView>("graph");
  const [narrowLayout, setNarrowLayout] = useState(false);
  const tourStepsRef = useRef<HTMLDivElement>(null);
  const [collapsedFolders, setCollapsedFolders] = useState<string[]>([]);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [showAllGraph, setShowAllGraph] = useState(false);
  const [compactGraph, setCompactGraph] = useState(false);
  const compactGraphRef = useRef(compactGraph);
  useLayoutEffect(() => { compactGraphRef.current = compactGraph; }, [compactGraph]);
  const [flow, setFlow] = useState<ReactFlowInstance<GraphNode> | null>(null);
  const layoutOwner = useRef({ version: 0, repositoryId: BOOT_SNAPSHOT.id });
  const graphCanvasRef = useRef<HTMLDivElement>(null);
  const [nodePositions, setNodePositions] = useState(new Map<string, { x: number; y: number }>());
  const nodePositionsRef = useRef(nodePositions);
  useLayoutEffect(() => { nodePositionsRef.current = nodePositions; }, [nodePositions]);
  const graphNodeDragging = useRef(false);
  const graphLayoutAnchor = useRef<string | undefined>(undefined);
  const nodePositionsPersisted = useRef(new Map<string, string>());
  const dirtyNodePositions = useRef(new Map<string, Set<string>>());
  const pendingNodePositionRestore = useRef<{ key: string; workspaceId: string; signature: string } | null>(null);
  const [nodePositionsReadyKey, setNodePositionsReadyKey] = useState<string | null>(null);
  const [workspacePersistenceReadyKeys, setWorkspacePersistenceReadyKeys] = useState(new Set<string>());
  const [workspaceReadFailures, setWorkspaceReadFailures] = useState(new Set<string>());
  const [graphReady, setGraphReady] = useState(false);
  const [graphSizeRevision, setGraphSizeRevision] = useState(0);
  const graphResizeRequest = useRef(0);
  const codeViewportRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const filesById = useMemo(() => new Map(repository.files.map((file) => [file.id, file])), [repository.files]);
  const workspaceId = repositoryWorkspaceId(repository);
  const currentReadingNotes = readingNotesByWorkspace.get(workspaceId) ?? [];
  const currentSavedTours = savedToursByWorkspace.get(workspaceId) ?? [];
  const persistenceStatus = useWorkspacePersistenceStatus(workspaceId);
  const activePersistenceKey = nodePositionSessionKey(repository);
  const saveStatusLabel = savedDataClearBusy ? "正在清除" : workspaceReadFailures.has(activePersistenceKey) || persistenceStatus.phase === "memory" ? "仅在内存" : !workspacePersistenceReadyKeys.has(activePersistenceKey) ? "正在恢复" : persistenceStatus.phase === "saving" ? "保存中" : persistenceStatus.phase === "clearing" ? "正在清除" : "已保存";
  const saveStatusDetail = workspaceReadFailures.has(activePersistenceKey) ? "读取保存数据失败，尚未确认磁盘记录；本页修改没有覆盖原数据。" : persistenceStatus.error || (saveStatusLabel === "仅在内存" ? "本页修改尚未确认写入磁盘。" : saveStatusLabel);
  const activeNodePositionKeyRef = useRef(nodePositionSessionKey(repository));
  useLayoutEffect(() => { activeNodePositionKeyRef.current = nodePositionSessionKey(repository); }, [repository]);
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
  const aiRouteStale = aiRoute ? Boolean(aiRoute.stale) || aiContextIsStale(aiRoute.contextFiles, repository) : false;
  const activeTour = aiRoute?.steps ?? repository.tour;
  const activeRouteSignature = aiRoute?.signature ?? routeSignature(activeTour);
  const activeProgressKey = progressKey(repository, activeTour, aiRoute?.signature);
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

  const persistReadingArtifactJournal = useCallback((snapshot: RepositorySnapshot, notes: ReadingNote[], tours: AiRouteRecord[]) => {
    const targetWorkspaceId = repositoryWorkspaceId(snapshot);
    const journal = readingArtifactJournals.current.get(targetWorkspaceId);
    if (!journal || !hasReadingArtifactOperations(journal)) return Promise.resolve();
    const checkpoint = readingArtifactJournalCheckpoint(journal);
    const saveNotes = hasReadingArtifactOperations(journal, "notes");
    const saveTours = hasReadingArtifactOperations(journal, "tours");
    const saves: Promise<unknown>[] = [];
    if (saveNotes) saves.push(enqueueWorkspacePersistence(targetWorkspaceId, async () => {
      await localWorkspaceProvider.saveReadingNotes(workspaceSession(snapshot), notes);
      const current = readingArtifactJournals.current.get(targetWorkspaceId);
      if (current) readingArtifactJournals.current.set(targetWorkspaceId, acknowledgeReadingArtifactJournal(current, "notes", checkpoint));
    }, { key: "reading-notes" }));
    if (saveTours) saves.push(enqueueWorkspacePersistence(targetWorkspaceId, async () => {
      await localWorkspaceProvider.saveTours(workspaceSession(snapshot), tours);
      const current = readingArtifactJournals.current.get(targetWorkspaceId);
      if (current) readingArtifactJournals.current.set(targetWorkspaceId, acknowledgeReadingArtifactJournal(current, "tours", checkpoint));
    }, { key: "saved-tours" }));
    return Promise.all(saves).then(() => undefined);
  }, []);

  const restoreWorkspaceState = useCallback((snapshot: RepositorySnapshot, saved: LocalWorkspaceState) => {
    initializeGuidePreferences(saved.guidePreferences ?? null, saved.guidePreferences != null, hasExistingWorkspaceUse(saved), saved.persistenceReady !== false, saved.warning);
    const positionsKey = nodePositionSessionKey(snapshot);
    if (saved.persistenceReady === false) {
      setWorkspacePersistenceReadyKeys((previous) => { const next = new Set(previous); next.delete(positionsKey); return next; });
      setNodePositionsReadyKey((current) => current === positionsKey ? null : current);
      setWorkspaceReadFailures((previous) => new Set(previous).add(positionsKey));
      return saved.warning ?? "本地保存数据尚未成功读取；本页修改不会覆盖原记录。";
    }
    const targetWorkspaceId = repositoryWorkspaceId(snapshot);
    const validSavedNodePositions = Object.fromEntries(Object.entries(saved.nodePositions).filter(([fileId, position]) =>
      Number.isFinite(position?.x) && Number.isFinite(position?.y) && snapshot.files.some((file) => file.id === fileId)));
    nodePositionsPersisted.current.set(positionsKey, nodePositionSignature(saved.nodePositions));
    const dirtyIds = dirtyNodePositions.current.get(targetWorkspaceId) ?? new Set<string>();
    const inMemoryPositions = Object.fromEntries([...nodePositionsRef.current].flatMap(([key, point]) => {
      const prefix = `${targetWorkspaceId}:`;
      const fileId = key.startsWith(prefix) ? key.slice(prefix.length) : "";
      return dirtyIds.has(fileId) && snapshot.files.some((file) => file.id === fileId) ? [[fileId, point] as const] : [];
    }));
    const savedNodePositions = { ...validSavedNodePositions, ...inMemoryPositions };
    pendingNodePositionRestore.current = { key: positionsKey, workspaceId: targetWorkspaceId, signature: nodePositionSignature(savedNodePositions) };
    setRecentRepositories(saved.recentRepositories);
    for (const [key, value] of Object.entries(saved.progress)) if (!progressMemory.has(key)) progressMemory.set(key, value);
    setAiResultsByFile((previous) => {
      const next = new Map(previous);
      for (const [fileId, value] of Object.entries(saved.aiResults)) {
        const resultKey = `${repositoryWorkspaceId(snapshot)}:${fileId}`;
        if (!next.has(resultKey) && value && typeof value === "object" && Array.isArray((value as AiResultRecord).__contextFiles)) next.set(resultKey, value as AiResultRecord);
      }
      return next;
    });
    if (saved.aiRoute && saved.aiRoute.repositoryId === snapshot.id && Array.isArray(saved.aiRoute.steps) && Array.isArray(saved.aiRoute.contextFiles)) {
      setAiRoutesByRepository((previous) => previous.has(repositoryWorkspaceId(snapshot)) ? previous : new Map(previous).set(repositoryWorkspaceId(snapshot), saved.aiRoute as unknown as AiRouteRecord));
    }
    const artifactWorkspaceId = repositoryWorkspaceId(snapshot);
    const journal = readingArtifactJournals.current.get(artifactWorkspaceId) ?? createReadingArtifactJournal<ReadingNote, AiRouteRecord>();
    readingArtifactJournals.current.set(artifactWorkspaceId, journal);
    const restoredNotes = applyReadingArtifactJournal(Array.isArray(saved.readingNotes) ? saved.readingNotes.filter((item): item is ReadingNote => Boolean(item && typeof item.id === "string" && typeof item.fileId === "string" && typeof item.text === "string")) : [], journal, "notes");
    const restoredTours = applyReadingArtifactJournal(Array.isArray(saved.savedTours) ? saved.savedTours as AiRouteRecord[] : [], journal, "tours");
    const nextNotes = new Map(readingNotesRef.current); nextNotes.set(artifactWorkspaceId, restoredNotes); readingNotesRef.current = nextNotes; setReadingNotesByWorkspace(nextNotes);
    const nextTours = new Map(savedToursRef.current); nextTours.set(artifactWorkspaceId, restoredTours); savedToursRef.current = nextTours; setSavedToursByWorkspace(nextTours);
    setNodePositions((previous) => {
      const prefix = `${repositoryWorkspaceId(snapshot)}:`;
      const next = new Map([...previous].filter(([key]) => !key.startsWith(prefix)));
      for (const [fileId, position] of Object.entries(savedNodePositions)) next.set(`${prefix}${fileId}`, position);
      return next;
    });
    setWorkspacePersistenceReadyKeys((previous) => {
      const next = new Set(previous);
      next.delete(positionsKey);
      next.add(positionsKey);
      while (next.size > 64) next.delete(next.values().next().value as string);
      return next;
    });
    setWorkspaceReadFailures((previous) => { const next = new Set(previous); next.delete(positionsKey); return next; });
    if (hasReadingArtifactOperations(journal)) {
      void persistReadingArtifactJournal(snapshot, restoredNotes, restoredTours).catch((error: Error) => setRepoMessage(`原有阅读记录已恢复，但本页改动尚未保存：${error.message}`));
    }
    return saved.warning;
  }, [initializeGuidePreferences, persistReadingArtifactJournal]);

  const retryWorkspaceRestore = useCallback(async () => {
    const snapshot = repository;
    const epoch = repositoryGate.current.current().epoch;
    try {
      const saved = await localWorkspaceProvider.get(repositoryWorkspaceId(snapshot));
      if (!repositoryGate.current.isCurrent(epoch, snapshot.id)) return;
      const warning = restoreWorkspaceState(snapshot, saved);
      if (saved.persistenceReady === false) throw new Error(warning ?? "本地保存数据尚未成功读取。");
      setRepoMessage(warning ? `保存数据已读取：${warning}` : "保存数据已恢复；本页待保存修改正在写入。");
    } catch (error) {
      if (!repositoryGate.current.isCurrent(epoch, snapshot.id)) return;
      const failedKey = nodePositionSessionKey(snapshot);
      setWorkspacePersistenceReadyKeys((current) => { const next = new Set(current); next.delete(failedKey); return next; });
      setWorkspaceReadFailures((current) => new Set(current).add(failedKey));
      setNodePositionsReadyKey((current) => current === failedKey ? null : current);
      setRepoMessage(`保存数据读取失败；原记录已保留，可稍后重试：${error instanceof Error ? error.message : "本地存储不可用。"}`);
    }
  }, [repository, restoreWorkspaceState]);

  const retryReadingArtifactSave = useCallback(async () => {
    if (!workspacePersistenceReadyKeys.has(nodePositionSessionKey(repository))) return;
    try {
      await persistReadingArtifactJournal(repository, readingNotesRef.current.get(workspaceId) ?? [], savedToursRef.current.get(workspaceId) ?? []);
      setRepoMessage("待保存的笔记和路线已写入本地存储。");
    } catch (error) {
      setRepoMessage(`笔记和路线仍未保存：${error instanceof Error ? error.message : "本地存储不可用。"}`);
    }
  }, [persistReadingArtifactJournal, repository, workspaceId, workspacePersistenceReadyKeys]);

  useEffect(() => {
    if (repository.source !== "local") return;
    const activeRepositoryId = repository.id;
    const activeWorkspaceId = workspaceId;
    const epoch = repositoryGate.current.current().epoch;
    let cancelled = false;
    const controller = new AbortController();
    localWorkspaceProvider.get(activeWorkspaceId, controller.signal).then((saved) => {
      if (cancelled || !repositoryGate.current.isCurrent(epoch, activeRepositoryId)) return;
      if (saved.persistenceReady === false) {
        const failedKey = nodePositionSessionKey(repository);
        setWorkspacePersistenceReadyKeys((current) => { const next = new Set(current); next.delete(failedKey); return next; });
        setWorkspaceReadFailures((current) => new Set(current).add(failedKey));
        setRepoMessage(saved.warning ?? "阅读记录读取失败；本页修改不会覆盖原有保存数据。");
        return;
      }
      const restoredKey = nodePositionSessionKey(repository);
      setWorkspacePersistenceReadyKeys((current) => new Set(current).add(restoredKey));
      setWorkspaceReadFailures((current) => { const next = new Set(current); next.delete(restoredKey); return next; });
      const journal = readingArtifactJournals.current.get(activeWorkspaceId) ?? createReadingArtifactJournal<ReadingNote, AiRouteRecord>();
      readingArtifactJournals.current.set(activeWorkspaceId, journal);
      const notes = applyReadingArtifactJournal(Array.isArray(saved.readingNotes) ? saved.readingNotes.filter((item): item is ReadingNote => Boolean(item && typeof item.id === "string" && typeof item.fileId === "string" && typeof item.text === "string")) : [], journal, "notes");
      const tours = applyReadingArtifactJournal(Array.isArray(saved.savedTours) ? saved.savedTours as AiRouteRecord[] : [], journal, "tours");
      const nextNotes = new Map(readingNotesRef.current); nextNotes.set(activeWorkspaceId, notes); readingNotesRef.current = nextNotes; setReadingNotesByWorkspace(nextNotes);
      const nextTours = new Map(savedToursRef.current); nextTours.set(activeWorkspaceId, tours); savedToursRef.current = nextTours; setSavedToursByWorkspace(nextTours);
      if (saved.aiRoute && Array.isArray(saved.aiRoute.steps) && Array.isArray(saved.aiRoute.contextFiles)) setAiRoutesByRepository((current) => current.has(activeWorkspaceId) ? current : new Map(current).set(activeWorkspaceId, saved.aiRoute as unknown as AiRouteRecord));
      if (hasReadingArtifactOperations(journal)) void persistReadingArtifactJournal(repository, notes, tours).catch((error: Error) => setRepoMessage(`原有阅读记录已恢复，但本页改动尚未保存：${error.message}`));
    }).catch((error: Error) => {
      if (cancelled || error.name === "AbortError") return;
      const failedKey = nodePositionSessionKey(repository);
      setWorkspacePersistenceReadyKeys((current) => { const next = new Set(current); next.delete(failedKey); return next; });
      setWorkspaceReadFailures((current) => new Set(current).add(failedKey));
      setRepoMessage(`阅读记录读取失败；本页修改不会覆盖原有保存数据：${error.message}`);
    });
    return () => { cancelled = true; controller.abort(); };
  }, [repository, repository.id, repository.source, workspaceId, persistReadingArtifactJournal]);

  useEffect(() => {
    const pending = pendingNodePositionRestore.current;
    if (!pending || workspaceId !== pending.workspaceId) return;
    const prefix = `${workspaceId}:`;
    const current = Object.fromEntries([...nodePositions].flatMap(([key, point]) =>
      key.startsWith(prefix) ? [[key.slice(prefix.length), point] as const] : []));
    if (nodePositionSignature(current) !== pending.signature) return;
    pendingNodePositionRestore.current = null;
    setNodePositionsReadyKey(pending.key);
  }, [nodePositions, workspaceId]);

  useEffect(() => {
    if (!desktopMode || savedDataClearBusy || repository.id === BOOT_SNAPSHOT.id) return;
    const positionsKey = nodePositionSessionKey(repository);
    if (nodePositionsReadyKey !== positionsKey) return;
    const timer = window.setTimeout(() => {
      const positions = Object.fromEntries([...nodePositions].flatMap(([key, point]) => {
        const prefix = `${workspaceId}:`;
        return key.startsWith(prefix) ? [[key.slice(prefix.length), point] as const] : [];
      }));
      const serialized = nodePositionSignature(positions);
      if (serialized === nodePositionsPersisted.current.get(positionsKey)) return;
      const save = enqueueWorkspacePersistence(workspaceId, async () => {
        if (!workspacePersistenceReadyKeys.has(positionsKey)) return;
        await localWorkspaceProvider.saveNodePositions(workspaceSession(repository), positions);
        nodePositionsPersisted.current.set(positionsKey, serialized);
        const currentPositions = Object.fromEntries([...nodePositionsRef.current].flatMap(([key, point]) => {
          const prefix = `${workspaceId}:`;
          return key.startsWith(prefix) ? [[key.slice(prefix.length), point] as const] : [];
        }));
        if (nodePositionSignature(currentPositions) === serialized) dirtyNodePositions.current.delete(workspaceId);
      });
      void save.catch((error: Error) => {
        if (activeNodePositionKeyRef.current === positionsKey) setRepoMessage(`节点位置只保存在当前页面：${error.message}`);
      });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [desktopMode, nodePositions, nodePositionsReadyKey, repository, repository.id, workspaceId, workspacePersistenceReadyKeys, savedDataClearBusy]);

  useEffect(() => {
    let cancelled = false;
    const epoch = beginRepositorySession();
    const storedGuide = desktopMode ? null : readBrowserUsageGuide();
    sampleRepositoryProvider.getSnapshot().then(async (snapshot) => {
      let warning: string | undefined;
      if (cancelled || !repositoryGate.current.isCurrent(epoch)) return;
      if (storedGuide) initializeGuidePreferences(storedGuide.stored, storedGuide.present, storedGuide.existingUse, storedGuide.available, storedGuide.message);
      if (desktopMode) {
        try {
          const saved = await localWorkspaceProvider.get(repositoryWorkspaceId(snapshot));
          if (cancelled || !repositoryGate.current.isCurrent(epoch)) return;
          warning = restoreWorkspaceState(snapshot, saved);
        }
        catch (error) {
          if (cancelled || !repositoryGate.current.isCurrent(epoch)) return;
          const failedKey = nodePositionSessionKey(snapshot);
          setWorkspacePersistenceReadyKeys((current) => { const next = new Set(current); next.delete(failedKey); return next; });
          setWorkspaceReadFailures((current) => new Set(current).add(failedKey));
          setNodePositionsReadyKey((current) => current === failedKey ? null : current);
          warning = error instanceof Error ? error.message : "无法读取桌面保存数据。";
          initializeGuidePreferences(null, false, false, false, warning);
        }
      }
      if (cancelled || !repositoryGate.current.activate(epoch, snapshot)) return;
      setRepositorySessionVersion((version) => version + 1);
      setRepository(snapshot);
      setSelectedFileId(snapshot.files[0]?.id ?? "");
      if (warning) setRepoMessage(`桌面保存数据读取失败；修改暂存于当前页面，原记录不会覆盖：${warning}`);
    }).catch((error: Error) => {
      if (!cancelled && repositoryGate.current.isCurrent(epoch)) {
        if (storedGuide) initializeGuidePreferences(storedGuide.stored, storedGuide.present, storedGuide.existingUse, storedGuide.available, storedGuide.message);
        setRepoMessage(error.message);
      }
    });
    return () => { cancelled = true; };
  }, [beginRepositorySession, desktopMode, initializeGuidePreferences, restoreWorkspaceState, setSelectedFileId]);

  const initialLayout = useMemo(
    () => layoutGraph(repository, selectedFileId, showAllGraph, compactGraph, graphDirectory, nodePositions),
    // Re-layout only on explicit reset; normal selection keeps user-arranged positions.
    [repository, selectedFileId, showAllGraph, compactGraph, graphDirectory, nodePositions],
  );
  const [nodes, setNodes, onNodesChangeBase] = useNodesState<GraphNode>(initialLayout.nodes);
  const graphNodesRef = useRef<GraphNode[]>(nodes);
  useLayoutEffect(() => { graphNodesRef.current = nodes; }, [nodes]);
  const edges = initialLayout.edges;

  useEffect(() => {
    const sameWorkspace = layoutOwner.current.repositoryId === workspaceId;
    const shouldReset = layoutOwner.current.version !== layoutVersion;
    if (!sameWorkspace || shouldReset) graphLayoutAnchor.current = undefined;
    const present = new Set(repository.files.map((file) => `${workspaceId}:${file.id}`));
    // Drop removed files and clear positions only when an explicit layout reset occurs.
    setNodePositions((previous) => {
      let changed = false;
      const next = new Map<string, { x: number; y: number }>();
      for (const [id, position] of previous) {
        const isCurrentRepository = id.startsWith(`${workspaceId}:`);
        if (isCurrentRepository && (shouldReset || !present.has(id))) { changed = true; continue; }
        next.set(id, position);
      }
      return changed ? next : previous;
    });
    // Keep React Flow's controlled nodes synchronized with the repository and the saved drag positions.
    const next = initialLayout.nodes.map((node) => {
        const existing = graphNodesRef.current.find((candidate) => candidate.id === node.id);
        const savedPosition = nodePositions.get(`${workspaceId}:${node.id}`);
        const position = !shouldReset
          ? graphNodeDragging.current
            ? existing?.position ?? node.position
            : savedPosition
              ? node.position
              : (sameWorkspace ? existing?.position : undefined) ?? node.position
          : node.position;
        const dimensionsMatch = existing?.measured?.width === node.measured?.width && existing?.measured?.height === node.measured?.height;
        return { ...node, ...(dimensionsMatch && existing?.measured ? { measured: existing.measured } : {}), position, selected: node.id === selectedFileId, data: { ...node.data, selected: node.id === selectedFileId } };
      });
    const resolved = graphNodeDragging.current ? next : separateOverlappingGraphNodes(next, { gap: compactGraph ? 12 : 16, anchorId: graphLayoutAnchor.current });
    setNodes(resolved);
    if (!graphNodeDragging.current) {
      const adjusted = resolved.filter((node, index) => node.position.x !== next[index].position.x || node.position.y !== next[index].position.y);
      if (adjusted.length) setNodePositions((previous) => {
        let changed = false;
        const updated = new Map(previous);
        for (const node of adjusted) {
          const key = `${workspaceId}:${node.id}`;
          const current = updated.get(key);
          if (current?.x === node.position.x && current?.y === node.position.y) continue;
          updated.set(key, node.position);
          changed = true;
        }
        return changed ? updated : previous;
      });
    }
    layoutOwner.current = { version: layoutVersion, repositoryId: workspaceId };
  }, [initialLayout, repository.id, workspaceId, repository.files, layoutVersion, selectedFileId, setNodes, nodePositions, compactGraph]);

  const onNodesChange = useCallback((changes: Parameters<typeof onNodesChangeBase>[0]) => {
    if (savedDataClearBusy) return;
    const positionChanges = changes.filter((change) => change.type === "position");
    const dragState = [...positionChanges].reverse().find((change) => typeof change.dragging === "boolean")?.dragging;
    if (typeof dragState === "boolean") graphNodeDragging.current = dragState;
    if (dragState === false) {
      const completedDrag = [...positionChanges].reverse().find((change) => change.dragging === false && change.position);
      if (completedDrag) graphLayoutAnchor.current = completedDrag.id;
    }
    for (const change of changes) if (change.type === "position" && change.position) {
      setNodePositions((previous) => new Map(previous).set(`${workspaceId}:${change.id}`, change.position!));
      const positionsKey = nodePositionSessionKey(repository);
      if (desktopMode && !workspacePersistenceReadyKeys.has(positionsKey)) {
        const dirty = dirtyNodePositions.current.get(workspaceId) ?? new Set<string>();
        dirty.add(change.id);
        dirtyNodePositions.current.set(workspaceId, dirty);
      }
    }
    onNodesChangeBase(changes);
  }, [desktopMode, onNodesChangeBase, repository, workspaceId, workspacePersistenceReadyKeys, savedDataClearBusy]);

  useLayoutEffect(() => {
    const updateLayout = () => setNarrowLayout((previous) => previous === (window.innerWidth <= 860) ? previous : window.innerWidth <= 860);
    updateLayout();
    window.addEventListener("resize", updateLayout);
    return () => window.removeEventListener("resize", updateLayout);
  }, []);

  useEffect(() => {
    const canvas = graphCanvasRef.current;
    if (!canvas) return;
    let frame = 0;
    const updateGraphSize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const bounds = canvas.getBoundingClientRect();
        const previous = graphSizeRef.current;
        if (bounds.width <= 0 || bounds.height <= 0) {
          if (previous.width > 0 || previous.height > 0) {
            graphSizeRef.current = { width: 0, height: 0 };
            setGraphReady(false);
          }
          return;
        }
        if (Math.abs(previous.width - bounds.width) < 1 && Math.abs(previous.height - bounds.height) < 1) return;
        graphSizeRef.current = { width: bounds.width, height: bounds.height };
        setGraphSizeRevision((revision) => revision + 1);
        setGraphReady(true);
        setCompactGraph((value) => value === (bounds.width <= 480) ? value : bounds.width <= 480);
      });
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
        window.setTimeout(() => setRepoMessage("已忽略损坏的本地阅读进度。"), 0);
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
    traceProgress("save", activeProgressKey, progressSession.current.current().generation, { outcome: saved ? "persistent" : "memory-only", stepIndex: tourIndex });
    if (!saved) window.setTimeout(() => setRepoMessage("浏览器存储不可用，本次阅读进度只保存在当前页面。"), 0);
    if (desktopMode && !savedDataClearBusy && repository.id !== BOOT_SNAPSHOT.id && workspacePersistenceReadyKeys.has(nodePositionSessionKey(repository))) {
      void enqueueWorkspacePersistence(workspaceId, () => localWorkspaceProvider.saveProgress(workspaceSession(repository), activeProgressKey, value)).catch((error: Error) => setRepoMessage(`阅读进度只保存在当前页面：${error.message}`));
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

  const clearAiContext = useCallback((preserveScope?: boolean) => {
    const requestId = ++aiRequestSequence.current;
    dispatchAiWorkflow({ type: "invalidate", requestId, preserveScope });
    const controller = aiAbortController.current;
    aiAbortController.current = null;
    controller?.abort();
  }, []);
  const changeAiScope = useCallback((selectedFiles: string[], ranges: Record<string, AiLineRange>) => {
    const requestId = ++aiRequestSequence.current;
    dispatchAiWorkflow({ type: "scopeChanged", requestId, selectedFiles, ranges });
    const controller = aiAbortController.current;
    aiAbortController.current = null;
    controller?.abort();
  }, []);
  const editAiSettings = useCallback((patch: Partial<typeof aiSettings>) => {
    aiSettingsDraftRevision.current += 1;
    aiSettingsDirtyRef.current = true;
    setAiSettingsDirty(true);
    clearAiContext();
    setAiSettingsRevision((revision) => revision + 1);
    setAiSettingsDraft((previous) => ({ ...previous, ...patch }));
  }, [clearAiContext]);

  const applySnapshot = useCallback((snapshot: RepositorySnapshot, epoch: number) => {
    if (!repositoryGate.current.isCurrent(epoch, snapshot.id)) return false;
    const initialDirectory = snapshot.origin?.kind === "github" ? snapshot.origin.subdirectory : "";
    const scopedFiles = [...snapshot.files].filter((file) => !initialDirectory || file.id.startsWith(`${initialDirectory}/`)).sort((a, b) => a.path.localeCompare(b.path));
    const restoredFileId = initialDirectory
      ? scopedFiles[0]?.id ?? snapshot.files[0]?.id ?? ""
      : snapshot.files.some((file) => file.id === selectedFileId) ? selectedFileId : snapshot.files[0]?.id ?? "";
    const graphDirectory = initialDirectory && scopedFiles.length ? initialDirectory : "";
    setRepository(snapshot);
    dispatchNavigation({ type: "snapshot", selectedFileId: restoredFileId, graphDirectory, clearFocus: true, resetTour: true });
    clearAiContext(); setSearchQuery(""); setCollapsedFolders([]); setShowAllGraph(false);
    setDetailTab("guide"); setMobileView("files");
    return true;
  }, [clearAiContext, selectedFileId]);

  const applyUpdatedSnapshot = useCallback((snapshot: RepositorySnapshot, epoch: number) => {
    if (!repositoryGate.current.acceptUpdate(epoch, snapshot)) return false;
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
    setRepository(snapshot);
    clearAiContext();
    dispatchNavigation({ type: "snapshot", selectedFileId: nextFile?.id ?? "", graphDirectory: nextDirectory, clearFocus: referenceChanged || !nextFile || expiredRouteFocus, resetTour: false });
    setLoadedSource(null);
    setRepoMessage(expiredRouteFocus ? "阅读路线引用的源码已变化，旧行号已清除；路线说明仍可查看。" : referenceChanged ? "定位到的源码已变化，旧行号已清除。" : contentChanged ? "当前文件已变化，旧 AI 确认已清除。" : snapshot.files.length ? "本地索引已更新。" : "仓库中已没有可分析的源码文件。");
    return true;
  }, [aiRoute, aiRouteStale, clearAiContext, filesById, focusOrigin, focusRouteSignature, focusedLine, graphDirectory, selectedFileId]);
  useEffect(() => { applyUpdatedSnapshotRef.current = applyUpdatedSnapshot; }, [applyUpdatedSnapshot]);

  useEffect(() => {
    if (!desktopMode) return;
    return window.repoLens?.onBackendStatus(({ available, message }) => {
      setDesktopBackendError(available ? "" : message);
      if (!available) {
        aiRequestSequence.current += 1;
        aiAbortController.current?.abort();
        aiAbortController.current = null;
        clearAiContext();
        setRepoMessage(message);
      }
    });
  }, [desktopMode, clearAiContext]);

  const openRepositoryPath = useCallback(async (path: string) => {
    if (savedDataClearBusy) return;
    const command = nextRepositoryCommand();
    const requestId = openRequestGate.current.begin();
    openRequestController.current?.abort();
    const controller = new AbortController();
    openRequestController.current = controller;
    setRepoBusy(true); setRepoMessage("");
    try {
      const snapshot = await localRepositoryProvider.openRepository(path, command, controller.signal);
      if (!openRequestGate.current.isCurrent(requestId) || !isCurrentRepositoryCommand(command) || controller.signal.aborted) return;
      let workspaceWarning: string | undefined;
      if (desktopMode) {
        try {
          const saved = await localWorkspaceProvider.get(repositoryWorkspaceId(snapshot), controller.signal);
          if (!openRequestGate.current.isCurrent(requestId) || !isCurrentRepositoryCommand(command) || controller.signal.aborted) return;
          workspaceWarning = restoreWorkspaceState(snapshot, saved);
        }
        catch (error) {
          if (controller.signal.aborted) return;
          if (!openRequestGate.current.isCurrent(requestId) || !isCurrentRepositoryCommand(command)) return;
          const failedKey = nodePositionSessionKey(snapshot);
          setWorkspacePersistenceReadyKeys((current) => { const next = new Set(current); next.delete(failedKey); return next; });
          setWorkspaceReadFailures((current) => new Set(current).add(failedKey));
          setNodePositionsReadyKey((current) => current === failedKey ? null : current);
          workspaceWarning = error instanceof Error ? error.message : "无法读取桌面保存数据。";
        }
      }
      if (!openRequestGate.current.isCurrent(requestId) || !isCurrentRepositoryCommand(command) || controller.signal.aborted) return;
      const epoch = beginRepositorySession();
      if (!repositoryGate.current.activate(epoch, snapshot)) return;
      setRepositorySessionVersion((version) => version + 1);
      if (applySnapshot(snapshot, epoch)) {
        completeGuideTask("repository");
        setRepoPath(path);
        setRepoMessage(workspaceWarning ? `仓库已打开；保存数据读取失败，修改暂存于当前页面，原记录不会覆盖：${workspaceWarning}` : "仓库已打开，正在监听文件变化。");
        if (desktopMode) {
          try {
            await enqueueWorkspacePersistence(repositoryWorkspaceId(snapshot), () => localWorkspaceProvider.touchRecent(workspaceSession(snapshot)));
            const saved = await localWorkspaceProvider.get(repositoryWorkspaceId(snapshot));
            if (openRequestGate.current.isCurrent(requestId) && isCurrentRepositoryCommand(command)) setRecentRepositories(saved.recentRepositories);
          } catch (error) { if (openRequestGate.current.isCurrent(requestId)) setRepoMessage(`仓库已打开；最近记录未能保存：${error instanceof Error ? error.message : "存储不可用。"}`); }
        }
      }
    }
    catch (error) { if (openRequestGate.current.isCurrent(requestId) && isCurrentRepositoryCommand(command) && !controller.signal.aborted) setRepoMessage(error instanceof Error ? error.message : "无法打开仓库。"); }
    finally {
      if (openRequestController.current === controller) openRequestController.current = null;
      if (openRequestGate.current.isCurrent(requestId) && isCurrentRepositoryCommand(command)) setRepoBusy(false);
    }
  }, [applySnapshot, beginRepositorySession, completeGuideTask, desktopMode, restoreWorkspaceState, savedDataClearBusy]);
  const openRepository = useCallback((event: React.FormEvent) => {
    event.preventDefault();
    void openRepositoryPath(repoPath);
  }, [openRepositoryPath, repoPath]);

  useEffect(() => {
    if (repository.source !== "local") return;
    let updateQueue = Promise.resolve();
    const repositoryId = repository.id;
    const epoch = repositoryGate.current.current().epoch;
    if (!repositoryGate.current.isCurrent(epoch, repositoryId)) return;
    const controllers = new Set<AbortController>();
    const activeReads = repositoryReads.current;
    const unsubscribe = localRepositoryProvider.subscribe(repositoryId, (_revision, sequence) => {
      updateQueue = updateQueue.then(async () => {
        if (!repositoryGate.current.isCurrent(epoch, repositoryId)) return;
        const controller = new AbortController(); controllers.add(controller); activeReads.add(controller);
        try {
          const next = await localRepositoryProvider.getSnapshot(repositoryId, controller.signal);
          if (!repositoryGate.current.isCurrent(epoch, repositoryId) || next.id !== repositoryId || (next.sequence ?? 0) < sequence) return;
          if (applyUpdatedSnapshotRef.current(next, epoch)) dispatchAiWorkflow({ type: "message", message: "仓库文件已变化，旧 AI 讲解需要重新生成；相关源码引用已停用。" });
        } catch (error) { if (!controller.signal.aborted && repositoryGate.current.isCurrent(epoch, repositoryId)) setRepoMessage((error as Error).message); }
        finally { controllers.delete(controller); activeReads.delete(controller); }
      });
    }, setRepoMessage);
    return () => {
      unsubscribe();
      for (const controller of controllers) { controller.abort(); activeReads.delete(controller); }
      controllers.clear();
    };
  }, [repository.source, repository.id, repositorySessionVersion]);

  useEffect(() => {
    if (repository.source !== "local") return;
    const requestId = ++aiSettingsReadSequence.current;
    const draftRevision = aiSettingsDraftRevision.current;
    const sessionVersion = repositorySessionVersion;
    const repositoryId = repository.id;
    localExplanationProvider.getSettings().then((value) => {
      if (requestId !== aiSettingsReadSequence.current || settingsSessionRef.current.sessionVersion !== sessionVersion || settingsSessionRef.current.repositoryId !== repositoryId) return;
      setAiSettingsReadError(null);
      setAiSettingsSaved(value);
      setAiSettingsReadySession({ repositoryId, sessionVersion });
      if (draftRevision === aiSettingsDraftRevision.current && !aiSettingsDirtyRef.current) {
        setAiSettingsDraft((previous) => ({ ...previous, baseUrl: value.baseUrl, model: value.model, apiKey: "" }));
        aiSettingsDirtyRef.current = false;
        setAiSettingsDirty(false);
      }
    }).catch((error: Error) => {
      if (requestId !== aiSettingsReadSequence.current || settingsSessionRef.current.sessionVersion !== sessionVersion || settingsSessionRef.current.repositoryId !== repositoryId) return;
      setAiSettingsReadError({ repositoryId, sessionVersion, message: error instanceof Error ? error.message : "无法读取本地模型配置。" });
    });
  }, [repository.source, repository.id, repositorySessionVersion]);

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

  const removeRecentRepository = useCallback(async (targetId: string) => {
    try {
      await localWorkspaceProvider.removeRecent(targetId);
      const saved = await localWorkspaceProvider.get(workspaceId);
      setRecentRepositories(saved.recentRepositories);
    } catch (error) { setRepoMessage(`无法移除最近仓库：${error instanceof Error ? error.message : "本地存储不可用。"}`); }
  }, [workspaceId]);

  const saveReadingNotes = useCallback((notes: ReadingNote[], expected?: { repositoryId: string; workspaceId: string; sessionVersion: number; clearGeneration: number }): Promise<boolean> => {
    const targetId = workspaceId;
    const snapshot = repository;
    const epoch = repositoryGate.current.current().epoch;
    const sessionVersion = repositorySessionVersion;
    if (savedDataClearActiveRef.current || expected && (expected.repositoryId !== snapshot.id || expected.workspaceId !== targetId || expected.sessionVersion !== sessionVersion || expected.clearGeneration !== savedDataClearGenerationRef.current) || !repositoryGate.current.isCurrent(epoch, snapshot.id)) return Promise.resolve(false);
    const previousNotes = readingNotesRef.current.get(targetId) ?? [];
    const journal = readingArtifactJournals.current.get(targetId) ?? createReadingArtifactJournal<ReadingNote, AiRouteRecord>();
    const stagedJournal = stageReadingArtifactChanges(journal, "notes", previousNotes, notes);
    readingArtifactJournals.current.set(targetId, stagedJournal);
    const next = new Map(readingNotesRef.current); next.set(targetId, notes);
    readingNotesRef.current = next;
    setReadingNotesByWorkspace(next);
    const restoreKey = nodePositionSessionKey(snapshot);
    if (!workspacePersistenceReadyKeys.has(restoreKey) || workspaceReadFailures.has(restoreKey)) {
      setRepoMessage("阅读记录已保留在当前页面；尚未成功读取原记录，暂不写入磁盘。恢复成功后会合并并保存。");
      return Promise.resolve(false);
    }
    const checkpoint = readingArtifactJournalCheckpoint(stagedJournal);
    return enqueueWorkspacePersistence(targetId, () => localWorkspaceProvider.saveReadingNotes(workspaceSession(snapshot), notes), { key: "reading-notes" }).then((result) => {
      if (result && "skipped" in result && result.skipped) return false;
      const current = readingArtifactJournals.current.get(targetId);
      if (current) readingArtifactJournals.current.set(targetId, acknowledgeReadingArtifactJournal(current, "notes", checkpoint));
      return true;
    }).catch((error: Error) => {
      if (repositoryGate.current.isCurrent(epoch, snapshot.id)) setRepoMessage(`阅读记录仅保存在当前页面：${error.message}`);
      return false;
    });
  }, [repository, repositorySessionVersion, workspaceId, workspacePersistenceReadyKeys, workspaceReadFailures]);

  const saveTours = useCallback((tours: AiRouteRecord[], expected?: { repositoryId: string; workspaceId: string; sessionVersion: number; clearGeneration: number }): Promise<boolean> => {
    const targetId = workspaceId;
    const snapshot = repository;
    const epoch = repositoryGate.current.current().epoch;
    const sessionVersion = repositorySessionVersion;
    if (savedDataClearActiveRef.current || expected && (expected.repositoryId !== snapshot.id || expected.workspaceId !== targetId || expected.sessionVersion !== sessionVersion || expected.clearGeneration !== savedDataClearGenerationRef.current) || !repositoryGate.current.isCurrent(epoch, snapshot.id)) return Promise.resolve(false);
    const previousTours = savedToursRef.current.get(targetId) ?? [];
    const journal = readingArtifactJournals.current.get(targetId) ?? createReadingArtifactJournal<ReadingNote, AiRouteRecord>();
    const stagedJournal = stageReadingArtifactChanges(journal, "tours", previousTours, tours);
    readingArtifactJournals.current.set(targetId, stagedJournal);
    const next = new Map(savedToursRef.current); next.set(targetId, tours); savedToursRef.current = next; setSavedToursByWorkspace(next);
    const restoreKey = nodePositionSessionKey(snapshot);
    if (!workspacePersistenceReadyKeys.has(restoreKey) || workspaceReadFailures.has(restoreKey)) {
      setRepoMessage("阅读路线已保留在当前页面；尚未成功读取原记录，暂不写入磁盘。恢复成功后会合并并保存。");
      return Promise.resolve(false);
    }
    const checkpoint = readingArtifactJournalCheckpoint(stagedJournal);
    return enqueueWorkspacePersistence(targetId, () => localWorkspaceProvider.saveTours(workspaceSession(snapshot), tours), { key: "saved-tours" }).then((result) => {
      if (result && "skipped" in result && result.skipped) return false;
      const current = readingArtifactJournals.current.get(targetId);
      if (current) readingArtifactJournals.current.set(targetId, acknowledgeReadingArtifactJournal(current, "tours", checkpoint));
      return true;
    }).catch((error: Error) => {
      if (repositoryGate.current.isCurrent(epoch, snapshot.id)) setRepoMessage(`阅读路线仅保存在当前页面：${error.message}`);
      return false;
    });
  }, [repository, repositorySessionVersion, workspaceId, workspacePersistenceReadyKeys, workspaceReadFailures]);

  const activateSavedTour = useCallback((route: AiRouteRecord) => {
    if (route.stale || aiContextIsStale(route.contextFiles, repository)) { setRepoMessage("这条路线引用的源码已变化或尚未校验；请重新生成或手动更新路线引用后再开始。"); return; }
    if (!route.steps.length) { setRepoMessage("这条路线没有有效步骤。"); return; }
    clearAiContext();
    setAiRoutesByRepository((previous) => new Map(previous).set(workspaceId, route));
    dispatchNavigation({ type: "restart-tour", step: route.steps[0], routeSignature: route.signature });
    setDetailTab("source"); setMobileView("details"); setRepoMessage("");
    const restoreKey = nodePositionSessionKey(repository);
    if (!desktopMode || (workspacePersistenceReadyKeys.has(restoreKey) && !workspaceReadFailures.has(restoreKey))) {
      void enqueueWorkspacePersistence(workspaceId, () => localWorkspaceProvider.saveAiRoute(workspaceSession(repository), route)).catch((error: Error) => {
        setRepoMessage(`路线已打开，但未能保存为当前路线：${error.message}`);
      });
    } else setRepoMessage("路线已在当前页面打开；保存数据恢复完成后再写入磁盘。");
  }, [clearAiContext, desktopMode, repository, workspaceId, workspacePersistenceReadyKeys, workspaceReadFailures]);

  const clearCurrentSavedData = useCallback(async () => {
    if (!desktopMode || repository.id === BOOT_SNAPSHOT.id || savedDataClearBusy || repoBusy) return;
    savedDataClearActiveRef.current = true;
    savedDataClearGenerationRef.current += 1;
    setSavedDataClearGeneration(savedDataClearGenerationRef.current);
    setSavedDataClearBusy(true);
    clearAiContext();
    try {
      await clearQuestionConversationWorkspace(workspaceId, async () => {
        const restoreBrowserProgress = stageBrowserProgressClear(workspaceId);
        try { await localWorkspaceProvider.clearRepository(workspaceSession(repository)); }
        catch (error) { restoreBrowserProgress(); throw error; }
      });
      setAiResultsByFile((previous) => new Map([...previous].filter(([key]) => !key.startsWith(`${workspaceId}:`))));
      setAiRoutesByRepository((previous) => { const next = new Map(previous); next.delete(workspaceId); return next; });
      setReadingNotesByWorkspace((previous) => { const next = new Map(previous); next.delete(workspaceId); readingNotesRef.current = next; return next; });
      setSavedToursByWorkspace((previous) => { const next = new Map(previous); next.delete(workspaceId); savedToursRef.current = next; return next; });
      readingArtifactJournals.current.set(workspaceId, createReadingArtifactJournal<ReadingNote, AiRouteRecord>());
      setNodePositions((previous) => new Map([...previous].filter(([key]) => !key.startsWith(`${workspaceId}:`))));
      nodePositionsPersisted.current.delete(nodePositionSessionKey(repository));
      dirtyNodePositions.current.delete(workspaceId);
      for (const key of progressMemory.keys()) if (key.startsWith(`repolens:${workspaceId}:`)) progressMemory.delete(key);
      setTourIndex(0); setCompletedSteps([]); setQuestionClearVersion((value) => value + 1); setRecentRepositories((previous) => previous.filter((item) => (item.workspaceId ?? item.id) !== workspaceId));
      setRepoMessage("已清除此仓库的本地保存结果、路线、进度和节点位置。");
    } catch (error) { setRepoMessage(`无法清除此仓库的保存数据：${error instanceof Error ? error.message : "本地存储不可用。"}`); }
    finally { savedDataClearActiveRef.current = false; setSavedDataClearBusy(false); }
  }, [clearAiContext, desktopMode, repository, savedDataClearBusy, setTourIndex, setCompletedSteps, workspaceId, repoBusy]);

  const clearAllSavedData = useCallback(async () => {
    if (savedDataClearBusy || repoBusy) return;
    savedDataClearActiveRef.current = true;
    savedDataClearGenerationRef.current += 1;
    setSavedDataClearGeneration(savedDataClearGenerationRef.current);
    setSavedDataClearBusy(true);
    guideSaveSequenceRef.current += 1;
    await guideWriteQueueRef.current;
    clearAiContext();
    try {
      let guideClearWarning = "";
      await clearAllQuestionConversations(async () => {
        const restoreBrowserProgress = stageBrowserProgressClear();
        try { await localWorkspaceProvider.clearAll(); }
        catch (error) { restoreBrowserProgress(); throw error; }
      }, [workspaceId]);
      if (!desktopMode) {
        try { window.localStorage.removeItem(USAGE_GUIDE_STORAGE_KEY); setGuideStorageMessage(""); }
        catch (error) { guideClearWarning = `已清除其他本地数据，但浏览器未允许移除使用指南偏好：${error instanceof Error ? error.message : "存储不可用。"}`; }
      }
      setRecentRepositories([]); setAiResultsByFile(new Map()); setAiRoutesByRepository(new Map()); setReadingNotesByWorkspace(new Map()); readingNotesRef.current = new Map(); setSavedToursByWorkspace(new Map()); savedToursRef.current = new Map(); setNodePositions(new Map());
      readingArtifactJournals.current.clear();
      progressMemory.clear();
      nodePositionsPersisted.current.clear();
      dirtyNodePositions.current.clear();
      setTourIndex(0); setCompletedSteps([]); setQuestionClearVersion((value) => value + 1); setRepoMessage("已清除全部 RepoLens 本地保存数据。");
      const freshGuide = createDefaultUsageGuidePreferences();
      guidePreferencesRef.current = freshGuide; setGuidePreferences(freshGuide);
      setShowGuideWelcome(true); setGuidePanelOpen(false); setGuideNoticeAvailable(false); setGuideStorageMessage(guideClearWarning);
      guideTourPracticeRef.current = null; guideNavigationRef.current = null;
    } catch (error) { setRepoMessage(`无法清除全部保存数据：${error instanceof Error ? error.message : "本地存储不可用。"}`); }
    finally { savedDataClearActiveRef.current = false; setSavedDataClearBusy(false); }
  }, [clearAiContext, desktopMode, savedDataClearBusy, setTourIndex, setCompletedSteps, repoBusy, workspaceId]);

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

  const loadSample = async (command: RepositoryCommand, epoch: number) => {
    if (!isCurrentRepositoryCommand(command)) return;
    openRequestGate.current.invalidate(); openRequestController.current?.abort(); openRequestController.current = null;
    clearAiContext(); setSearchQuery(""); setCollapsedFolders([]); setTourIndex(0); setCompletedSteps([]); setFocusedLine(null); setShowAllGraph(false); setGraphDirectory(""); setRepoMessage("正在载入内置示例仓库。"); setDetailTab("guide"); setMobileView("graph");
    try {
      const snapshot = await sampleRepositoryProvider.getSnapshot();
      if (!isCurrentRepositoryCommand(command) || !repositoryGate.current.activate(epoch, snapshot)) return;
      setRepositorySessionVersion((version) => version + 1);
      if (!applySnapshot(snapshot, epoch)) return;
      // Same-page returns retain the sample workspace's in-memory positions.
      // Re-enable autosave only after the sample snapshot has become active.
      if (desktopMode && workspacePersistenceReadyKeys.has(nodePositionSessionKey(snapshot))) setNodePositionsReadyKey(nodePositionSessionKey(snapshot));
      setRepoMessage("正在浏览内置示例仓库。");
      setRepoBusy(false);
    }
    catch (error) { if (isCurrentRepositoryCommand(command) && repositoryGate.current.isCurrent(epoch)) { setRepoBusy(false); setRepoMessage(error instanceof Error ? error.message : "无法载入示例仓库。"); } }
  };
  const closeRepository = async () => {
    if (savedDataClearBusy) return;
    const command = nextRepositoryCommand();
    openRequestGate.current.invalidate(); openRequestController.current?.abort(); openRequestController.current = null;
    const epoch = beginRepositorySession(); setRepositorySessionVersion((version) => version + 1); setRepoBusy(true);
    void localRepositoryProvider.closeRepository(command).catch((error) => {
      if (isCurrentRepositoryCommand(command) && repositoryGate.current.isCurrent(epoch)) setRepoMessage(`已返回示例；关闭本地仓库尚未确认。${error instanceof Error ? ` ${error.message}` : ""}`);
    });
    await loadSample(command, epoch);
  };
  useLayoutEffect(() => { closeRepositoryRef.current = closeRepository; });
  const closeUsageGuidePanel = useCallback(() => {
    setGuidePanelOpen(false);
    updateGuidePreferences((previous) => ({ ...previous, checklistOpen: false }));
  }, [updateGuidePreferences]);
  const openUsageGuidePanel = useCallback(() => {
    setShowGuideWelcome(false);
    setGuidePanelOpen(true);
    setGuideNoticeAvailable(false);
    updateGuidePreferences((previous) => ({ ...previous, checklistOpen: true, noticeDismissed: true }));
  }, [updateGuidePreferences]);
  const openGuideWelcome = useCallback(() => {
    closeUsageGuidePanel();
    setShowGuideWelcome(true);
  }, [closeUsageGuidePanel]);
  const handleTryExample = useCallback(() => {
    setShowGuideWelcome(false);
    setGuidePanelOpen(true);
    updateGuidePreferences((previous) => ({ ...previous, welcomeHandled: true, checklistOpen: true, noticeDismissed: true }));
    if (repository.source === "local") void closeRepositoryRef.current();
  }, [repository.source, updateGuidePreferences]);
  const handleSkipWelcome = useCallback(() => {
    setShowGuideWelcome(false);
    setGuidePanelOpen(false);
    updateGuidePreferences((previous) => ({ ...previous, welcomeHandled: true, checklistOpen: false, noticeDismissed: true }));
    setGuideNoticeAvailable(false);
  }, [updateGuidePreferences]);
  const handleOpenRepositoryFromGuide = useCallback(() => {
    setShowGuideWelcome(false);
    setGuidePanelOpen(false);
    setMobileView("files");
    updateGuidePreferences((previous) => ({ ...previous, welcomeHandled: true, checklistOpen: false, noticeDismissed: true }));
    setGuideNoticeAvailable(false);
    setGuideRepoRequest((request) => request + 1);
  }, [updateGuidePreferences]);
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
      else setRepoMessage("当前已在示例仓库中；可以从路线栏选择下一步继续练习。");
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
  const rescanRepository = async () => {
    if (savedDataClearBusy) return;
    const repositoryId = repository.id; const epoch = repositoryGate.current.current().epoch; const controller = new AbortController();
    repositoryReads.current.add(controller); setRepoBusy(true);
    try {
      const next = await localRepositoryProvider.rescan(repositoryId, controller.signal);
      if (!repositoryGate.current.isCurrent(epoch, repositoryId)) return;
      if (applyUpdatedSnapshotRef.current(next, epoch)) setRepoMessage("仓库已重新扫描。");
      else if (next.id === repositoryId) setRepoMessage("仓库已是最新，无需更新索引。");
    }
    catch (error) { if (!controller.signal.aborted && repositoryGate.current.isCurrent(epoch, repositoryId)) setRepoMessage(error instanceof Error ? error.message : "重新扫描失败。"); }
    finally { repositoryReads.current.delete(controller); if (repositoryGate.current.isCurrent(epoch, repositoryId)) setRepoBusy(false); }
  };
  const saveAiSettings = async (event: React.FormEvent) => {
    event.preventDefault(); dispatchAiWorkflow({ type: "message", message: "" });
    if (aiSettingsBusyRef.current) return;
    setAiSettingsSaveError(null);
    aiSettingsBusyRef.current = true;
    setAiSettingsBusy(true);
    const requestId = ++aiSettingsSaveSequence.current;
    aiSettingsReadSequence.current += 1;
    const draftRevision = aiSettingsDraftRevision.current;
    const repositoryId = repository.id;
    const sessionVersion = repositorySessionVersion;
    const submittedSettings = { ...aiSettingsDraft };
    try {
      clearAiContext();
      const value = await localExplanationProvider.saveSettings(submittedSettings);
      if (requestId !== aiSettingsSaveSequence.current || settingsSessionRef.current.repositoryId !== repositoryId || settingsSessionRef.current.sessionVersion !== sessionVersion) return;
      setAiSettingsReadError(null);
      setAiSettingsSaveError(null);
      setAiSettingsSaved(value);
      setAiSettingsReadySession({ repositoryId, sessionVersion });
      if (draftRevision === aiSettingsDraftRevision.current) {
        setAiSettingsDraft((previous) => ({ ...previous, baseUrl: value.baseUrl, model: value.model, apiKey: "" }));
        aiSettingsDirtyRef.current = false;
        setAiSettingsDirty(false);
        setAiSettingsRevision((revision) => revision + 1);
        dispatchAiWorkflow({ type: "message", message: value.configured ? "模型配置已保存在本地服务内存中。" : "请补齐服务地址、模型名称和密钥。" });
      } else {
        dispatchAiWorkflow({ type: "message", message: "已保存较早的配置；当前表单包含更新内容，请再次保存后使用 AI。" });
      }
    } catch (error) {
      if (requestId === aiSettingsSaveSequence.current && settingsSessionRef.current.repositoryId === repositoryId && settingsSessionRef.current.sessionVersion === sessionVersion) {
        setAiSettingsSaveError({ repositoryId, sessionVersion, message: error instanceof Error ? error.message : "无法保存本地模型配置。" });
      }
    }
    finally {
      if (requestId === aiSettingsSaveSequence.current) { aiSettingsBusyRef.current = false; setAiSettingsBusy(false); }
    }
  };
  const previewAi = async (mode: AiMode, fileIds?: string[], goal?: string) => {
    if (savedDataClearBusy) return;
    if (desktopBackendError) { setRepoMessage(desktopBackendError); return; }
    if (!aiSettings.configured) { clearAiContext(); dispatchAiWorkflow({ type: "message", message: "请先保存完整的模型服务地址、模型名称和密钥，再预览发送范围。" }); return; }
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
        dispatchAiWorkflow({ type: "scopeRequired", requestId, contextKey: requestContext, candidates: value.candidates, selectedFiles, ranges, message: `范围超过 ${value.maxFiles} 个文件或 ${value.maxCharacters.toLocaleString()} 字符上限，请选择要纳入的文件后重新预览。` });
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
        saveTours([...currentSavedTours.filter((route) => route.signature !== nextRoute.signature), nextRoute]);
        const restoreKey = nodePositionSessionKey(repository);
        if (!desktopMode || (workspacePersistenceReadyKeys.has(restoreKey) && !workspaceReadFailures.has(restoreKey))) {
          try {
            const saved = await enqueueWorkspacePersistence(workspaceId, () => localWorkspaceProvider.saveAiRoute(savedWorkspaceSession, nextRoute as AiRouteRecord));
            if (saved && "skipped" in saved && saved.skipped) return;
          }
          catch (error) { setRepoMessage(`路线已生成，但未能保存当前路线：${error instanceof Error ? error.message : "存储不可用。"}`); }
        } else setRepoMessage("路线已生成并保留在当前页面；保存数据恢复完成后再写入磁盘。");
        if (aiRequestSequence.current !== requestId || aiContextRef.current !== contextKey) return;
        setSearchQuery(""); setCollapsedFolders([]);
        finalMessage = "AI 阅读路线已生成；选中步骤即可定位文件和源码。";
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
        finalMessage = "讲解已生成，引用经过文件和行号校验。";
      }
      dispatchAiWorkflow({ type: "message", message: finalMessage });
      dispatchAiWorkflow({ type: "succeeded", requestId, contextKey: requestContext, message: finalMessage });
    } catch (error) { if (aiRequestSequence.current === requestId && aiContextRef.current === contextKey) dispatchAiWorkflow({ type: "failed", requestId, contextKey: requestContext, message: error instanceof Error ? error.name === "AbortError" ? "已取消模型请求。" : error.message : "生成失败。" }); }
    finally { if (aiRequestSequence.current === requestId && aiAbortController.current === controller) aiAbortController.current = null; }
  };

  if (guideReady && showGuideWelcome) return <UsageGuideWelcome onTryExample={handleTryExample} onOpenRepository={handleOpenRepositoryFromGuide} onSkip={handleSkipWelcome} />;

  return (
    <main className={`app-shell${activeTour.length ? "" : " is-analysis-only"}${layoutMode === "reading" ? " is-reading-mode" : ""}`}>
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
            <button ref={guideButtonRef} type="button" className="repo-action usage-guide-trigger" aria-label="使用指南" title="使用指南" disabled={!guideReady} onClick={openUsageGuidePanel}><BookOpen size={14} /><span>使用指南</span></button>
          </div>
          {repository.source === "local" && <><span className={`workspace-save-status is-${saveStatusLabel === "已保存" ? "saved" : saveStatusLabel === "正在恢复" || saveStatusLabel === "保存中" || saveStatusLabel === "正在清除" ? "busy" : "memory"}`} role="status" aria-label={`本地保存状态：${saveStatusLabel}`} title={saveStatusDetail}>{saveStatusLabel}</span>{workspaceReadFailures.has(activePersistenceKey) && <button type="button" className="repo-action" disabled={savedDataClearBusy} onClick={() => void retryWorkspaceRestore()}>重试恢复</button>}{persistenceStatus.phase === "memory" && <button type="button" className="repo-action" disabled={savedDataClearBusy || !workspacePersistenceReadyKeys.has(activePersistenceKey)} onClick={() => void retryReadingArtifactSave()}>重试保存</button>}</>}
          {repository.source === "sample" && <span className="tour-status"><Sparkles size={14} />预置导览</span>}
          {repository.source === "local" && <><button className="repo-action" onClick={rescanRepository} disabled={repoBusy || savedDataClearBusy || Boolean(desktopBackendError)}>{repository.origin?.kind === "github" ? "检查远端更新" : "重新扫描"}</button><button className="repo-action" onClick={closeRepository} disabled={savedDataClearBusy || Boolean(desktopBackendError)}>返回示例</button></>}
          <span className="version-stamp" title={`版本 ${repository.version}`}>v{repository.version}</span>
        </div>
      </header>
      {desktopBackendError && <div className="desktop-backend-alert" role="alert">本地服务不可用：{desktopBackendError}</div>}
      {guideNoticeAvailable && !guidePreferences.noticeDismissed && <UsageGuideNotice onOpen={openUsageGuidePanel} onDismiss={dismissGuideNotice} />}
      <UsageGuidePanel open={guidePanelOpen} completedTaskIds={guidePreferences.completedTaskIds} repositoryName={repository.name} hasDependencies={repository.dependencies.length > 0} hasTour={activeTour.length > 1} canAddNote={repository.source === "local"} returnFocusRef={guideButtonRef} onClose={closeUsageGuidePanel} onStartTask={startUsageGuideTask} onOpenWelcome={openGuideWelcome} onResetProgress={resetUsageGuide} storageMessage={guideStorageMessage} />

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

      <WorkspaceOverview repository={repository} stepCount={activeTour.length} compact={layoutMode === "reading"} notes={currentReadingNotes} tours={currentSavedTours} results={[...aiResultsByFile.entries()].filter(([key, value]) => key.startsWith(`${workspaceId}:`) && value.__repositoryId === repository.id).map(([, value]) => value)} onSelectFile={(fileId) => selectFile(fileId, "details")} />

      <section id="repository-workspace" className={`workspace-grid${layoutMode === "reading" ? " is-reading-mode" : ""}`}>
        <DirectoryPanel
          repository={repository}
          mobileView={mobileView}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          repoPath={repoPath}
          onRepoPathChange={setRepoPath}
          repoBusy={repoBusy}
          serviceAvailable={!desktopBackendError}
          repoMessage={repoMessage}
          desktopMode={desktopMode}
          clearDataBusy={savedDataClearBusy}
          onPickDirectory={() => {
            void window.repoLens?.selectDirectory().then((selectedPath) => { if (selectedPath) setRepoPath(selectedPath); })
              .catch((error: unknown) => setRepoMessage(error instanceof Error ? error.message : "无法选择本地目录。"));
          }}
          onOpenRepository={openRepository}
          onRescan={rescanRepository}
          recentRepositories={recentRepositories}
          onOpenRecent={(location) => { setRepoPath(location); void openRepositoryPath(location); }}
          onRemoveRecent={(id) => { void removeRecentRepository(id); }}
          onClearRepositoryData={() => { void clearCurrentSavedData(); }}
          onClearSavedData={() => { void clearAllSavedData(); }}
          selectedFileId={selectedFileId}
          collapsedFolders={collapsedFolders}
          onToggleFolder={(path) => setCollapsedFolders((previous) => previous.includes(path) ? previous.filter((item) => item !== path) : [...previous, path])}
          onSelectFile={(file) => selectFile(file.id, "details")}
          onOpenSearchResult={(fileId, line) => openReference({ fileId, line })}
          onAddSearchResult={(fileIds) => {
            const targetWorkspaceId = repositoryWorkspaceId(repository);
            const nextFileIds = [...new Set([...(searchQuestionScope.workspaceId === targetWorkspaceId ? searchQuestionScope.fileIds : []), ...fileIds])];
            if (nextFileIds.length > 12) { setRepoMessage("问答范围最多包含 12 个文件；请减少已选文件后再添加。 "); return; }
            setSearchQuestionScope({ workspaceId: targetWorkspaceId, fileIds: nextFileIds });
            const firstFileId = fileIds[0];
            if (firstFileId) { selectFile(firstFileId, "details"); setDetailTab("questions"); }
          }}
          searchInputRef={searchInputRef}
        />

        <GraphPanel
          mobileView={mobileView}
          directory={graphDirectory}
          directories={graphDirectories}
          graphLabel={!showAllGraph ? `当前文件的一跳关系 · ${graphVisibleCount}/${graphCandidateCount} 个节点` : `${scopedGraphFiles.length} 个文件 · ${repository.dependencies.filter((edge) => scopedGraphIds.has(edge.fromId) && scopedGraphIds.has(edge.toId)).length} 条静态引用`}
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

        <FileDetailsPanel
          repository={repository}
          backendAvailable={!desktopBackendError}
          currentFile={currentFile}
          filesById={filesById}
          mobileView={mobileView}
          detailTab={detailTab}
          questionStorageBusy={savedDataClearBusy}
          questionClearVersion={questionClearVersion}
          savedDataClearGeneration={savedDataClearGeneration}
          savedDataClearBusy={savedDataClearBusy}
          questionExtraFileIds={questionExtraFileIds}
          onClearQuestionExtraFiles={() => setSearchQuestionScope({ workspaceId: repositoryWorkspaceId(repository), fileIds: [] })}
          onDetailTabChange={setDetailTab}
          onOpenReference={openReference}
          aiSettings={aiSettings}
          aiSettingsBusy={aiSettingsBusy}
          onBaseUrlChange={(value) => editAiSettings({ baseUrl: value })}
          onModelChange={(value) => editAiSettings({ model: value })}
          onApiKeyChange={(value) => editAiSettings({ apiKey: value })}
          onSaveSettings={saveAiSettings}
          onPreviewAi={previewAi}
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
          aiSettingsReadError={currentAiSettingsReadError}
          aiSettingsSaveError={currentAiSettingsSaveError}
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
      </section>

      <TourBar
        repository={activeTour === repository.tour ? repository : { ...repository, tour: activeTour }}
        stepIndex={tourIndex}
        completedSteps={completedSteps}
        stepsRef={tourStepsRef}
        disabled={aiRouteStale || savedDataClearBusy}
        onGoToStep={goToStep}
        onComplete={() => { if (currentTour) setCompletedSteps((previous) => previous.includes(currentTour.id) ? previous : [...previous, currentTour.id]); }}
        onReset={resetTour}
        onOpenReference={openTourReference}
      />
      <QuickOpenDialog open={quickOpen} files={repository.files} onOpenChange={setQuickOpen} onSelectFile={(file) => selectFile(file.id, "details")} />
    </main>
  );
}

export default function Home() {
  return <ReactFlowProvider><AppShell /></ReactFlowProvider>;
}
