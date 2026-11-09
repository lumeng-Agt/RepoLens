import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  localRepositoryProvider,
  localWorkspaceProvider,
  sampleRepositoryProvider,
  type LocalWorkspaceState,
  type RepositoryCommand,
  type WorkspaceSession,
} from "@/data/providers";
import { createRepositorySessionGate } from "@/data/repository-session.mjs";
import { createOpenRequestGate } from "@/data/open-request-gate.mjs";
import { enqueueWorkspacePersistence } from "@/data/workspace-persistence.mjs";
import { failInvestigationRead } from "@/data/investigation-state.mjs";
import type { RepositorySnapshot, SourceReference } from "@/data/model";

export const BOOT_SNAPSHOT: RepositorySnapshot = {
  id: "sample-loading",
  version: "loading",
  name: "RepoLens",
  description: "正在加载示例仓库…",
  files: [],
  dependencies: [],
  tour: [],
  source: "sample",
};

export function repositoryWorkspaceId(repository: RepositorySnapshot) {
  return repository.workspaceId ?? repository.id;
}

export function repositoryOpenErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/\bENOENT\b|no such file or directory/i.test(message)) return "找不到这个目录，请检查路径后重试。";
  if (/\bENOTDIR\b|not a directory/i.test(message)) return "这个路径不是文件夹，请选择一个仓库目录。";
  if (/\bEACCES\b|\bEPERM\b|permission denied/i.test(message)) return "没有权限读取这个目录，请检查访问权限。";
  return message || "无法打开仓库。";
}

export function nodePositionSessionKey(repository: RepositorySnapshot) {
  return repositoryWorkspaceId(repository) + ":" + (repository.persistenceSessionId ?? repository.id);
}

export function nodePositionSignature(positions: Record<string, { x: number; y: number }>) {
  return JSON.stringify(Object.fromEntries(Object.entries(positions).sort(([left], [right]) => left.localeCompare(right))));
}

export function workspaceSession(repository: RepositorySnapshot): WorkspaceSession {
  return {
    repositoryId: repository.id,
    workspaceId: repositoryWorkspaceId(repository),
    persistenceSessionId: repository.persistenceSessionId,
  };
}

export interface UseRepositorySessionOptions {
  desktopMode: boolean;
  savedDataClearBusy?: boolean;
  isSavedDataClearBusy?: () => boolean;
  onClearAiContext: () => void;
  onSnapshotApplied: (snapshot: RepositorySnapshot) => void;
  onUpdatedSnapshotApplied: (snapshot: RepositorySnapshot) => void;
  onRestoreWorkspaceState: (snapshot: RepositorySnapshot, saved: LocalWorkspaceState) => string | undefined;
  onGuideTaskCompleted: (task: "repository") => void;
  onCloseGuidePanel: () => void;
  onLoadSampleStart?: () => void;
  workspacePersistenceReadyKeys: Set<string>;
  setWorkspacePersistenceReadyKeys: React.Dispatch<React.SetStateAction<Set<string>>>;
  setWorkspaceReadFailures: React.Dispatch<React.SetStateAction<Set<string>>>;
  setNodePositionsReadyKey: React.Dispatch<React.SetStateAction<string | null>>;
  onDispatchAiMessage: (message: string) => void;
}

export function useRepositorySession({
  desktopMode,
  savedDataClearBusy = false,
  isSavedDataClearBusy,
  onClearAiContext,
  onSnapshotApplied,
  onUpdatedSnapshotApplied,
  onRestoreWorkspaceState,
  onGuideTaskCompleted,
  onCloseGuidePanel,
  onLoadSampleStart,
  workspacePersistenceReadyKeys,
  setWorkspacePersistenceReadyKeys,
  setWorkspaceReadFailures,
  setNodePositionsReadyKey,
  onDispatchAiMessage,
}: UseRepositorySessionOptions) {
  const [repository, setRepository] = useState<RepositorySnapshot>(BOOT_SNAPSHOT);
  const [recentRepositories, setRecentRepositories] = useState<LocalWorkspaceState["recentRepositories"]>([]);
  const [repoPath, setRepoPath] = useState("");
  const [repoBusy, setRepoBusy] = useState(false);
  const [repoMessage, setRepoMessage] = useState("");
  const [desktopBackendError, setDesktopBackendError] = useState("");
  const [repositorySessionVersion, setRepositorySessionVersion] = useState(0);

  const repositoryCommandIssuer = useRef<{ clientId: string; intentSequence: number } | null>(null);
  if (repositoryCommandIssuer.current == null) {
    repositoryCommandIssuer.current = { clientId: globalThis.crypto.randomUUID(), intentSequence: 0 };
  }
  const nextRepositoryCommand = (): RepositoryCommand => {
    const issuer = repositoryCommandIssuer.current!;
    issuer.intentSequence += 1;
    return { clientId: issuer.clientId, intentSequence: issuer.intentSequence };
  };
  const isCurrentRepositoryCommand = (command: RepositoryCommand) =>
    repositoryCommandIssuer.current?.clientId === command.clientId &&
    repositoryCommandIssuer.current.intentSequence === command.intentSequence;

  const repositoryGate = useRef(createRepositorySessionGate());
  const repositoryReads = useRef(new Set<AbortController>());
  const openRequestGate = useRef(createOpenRequestGate());
  const openRequestController = useRef<AbortController | null>(null);
  const applyUpdatedSnapshotRef = useRef<(snapshot: RepositorySnapshot, epoch: number) => boolean>(() => false);
  const onDispatchAiMessageRef = useRef(onDispatchAiMessage);
  const closeRepositoryRef = useRef<() => Promise<void>>(async () => {});

  const beginRepositorySession = useCallback(() => {
    for (const controller of repositoryReads.current) controller.abort();
    repositoryReads.current.clear();
    return repositoryGate.current.begin();
  }, []);

  const applySnapshot = useCallback(
    (snapshot: RepositorySnapshot, epoch: number) => {
      if (!repositoryGate.current.isCurrent(epoch, snapshot.id)) return false;
      setRepository(snapshot);
      onSnapshotApplied(snapshot);
      return true;
    },
    [onSnapshotApplied]
  );

  const applyUpdatedSnapshot = useCallback(
    (snapshot: RepositorySnapshot, epoch: number) => {
      if (!repositoryGate.current.acceptUpdate(epoch, snapshot)) return false;
      setRepository(snapshot);
      onUpdatedSnapshotApplied(snapshot);
      return true;
    },
    [onUpdatedSnapshotApplied]
  );
  useEffect(() => {
    applyUpdatedSnapshotRef.current = applyUpdatedSnapshot;
    onDispatchAiMessageRef.current = onDispatchAiMessage;
  }, [applyUpdatedSnapshot, onDispatchAiMessage]);

  // Desktop backend status event listener
  useEffect(() => {
    if (!desktopMode) return;
    return window.repoLens?.onBackendStatus(({ available, message }) => {
      setDesktopBackendError(available ? "" : message);
      if (!available) {
        onClearAiContext();
        setRepoMessage(message);
      }
    });
  }, [desktopMode, onClearAiContext]);

  // Open repository path
  const isClearBusy = useCallback(() => Boolean(savedDataClearBusy || isSavedDataClearBusy?.()), [savedDataClearBusy, isSavedDataClearBusy]);

  const openRepositoryPath = useCallback(
    async (path: string) => {
      if (isClearBusy()) return;
      const command = nextRepositoryCommand();
      const requestId = openRequestGate.current.begin();
      openRequestController.current?.abort();
      const controller = new AbortController();
      openRequestController.current = controller;
      setRepoBusy(true);
      setRepoMessage("");
      try {
        const snapshot = await localRepositoryProvider.openRepository(path, command, controller.signal);
        if (
          !openRequestGate.current.isCurrent(requestId) ||
          !isCurrentRepositoryCommand(command) ||
          controller.signal.aborted
        )
          return;
        let workspaceWarning: string | undefined;
        if (desktopMode) {
          try {
            const saved = await localWorkspaceProvider.get(repositoryWorkspaceId(snapshot), controller.signal);
            if (
              !openRequestGate.current.isCurrent(requestId) ||
              !isCurrentRepositoryCommand(command) ||
              controller.signal.aborted
            )
              return;
            workspaceWarning = onRestoreWorkspaceState(snapshot, saved);
          } catch (error) {
            if (controller.signal.aborted) return;
            if (!openRequestGate.current.isCurrent(requestId) || !isCurrentRepositoryCommand(command)) return;
            const failedKey = nodePositionSessionKey(snapshot);
            setWorkspacePersistenceReadyKeys((current) => {
              const next = new Set(current);
              next.delete(failedKey);
              return next;
            });
            setWorkspaceReadFailures((current) => new Set(current).add(failedKey));
            setNodePositionsReadyKey((current) => (current === failedKey ? null : current));
            workspaceWarning = error instanceof Error ? error.message : "无法读取桌面保存数据。";
            failInvestigationRead(repositoryWorkspaceId(snapshot), workspaceWarning);
          }
        }
        if (
          !openRequestGate.current.isCurrent(requestId) ||
          !isCurrentRepositoryCommand(command) ||
          controller.signal.aborted
        )
          return;
        const epoch = beginRepositorySession();
        if (!repositoryGate.current.activate(epoch, snapshot)) return;
        setRepositorySessionVersion((version) => version + 1);
        if (applySnapshot(snapshot, epoch)) {
          onGuideTaskCompleted("repository");
          onCloseGuidePanel();
          setRepoPath(path);
          setRepoMessage(
            workspaceWarning
              ? `仓库已打开，但无法读取已保存数据。本页修改尚未保存，原记录不会被覆盖：${workspaceWarning}`
              : "仓库已打开，正在监听文件变化。"
          );
          try {
            await enqueueWorkspacePersistence(repositoryWorkspaceId(snapshot), () =>
              localWorkspaceProvider.touchRecent(workspaceSession(snapshot))
            );
            const saved = await localWorkspaceProvider.get(repositoryWorkspaceId(snapshot));
            if (
              openRequestGate.current.isCurrent(requestId) &&
              isCurrentRepositoryCommand(command) &&
              saved.persistenceReady !== false
            )
              setRecentRepositories(saved.recentRepositories);
          } catch (error) {
            if (openRequestGate.current.isCurrent(requestId))
              setRepoMessage(
                `仓库已打开；最近打开列表未能更新：${error instanceof Error ? error.message : "本地存储不可用。"}`
              );
          }
        }
      } catch (error) {
        if (
          openRequestGate.current.isCurrent(requestId) &&
          isCurrentRepositoryCommand(command) &&
          !controller.signal.aborted
        )
          setRepoMessage(repositoryOpenErrorMessage(error));
      } finally {
        if (openRequestController.current === controller) openRequestController.current = null;
        if (openRequestGate.current.isCurrent(requestId) && isCurrentRepositoryCommand(command)) setRepoBusy(false);
      }
    },
    [
      applySnapshot,
      beginRepositorySession,
      desktopMode,
      onCloseGuidePanel,
      onGuideTaskCompleted,
      onRestoreWorkspaceState,
      isClearBusy,
      setNodePositionsReadyKey,
      setWorkspacePersistenceReadyKeys,
      setWorkspaceReadFailures,
    ]
  );

  const openRepository = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      void openRepositoryPath(repoPath);
    },
    [openRepositoryPath, repoPath]
  );

  // Subscribe to local repository file system changes
  useEffect(() => {
    if (repository.source !== "local") return;
    let updateQueue = Promise.resolve();
    const repositoryId = repository.id;
    const epoch = repositoryGate.current.current().epoch;
    if (!repositoryGate.current.isCurrent(epoch, repositoryId)) return;
    const controllers = new Set<AbortController>();
    const activeReads = repositoryReads.current;
    const unsubscribe = localRepositoryProvider.subscribe(
      repositoryId,
      (_revision, sequence) => {
        updateQueue = updateQueue.then(async () => {
          if (!repositoryGate.current.isCurrent(epoch, repositoryId)) return;
          const controller = new AbortController();
          controllers.add(controller);
          activeReads.add(controller);
          try {
            const next = await localRepositoryProvider.getSnapshot(repositoryId, controller.signal);
            if (
              !repositoryGate.current.isCurrent(epoch, repositoryId) ||
              next.id !== repositoryId ||
              (next.sequence ?? 0) < sequence
            )
              return;
            if (applyUpdatedSnapshotRef.current(next, epoch))
              onDispatchAiMessageRef.current("仓库文件已变化，旧 AI 讲解需要重新生成；相关源码引用已停用。");
          } catch (error) {
            if (!controller.signal.aborted && repositoryGate.current.isCurrent(epoch, repositoryId))
              setRepoMessage((error as Error).message);
          } finally {
            controllers.delete(controller);
            activeReads.delete(controller);
          }
        });
      },
      setRepoMessage
    );
    return () => {
      unsubscribe();
      for (const controller of controllers) {
        controller.abort();
        activeReads.delete(controller);
      }
      controllers.clear();
    };
  }, [repository.id, repository.source, repositorySessionVersion]);

  // Load sample repository
  const loadSample = async (command: RepositoryCommand, epoch: number) => {
    if (!isCurrentRepositoryCommand(command)) return;
    openRequestGate.current.invalidate();
    openRequestController.current?.abort();
    openRequestController.current = null;
    onClearAiContext();
    onLoadSampleStart?.();
    setRepoMessage("正在加载内置示例仓库…");
    try {
      const snapshot = await sampleRepositoryProvider.getSnapshot();
      if (!isCurrentRepositoryCommand(command) || !repositoryGate.current.activate(epoch, snapshot)) return;
      setRepositorySessionVersion((version) => version + 1);
      if (!applySnapshot(snapshot, epoch)) return;
      if (desktopMode && workspacePersistenceReadyKeys.has(nodePositionSessionKey(snapshot)))
        setNodePositionsReadyKey(nodePositionSessionKey(snapshot));
      setRepoMessage("正在浏览内置示例仓库。");
      setRepoBusy(false);
    } catch (error) {
      if (isCurrentRepositoryCommand(command) && repositoryGate.current.isCurrent(epoch)) {
        setRepoBusy(false);
        setRepoMessage(error instanceof Error ? error.message : "无法载入示例仓库。");
      }
    }
  };

  const closeRepository = async () => {
    if (isClearBusy()) return;
    const command = nextRepositoryCommand();
    openRequestGate.current.invalidate();
    openRequestController.current?.abort();
    openRequestController.current = null;
    const epoch = beginRepositorySession();
    setRepositorySessionVersion((version) => version + 1);
    setRepoBusy(true);
    void localRepositoryProvider.closeRepository(command).catch((error) => {
      if (isCurrentRepositoryCommand(command) && repositoryGate.current.isCurrent(epoch))
        setRepoMessage(`已返回示例；关闭本地仓库尚未确认。${error instanceof Error ? ` ${error.message}` : ""}`);
    });
    await loadSample(command, epoch);
  };
  useLayoutEffect(() => {
    closeRepositoryRef.current = closeRepository;
  });

  const cancelPendingRepositoryOpen = useCallback(() => {
    const controller = openRequestController.current;
    if (!controller) return;
    const command = nextRepositoryCommand();
    openRequestGate.current.invalidate();
    controller.abort();
    openRequestController.current = null;
    setRepoBusy(false);
    void localRepositoryProvider.closeRepository(command).catch((error: unknown) => {
      if (isCurrentRepositoryCommand(command))
        setRepoMessage(
          `示例已打开，但上一次仓库操作未能确认关闭：${error instanceof Error ? error.message : "本地服务不可用。"}`
        );
    });
  }, []);

  const rescanRepository = async () => {
    if (isClearBusy()) return;
    const repositoryId = repository.id;
    const epoch = repositoryGate.current.current().epoch;
    const controller = new AbortController();
    repositoryReads.current.add(controller);
    setRepoBusy(true);
    try {
      const next = await localRepositoryProvider.rescan(repositoryId, controller.signal);
      if (!repositoryGate.current.isCurrent(epoch, repositoryId)) return;
      if (applyUpdatedSnapshotRef.current(next, epoch)) setRepoMessage("仓库已重新扫描。");
      else if (next.id === repositoryId) setRepoMessage("仓库已是最新，无需更新索引。");
    } catch (error) {
      if (!controller.signal.aborted && repositoryGate.current.isCurrent(epoch, repositoryId))
        setRepoMessage(error instanceof Error ? error.message : "重新扫描失败。");
    } finally {
      repositoryReads.current.delete(controller);
      if (repositoryGate.current.isCurrent(epoch, repositoryId)) setRepoBusy(false);
    }
  };

  const removeRecentRepository = useCallback(
    async (targetId: string) => {
      try {
        await localWorkspaceProvider.removeRecent(targetId);
        const saved = await localWorkspaceProvider.get(repositoryWorkspaceId(repository));
        setRecentRepositories(saved.recentRepositories);
      } catch (error) {
        setRepoMessage(`无法移除最近仓库：${error instanceof Error ? error.message : "本地存储不可用。"}`);
      }
    },
    [repository]
  );

  return {
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
  };
}
