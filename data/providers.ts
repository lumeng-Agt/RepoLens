import type { RepositorySnapshot } from "./model";
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
  subscribe(repositoryId: string, onRevision: (revision: string, sequence: number) => void, onError: (message: string) => void): () => void;
}

export type LocalWorkspaceState = {
  version: number;
  recentRepositories: { id: string; name: string; location: string; kind: "local" | "github"; lastOpenedAt: number; requestedRef?: string; resolvedRef?: string; commit?: string; subdirectory?: string }[];
  aiResults: Record<string, Record<string, unknown>>;
  aiRoute: Record<string, unknown> | null;
  progress: Record<string, string>;
  nodePositions: Record<string, { x: number; y: number }>;
  conversations: unknown[];
  warning?: string;
};

export interface WorkspacePersistenceProvider {
  get(repositoryId: string, signal?: AbortSignal): Promise<LocalWorkspaceState>;
  touchRecent(repositoryId: string): Promise<void>;
  removeRecent(repositoryId: string): Promise<void>;
  saveProgress(repositoryId: string, key: string, value: string): Promise<void>;
  saveNodePositions(repositoryId: string, positions: Record<string, { x: number; y: number }>): Promise<void>;
  saveAiResult(repositoryId: string, fileId: string, record: Record<string, unknown>): Promise<void>;
  saveAiRoute(repositoryId: string, record: Record<string, unknown>): Promise<void>;
  saveConversations(repositoryId: string, conversations: unknown[]): Promise<void>;
  clearRepository(repositoryId: string): Promise<void>;
  clearAll(): Promise<void>;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(url, init); }
  catch { throw new Error("本地 RepoLens 服务不可用。请用 npm run dev 启动完整应用。"); }
  const body = await response.json() as T & { error?: string; ok?: boolean; warning?: string };
  if (!response.ok) throw new Error(body.error ?? `本地服务返回 ${response.status}`);
  if (body.ok === false) throw new Error(body.warning ?? "本地数据未能保存。");
  return body;
}

export const localRepositoryProvider: LocalRepositoryProvider = {
  async getSnapshot(repositoryId, signal) { return request<RepositorySnapshot>(`${LOCAL_API_ORIGIN}/api/snapshot?repositoryId=${encodeURIComponent(repositoryId ?? "")}`, { signal }); },
  async openRepository(path, command, signal) { return request<RepositorySnapshot>(`${LOCAL_API_ORIGIN}/api/open`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, command }), signal }); },
  async rescan(repositoryId, signal) { return request<RepositorySnapshot>(`${LOCAL_API_ORIGIN}/api/rescan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repositoryId }), signal }); },
  async closeRepository(command, signal) { await request(`${LOCAL_API_ORIGIN}/api/close`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command }), signal }); },
  async getSource(repositoryId, revision, fileId, signal) { const query = new URLSearchParams({ repositoryId, file: fileId, ...(revision ? { revision } : {}) }); const value = await request<{ source: string }>(`${LOCAL_API_ORIGIN}/api/source?${query}`, { signal }); return value.source; },
  subscribe(repositoryId, onRevision, onError) {
    const source = new EventSource(`${LOCAL_API_ORIGIN}/api/events?repositoryId=${encodeURIComponent(repositoryId)}`);
    source.addEventListener("revision", (event) => { const value = JSON.parse((event as MessageEvent).data) as { revision?: string; sequence?: number }; if (value.revision) onRevision(value.revision, value.sequence ?? 0); else onError("仓库索引已关闭。"); });
    source.addEventListener("diagnostic", (event) => onError((JSON.parse((event as MessageEvent).data) as { message: string }).message));
    source.onerror = () => onError("仓库监听连接已断开，正在尝试重连。");
    return () => source.close();
  },
};

export const localWorkspaceProvider: WorkspacePersistenceProvider = {
  async get(repositoryId, signal) { return request<LocalWorkspaceState>(`${LOCAL_API_ORIGIN}/api/workspace?repositoryId=${encodeURIComponent(repositoryId)}`, { signal }); },
  async touchRecent(repositoryId) { await request(`${LOCAL_API_ORIGIN}/api/workspace`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "recent-touch", repositoryId }) }); },
  async removeRecent(repositoryId) { await request(`${LOCAL_API_ORIGIN}/api/workspace`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "recent-remove", repositoryId }) }); },
  async saveProgress(repositoryId, key, value) { await request(`${LOCAL_API_ORIGIN}/api/workspace`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "progress", repositoryId, key, value }) }); },
  async saveNodePositions(repositoryId, positions) { await request(`${LOCAL_API_ORIGIN}/api/workspace`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "node-positions", repositoryId, positions }) }); },
  async saveAiResult(repositoryId, fileId, record) { await request(`${LOCAL_API_ORIGIN}/api/workspace`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "ai-result", repositoryId, fileId, record }) }); },
  async saveAiRoute(repositoryId, record) { await request(`${LOCAL_API_ORIGIN}/api/workspace`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "ai-route", repositoryId, record }) }); },
  async saveConversations(repositoryId, conversations) { await request(`${LOCAL_API_ORIGIN}/api/workspace`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "conversations", repositoryId, conversations }) }); },
  async clearRepository(repositoryId) { await request(`${LOCAL_API_ORIGIN}/api/workspace`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "clear-repository", repositoryId }) }); },
  async clearAll() { await request(`${LOCAL_API_ORIGIN}/api/workspace`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "clear-all", repositoryId: "" }) }); },
};
