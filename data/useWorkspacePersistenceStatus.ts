"use client";

import { useCallback, useSyncExternalStore } from "react";
import { getWorkspacePersistenceStatus, subscribeWorkspacePersistence } from "./workspace-persistence.mjs";

const idleStatus = Object.freeze({ phase: "idle" as const, pending: 0, error: "" });

export function useWorkspacePersistenceStatus(workspaceId: string) {
  const subscribe = useCallback((listener: () => void) => subscribeWorkspacePersistence(workspaceId, listener), [workspaceId]);
  const getSnapshot = useCallback(() => getWorkspacePersistenceStatus(workspaceId), [workspaceId]);
  return useSyncExternalStore(subscribe, getSnapshot, () => idleStatus);
}
