export type WorkspaceWriteResult = { skipped?: boolean };

export function enqueueWorkspacePersistence<T>(workspaceId: string, operation: () => Promise<T> | T): Promise<T | WorkspaceWriteResult>;
export function clearWorkspacePersistence<T>(workspaceIds: string[], operation: () => Promise<T> | T): Promise<T>;
export function getKnownWorkspacePersistenceIds(): string[];
export function isWorkspacePersistenceClearing(workspaceId: string): boolean;
