import type { AiMode } from "@/data/explanation-provider";
import type { Investigation } from "@/data/model";

export type ChatAttachment = { fileId: string; contentHash: string; startLine?: number; endLine?: number };
export type ChatIntent = { id: number; mode: AiMode; investigation?: Investigation; draft?: string; attachments?: ChatAttachment[]; sessionId?: string };
