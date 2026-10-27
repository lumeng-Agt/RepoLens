import type { AiRouteRecord } from "./model";
import type { AiResultRecord } from "../components/repolens/AiResultView";

export type QuestionRecoveryMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  references: { fileId: string; startLine: number; endLine?: number }[];
  contextFiles: { fileId: string; contentHash: string; startLine?: number; endLine?: number }[];
  claims?: { text: string; referenceIndices: number[] }[];
  insufficientEvidence?: boolean;
  stale?: boolean;
  /** Unified AI chat keeps the generated artifact beside the transcript entry. */
  route?: AiRouteRecord;
  explanation?: AiResultRecord;
};
export type QuestionRecoveryConversation = {
  id: string;
  title: string;
  messages: QuestionRecoveryMessage[];
  updatedAt: number;
};
export type QuestionRecoveryOperation =
  | { sequence: number; kind: "delete"; conversationId: string }
  | { sequence: number; kind: "upsert"; conversation: QuestionRecoveryConversation };

export function restoreQuestionConversations(workspaceId: string, saved: QuestionRecoveryConversation[]): QuestionRecoveryConversation[];
export function failQuestionConversationRead(workspaceId: string, message: string): QuestionRecoveryConversation[];
export function getQuestionConversationView(workspaceId: string): QuestionRecoveryConversation[];
export function getQuestionConversationReadError(workspaceId: string): string;
export function getQuestionConversationSaveError(workspaceId: string): string;
export function recordQuestionConversationChanges(workspaceId: string, value: QuestionRecoveryConversation[]): QuestionRecoveryConversation[];
export function getQuestionConversationOperations(workspaceId: string): QuestionRecoveryOperation[];
export function acknowledgeQuestionConversationSave(workspaceId: string, persisted: QuestionRecoveryConversation[], throughSequence: number): QuestionRecoveryConversation[];
export function setQuestionConversationSaveError(workspaceId: string, message: string): void;
export function clearQuestionConversationSaveError(workspaceId: string): void;
export function enqueueQuestionConversationSave<T>(workspaceId: string, operation: () => Promise<T>): Promise<T>;
export function clearQuestionConversationWorkspace<T>(workspaceId: string, operation: () => Promise<T>): Promise<T>;
export function clearAllQuestionConversations<T>(operation: () => Promise<T>, additionalWorkspaceIds?: string[]): Promise<T>;
export function isQuestionConversationClearPending(workspaceId: string): boolean;
export function getQuestionConversationGeneration(workspaceId: string): number;
