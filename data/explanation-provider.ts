import type { AiPreview, RepositorySnapshot } from "./model";
import { AiGenerationEnvelopeSchema, AiPreviewResponseSchema } from "./ai-contract.mjs";
import { localApiOrigin } from "./runtime-config";

const LOCAL_API_ORIGIN = localApiOrigin();

export type AiMode = "explanation" | "route" | "question";
export type AiScopeCandidate = { fileId: string; characters: number; lineCount: number; oversizedLines: number[] };
export type AiLineRange = { startLine: number; endLine: number };
export type AiPreviewResponse = { scopeRequired: false; preview: AiPreview } | { scopeRequired: true; candidates: AiScopeCandidate[]; maxFiles: number; maxCharacters: number; retrievalInsufficient?: boolean };
export type AiGenerationResult = { result: Record<string, unknown>; cached: boolean; revision: string; repositoryId: string; entryFileId: string; mode: AiMode };
export type AiQuestionHistoryItem = { role: "user" | "assistant"; content: string };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const value = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? `本地服务返回 ${response.status}`);
  return value;
}

async function requestPreview(url: string, init?: RequestInit): Promise<AiPreviewResponse> {
  const response = await fetch(url, init);
  const value: unknown = await response.json();
  const parsed = AiPreviewResponseSchema.safeParse(value);
  if (response.status === 413 && parsed.success && parsed.data.scopeRequired) return parsed.data as AiPreviewResponse;
  if (!response.ok) {
    const message = typeof value === "object" && value !== null && "error" in value && typeof value.error === "string"
      ? value.error
      : `本地服务返回 ${response.status}`;
    throw new Error(message);
  }
  if (!parsed.success || parsed.data.scopeRequired) throw new Error("本地服务返回的发送范围格式无效，请重新预览。");
  return parsed.data as AiPreviewResponse;
}

export interface ExplanationProvider {
  preview(repository: RepositorySnapshot, fileId: string, mode: AiMode, fileIds?: string[], scopePrefix?: string, ranges?: Record<string, AiLineRange>, signal?: AbortSignal): Promise<AiPreviewResponse>;
  generate(preview: AiPreview, signal: AbortSignal): Promise<AiGenerationResult>;
  saveSettings(settings: { baseUrl: string; model: string; apiKey: string }): Promise<{ baseUrl: string; model: string; configured: boolean }>;
  getSettings(): Promise<{ baseUrl: string; model: string; configured: boolean }>;
  previewQuestion(repository: RepositorySnapshot, fileId: string, question: string, history: AiQuestionHistoryItem[], fileIds?: string[], ranges?: Record<string, AiLineRange>, signal?: AbortSignal): Promise<AiPreviewResponse>;
}

export const localExplanationProvider: ExplanationProvider = {
  preview(repository, fileId, mode, fileIds, scopePrefix, ranges, signal) {
    return requestPreview(`${LOCAL_API_ORIGIN}/api/ai/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repositoryId: repository.id, fileId, mode, fileIds, scopePrefix, ranges }), signal });
  },
  previewQuestion(repository, fileId, question, history, fileIds, ranges, signal) {
    return requestPreview(`${LOCAL_API_ORIGIN}/api/ai/question/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repositoryId: repository.id, fileId, question, history, fileIds, ranges }), signal });
  },
  generate(preview, signal) {
    return request(`${LOCAL_API_ORIGIN}/api/ai/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ previewId: preview.id }), signal })
      .then((value) => {
        const parsed = AiGenerationEnvelopeSchema.safeParse(value);
        if (!parsed.success) throw new Error("模型服务返回格式无效，缺少完整的讲解结果或仓库定位信息。");
        return parsed.data as AiGenerationResult;
      });
  },
  saveSettings(settings) {
    return request(`${LOCAL_API_ORIGIN}/api/ai/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) });
  },
  getSettings() { return request(`${LOCAL_API_ORIGIN}/api/ai/settings`); },
};
