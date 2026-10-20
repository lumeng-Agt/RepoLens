export type WorkspaceWriteResult = { skipped?: boolean };
export type WorkspacePersistenceStatus = { phase: "idle" | "saving" | "saved" | "memory" | "clearing"; pending: number; error: string };

export function enqueueWorkspacePersistence<T>(workspaceId: string, operation: () => Promise<T> | T, options?: { key?: string }): Promise<T | WorkspaceWriteResult>;
export function clearWorkspacePersistence<T>(workspaceIds: string[], operation: () => Promise<T> | T): Promise<T>;
export function getKnownWorkspacePersistenceIds(): string[];
export function isWorkspacePersistenceClearing(workspaceId: string): boolean;
export function getWorkspacePersistenceStatus(workspaceId: string): WorkspacePersistenceStatus;
export function subscribeWorkspacePersistence(workspaceId: string, listener: () => void): () => void;
