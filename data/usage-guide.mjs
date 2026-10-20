export const USAGE_GUIDE_VERSION = 1;
export const USAGE_GUIDE_TASK_IDS = Object.freeze(["source", "dependencies", "tour", "note", "repository"]);

export function createDefaultUsageGuidePreferences() {
  return { version: USAGE_GUIDE_VERSION, welcomeHandled: false, completedTaskIds: [], checklistOpen: false, noticeDismissed: false };
}

export function normalizeUsageGuidePreferences(value) {
  if (!value || typeof value !== "object" || value.version !== USAGE_GUIDE_VERSION ||
      typeof value.welcomeHandled !== "boolean" || typeof value.checklistOpen !== "boolean" ||
      typeof value.noticeDismissed !== "boolean" || !Array.isArray(value.completedTaskIds) ||
      value.completedTaskIds.some((id) => !USAGE_GUIDE_TASK_IDS.includes(id))) return null;
  return {
    version: USAGE_GUIDE_VERSION,
    welcomeHandled: value.welcomeHandled,
    completedTaskIds: [...new Set(value.completedTaskIds)],
    checklistOpen: value.checklistOpen,
    noticeDismissed: value.noticeDismissed,
  };
}

export function completeUsageGuideTask(preferences, taskId) {
  if (!USAGE_GUIDE_TASK_IDS.includes(taskId) || preferences.completedTaskIds.includes(taskId)) return preferences;
  return { ...preferences, completedTaskIds: [...preferences.completedTaskIds, taskId] };
}

export function hasExistingWorkspaceUse(saved) {
  if (!saved || typeof saved !== "object") return false;
  return Boolean(saved.recentRepositories?.length || Object.keys(saved.progress ?? {}).length ||
    Object.keys(saved.nodePositions ?? {}).length || Object.keys(saved.aiResults ?? {}).length ||
    saved.aiRoute || saved.conversations?.length || saved.readingNotes?.length || saved.savedTours?.length);
}

export function hasExistingBrowserUse(storageKeys) {
  return [...storageKeys].some((key) => key.startsWith("repolens:") && key !== "repolens:usage-guide:v1");
}
