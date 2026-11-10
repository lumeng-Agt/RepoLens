import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { localWorkspaceProvider } from "@/data/providers";
import type { AiRouteRecord, RepositorySnapshot, SourceReference, TourStep } from "@/data/model";
import type { StateUpdate, navigationReducer } from "@/data/navigation-state.mjs";
import { parseTourProgress } from "@/data/tour-progress.mjs";
import { createProgressSessionGate } from "@/data/progress-session.mjs";
import { enqueueWorkspacePersistence } from "@/data/workspace-persistence.mjs";
import { BOOT_SNAPSHOT, nodePositionSessionKey, repositoryWorkspaceId, workspaceSession } from "./useRepositorySession";

export const progressMemory = new Map<string, string>();

export function routeSignature(tour: TourStep[]) {
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

export function writeTourProgress(key: string, value: string) {
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

interface TourProgressOptions {
  repository: RepositorySnapshot;
  repositorySessionVersion: number;
  workspaceId: string;
  activeTour: TourStep[];
  activeRouteSignature: string;
  aiRoute: AiRouteRecord | null;
  aiRouteStale: boolean;
  activeProgressKeyRef: RefObject<string>;
  tourIndex: number;
  completedSteps: string[];
  setTourIndex: (value: StateUpdate<number>) => void;
  setCompletedSteps: (value: StateUpdate<string[]>) => void;
  setFocusedLine: (value: StateUpdate<SourceReference | null>) => void;
  dispatchNavigation: Dispatch<Parameters<typeof navigationReducer>[1]>;
  setDetailTab: Dispatch<SetStateAction<string>>;
  setMobileView: Dispatch<SetStateAction<"files" | "graph" | "details">>;
  setRepoMessage: (message: string) => void;
  desktopMode: boolean;
  savedDataClearBusy: boolean;
  savedDataClearGenerationRef: RefObject<number>;
  workspacePersistenceReadyKeys: ReadonlySet<string>;
  setBrowserProgressSaveFailures: Dispatch<SetStateAction<Set<string>>>;
}

export function useTourProgress({
  repository, repositorySessionVersion, workspaceId, activeTour, activeRouteSignature, aiRoute, aiRouteStale,
  activeProgressKeyRef, tourIndex, completedSteps, setTourIndex, setCompletedSteps, setFocusedLine,
  dispatchNavigation, setDetailTab, setMobileView, setRepoMessage, desktopMode, savedDataClearBusy,
  savedDataClearGenerationRef, workspacePersistenceReadyKeys, setBrowserProgressSaveFailures,
}: TourProgressOptions) {
  const activeProgressKey = progressKey(repository, activeTour, activeRouteSignature);
  useLayoutEffect(() => { activeProgressKeyRef.current = activeProgressKey; }, [activeProgressKey, activeProgressKeyRef]);
  const activeTourRef = useRef(activeTour);
  useLayoutEffect(() => { activeTourRef.current = activeTour; }, [activeTour]);
  const progressSession = useRef(createProgressSessionGate());
  const [progressReadyKey, setProgressReadyKey] = useState<string | null>(null);
  const activeProgressSessionKey = `${activeProgressKey}:${repositorySessionVersion}`;
  const lastProgressRepoSessionVersion = useRef(repositorySessionVersion);
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
  }, [activeProgressKey, activeRouteSignature, aiRoute, aiRouteStale, repositorySessionVersion, setFocusedLine, setCompletedSteps, setTourIndex, dispatchNavigation, setDetailTab, setMobileView, setRepoMessage]);

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
  }, [tourIndex, completedSteps, activeProgressKey, desktopMode, repository, repository.id, workspacePersistenceReadyKeys, savedDataClearBusy, workspaceId, savedDataClearGenerationRef, setBrowserProgressSaveFailures, setRepoMessage]);

  return progressReadyKey === activeProgressSessionKey;
}
