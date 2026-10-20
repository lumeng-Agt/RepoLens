export type UsageGuideTaskId = "source" | "dependencies" | "tour" | "note" | "repository";
export type UsageGuidePreferences = {
  version: 1;
  welcomeHandled: boolean;
  completedTaskIds: UsageGuideTaskId[];
  checklistOpen: boolean;
  noticeDismissed: boolean;
};
export const USAGE_GUIDE_VERSION: 1;
export const USAGE_GUIDE_TASK_IDS: readonly UsageGuideTaskId[];
export function createDefaultUsageGuidePreferences(): UsageGuidePreferences;
export function normalizeUsageGuidePreferences(value: unknown): UsageGuidePreferences | null;
export function completeUsageGuideTask(preferences: UsageGuidePreferences, taskId: UsageGuideTaskId): UsageGuidePreferences;
export function hasExistingWorkspaceUse(saved: unknown): boolean;
export function hasExistingBrowserUse(storageKeys: Iterable<string>): boolean;
