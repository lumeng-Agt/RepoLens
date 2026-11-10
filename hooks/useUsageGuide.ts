import { useCallback, useRef, useState } from "react";
import { localWorkspaceProvider } from "@/data/providers";
import { USAGE_GUIDE_STORAGE_KEY } from "@/data/browser-workspace";
import { completeUsageGuideTask, createDefaultUsageGuidePreferences, normalizeUsageGuidePreferences, type UsageGuidePreferences, type UsageGuideTaskId } from "@/data/usage-guide.mjs";

export function useUsageGuide(desktopMode: boolean) {
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
  const guideInitializedRef = useRef(false);
  const guideSaveSequenceRef = useRef(0);
  const guideWriteQueueRef = useRef<Promise<void>>(Promise.resolve());
  const guideTourPracticeRef = useRef<{ workspaceId: string; sessionVersion: number; origin: { fileId: string; line?: number }; destination: { fileId: string; line: number }; visited: boolean; returned: boolean } | null>(null);
  const guideNavigationRef = useRef<{ repositoryId: string; sessionVersion: number; fileId: string; dependency: boolean } | null>(null);

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

  return {
    guidePreferences, setGuidePreferences, guidePreferencesRef, guideReady, guideStorageMessage,
    setGuideStorageMessage, showGuideWelcome, setShowGuideWelcome, guidePanelOpen, setGuidePanelOpen,
    guideNoticeAvailable, setGuideNoticeAvailable, guideRepoRequest, setGuideRepoRequest, guideButtonRef,
    guideSaveSequenceRef, guideWriteQueueRef, guideTourPracticeRef, guideNavigationRef, updateGuidePreferences,
    initializeGuidePreferences, completeGuideTask,
  };
}
