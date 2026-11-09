export function registerChatPreferenceFlush(flush: () => Promise<void>, retry?: () => Promise<void>): () => void;
export function flushChatPreferences(signal?: AbortSignal): Promise<void>;
export function retryChatPreferences(signal?: AbortSignal): Promise<void>;
