import type { AiPreview, RepositorySnapshot } from "./model";
import { AiGenerationEnvelopeSchema, AiPreviewResponseSchema, AiStreamEventSchema } from "./ai-contract.mjs";
import { readSseData } from "./ai-stream.mjs";
import { localApiOrigin } from "./runtime-config";

const LOCAL_API_ORIGIN = localApiOrigin();

export type AiMode = "explanation" | "route" | "question";
export type AiScopeCandidate = { fileId: string; characters: number; lineCount: number; oversizedLines: number[]; reasons?: string[]; suggestedRange?: { startLine: number; endLine: number } };
export type AiLineRange = { startLine: number; endLine: number };
export type AiPreviewResponse = { scopeRequired: false; preview: AiPreview } | { scopeRequired: true; candidates: AiScopeCandidate[]; maxFiles: number; maxCharacters: number; retrievalInsufficient?: boolean };
export type AiGenerationResult = { result: Record<string, unknown>; cached: boolean; revision: string; repositoryId: string; entryFileId: string; mode: AiMode; chatPersisted?: boolean; warning?: string };
export type AiChatCompletion = { conversationId: string; userMessageId: string; answerMessageId: string };
export type AiQuestionHistoryItem = { role: "user" | "assistant"; content: string };
export type AiStreamEvent = { type: "status" | "text" | "replace" | "complete" | "error"; text?: string; status?: string };

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
  preview(repository: RepositorySnapshot, fileId: string, mode: AiMode, fileIds?: string[], scopePrefix?: string, ranges?: Record<string, AiLineRange>, signal?: AbortSignal, goal?: string): Promise<AiPreviewResponse>;
  generate(preview: AiPreview, signal: AbortSignal, chat?: AiChatCompletion): Promise<AiGenerationResult>;
  saveSettings(settings: { baseUrl: string; model: string; apiKey: string }): Promise<{ baseUrl: string; model: string; configured: boolean }>;
  getSettings(): Promise<{ baseUrl: string; model: string; configured: boolean }>;
  previewQuestion(repository: RepositorySnapshot, fileId: string, question: string, history: AiQuestionHistoryItem[], fileIds?: string[], ranges?: Record<string, AiLineRange>, signal?: AbortSignal): Promise<AiPreviewResponse>;
}

export const localExplanationProvider: ExplanationProvider = {
  preview(repository, fileId, mode, fileIds, scopePrefix, ranges, signal, goal) {
    return requestPreview(`${LOCAL_API_ORIGIN}/api/ai/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repositoryId: repository.id, fileId, mode, fileIds, scopePrefix, ranges, goal }), signal });
  },
  previewQuestion(repository, fileId, question, history, fileIds, ranges, signal) {
    return requestPreview(`${LOCAL_API_ORIGIN}/api/ai/question/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repositoryId: repository.id, fileId, question, history, fileIds, ranges }), signal });
  },
  generate(preview, signal, chat) {
    return request(`${LOCAL_API_ORIGIN}/api/ai/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ previewId: preview.id, ...(chat ? { chat } : {}) }), signal })
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

export async function generateChatStream(preview: AiPreview, signal: AbortSignal, chat: AiChatCompletion, onEvent: (event: AiStreamEvent) => void, stream = true): Promise<AiGenerationResult> {
  const response = await fetch(`${LOCAL_API_ORIGIN}/api/ai/generate`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream" }, body: JSON.stringify({ previewId: preview.id, chat, stream }), signal });
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    const body: unknown = await response.json();
    if (!response.ok) throw new Error(body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : `本地服务返回 ${response.status}`);
    return AiGenerationEnvelopeSchema.parse(body) as AiGenerationResult;
  }
  for await (const data of readSseData(response.body, signal)) {
    let value;
    try { value = AiStreamEventSchema.parse(JSON.parse(data)); } catch { throw new Error("回答数据格式无效，内容尚未完成。"); }
    if (value.requestId !== preview.id || value.repositoryId !== preview.repositoryId || value.revision !== preview.revision) throw new Error("回答不属于本次请求，已停止接收。");
    if (value.type === "error") throw Object.assign(new Error(value.error), { code: value.code });
    if (value.type === "complete") {
      const result = value.result as AiGenerationResult;
      if (result.repositoryId !== preview.repositoryId || result.revision !== preview.revision || result.entryFileId !== preview.entryFileId || result.mode !== preview.mode) throw new Error("回答归属不符，结果已丢弃。");
      return result;
    }
    onEvent(value);
  }
  throw new Error("回答连接已中断，内容尚未完成。");
}
