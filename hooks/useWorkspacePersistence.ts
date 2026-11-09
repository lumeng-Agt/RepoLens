import { assertReadingArtifactCapacity } from "@/data/persistence-limits.mjs";
import { getReadingTourStatus } from "@/data/reading-route-state.mjs";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  localWorkspaceProvider,
  isWorkspaceCopyCleanupPending,
  type LocalWorkspaceState,
  type WorkspaceSession,
} from "@/data/providers";
import { markWorkspacePersistencePending, enqueueWorkspacePersistence, acknowledgeWorkspaceCopyCleanup, getKnownWorkspacePersistenceIds } from "@/data/workspace-persistence.mjs";
import {
  clearAllQuestionConversations,
  clearQuestionConversationWorkspace,
} from "@/data/question-recovery.mjs";
import {
  clearInvestigationMemory,
  failInvestigationRead,
  invalidateInvestigationTasks,
  knownInvestigationWorkspaces,
  registerInvestigationSession,
  restoreInvestigations,
} from "@/data/investigation-state.mjs";
import {
  acknowledgeReadingArtifactJournal,
  applyReadingArtifactJournal,
  createReadingArtifactJournal,
  hasReadingArtifactOperations,
  readingArtifactJournalCheckpoint,
  stageReadingArtifactChanges,
  type ReadingArtifactJournal,
} from "@/data/reading-artifact-journal.mjs";
import {
  DEFAULT_WORKSPACE_LAYOUT,
  normalizeWorkspaceLayout,
} from "@/data/workspace-layout.mjs";
import {
  createDefaultUsageGuidePreferences,
  hasExistingWorkspaceUse,
  type UsageGuidePreferences,
} from "@/data/usage-guide.mjs";
import type { AiResultRecord } from "@/components/repolens/AiResultView";
import type { AiRouteRecord, ReadingNote, RepositorySnapshot } from "@/data/model";
import {
  nodePositionSessionKey,
  nodePositionSignature,
  repositoryWorkspaceId,
  workspaceSession,
} from "@/hooks/useRepositorySession";
import {
  WORKSPACE_LAYOUT_PERSISTENCE_ID,
  WORKSPACE_LAYOUT_STORAGE_KEY,
} from "@/hooks/useWorkspaceLayout";

export const USAGE_GUIDE_STORAGE_KEY = "repolens:usage-guide:v1";

export function stageBrowserProgressClear(workspaceId?: string) {
  const localPrefix = workspaceId ? `repolens:${workspaceId}:` : "repolens:";
  const cookiePrefix = workspaceId
    ? `repolens_${workspaceId.replaceAll(/[^a-zA-Z0-9_-]/g, "_")}_`
    : "repolens_";
  const localEntries: [string, string][] = [];
  const cookieEntries: [string, string][] = [];
  for (const key of Object.keys(window.localStorage)) {
    if (
      !key.startsWith(localPrefix) &&
      key !== `repolens:reading-baseline:${workspaceId}` &&
      key !== `repolens:chat-ui:${workspaceId}`
    )
      continue;
    const value = window.localStorage.getItem(key);
    if (value !== null) localEntries.push([key, value]);
  }
  for (const part of document.cookie.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name.startsWith(cookiePrefix)) cookieEntries.push([name, value.join("=")]);
  }
  const restore = () => {
    for (const [key, value] of localEntries) window.localStorage.setItem(key, value);
    for (const [name, value] of cookieEntries)
      document.cookie = `${name}=${value}; Path=/; Max-Age=31536000; SameSite=Lax`;
  };
  try {
    for (const [key] of localEntries) window.localStorage.removeItem(key);
    for (const [name] of cookieEntries) document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
    const remainingLocal = localEntries.some(([key]) => window.localStorage.getItem(key) !== null);
    const remainingCookies = cookieEntries.some(([name]) =>
      document.cookie.split(";").some((part) => part.trim().startsWith(`${name}=`))
    );
    if (remainingLocal || remainingCookies) throw new Error("浏览器中的阅读进度未能清除。");
  } catch (error) {
    try {
      restore();
    } catch {
      /* Keep the original clearing error and report it to the user. */
    }
    throw new Error(`无法清除浏览器中的阅读进度：${error instanceof Error ? error.message : String(error)}`);
  }
  return restore;
}

export interface UseWorkspacePersistenceOptions {
  repository: RepositorySnapshot;
  workspaceId: string;
  repositorySessionVersion: number;
  desktopMode: boolean;
  repoBusy: boolean;
  savedDataClearBusy?: boolean;
  setSavedDataClearBusy?: React.Dispatch<React.SetStateAction<boolean>>;
  onClearAiContext: () => void;
  onSetRepoMessage: (message: string) => void;
  repositoryGate: React.MutableRefObject<{
    current: () => { epoch: number };
    isCurrent: (epoch: number, id?: string) => boolean;
  }>;
  workspacePersistenceReadyKeys: Set<string>;
  setWorkspacePersistenceReadyKeys: React.Dispatch<React.SetStateAction<Set<string>>>;
  workspaceReadFailures: Set<string>;
  setWorkspaceReadFailures: React.Dispatch<React.SetStateAction<Set<string>>>;
  nodePositionsRef: React.MutableRefObject<Map<string, { x: number; y: number }>>;
  setNodePositions: React.Dispatch<React.SetStateAction<Map<string, { x: number; y: number }>>>;
  nodePositionsPersisted: React.MutableRefObject<Map<string, string>>;
  dirtyNodePositions: React.MutableRefObject<Map<string, Set<string>>>;
  pendingNodePositionRestore: React.MutableRefObject<{ key: string; workspaceId: string; signature: string } | null>;
  setNodePositionsReadyKey: React.Dispatch<React.SetStateAction<string | null>>;
  setRecentRepositories: React.Dispatch<React.SetStateAction<LocalWorkspaceState["recentRepositories"]>>;
  progressMemory: Map<string, string>;
  workspaceLayoutReady: boolean;
  workspaceLayoutInitializedRef: React.MutableRefObject<boolean>;
  workspaceLayoutPreferences: typeof DEFAULT_WORKSPACE_LAYOUT;
  setWorkspaceLayoutPreferences: React.Dispatch<React.SetStateAction<typeof DEFAULT_WORKSPACE_LAYOUT>>;
  setWorkspaceLayoutReady: React.Dispatch<React.SetStateAction<boolean>>;
  setBrowserLayoutSaveError: React.Dispatch<React.SetStateAction<string>>;
  setBrowserProgressSaveFailures: React.Dispatch<React.SetStateAction<Set<string>>>;
  initializeGuidePreferences: (
    stored: unknown,
    present: boolean,
    hasExistingUse: boolean,
    storageReady: boolean,
    warning?: string
  ) => void;
  guidePreferencesRef: React.MutableRefObject<UsageGuidePreferences>;
  setGuidePreferences: React.Dispatch<React.SetStateAction<UsageGuidePreferences>>;
  setShowGuideWelcome: React.Dispatch<React.SetStateAction<boolean>>;
  setGuidePanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setGuideNoticeAvailable: React.Dispatch<React.SetStateAction<boolean>>;
  setGuideStorageMessage: React.Dispatch<React.SetStateAction<string>>;
  guideTourPracticeRef: React.MutableRefObject<unknown>;
  guideNavigationRef: React.MutableRefObject<unknown>;
  guideSaveSequenceRef: React.MutableRefObject<number>;
  guideWriteQueueRef: React.MutableRefObject<Promise<void>>;
  setTourIndex: (value: number | ((prev: number) => number)) => void;
  setCompletedSteps: (value: string[] | ((prev: string[]) => string[])) => void;
  setTourVisibilityOverride: React.Dispatch<React.SetStateAction<{ signature: string; open: boolean } | null>>;
  activeProgressKey?: string;
  getActiveProgressKey?: () => string;
  savedDataClearActiveRef?: React.MutableRefObject<boolean>;
  tourIndex: number;
  completedSteps: string[];
}

export function useWorkspacePersistence({
  repository,
  workspaceId,
  repositorySessionVersion,
  desktopMode,
  repoBusy,
  savedDataClearBusy: externalSavedDataClearBusy,
  setSavedDataClearBusy: externalSetSavedDataClearBusy,
  onClearAiContext,
  onSetRepoMessage,
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
  activeProgressKey,
  getActiveProgressKey,
  savedDataClearActiveRef: externalSavedDataClearActiveRef,
  tourIndex,
  completedSteps,
}: UseWorkspacePersistenceOptions) {
  const [readingNotesByWorkspace, setReadingNotesByWorkspace] = useState<Map<string, ReadingNote[]>>(() => new Map());
  const readingNotesRef = useRef(readingNotesByWorkspace);
  useLayoutEffect(() => {
    readingNotesRef.current = readingNotesByWorkspace;
  }, [readingNotesByWorkspace]);

  const [savedToursByWorkspace, setSavedToursByWorkspace] = useState<Map<string, AiRouteRecord[]>>(() => new Map());
  const savedToursRef = useRef(savedToursByWorkspace);
  useLayoutEffect(() => {
    savedToursRef.current = savedToursByWorkspace;
  }, [savedToursByWorkspace]);

  const [aiResultsByFile, setAiResultsByFile] = useState<Map<string, AiResultRecord>>(() => new Map());
  const [aiRoutesByRepository, setAiRoutesByRepository] = useState<Map<string, AiRouteRecord>>(() => new Map());
  const readingArtifactJournals = useRef<Map<string, ReadingArtifactJournal<ReadingNote, AiRouteRecord>>>(new Map());

  const [internalSavedDataClearBusy, setInternalSavedDataClearBusy] = useState(false);
  const savedDataClearBusy = externalSavedDataClearBusy ?? internalSavedDataClearBusy;
  const setSavedDataClearBusy = externalSetSavedDataClearBusy ?? setInternalSavedDataClearBusy;
  const [savedDataClearGeneration, setSavedDataClearGeneration] = useState(0);
  const savedDataClearGenerationRef = useRef(0);
  const internalSavedDataClearActiveRef = useRef(false);
  const savedDataClearActiveRef = externalSavedDataClearActiveRef ?? internalSavedDataClearActiveRef;

  const [questionClearVersion, setQuestionClearVersion] = useState(0);
  const [chatClearingTarget, setChatClearingTarget] = useState<string | null>(null);
  const [chatClearVersions, setChatClearVersions] = useState<Record<string, number>>({});
  const [chatClearAllVersion, setChatClearAllVersion] = useState(0);

  const persistReadingArtifactJournal = useCallback(
    (snapshot: RepositorySnapshot, notes: ReadingNote[], tours: AiRouteRecord[]) => {
      const targetWorkspaceId = repositoryWorkspaceId(snapshot);
      const journal = readingArtifactJournals.current.get(targetWorkspaceId);
      if (!journal || !hasReadingArtifactOperations(journal)) return Promise.resolve();
      const checkpoint = readingArtifactJournalCheckpoint(journal);
      const saveNotes = hasReadingArtifactOperations(journal, "notes");
      const saveTours = hasReadingArtifactOperations(journal, "tours");
      const saves: Promise<unknown>[] = [];
      if (saveNotes)
        saves.push(
          enqueueWorkspacePersistence(
            targetWorkspaceId,
            async () => {
              await localWorkspaceProvider.saveReadingNotes(workspaceSession(snapshot), notes);
              const current = readingArtifactJournals.current.get(targetWorkspaceId);
              if (current)
                readingArtifactJournals.current.set(
                  targetWorkspaceId,
                  acknowledgeReadingArtifactJournal(current, "notes", checkpoint)
                );
            },
            { key: "reading-notes" }
          )
        );
      if (saveTours)
        saves.push(
          enqueueWorkspacePersistence(
            targetWorkspaceId,
            async () => {
              await localWorkspaceProvider.saveTours(workspaceSession(snapshot), tours);
              const current = readingArtifactJournals.current.get(targetWorkspaceId);
              if (current)
                readingArtifactJournals.current.set(
                  targetWorkspaceId,
                  acknowledgeReadingArtifactJournal(current, "tours", checkpoint)
                );
            },
            { key: "saved-tours" }
          )
        );
      return Promise.all(saves).then(() => undefined);
    },
    []
  );

  const restoreWorkspaceState = useCallback(
    (snapshot: RepositorySnapshot, saved: LocalWorkspaceState) => {
      const investigationWorkspaceId = repositoryWorkspaceId(snapshot);
      registerInvestigationSession(
        investigationWorkspaceId,
        `${investigationWorkspaceId}:${snapshot.persistenceSessionId ?? ""}`
      );
      if (saved.persistenceReady === false)
        failInvestigationRead(investigationWorkspaceId, saved.warning ?? "调查记录读取失败。");
      else restoreInvestigations(investigationWorkspaceId, saved.investigations ?? []);
      initializeGuidePreferences(
        saved.guidePreferences ?? null,
        saved.guidePreferences != null,
        hasExistingWorkspaceUse(saved),
        saved.persistenceReady !== false,
        saved.warning
      );
      const positionsKey = nodePositionSessionKey(snapshot);
      if (saved.persistenceReady === false) {
        setWorkspacePersistenceReadyKeys((previous) => {
          const next = new Set(previous);
          next.delete(positionsKey);
          return next;
        });
        setNodePositionsReadyKey((current) => (current === positionsKey ? null : current));
        setWorkspaceReadFailures((previous) => new Set(previous).add(positionsKey));
        return saved.warning ?? "本地保存数据尚未成功读取；本页修改不会覆盖原记录。";
      }
      if (desktopMode && !workspaceLayoutInitializedRef.current) {
        const restoredLayout =
          saved.layoutPreferences == null ? DEFAULT_WORKSPACE_LAYOUT : normalizeWorkspaceLayout(saved.layoutPreferences);
        if (restoredLayout) {
          setWorkspaceLayoutPreferences(restoredLayout);
          workspaceLayoutInitializedRef.current = true;
          setWorkspaceLayoutReady(true);
        } else {
          onSetRepoMessage("无法读取已保存的栏目宽度；本次使用默认布局，原记录未被覆盖。");
        }
      }
      const targetWorkspaceId = repositoryWorkspaceId(snapshot);
      const validSavedNodePositions = Object.fromEntries(
        Object.entries(saved.nodePositions).filter(
          ([fileId, position]) =>
            Number.isFinite(position?.x) &&
            Number.isFinite(position?.y) &&
            snapshot.files.some((file) => file.id === fileId)
        )
      );
      nodePositionsPersisted.current.set(positionsKey, nodePositionSignature(saved.nodePositions));
      const dirtyIds = dirtyNodePositions.current.get(targetWorkspaceId) ?? new Set<string>();
      const inMemoryPositions = Object.fromEntries(
        [...nodePositionsRef.current].flatMap(([key, point]) => {
          const prefix = `${targetWorkspaceId}:`;
          const fileId = key.startsWith(prefix) ? key.slice(prefix.length) : "";
          return dirtyIds.has(fileId) && snapshot.files.some((file) => file.id === fileId)
            ? ([[fileId, point] as const] as const)
            : [];
        })
      );
      const savedNodePositions = { ...validSavedNodePositions, ...inMemoryPositions };
      pendingNodePositionRestore.current = {
        key: positionsKey,
        workspaceId: targetWorkspaceId,
        signature: nodePositionSignature(savedNodePositions),
      };
      setRecentRepositories(saved.recentRepositories);
      for (const [key, value] of Object.entries(saved.progress)) {
        if (!progressMemory.has(key)) progressMemory.set(key, value);
      }
      setAiResultsByFile((previous) => {
        const next = new Map(previous);
        for (const [fileId, value] of Object.entries(saved.aiResults)) {
          const resultKey = `${repositoryWorkspaceId(snapshot)}:${fileId}`;
          if (
            !next.has(resultKey) &&
            value &&
            typeof value === "object" &&
            Array.isArray((value as AiResultRecord).__contextFiles)
          )
            next.set(resultKey, value as AiResultRecord);
        }
        return next;
      });
      if (
        saved.aiRoute &&
        saved.aiRoute.repositoryId === snapshot.id &&
        ["current", "stale"].includes(getReadingTourStatus(saved.aiRoute, new Map(snapshot.files.map(file => [file.id, file]))).state)
      ) {
        setAiRoutesByRepository((previous) =>
          previous.has(repositoryWorkspaceId(snapshot))
            ? previous
            : new Map(previous).set(repositoryWorkspaceId(snapshot), saved.aiRoute as unknown as AiRouteRecord)
        );
      }
      const artifactWorkspaceId = repositoryWorkspaceId(snapshot);
      const journal =
        readingArtifactJournals.current.get(artifactWorkspaceId) ??
        createReadingArtifactJournal<ReadingNote, AiRouteRecord>();
      readingArtifactJournals.current.set(artifactWorkspaceId, journal);
      const restoredNotes = applyReadingArtifactJournal(
        Array.isArray(saved.readingNotes)
          ? saved.readingNotes.filter(
              (item): item is ReadingNote =>
                Boolean(item && typeof item.id === "string" && typeof item.fileId === "string" && typeof item.text === "string")
            )
          : [],
        journal,
        "notes"
      );
      const restoredTours = applyReadingArtifactJournal(
        Array.isArray(saved.savedTours) ? (saved.savedTours as AiRouteRecord[]) : [],
        journal,
        "tours"
      );
      const nextNotes = new Map(readingNotesRef.current);
      nextNotes.set(artifactWorkspaceId, restoredNotes);
      readingNotesRef.current = nextNotes;
      setReadingNotesByWorkspace(nextNotes);
      const nextTours = new Map(savedToursRef.current);
      nextTours.set(artifactWorkspaceId, restoredTours);
      savedToursRef.current = nextTours;
      setSavedToursByWorkspace(nextTours);
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
      setWorkspaceReadFailures((previous) => {
        const next = new Set(previous);
        next.delete(positionsKey);
        return next;
      });
      if (hasReadingArtifactOperations(journal)) {
        void persistReadingArtifactJournal(snapshot, restoredNotes, restoredTours).catch((error: Error) =>
          onSetRepoMessage(`原有阅读记录已恢复，但本页改动尚未保存：${error.message}`)
        );
      }
      return saved.warning;
    },
    [
      desktopMode,
      dirtyNodePositions,
      initializeGuidePreferences,
      nodePositionsPersisted,
      nodePositionsRef,
      onSetRepoMessage,
      pendingNodePositionRestore,
      persistReadingArtifactJournal,
      progressMemory,
      setNodePositions,
      setNodePositionsReadyKey,
      setRecentRepositories,
      setWorkspaceLayoutPreferences,
      setWorkspaceLayoutReady,
      setWorkspacePersistenceReadyKeys,
      setWorkspaceReadFailures,
      workspaceLayoutInitializedRef,
    ]
  );

  const saveReadingNotes = useCallback(
    (
      notes: ReadingNote[],
      expected?: { repositoryId: string; workspaceId: string; sessionVersion: number; clearGeneration: number }
    ): Promise<boolean> => {
      const targetId = workspaceId;
      const snapshot = repository;
      const epoch = repositoryGate.current.current().epoch;
      const sessionVersion = repositorySessionVersion;
      if (
        savedDataClearActiveRef.current ||
        (expected &&
          (expected.repositoryId !== snapshot.id ||
            expected.workspaceId !== targetId ||
            expected.sessionVersion !== sessionVersion ||
            expected.clearGeneration !== savedDataClearGenerationRef.current)) ||
        !repositoryGate.current.isCurrent(epoch, snapshot.id)
      )
        return Promise.resolve(false);
      try { assertReadingArtifactCapacity({ notes }, workspaceSession(snapshot)); }
      catch (error) { onSetRepoMessage(`无法保存阅读记录：${error instanceof Error ? error.message : "记录格式无效。"}`); return Promise.resolve(false); }
      const previousNotes = readingNotesRef.current.get(targetId) ?? [];
      const journal =
        readingArtifactJournals.current.get(targetId) ?? createReadingArtifactJournal<ReadingNote, AiRouteRecord>();
      const stagedJournal = stageReadingArtifactChanges(journal, "notes", previousNotes, notes);
      readingArtifactJournals.current.set(targetId, stagedJournal);
      const next = new Map(readingNotesRef.current);
      next.set(targetId, notes);
      readingNotesRef.current = next;
      setReadingNotesByWorkspace(next);
      const restoreKey = nodePositionSessionKey(snapshot);
      if (!workspacePersistenceReadyKeys.has(restoreKey) || workspaceReadFailures.has(restoreKey)) {
        onSetRepoMessage("原有阅读记录尚未读取成功。本次修改尚未保存到本地；读取恢复后会与原记录合并。");
        return Promise.resolve(false);
      }
      const checkpoint = readingArtifactJournalCheckpoint(stagedJournal);
      return enqueueWorkspacePersistence(
        targetId,
        () => localWorkspaceProvider.saveReadingNotes(workspaceSession(snapshot), notes),
        { key: "reading-notes" }
      )
        .then((result) => {
          if (result && "skipped" in result && result.skipped) return false;
          const current = readingArtifactJournals.current.get(targetId);
          if (current)
            readingArtifactJournals.current.set(
              targetId,
              acknowledgeReadingArtifactJournal(current, "notes", checkpoint)
            );
          return true;
        })
        .catch((error: Error) => {
          if (repositoryGate.current.isCurrent(epoch, snapshot.id))
            onSetRepoMessage(`阅读记录尚未保存到本地：${error.message}`);
          return false;
        });
    },
    [
      onSetRepoMessage,
      repository,
      repositoryGate,
      repositorySessionVersion,
      workspaceId,
      workspacePersistenceReadyKeys,
      workspaceReadFailures,
    ]
  );

  const saveTours = useCallback(
    (
      tours: AiRouteRecord[],
      expected?: { repositoryId: string; workspaceId: string; sessionVersion: number; clearGeneration: number }
    ): Promise<boolean> => {
      const targetId = workspaceId;
      const snapshot = repository;
      const epoch = repositoryGate.current.current().epoch;
      const sessionVersion = repositorySessionVersion;
      if (
        savedDataClearActiveRef.current ||
        (expected &&
          (expected.repositoryId !== snapshot.id ||
            expected.workspaceId !== targetId ||
            expected.sessionVersion !== sessionVersion ||
            expected.clearGeneration !== savedDataClearGenerationRef.current)) ||
        !repositoryGate.current.isCurrent(epoch, snapshot.id)
      )
        return Promise.resolve(false);
      try { assertReadingArtifactCapacity({ tours }, workspaceSession(snapshot)); }
      catch (error) { onSetRepoMessage(`无法保存阅读路线：${error instanceof Error ? error.message : "记录格式无效。"}`); return Promise.resolve(false); }
      const previousTours = savedToursRef.current.get(targetId) ?? [];
      const journal =
        readingArtifactJournals.current.get(targetId) ?? createReadingArtifactJournal<ReadingNote, AiRouteRecord>();
      const stagedJournal = stageReadingArtifactChanges(journal, "tours", previousTours, tours);
      readingArtifactJournals.current.set(targetId, stagedJournal);
      const next = new Map(savedToursRef.current);
      next.set(targetId, tours);
      savedToursRef.current = next;
      setSavedToursByWorkspace(next);
      const restoreKey = nodePositionSessionKey(snapshot);
      if (!workspacePersistenceReadyKeys.has(restoreKey) || workspaceReadFailures.has(restoreKey)) {
        onSetRepoMessage("原有阅读路线尚未读取成功。本次修改尚未保存到本地；读取恢复后会与原路线合并。");
        return Promise.resolve(false);
      }
      const checkpoint = readingArtifactJournalCheckpoint(stagedJournal);
      return enqueueWorkspacePersistence(
        targetId,
        () => localWorkspaceProvider.saveTours(workspaceSession(snapshot), tours),
        { key: "saved-tours" }
      )
        .then((result) => {
          if (result && "skipped" in result && result.skipped) return false;
          const current = readingArtifactJournals.current.get(targetId);
          if (current)
            readingArtifactJournals.current.set(
              targetId,
              acknowledgeReadingArtifactJournal(current, "tours", checkpoint)
            );
          return true;
        })
        .catch((error: Error) => {
          if (repositoryGate.current.isCurrent(epoch, snapshot.id))
            onSetRepoMessage(`阅读路线尚未保存到本地：${error.message}`);
          return false;
        });
    },
    [
      onSetRepoMessage,
      repository,
      repositoryGate,
      repositorySessionVersion,
      workspaceId,
      workspacePersistenceReadyKeys,
      workspaceReadFailures,
    ]
  );

  const retryWorkspaceRestore = useCallback(async () => {
    const snapshot = repository;
    const restoreGeneration = savedDataClearGenerationRef.current;
    const epoch = repositoryGate.current.current().epoch;
    try {
      const saved = await localWorkspaceProvider.get(repositoryWorkspaceId(snapshot));
      if (
        !repositoryGate.current.isCurrent(epoch, snapshot.id) ||
        savedDataClearActiveRef.current ||
        restoreGeneration !== savedDataClearGenerationRef.current
      )
        return;
      const warning = restoreWorkspaceState(snapshot, saved);
      if (saved.persistenceReady === false) throw new Error(warning ?? "本地保存数据尚未成功读取。");
      onSetRepoMessage(warning ? `保存数据已读取：${warning}` : "保存数据已恢复；本页待保存修改正在写入。");
    } catch (error) {
      if (
        !repositoryGate.current.isCurrent(epoch, snapshot.id) ||
        savedDataClearActiveRef.current ||
        restoreGeneration !== savedDataClearGenerationRef.current
      )
        return;
      failInvestigationRead(repositoryWorkspaceId(snapshot), error instanceof Error ? error.message : "本地存储不可用。");
      const failedKey = nodePositionSessionKey(snapshot);
      setWorkspacePersistenceReadyKeys((current) => {
        const next = new Set(current);
        next.delete(failedKey);
        return next;
      });
      setWorkspaceReadFailures((current) => new Set(current).add(failedKey));
      setNodePositionsReadyKey((current) => (current === failedKey ? null : current));
      onSetRepoMessage(
        `保存数据读取失败；原记录已保留，可稍后重试：${error instanceof Error ? error.message : "本地存储不可用。"}`
      );
    }
  }, [
    onSetRepoMessage,
    repository,
    repositoryGate,
    restoreWorkspaceState,
    setNodePositionsReadyKey,
    setWorkspacePersistenceReadyKeys,
    setWorkspaceReadFailures,
  ]);

  const retryReadingArtifactSave = useCallback(async () => {
    try {
      const layoutSave =
        desktopMode && workspaceLayoutReady
          ? enqueueWorkspacePersistence(
              WORKSPACE_LAYOUT_PERSISTENCE_ID,
              () => localWorkspaceProvider.saveLayoutPreferences(workspaceLayoutPreferences),
              { key: "layout-preferences" }
            )
          : Promise.resolve();
      if (!workspacePersistenceReadyKeys.has(nodePositionSessionKey(repository))) {
        await layoutSave;
        return;
      }
      const progressKeyToSave = activeProgressKey ?? getActiveProgressKey?.() ?? "";
      await Promise.all([
        persistReadingArtifactJournal(
          repository,
          readingNotesRef.current.get(workspaceId) ?? [],
          savedToursRef.current.get(workspaceId) ?? []
        ),
        progressKeyToSave
          ? enqueueWorkspacePersistence(
              workspaceId,
              () =>
                localWorkspaceProvider.saveProgress(
                  workspaceSession(repository),
                  progressKeyToSave,
                  JSON.stringify({ stepIndex: tourIndex, completedSteps })
                ),
              { key: `progress:${progressKeyToSave}` }
            )
          : Promise.resolve(),
        layoutSave,
      ]);
      onSetRepoMessage("已重试阅读进度、笔记、路线和栏目宽度的保存；请查看保存状态。");
    } catch (error) {
      onSetRepoMessage(`仍有阅读数据尚未保存：${error instanceof Error ? error.message : "本地存储不可用。"}`);
    }
  }, [
    activeProgressKey,
    completedSteps,
    desktopMode,
    getActiveProgressKey,
    onSetRepoMessage,
    persistReadingArtifactJournal,
    repository,
    tourIndex,
    workspaceId,
    workspaceLayoutPreferences,
    workspaceLayoutReady,
    workspacePersistenceReadyKeys,
  ]);

  // Read workspace on local repository activation
  useEffect(() => {
    if (repository.source !== "local") return;
    const activeRepositoryId = repository.id;
    const activeWorkspaceId = workspaceId;
    const epoch = repositoryGate.current.current().epoch;
    const restoreGeneration = savedDataClearGenerationRef.current;
    let cancelled = false;
    const controller = new AbortController();
    localWorkspaceProvider
      .get(activeWorkspaceId, controller.signal)
      .then((saved) => {
        if (
          cancelled ||
          !repositoryGate.current.isCurrent(epoch, activeRepositoryId) ||
          savedDataClearActiveRef.current ||
          restoreGeneration !== savedDataClearGenerationRef.current
        )
          return;
        registerInvestigationSession(
          activeWorkspaceId,
          `${activeWorkspaceId}:${repository.persistenceSessionId ?? ""}`
        );
        if (saved.persistenceReady === false)
          failInvestigationRead(activeWorkspaceId, saved.warning ?? "调查记录读取失败。");
        else restoreInvestigations(activeWorkspaceId, saved.investigations ?? []);
        if (saved.persistenceReady === false) {
          const failedKey = nodePositionSessionKey(repository);
          setWorkspacePersistenceReadyKeys((current) => {
            const next = new Set(current);
            next.delete(failedKey);
            return next;
          });
          setWorkspaceReadFailures((current) => new Set(current).add(failedKey));
          setNodePositionsReadyKey((current) => (current === failedKey ? null : current));
          onSetRepoMessage(`保存数据读取失败；原记录未被覆盖：${saved.warning ?? "无法读取本地存储。"}`);
          return;
        }
        restoreWorkspaceState(repository, saved);
      })
      .catch((error: Error) => {
        if (
          cancelled ||
          !repositoryGate.current.isCurrent(epoch, activeRepositoryId) ||
          savedDataClearActiveRef.current ||
          restoreGeneration !== savedDataClearGenerationRef.current
        )
          return;
        failInvestigationRead(activeWorkspaceId, error.message);
        const failedKey = nodePositionSessionKey(repository);
        setWorkspacePersistenceReadyKeys((current) => {
          const next = new Set(current);
          next.delete(failedKey);
          return next;
        });
        setWorkspaceReadFailures((current) => new Set(current).add(failedKey));
        setNodePositionsReadyKey((current) => (current === failedKey ? null : current));
        onSetRepoMessage(`保存数据读取失败；原记录已保留，可稍后重试：${error.message}`);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    onSetRepoMessage,
    repository,
    repository.id,
    repository.persistenceSessionId,
    repository.source,
    repositoryGate,
    restoreWorkspaceState,
    setNodePositionsReadyKey,
    setWorkspacePersistenceReadyKeys,
    setWorkspaceReadFailures,
    workspaceId,
  ]);

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
  }, [repository, workspaceId, onSetRepoMessage]);

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
    onClearAiContext();
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
    onClearAiContext,
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
    onClearAiContext();
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
    onClearAiContext,
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
  ]);

  return {
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
    savedDataClearBusy,
    savedDataClearGeneration,
    savedDataClearGenerationRef,
    savedDataClearActiveRef,
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
    retrySavedDataClear: () => {
      if (pendingClearScope.current === "current" && pendingClearWorkspace.current !== workspaceId) { onSetRepoMessage("请先返回未完成清除的仓库，再重试。"); return; }
      return pendingClearScope.current === "all" ? clearAllSavedData() : clearCurrentSavedData();
    },
  };
}
