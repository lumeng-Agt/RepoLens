import { useCallback, useEffect, useLayoutEffect, useSyncExternalStore } from "react";
import type { RepositorySnapshot, Investigation } from "@/data/model";
import { localWorkspaceProvider } from "@/data/providers";
import { getInvestigationEpoch, getInvestigationState, subscribeInvestigations, restoreInvestigations, failInvestigationRead, persistInvestigations, changeInvestigation, deleteInvestigation, registerInvestigationSession } from "@/data/investigation-state.mjs";
import { markWorkspacePersistencePending } from "@/data/workspace-persistence.mjs";

export function useInvestigationRecords(repository: RepositorySnapshot, busy: boolean) {
  const id = repository.workspaceId ?? repository.id;
  const state = useSyncExternalStore(useCallback(listener => subscribeInvestigations(id, listener), [id]), useCallback(() => getInvestigationState(id), [id]), useCallback(() => getInvestigationState(id), [id]));
  const session = `${id}:${repository.persistenceSessionId ?? ""}`;
  useLayoutEffect(() => { registerInvestigationSession(id, session); }, [id, session]);
  const write = useCallback((records: Investigation[]) => localWorkspaceProvider.saveInvestigations({ repositoryId: repository.id, workspaceId: id, persistenceSessionId: repository.persistenceSessionId }, records), [id, repository.id, repository.persistenceSessionId]);
  const read = useCallback(async (signal?: AbortSignal) => {
    const epoch = getInvestigationEpoch(id);
    try {
      const value = await localWorkspaceProvider.get(id, signal);
      if (signal?.aborted || epoch !== getInvestigationEpoch(id)) return;
      if (value.persistenceReady === false) throw new Error(value.warning || "无法读取调查记录。");
      restoreInvestigations(id, value.investigations ?? []);
      await persistInvestigations(id, write).catch(() => {});
    } catch (error) {
      if (signal?.aborted || epoch !== getInvestigationEpoch(id)) return;
      failInvestigationRead(id, error instanceof Error ? error.message : "无法读取调查记录。");
    }
  }, [id, write]);
  useEffect(() => {
    if (!state.pending || busy || repository.source !== "local") return;
    markWorkspacePersistencePending(id, "investigations", "调查有尚未保存的修改。");
    if (!state.loaded) return;
    void persistInvestigations(id, write).catch(() => {});
  }, [id, state.pending, state.loaded, busy, repository.source, write]);
  return { ...state, read, retry: () => state.loaded ? persistInvestigations(id, write).catch(() => false) : read(),
    update: (record: Investigation) => !busy && changeInvestigation(id, { ...record, updatedAt: Date.now() }),
    remove: (recordId: string) => !busy && deleteInvestigation(id, recordId) };
}
