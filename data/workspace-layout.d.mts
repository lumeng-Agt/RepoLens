export type WorkspaceLayoutPreferences = {
  version: 1; chatWidth?: number;
  structure: { files: number; graph: number; details: number };
  reading: { files: number; details: number };
};

export const DEFAULT_WORKSPACE_LAYOUT: WorkspaceLayoutPreferences;
export function normalizeWorkspaceLayout(value: unknown): WorkspaceLayoutPreferences | null;
export function workspaceOuterLayout(preferences: unknown, mode: "structure" | "reading"): Record<"files" | "content", number>;
export function workspaceInnerLayout(preferences: unknown, mode: "structure" | "reading"): Record<"graph" | "details", number>;
export function updateWorkspaceLayout(preferences: unknown, mode: "structure" | "reading", area: "outer" | "inner", layout: Record<string, number>): WorkspaceLayoutPreferences;
