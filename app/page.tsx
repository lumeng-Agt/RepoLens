"use client";

import {
  MarkerType,
  ReactFlowProvider,
  type Edge,
  type ReactFlowInstance,
  useNodesState,
} from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import {
  BookOpenText,
  Folder,
  GitBranch,
  ListTree,
  Sparkles,
  Waypoints,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useLayoutEffect,
} from "react";
import { localRepositoryProvider, localWorkspaceProvider, sampleRepositoryProvider, type LocalWorkspaceState, type RepositoryCommand } from "@/data/providers";
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
import type {
  FileRecord,
  AiPreview,
  RepositorySnapshot,
  SourceReference,
  AiRouteRecord,
  TourStep,
} from "@/data/model";
import "@xyflow/react/dist/style.css";

type MobileView = "files" | "graph" | "details";
type NavigationState = {
  selectedFileId: string; tourIndex: number; focusedLine: SourceReference | null;
  focusOrigin: "none" | "reference" | "route"; focusRouteSignature: string | null;
  completedSteps: string[]; graphDirectory: string;
};
type NavigationAction =
  | { type: "select"; value: string | ((previous: string) => string) }
  | { type: "tour"; value: number | ((previous: number) => number) }
  | { type: "reference"; value: SourceReference | null | ((previous: SourceReference | null) => SourceReference | null); origin?: "reference" | "route"; routeSignature?: string }
  | { type: "directory"; value: string }
  | { type: "directory-select"; value: string; fileId: string; preserveFocus: boolean }
  | { type: "select-file"; fileId: string; directory: string }
  | { type: "reference-navigation"; reference: SourceReference; directory: string; origin?: "reference" | "route"; routeSignature?: string }
  | { type: "completed"; value: string[] | ((previous: string[]) => string[]) }
  | { type: "restore-progress"; stepIndex: number; completedSteps: string[]; step?: TourStep; routeSignature: string; routeStale: boolean }
  | { type: "route-step"; stepIndex: number; step: TourStep; routeSignature: string; completedStepId?: string }
  | { type: "restart-tour"; step: TourStep; routeSignature: string }
  | { type: "snapshot"; selectedFileId: string; graphDirectory: string; clearFocus: boolean; resetTour: boolean };
type StateUpdate<T> = T | ((previous: T) => T);

function navigationReducer(state: NavigationState, action: NavigationAction): NavigationState {
  if (action.type === "select") return { ...state, selectedFileId: typeof action.value === "function" ? action.value(state.selectedFileId) : action.value };
  if (action.type === "tour") return { ...state, tourIndex: typeof action.value === "function" ? action.value(state.tourIndex) : action.value };
  if (action.type === "reference") {
    const reference = typeof action.value === "function" ? action.value(state.focusedLine) : action.value;
    return { ...state, focusedLine: reference, focusOrigin: reference ? action.origin ?? "reference" : "none", focusRouteSignature: reference && action.origin === "route" ? action.routeSignature ?? null : null };
  }
  if (action.type === "directory") return { ...state, graphDirectory: action.value };
  if (action.type === "directory-select") return { ...state, graphDirectory: action.value, selectedFileId: action.fileId, ...(action.preserveFocus ? {} : { focusedLine: null, focusOrigin: "none" as const, focusRouteSignature: null }) };
  if (action.type === "select-file") return { ...state, selectedFileId: action.fileId, graphDirectory: action.directory, focusedLine: null, focusOrigin: "none", focusRouteSignature: null };
  if (action.type === "reference-navigation") return { ...state, selectedFileId: action.reference.fileId, graphDirectory: action.directory, focusedLine: action.reference, focusOrigin: action.origin ?? "reference", focusRouteSignature: action.origin === "route" ? action.routeSignature ?? null : null };
  if (action.type === "completed") return { ...state, completedSteps: typeof action.value === "function" ? action.value(state.completedSteps) : action.value };
  if (action.type === "restore-progress") return {
    ...state,
    tourIndex: action.stepIndex,
    completedSteps: action.completedSteps,
    ...(action.step && !action.routeStale ? { selectedFileId: action.step.focusFileId, focusedLine: action.step.reference, focusOrigin: "route" as const, focusRouteSignature: action.routeSignature } : { focusedLine: null, focusOrigin: "none" as const, focusRouteSignature: null }),
  };
  if (action.type === "route-step") return {
    ...state,
    tourIndex: action.stepIndex,
    selectedFileId: action.step.focusFileId,
    graphDirectory: "",
    focusedLine: action.step.reference,
    focusOrigin: "route",
    focusRouteSignature: action.routeSignature,
    ...(action.completedStepId ? { completedSteps: state.completedSteps.includes(action.completedStepId) ? state.completedSteps : [...state.completedSteps, action.completedStepId] } : {}),
  };
  if (action.type === "restart-tour") return { ...state, tourIndex: 0, completedSteps: [], selectedFileId: action.step.focusFileId, graphDirectory: "", focusedLine: action.step.reference, focusOrigin: "route", focusRouteSignature: action.routeSignature };
  return { ...state, selectedFileId: action.selectedFileId, graphDirectory: action.graphDirectory, ...(action.resetTour ? { tourIndex: 0, completedSteps: [] } : {}), ...(action.clearFocus ? { focusedLine: null, focusOrigin: "none", focusRouteSignature: null } : {}) };
}

const progressMemory = new Map<string, string>();

const BOOT_SNAPSHOT: RepositorySnapshot = { id: "sample-loading", version: "loading", name: "RepoLens", description: "正在载入示例仓库", files: [], dependencies: [], tour: [], source: "sample" };

function routeSignature(tour: TourStep[]) {
  const value = JSON.stringify(tour.map((step) => [step.title, step.focusFileId, step.description, step.reference.fileId, step.reference.line, step.reference.endLine ?? null]));
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(36);
}
function progressKey(repository: RepositorySnapshot, tour: TourStep[], stableRouteSignature?: string) { return `repolens:${repository.id}:${repository.source === "sample" ? repository.version : stableRouteSignature ?? routeSignature(tour)}`; }

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
    graph.setNode(file.id, { width: compact ? 150 : 190, height: compact ? 66 : 76 });
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
      position: nodePositions.get(`${snapshot.id}:${file.id}`) ?? { x: position.x - (compact ? 75 : 95), y: position.y - (compact ? 33 : 38) },
      data: { file, selected: file.id === selectedId, compact },
      selected: file.id === selectedId,
    };
  });

  const edges: Edge[] = visibleDependencies.map((dependency) => {
    const connected = dependency.fromId === selectedId || dependency.toId === selectedId;
    return {
      id: dependency.id,
      deletable: false,
      source: dependency.fromId,
      target: dependency.toId,
      type: "smoothstep",
      animated: false,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      style: {
        stroke: connected ? "#75d5bd" : "#526270",
        strokeWidth: connected ? 1.8 : 1.15,
        opacity: connected ? 1 : 0.72,
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
  const [navigation, dispatchNavigation] = useReducer(navigationReducer, { selectedFileId: "src/main.tsx", tourIndex: 0, focusedLine: null, focusOrigin: "none", focusRouteSignature: null, completedSteps: [], graphDirectory: "" });
  const { selectedFileId, tourIndex, focusedLine, focusOrigin, focusRouteSignature, completedSteps, graphDirectory } = navigation;
  const setSelectedFileId = useCallback((value: StateUpdate<string>) => dispatchNavigation({ type: "select", value }), []);
  const setTourIndex = useCallback((value: StateUpdate<number>) => dispatchNavigation({ type: "tour", value }), []);
  const setFocusedLine = useCallback((value: StateUpdate<SourceReference | null>) => dispatchNavigation({ type: "reference", value }), []);
  const setCompletedSteps = useCallback((value: StateUpdate<string[]>) => dispatchNavigation({ type: "completed", value }), []);
  const setGraphDirectory = useCallback((value: string) => dispatchNavigation({ type: "directory", value }), []);
  const [detailTab, setDetailTab] = useState("guide");
  const [searchQuery, setSearchQuery] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [desktopMode] = useState(() => Boolean(globalThis.__REPOLENS_RUNTIME__?.desktop));
  const [repoBusy, setRepoBusy] = useState(false);
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
  const nodePositionsPersisted = useRef("");
  const [graphReady, setGraphReady] = useState(false);
  const [graphSizeRevision, setGraphSizeRevision] = useState(0);
  const graphResizeRequest = useRef(0);
  const codeViewportRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const filesById = useMemo(() => new Map(repository.files.map((file) => [file.id, file])), [repository.files]);
  const currentFile = filesById.get(selectedFileId) ?? repository.files[0] ?? EMPTY_FILE;
  const aiResult = aiResultsByFile.get(`${repository.id}:${currentFile.id}`) ?? null;
  const aiStale = aiResultIsStale(aiResult, repository);
  const sourceKey = `${repository.id}:${repository.revision ?? repository.version}:${currentFile?.id ?? ""}`;
  const sourceMatches = loadedSource?.fileId === currentFile?.id && loadedSource.repositoryId === repository.id && loadedSource.revision === repository.revision;
  const sourceText = repository.source === "local" ? (sourceMatches ? loadedSource?.text ?? "" : "") : currentFile?.source ?? "";
  const sourceStatus = repository.source === "local" ? (sourceMatches ? "loaded" : sourceLoad?.key === sourceKey ? sourceLoad.status : "loading") : "loaded";
  const aiContextKey = `${repository.id}:${repository.revision ?? repository.version}:${currentFile?.id ?? ""}:${aiSettingsRevision}`;
  useLayoutEffect(() => { aiContextRef.current = aiContextKey; }, [aiContextKey]);
  useLayoutEffect(() => { settingsSessionRef.current = { repositoryId: repository.id, sessionVersion: repositorySessionVersion }; }, [repository.id, repositorySessionVersion]);
  const aiRoute = aiRoutesByRepository.get(repository.id) ?? null;
  const aiRouteStale = aiRoute ? aiContextIsStale(aiRoute.contextFiles, repository) : false;
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

  const restoreWorkspaceState = useCallback((snapshot: RepositorySnapshot, saved: LocalWorkspaceState) => {
    setRecentRepositories(saved.recentRepositories);
    for (const [key, value] of Object.entries(saved.progress)) progressMemory.set(key, value);
    setAiResultsByFile((previous) => {
      const next = new Map(previous);
      for (const [fileId, value] of Object.entries(saved.aiResults)) {
        if (value && typeof value === "object" && Array.isArray((value as AiResultRecord).__contextFiles)) next.set(`${snapshot.id}:${fileId}`, value as AiResultRecord);
      }
      return next;
    });
    if (saved.aiRoute && saved.aiRoute.repositoryId === snapshot.id && Array.isArray(saved.aiRoute.steps) && Array.isArray(saved.aiRoute.contextFiles)) {
      setAiRoutesByRepository((previous) => new Map(previous).set(snapshot.id, saved.aiRoute as unknown as AiRouteRecord));
    }
    setNodePositions((previous) => {
      const next = new Map([...previous].filter(([key]) => !key.startsWith(`${snapshot.id}:`)));
      for (const [fileId, position] of Object.entries(saved.nodePositions)) {
        if (Number.isFinite(position?.x) && Number.isFinite(position?.y) && snapshot.files.some((file) => file.id === fileId)) next.set(`${snapshot.id}:${fileId}`, position);
      }
      nodePositionsPersisted.current = JSON.stringify(saved.nodePositions);
      return next;
    });
    return saved.warning;
  }, []);

  useEffect(() => {
    if (!desktopMode || repository.id === BOOT_SNAPSHOT.id) return;
    const timer = window.setTimeout(() => {
      const positions = Object.fromEntries([...nodePositions].flatMap(([key, point]) => {
        const prefix = `${repository.id}:`;
        return key.startsWith(prefix) ? [[key.slice(prefix.length), point] as const] : [];
      }));
      const serialized = JSON.stringify(positions);
      if (serialized === nodePositionsPersisted.current) return;
      nodePositionsPersisted.current = serialized;
      void localWorkspaceProvider.saveNodePositions(repository.id, positions).catch((error: Error) => setRepoMessage(`节点位置只保存在当前页面：${error.message}`));
    }, 450);
    return () => window.clearTimeout(timer);
  }, [desktopMode, nodePositions, repository.id]);

  useEffect(() => {
    let cancelled = false;
    const epoch = beginRepositorySession();
    sampleRepositoryProvider.getSnapshot().then(async (snapshot) => {
      let warning: string | undefined;
      if (desktopMode) {
        try { warning = restoreWorkspaceState(snapshot, await localWorkspaceProvider.get(snapshot.id)); }
        catch (error) { warning = error instanceof Error ? error.message : "无法读取桌面保存数据。"; }
      }
      if (cancelled || !repositoryGate.current.activate(epoch, snapshot)) return;
      setRepositorySessionVersion((version) => version + 1);
      setRepository(snapshot);
      setSelectedFileId(snapshot.files[0]?.id ?? "");
      if (warning) setRepoMessage(`桌面保存数据不可用，本次继续使用内存：${warning}`);
    }).catch((error: Error) => { if (!cancelled && repositoryGate.current.isCurrent(epoch)) setRepoMessage(error.message); });
    return () => { cancelled = true; };
  }, [beginRepositorySession, desktopMode, restoreWorkspaceState, setSelectedFileId]);

  const initialLayout = useMemo(
    () => layoutGraph(repository, selectedFileId, showAllGraph, compactGraph, graphDirectory, nodePositions),
    // Re-layout only on explicit reset; normal selection keeps user-arranged positions.
    [repository, selectedFileId, showAllGraph, compactGraph, graphDirectory, nodePositions],
  );
  const [nodes, setNodes, onNodesChangeBase] = useNodesState<GraphNode>(initialLayout.nodes);
  const edges = initialLayout.edges;

  useEffect(() => {
    const shouldReset = layoutOwner.current.version !== layoutVersion || layoutOwner.current.repositoryId !== repository.id;
    const present = new Set(repository.files.map((file) => `${repository.id}:${file.id}`));
    // Drop removed files and clear positions only when an explicit layout reset occurs.
    setNodePositions((previous) => {
      let changed = false;
      const next = new Map<string, { x: number; y: number }>();
      for (const [id, position] of previous) {
        const isCurrentRepository = id.startsWith(`${repository.id}:`);
        if (isCurrentRepository && (shouldReset || !present.has(id))) { changed = true; continue; }
        next.set(id, position);
      }
      return changed ? next : previous;
    });
    // Keep React Flow's controlled nodes synchronized with the repository and the saved drag positions.
    setNodes((previous) => initialLayout.nodes.map((node) => {
      const existing = previous.find((candidate) => candidate.id === node.id);
      const position = !shouldReset ? nodePositions.get(`${repository.id}:${node.id}`) ?? existing?.position ?? node.position : node.position;
      return { ...node, ...(existing?.measured ? { measured: existing.measured } : {}), position, selected: node.id === selectedFileId, data: { ...node.data, selected: node.id === selectedFileId } };
    }));
    layoutOwner.current = { version: layoutVersion, repositoryId: repository.id };
  }, [initialLayout, repository.id, repository.files, layoutVersion, selectedFileId, setNodes, nodePositions]);

  const onNodesChange = useCallback((changes: Parameters<typeof onNodesChangeBase>[0]) => {
    for (const change of changes) if (change.type === "position" && change.position) setNodePositions((previous) => new Map(previous).set(`${repository.id}:${change.id}`, change.position!));
    onNodesChangeBase(changes);
  }, [onNodesChangeBase, repository.id]);

  useEffect(() => {
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
  }, []);

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
    if (desktopMode && repository.id !== BOOT_SNAPSHOT.id) {
      void localWorkspaceProvider.saveProgress(repository.id, activeProgressKey, value).catch((error: Error) => setRepoMessage(`阅读进度只保存在当前页面：${error.message}`));
    }
  }, [tourIndex, completedSteps, activeProgressKey, desktopMode, repository.id]);

  useEffect(() => {
    const reference = focusedLine;
    if (!reference || reference.fileId !== currentFile.id || detailTab !== "source") return;
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(`source-line-${reference.line}`);
      if (target && codeViewportRef.current) {
        const viewport = codeViewportRef.current;
        viewport.scrollTo({ top: Math.max(0, target.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop - 115), behavior: "smooth" });
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
    clearAiContext(); setSearchQuery(""); setCollapsedFolders([]); setShowAllGraph(false); setLayoutVersion((version) => version + 1);
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
    const routeExpired = Boolean(aiRoute && !aiRouteStale && aiContextIsStale(aiRoute.contextFiles, snapshot));
    const expiredRouteFocus = routeExpired && focusOrigin === "route" && focusRouteSignature === aiRoute?.signature;
    setRepository(snapshot);
    clearAiContext();
    dispatchNavigation({ type: "snapshot", selectedFileId: nextFile?.id ?? "", graphDirectory: nextDirectory, clearFocus: referenceChanged || !nextFile || expiredRouteFocus, resetTour: false });
    setLoadedSource(null);
    setRepoMessage(expiredRouteFocus ? "阅读路线引用的源码已变化，旧行号已清除；路线说明仍可查看。" : referenceChanged ? "定位到的源码已变化，旧行号已清除。" : contentChanged ? "当前文件已变化，旧 AI 确认已清除。" : snapshot.files.length ? "本地索引已更新。" : "仓库中已没有可分析的源码文件。");
    return true;
  }, [aiRoute, aiRouteStale, clearAiContext, filesById, focusOrigin, focusRouteSignature, focusedLine, graphDirectory, selectedFileId]);
  useEffect(() => { applyUpdatedSnapshotRef.current = applyUpdatedSnapshot; }, [applyUpdatedSnapshot]);

  const openRepositoryPath = useCallback(async (path: string) => {
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
        try { workspaceWarning = restoreWorkspaceState(snapshot, await localWorkspaceProvider.get(snapshot.id, controller.signal)); }
        catch (error) { if (controller.signal.aborted) return; workspaceWarning = error instanceof Error ? error.message : "无法读取桌面保存数据。"; }
      }
      if (!openRequestGate.current.isCurrent(requestId) || !isCurrentRepositoryCommand(command) || controller.signal.aborted) return;
      const epoch = beginRepositorySession();
      if (!repositoryGate.current.activate(epoch, snapshot)) return;
      setRepositorySessionVersion((version) => version + 1);
      if (applySnapshot(snapshot, epoch)) {
        setRepoPath(path);
        setRepoMessage(workspaceWarning ? `仓库已打开；保存数据读取失败：${workspaceWarning}` : "仓库已打开，正在监听文件变化。");
        if (desktopMode) {
          try {
            await localWorkspaceProvider.touchRecent(snapshot.id);
            const saved = await localWorkspaceProvider.get(snapshot.id);
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
  }, [applySnapshot, beginRepositorySession, desktopMode, restoreWorkspaceState]);
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
        width: node.measured?.width ?? node.width ?? (compactGraphRef.current ? 150 : 190),
        height: node.measured?.height ?? node.height ?? (compactGraphRef.current ? 66 : 76),
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
      flow.setCenter(box.x, box.y, { zoom, duration: 280 });
    };
    requestAnimationFrame(locate);
  }, [flow, repository.dependencies]);

  useEffect(() => {
    if (!graphSizeRevision || !graphCanMount || !flow || !selectedFileId) return;
    const request = ++graphResizeRequest.current;
    let frame = 0;
    let attempts = 0;
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
      const margin = 24;
      const width = bounds.width - margin * 2;
      const height = bounds.height - margin * 2;
      const viewport = flow.getViewport();
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
        flow.setViewport({ ...viewport, x: viewport.x + deltaX, y: viewport.y + deltaY }, { duration: 180 });
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
  const selectFile = useCallback((fileId: string, view: MobileView = "details", directoryOverride?: string) => {
    clearAiContext();
    const nextDirectory = directoryOverride !== undefined ? directoryOverride : graphDirectory && !fileId.startsWith(`${graphDirectory}/`) ? "" : graphDirectory;
    dispatchNavigation({ type: "select-file", fileId, directory: nextDirectory });
    setDetailTab("guide");
    setMobileView(view);
    setSearchQuery(""); focusTreeFile(fileId); focusGraphFile(fileId);
  }, [clearAiContext, focusTreeFile, focusGraphFile, graphDirectory]);

  const openReference = useCallback((reference: SourceReference) => {
    clearAiContext();
    const nextDirectory = graphDirectory && !reference.fileId.startsWith(`${graphDirectory}/`) ? "" : graphDirectory;
    dispatchNavigation({ type: "reference-navigation", reference, directory: nextDirectory });
    setDetailTab("source");
    setMobileView("details");
    setSearchQuery(""); focusTreeFile(reference.fileId); focusGraphFile(reference.fileId);
  }, [clearAiContext, focusTreeFile, focusGraphFile, graphDirectory]);

  const openTourReference = useCallback((reference: SourceReference) => {
    clearAiContext();
    const nextDirectory = graphDirectory && !reference.fileId.startsWith(`${graphDirectory}/`) ? "" : graphDirectory;
    dispatchNavigation({ type: "reference-navigation", reference, directory: nextDirectory, origin: "route", routeSignature: activeRouteSignature });
    setDetailTab("source"); setMobileView("details"); setSearchQuery("");
    focusTreeFile(reference.fileId); focusGraphFile(reference.fileId);
  }, [activeRouteSignature, clearAiContext, focusTreeFile, focusGraphFile, graphDirectory]);

  const goToStep = useCallback((index: number, markCurrentComplete = false) => {
    const nextIndex = Math.max(0, Math.min(activeTour.length - 1, index));
    if (!activeTour.length || aiRouteStale) return;
    const step = activeTour[nextIndex];
    clearAiContext();
    dispatchNavigation({ type: "route-step", stepIndex: nextIndex, step, routeSignature: activeRouteSignature, ...(markCurrentComplete ? { completedStepId: activeTour[tourIndex].id } : {}) });
    setShowAllGraph(false);
    setDetailTab("source");
    setMobileView("details");
    setSearchQuery(""); focusTreeFile(step.focusFileId); focusGraphFile(step.focusFileId);
  }, [tourIndex, activeTour, activeRouteSignature, aiRouteStale, clearAiContext, focusTreeFile, focusGraphFile]);

  const resetTour = useCallback(() => {
    if (!activeTour.length || aiRouteStale) return;
    clearAiContext();
    setShowAllGraph(false);
    dispatchNavigation({ type: "restart-tour", step: activeTour[0], routeSignature: activeRouteSignature });
    setDetailTab("source");
    setMobileView("details");
    setSearchQuery(""); focusTreeFile(activeTour[0].focusFileId); focusGraphFile(activeTour[0].focusFileId);
  }, [activeTour, activeRouteSignature, aiRouteStale, clearAiContext, focusTreeFile, focusGraphFile]);

  const resetGraph = useCallback(() => {
    setNodePositions((previous) => new Map([...previous].filter(([id]) => !id.startsWith(`${repository.id}:`))));
    setLayoutVersion((version) => version + 1);
    window.requestAnimationFrame(() => focusGraphFile(currentFile.id));
  }, [currentFile.id, focusGraphFile, repository.id]);

  const removeRecentRepository = useCallback(async (repositoryId: string) => {
    try {
      await localWorkspaceProvider.removeRecent(repositoryId);
      const saved = await localWorkspaceProvider.get(repository.id);
      setRecentRepositories(saved.recentRepositories);
    } catch (error) { setRepoMessage(`无法移除最近仓库：${error instanceof Error ? error.message : "本地存储不可用。"}`); }
  }, [repository.id]);

  const clearCurrentSavedData = useCallback(async () => {
    if (!desktopMode || repository.id === BOOT_SNAPSHOT.id) return;
    try {
      await localWorkspaceProvider.clearRepository(repository.id);
      setAiResultsByFile((previous) => new Map([...previous].filter(([key]) => !key.startsWith(`${repository.id}:`))));
      setAiRoutesByRepository((previous) => { const next = new Map(previous); next.delete(repository.id); return next; });
      setNodePositions((previous) => new Map([...previous].filter(([key]) => !key.startsWith(`${repository.id}:`))));
      for (const key of progressMemory.keys()) if (key.startsWith(`repolens:${repository.id}:`)) progressMemory.delete(key);
      setTourIndex(0); setCompletedSteps([]); setRecentRepositories((previous) => previous.filter((item) => item.id !== repository.id));
      setRepoMessage("已清除此仓库的本地保存结果、路线、进度和节点位置。");
    } catch (error) { setRepoMessage(`无法清除此仓库的保存数据：${error instanceof Error ? error.message : "本地存储不可用。"}`); }
  }, [desktopMode, repository.id, setTourIndex, setCompletedSteps]);

  const clearAllSavedData = useCallback(async () => {
    try {
      await localWorkspaceProvider.clearAll();
      setRecentRepositories([]); setAiResultsByFile(new Map()); setAiRoutesByRepository(new Map()); setNodePositions(new Map());
      progressMemory.clear();
      try {
        for (const key of Object.keys(window.localStorage)) if (key.startsWith("repolens:")) window.localStorage.removeItem(key);
        for (const part of document.cookie.split(";")) {
          const key = part.trim().split("=", 1)[0];
          if (key.startsWith("repolens_")) document.cookie = `${key}=; Path=/; Max-Age=0; SameSite=Lax`;
        }
      } catch { /* Server storage is still cleared; browser storage can be unavailable. */ }
      setTourIndex(0); setCompletedSteps([]); setRepoMessage("已清除全部 RepoLens 本地保存数据。");
    } catch (error) { setRepoMessage(`无法清除全部保存数据：${error instanceof Error ? error.message : "本地存储不可用。"}`); }
  }, [setTourIndex, setCompletedSteps]);

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
    try { const snapshot = await sampleRepositoryProvider.getSnapshot(); if (!isCurrentRepositoryCommand(command) || !repositoryGate.current.activate(epoch, snapshot)) return; setRepositorySessionVersion((version) => version + 1); if (!applySnapshot(snapshot, epoch)) return; setRepoMessage("正在浏览内置示例仓库。"); setRepoBusy(false); }
    catch (error) { if (isCurrentRepositoryCommand(command) && repositoryGate.current.isCurrent(epoch)) { setRepoBusy(false); setRepoMessage(error instanceof Error ? error.message : "无法载入示例仓库。"); } }
  };
  const closeRepository = async () => {
    const command = nextRepositoryCommand();
    openRequestGate.current.invalidate(); openRequestController.current?.abort(); openRequestController.current = null;
    const epoch = beginRepositorySession(); setRepositorySessionVersion((version) => version + 1); setRepoBusy(true);
    void localRepositoryProvider.closeRepository(command).catch((error) => {
      if (isCurrentRepositoryCommand(command) && repositoryGate.current.isCurrent(epoch)) setRepoMessage(`已返回示例；关闭本地仓库尚未确认。${error instanceof Error ? ` ${error.message}` : ""}`);
    });
    await loadSample(command, epoch);
  };
  const rescanRepository = async () => {
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
  const previewAi = async (mode: AiMode, fileIds?: string[]) => {
    if (!aiSettings.configured) { clearAiContext(); dispatchAiWorkflow({ type: "message", message: "请先保存完整的模型服务地址、模型名称和密钥，再预览发送范围。" }); return; }
    const contextKey = aiContextKey;
    const preserveScope = aiWorkflow.mode === mode && aiCandidates.length > 0;
    clearAiContext(preserveScope);
    const requestId = ++aiRequestSequence.current;
    const requestContext = JSON.stringify([contextKey, mode, fileIds ?? null, graphDirectory, selectedAiRanges]);
    const controller = new AbortController();
    aiAbortController.current = controller;
    dispatchAiWorkflow({ type: "start", requestId, stage: "previewing", contextKey: requestContext, mode, preserveScope });
    try {
      const value = await localExplanationProvider.preview(repository, currentFile.id, mode, fileIds, graphDirectory || undefined, selectedAiRanges, controller.signal);
      if (aiRequestSequence.current !== requestId || aiContextRef.current !== contextKey) return;
      if (value.scopeRequired) {
        const previousFiles = selectedAiFiles.filter((id) => value.candidates.some((file) => file.fileId === id));
        const selectedFiles = previousFiles.includes(currentFile.id) ? previousFiles : [currentFile.id, ...previousFiles];
        const ranges = Object.fromEntries(value.candidates.map((file) => [file.fileId, selectedAiRanges[file.fileId] ?? { startLine: 1, endLine: file.lineCount }]));
        dispatchAiWorkflow({ type: "scopeRequired", requestId, contextKey: requestContext, candidates: value.candidates, selectedFiles, ranges, message: `范围超过 ${value.maxFiles} 个文件或 ${value.maxCharacters.toLocaleString()} 字符上限，请选择要纳入的文件后重新预览。` });
        return;
      }
      dispatchAiWorkflow({ type: "previewReady", requestId, contextKey: requestContext, preview: value.preview });
    } catch (error) { if (aiRequestSequence.current === requestId && aiContextRef.current === contextKey && (error as Error).name !== "AbortError") dispatchAiWorkflow({ type: "failed", requestId, contextKey: requestContext, message: error instanceof Error ? error.message : "无法预览发送范围。" }); }
    finally { if (aiAbortController.current === controller) aiAbortController.current = null; }
  };
  const generateAi = async () => {
    const preview = aiPreview;
    if (aiWorkflow.status !== "ready" || !aiWorkflow.mode || !preview || preview.mode !== aiWorkflow.mode || preview.repositoryId !== repository.id || preview.entryFileId !== currentFile.id || preview.revision !== repository.revision) return;
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
          steps: value.result.steps as { fileId: string; purpose: string; references: { fileId: string; startLine: number; endLine?: number }[] }[],
          contextFiles,
        }, (fileId: string) => filesById.get(fileId)?.name ?? fileId);
        setAiRoutesByRepository((previous) => new Map(previous).set(value.repositoryId, nextRoute));
        if (desktopMode) {
          try { await localWorkspaceProvider.saveAiRoute(value.repositoryId, nextRoute as unknown as Record<string, unknown>); }
          catch (error) { setRepoMessage(`路线已生成，但未能写入桌面保存数据：${error instanceof Error ? error.message : "存储不可用。"}`); }
        }
        setSearchQuery(""); setCollapsedFolders([]);
        finalMessage = "AI 阅读路线已生成；选中步骤即可定位文件和源码。";
      } else {
        const result: AiResultRecord = { ...value.result, __repositoryId: value.repositoryId, __entryFileId: value.entryFileId, __revision: value.revision, __mode: "explanation", __contextFiles: contextFiles };
        setAiResultsByFile((previous) => new Map(previous).set(`${value.repositoryId}:${value.entryFileId}`, result));
        if (desktopMode) {
          try { await localWorkspaceProvider.saveAiResult(value.repositoryId, value.entryFileId, result); }
          catch (error) { setRepoMessage(`讲解已生成，但未能写入桌面保存数据：${error instanceof Error ? error.message : "存储不可用。"}`); }
        }
        finalMessage = "讲解已生成，引用经过文件和行号校验。";
      }
      dispatchAiWorkflow({ type: "message", message: finalMessage });
      dispatchAiWorkflow({ type: "succeeded", requestId, contextKey: requestContext, message: finalMessage });
    } catch (error) { if (aiRequestSequence.current === requestId && aiContextRef.current === contextKey) dispatchAiWorkflow({ type: "failed", requestId, contextKey: requestContext, message: error instanceof Error ? error.name === "AbortError" ? "已取消模型请求。" : error.message : "生成失败。" }); }
    finally { if (aiRequestSequence.current === requestId && aiAbortController.current === controller) aiAbortController.current = null; }
  };

  return (
    <main className="app-shell">
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
        </div>
        <div className="topbar-end">
          {repository.source === "sample" && <span className="tour-status"><Sparkles size={14} />预置导览</span>}
          {repository.source === "local" && <><button className="repo-action" onClick={rescanRepository} disabled={repoBusy}>{repository.origin?.kind === "github" ? "检查远端更新" : "重新扫描"}</button><button className="repo-action" onClick={closeRepository}>返回示例</button></>}
          <span className="version-stamp">v{repository.version}</span>
        </div>
      </header>

      <nav className="mobile-tabs" aria-label="工作区面板">
        <button className={mobileView === "files" ? "is-active" : ""} onClick={() => setMobileView("files")}>
          <ListTree size={15} />文件
        </button>
        <button className={mobileView === "graph" ? "is-active" : ""} onClick={() => { setMobileView("graph"); focusGraphFile(currentFile.id); }}>
          <Waypoints size={15} />依赖图
        </button>
        <button className={mobileView === "details" ? "is-active" : ""} onClick={() => setMobileView("details")}>
          <BookOpenText size={15} />详情
        </button>
      </nav>

      <section id="repository-workspace" className="workspace-grid">
        <DirectoryPanel
          repository={repository}
          mobileView={mobileView}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          repoPath={repoPath}
          onRepoPathChange={setRepoPath}
          repoBusy={repoBusy}
          repoMessage={repoMessage}
          desktopMode={desktopMode}
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
          canvasRef={graphCanvasRef}
          nodes={nodes}
          edges={edges}
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
          currentFile={currentFile}
          filesById={filesById}
          mobileView={mobileView}
          detailTab={detailTab}
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
        />
      </section>

      <TourBar
        repository={activeTour === repository.tour ? repository : { ...repository, tour: activeTour }}
        stepIndex={tourIndex}
        completedSteps={completedSteps}
        stepsRef={tourStepsRef}
        disabled={aiRouteStale}
        onGoToStep={goToStep}
        onComplete={() => { if (currentTour) setCompletedSteps((previous) => previous.includes(currentTour.id) ? previous : [...previous, currentTour.id]); }}
        onReset={resetTour}
        onOpenReference={openTourReference}
      />
    </main>
  );
}

export default function Home() {
  return <ReactFlowProvider><AppShell /></ReactFlowProvider>;
}
