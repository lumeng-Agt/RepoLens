export function isValidChatTimestamp(value: unknown): boolean;
export function formatChatTimestamp(value: unknown): string;
export function copyChatText(text: string, getClipboard?: () => { writeText(text: string): Promise<void> } | undefined): Promise<boolean>;
