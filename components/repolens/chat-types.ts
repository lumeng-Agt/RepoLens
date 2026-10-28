import type { AiRouteRecord, InvestigationResult } from "@/data/model";
import type { AiResultRecord } from "./AiResultView";

export type QaReference = { fileId: string; startLine: number; endLine?: number };
export type QaMessage = {
  id: string; role: "user" | "assistant"; content: string; references: QaReference[];
  contextFiles: { fileId: string; contentHash: string; startLine?: number; endLine?: number }[];
  claims?: { text: string; referenceIndices: number[] }[];
  selectionReasons?: Record<string, string[]>; investigation?: InvestigationResult; investigationQuestion?: string; excludedFileIds?: string[]; insufficientEvidence?: boolean; stale?: boolean; route?: AiRouteRecord; explanation?: AiResultRecord;
};
export type QaConversation = { id: string; title: string; messages: QaMessage[]; updatedAt: number };
export type ChatEvidenceState = { messageId: string; referenceIndex: number; fileId: string; startLine: number; source: string; status: "loading" | "loaded" | "error"; error?: string };
