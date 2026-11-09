import { flushChatPreferences } from "./chat-preference-lifecycle.mjs";
import type { ChatPreferences } from "./chat-preferences.mjs";
import { serializeWorkspaceMutation, assertConversationCapacity } from "./persistence-limits.mjs";
import type { Investigation, AiQuestionConversation, AiRouteRecord, AiSavedResult, ReadingNote, RepositoryOverview, RepositorySnapshot, RevisionComparison, SearchRequest, SearchResponse } from "./model";
import type { z } from "zod";
import type { UsageGuidePreferences } from "./usage-guide.mjs";
import type { WorkspaceLayoutPreferences } from "./workspace-layout.mjs";
import {
  LocalWorkspaceStateSchema,
  RepositoryDiagnosticEventSchema,
  RepositoryRevisionEventSchema,
  RepositorySnapshotSchema,
  SourceResponseSchema,
  SearchResponseSchema,
  RepositoryOverviewSchema,
  RevisionComparisonResponseSchema,
  RevisionFetchResponseSchema,
  WorkspaceSaveResponseSchema,
  parseLocalApiResponse,
  parseRepositoryEvent,
} from "./local-contracts.mjs";
import { sampleRepositoryProvider as sampleDataProvider } from "./sampleRepository";
import { localApiOrigin } from "./runtime-config";

const LOCAL_API_ORIGIN = localApiOrigin();

export interface RepositoryProvider {
  getSnapshot(repositoryId?: string, signal?: AbortSignal): Promise<RepositorySnapshot>;
}

export interface RepositoryCommand {
  clientId: string;
  intentSequence: number;
}

export const sampleRepositoryProvider: RepositoryProvider = {
  async getSnapshot() { return { ...sampleDataProvider.getSnapshot(), source: "sample" }; },
};

export interface LocalRepositoryProvider extends RepositoryProvider {
  openRepository(path: string, command: RepositoryCommand, signal?: AbortSignal): Promise<RepositorySnapshot>;
  rescan(repositoryId: string, signal?: AbortSignal): Promise<RepositorySnapshot>;
  closeRepository(command: RepositoryCommand, signal?: AbortSignal): Promise<void>;
  getSource(repositoryId: string, revision: string | undefined, fileId: string, signal?: AbortSignal): Promise<string>;
  searchContent(input: SearchRequest, signal?: AbortSignal): Promise<SearchResponse>;
  getOverview(repositoryId: string, revision: string, signal?: AbortSignal): Promise<RepositoryOverview>;
  compare(input: { repositoryId: string; revision: string; mode: "working-tree" | "commits"; baseRef?: string; headRef?: string }, signal?: AbortSignal): Promise<RevisionComparison>;
  fetchHistory(input: { repositoryId: string; workspaceId: string; persistenceSessionId: string; revision: string; target: string }, signal?: AbortSignal): Promise<{ repositoryId: string; workspaceId: string; revision: string; target: string; commit: string; objectsAvailable: true }>;
  subscribe(repositoryId: string, onRevision: (revision: string, sequence: number) => void, onError: (message: string) => void): () => void;
}

export type LocalWorkspaceState = {
  version: number;
  recentRepositories: { id: string; targetId?: string; workspaceId?: string; name: string; location: string; kind: "local" | "github"; lastOpenedAt: number; requestedRef?: string; resolvedRef?: string; commit?: string; subdirectory?: string }[];
  aiResults: Record<string, AiSavedResult>;
  aiRoute: AiRouteRecord | null;
  progress: Record<string, string>;
  nodePositions: Record<string, { x: number; y: number }>;
  conversations: AiQuestionConversation[];
  chatPreferences?: unknown;
  investigations?: Investigation[];
  readingNotes?: ReadingNote[];
  savedTours?: AiRouteRecord[];
  guidePreferences?: UsageGuidePreferences | null;
  layoutPreferences?: WorkspaceLayoutPreferences | null;
  warning?: string;
  persistenceReady?: boolean;
};

export type WorkspaceSession = { repositoryId: string; workspaceId: string; persistenceSessionId?: string };

export interface WorkspacePersistenceProvider {
  get(repositoryId: string, signal?: AbortSignal): Promise<LocalWorkspaceState>;
  touchRecent(session: WorkspaceSession): Promise<void>;
  removeRecent(targetId: string): Promise<void>;
  saveProgress(session: WorkspaceSession, key: string, value: string): Promise<void>;
  saveNodePositions(session: WorkspaceSession, positions: Record<string, { x: number; y: number }>): Promise<void>;
  saveAiResult(session: WorkspaceSession, fileId: string, record: AiSavedResult): Promise<void>;
  saveAiRoute(session: WorkspaceSession, record: AiRouteRecord): Promise<void>;
  saveConversations(session: WorkspaceSession, conversations: AiQuestionConversation[]): Promise<void>;
  saveChatPreferences(session: WorkspaceSession, preferences: ChatPreferences): Promise<void>;
  saveReadingNotes(session: WorkspaceSession, notes: ReadingNote[]): Promise<void>;
  saveTours(session: WorkspaceSession, tours: AiRouteRecord[]): Promise<void>;
  saveInvestigations(session: WorkspaceSession, records: Investigation[]): Promise<void>;
  clearRepository(session: WorkspaceSession): Promise<ClearResult>;
  saveGuidePreferences(preferences: UsageGuidePreferences): Promise<void>;
  saveLayoutPreferences(preferences: WorkspaceLayoutPreferences): Promise<void>;
  clearAll(): Promise<ClearResult>;
}

async function request<T>(url: string, schema: z.ZodTypeAny, fallback: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(url, init); }
  catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new Error("本地 RepoLens 服务不可用。请确认应用仍在运行。");
  }
  let value: unknown;
  try { value = await response.json(); }
  catch {
    if (!response.ok) throw new Error(`本地服务返回 ${response.status}`);
    throw new Error(`${fallback} 响应不是有效 JSON。`);
  }
  return parseLocalApiResponse(value, response.status, schema, fallback) as T;
}

type ClearResult = { preserveMemory?: boolean; ok: boolean; warning?: string; cleared?: { model?: boolean; workspace: boolean; copies: boolean } };
const clearOperations = new Map<string, string>();
const appliedClears = new Set<string>();
const notifiedModelClears = new Set<string>();
// Only an acknowledged main-record clear permits a nondestructive copy-only retry.
export function isWorkspaceCopyCleanupPending(session?: WorkspaceSession): boolean {
  const operationId = clearOperations.get(session?.workspaceId ?? "clear-all");
  return operationId !== undefined && appliedClears.has(operationId);
}
async function clearSavedData(input: Record<string, unknown>): Promise<ClearResult> {
  const scope = String(input.workspaceId ?? input.action);
  const operationId = clearOperations.get(scope) ?? crypto.randomUUID();
  clearOperations.set(scope, operationId);
  let result: ClearResult;
  try {
    const response = await fetch(`${LOCAL_API_ORIGIN}/api/workspace`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, operationId }) });
    if (!response.ok) throw new Error(`清除结果未知（${response.status}），请重试清除。`);
    result = WorkspaceSaveResponseSchema.parse(await response.json()) as ClearResult;
  } catch (cause) { throw Object.assign(new Error("尚未确认清除结果，自动保存已暂停。请重试清除。", { cause }), { clearUnknown: true }); }
  result.preserveMemory = appliedClears.has(operationId);
  if (result.cleared?.model && !notifiedModelClears.has(operationId)) { notifiedModelClears.add(operationId); window.dispatchEvent(new Event("repolens:model-cleared")); }
  if (result.cleared?.workspace) appliedClears.add(operationId);
  if (result.ok) { clearOperations.delete(scope); appliedClears.delete(operationId); notifiedModelClears.delete(operationId); }
  if (!result.ok && !result.cleared?.workspace) throw new Error(result.warning ?? "清除失败，请重试。");
  return result;
}

async function persist(url: string, value: unknown): Promise<void> {
  const result = await request<{ ok: boolean; warning?: string }>(url, WorkspaceSaveResponseSchema, "本地保存结果格式无效。", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: serializeWorkspaceMutation(value),
  });
  if (!result.ok) throw new Error(result.warning ?? "本地保存未能写入磁盘。");
}

export const localRepositoryProvider: LocalRepositoryProvider = {
  async getSnapshot(repositoryId, signal) { return request(`${LOCAL_API_ORIGIN}/api/snapshot?repositoryId=${encodeURIComponent(repositoryId ?? "")}`, RepositorySnapshotSchema, "仓库快照格式无效。", { signal }) as Promise<RepositorySnapshot>; },
  async openRepository(path, command, signal) { await flushChatPreferences(signal); return request(`${LOCAL_API_ORIGIN}/api/open`, RepositorySnapshotSchema, "仓库快照格式无效。", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, command }), signal }) as Promise<RepositorySnapshot>; },
  async rescan(repositoryId, signal) { return request(`${LOCAL_API_ORIGIN}/api/rescan`, RepositorySnapshotSchema, "仓库快照格式无效。", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repositoryId }), signal }) as Promise<RepositorySnapshot>; },
  async closeRepository(command, signal) { await flushChatPreferences(signal); await request(`${LOCAL_API_ORIGIN}/api/close`, WorkspaceSaveResponseSchema, "关闭结果格式无效。", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command }), signal }); },
  async getSource(repositoryId, revision, fileId, signal) { const query = new URLSearchParams({ repositoryId, file: fileId, ...(revision ? { revision } : {}) }); const value = await request<{ source: string }>(`${LOCAL_API_ORIGIN}/api/source?${query}`, SourceResponseSchema, "源码响应格式无效。", { signal }); return value.source; },
  async searchContent(input, signal) { return request(`${LOCAL_API_ORIGIN}/api/search`, SearchResponseSchema, "源码搜索结果格式无效。", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal }) as Promise<SearchResponse>; },
  async getOverview(repositoryId, revision, signal) { const query = new URLSearchParams({ repositoryId, revision }); return request(`${LOCAL_API_ORIGIN}/api/overview?${query}`, RepositoryOverviewSchema, "仓库概览格式无效。", { signal }) as Promise<RepositoryOverview>; },
  async compare(input, signal) { return request(`${LOCAL_API_ORIGIN}/api/compare`, RevisionComparisonResponseSchema, "版本比较结果格式无效。", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal }) as Promise<RevisionComparison>; },
  async fetchHistory(input, signal) { return request(`${LOCAL_API_ORIGIN}/api/compare/fetch`, RevisionFetchResponseSchema, "GitHub 版本获取结果格式无效。", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal }); },
  subscribe(repositoryId, onRevision, onError) {
    const source = new EventSource(`${LOCAL_API_ORIGIN}/api/events?repositoryId=${encodeURIComponent(repositoryId)}`);
    source.addEventListener("revision", (event) => {
      const parsed = parseRepositoryEvent("revision", (event as MessageEvent).data);
      if (!parsed.success) { onError(parsed.message); return; }
      const value = RepositoryRevisionEventSchema.parse(parsed.value) as { repositoryId: string; revision: string; sequence: number };
      if (value.repositoryId !== repositoryId) { onError("收到其他仓库的索引事件，正在重新同步。"); return; }
      onRevision(value.revision, value.sequence);
    });
    source.addEventListener("diagnostic", (event) => {
      const parsed = parseRepositoryEvent("diagnostic", (event as MessageEvent).data);
      if (!parsed.success) { onError(parsed.message); return; }
      onError((RepositoryDiagnosticEventSchema.parse(parsed.value) as { message: string }).message);
    });
    source.onerror = () => onError("仓库监听连接已断开，正在尝试重连。");
    return () => source.close();
  },
};

export const localWorkspaceProvider: WorkspacePersistenceProvider = {
  async get(repositoryId, signal) { return request<LocalWorkspaceState>(`${LOCAL_API_ORIGIN}/api/workspace?repositoryId=${encodeURIComponent(repositoryId)}`, LocalWorkspaceStateSchema, "本地保存数据格式无效。", { signal }); },
  async touchRecent(session) { await persist(`${LOCAL_API_ORIGIN}/api/workspace`, { action: "recent-touch", ...session }); },
  async removeRecent(targetId) { await persist(`${LOCAL_API_ORIGIN}/api/workspace`, { action: "recent-remove", targetId }); },
  async saveProgress(session, key, value) { await persist(`${LOCAL_API_ORIGIN}/api/workspace`, { action: "progress", ...session, key, value }); },
  async saveNodePositions(session, positions) { await persist(`${LOCAL_API_ORIGIN}/api/workspace`, { action: "node-positions", ...session, positions }); },
  async saveAiResult(session, fileId, record) { await persist(`${LOCAL_API_ORIGIN}/api/workspace`, { action: "ai-result", ...session, fileId, record }); },
  async saveAiRoute(session, record) { await persist(`${LOCAL_API_ORIGIN}/api/workspace`, { action: "ai-route", ...session, record }); },
  async saveConversations(session, conversations) { assertConversationCapacity(conversations); await persist(`${LOCAL_API_ORIGIN}/api/workspace`, { action: "conversations", ...session, conversations }); },
  async saveChatPreferences(session, preferences) { await persist(`${LOCAL_API_ORIGIN}/api/workspace`, { action: "chat-preferences", ...session, preferences }); },
  async saveReadingNotes(session, notes) { await persist(`${LOCAL_API_ORIGIN}/api/workspace`, { action: "reading-notes", ...session, notes }); },
  async saveInvestigations(session, records) { await persist(`${LOCAL_API_ORIGIN}/api/workspace`, { action: "investigations", ...session, records }); },
  async saveTours(session, tours) { await persist(`${LOCAL_API_ORIGIN}/api/workspace`, { action: "saved-tours", ...session, tours }); },
  async saveGuidePreferences(preferences) { await persist(`${LOCAL_API_ORIGIN}/api/workspace`, { action: "guide-preferences", preferences }); },
  async saveLayoutPreferences(preferences) { await persist(`${LOCAL_API_ORIGIN}/api/workspace`, { action: "layout-preferences", preferences }); },
  async clearRepository(session) { return clearSavedData({ action: "clear-repository", ...session }); },
  async clearAll() { return clearSavedData({ action: "clear-all", repositoryId: "" }); },
};
