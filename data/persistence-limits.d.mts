export const MAX_WORKSPACE_REQUEST_BYTES: number;
export const MAX_SAVED_TOURS: number;
export const MAX_READING_NOTES: number;
export function assertBoundedData(value: unknown): void;
export function serializeWorkspaceMutation(value: unknown): string;
export function assertReadingArtifactCapacity(records: { notes?: unknown[]; tours?: unknown[] }, session?: Record<string, unknown>): void;

export const MAX_CONVERSATIONS: number;
export const CONVERSATION_CAPACITY_MESSAGE: string;
export function assertConversationCapacity(conversations: unknown): void;
export function assertConversationPersistenceCapacity(conversations: unknown): void;
