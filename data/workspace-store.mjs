import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const VERSION = 1;
const MAX_STORE_BYTES = 64 * 1024 * 1024;
const MAX_PROGRESS_BYTES = 16 * 1024;
const emptyState = () => ({ version: VERSION, recentRepositories: [], aiResults: {}, aiRoutes: {}, progress: {}, nodePositions: {}, conversations: {} });
const clone = (value) => structuredClone(value);

function validateState(value) {
  if (!value || typeof value !== "object" || value.version !== VERSION) throw new Error("工作区存储版本无效。");
  const state = emptyState();
  state.recentRepositories = Array.isArray(value.recentRepositories) ? value.recentRepositories.filter((item) => item && typeof item.id === "string" && typeof item.name === "string" && typeof item.location === "string").slice(0, 20) : [];
  for (const key of ["aiResults", "aiRoutes", "progress", "nodePositions", "conversations"]) {
    if (value[key] && typeof value[key] === "object" && !Array.isArray(value[key])) state[key] = value[key];
  }
  return state;
}

export function createWorkspaceStore(directory) {
  const filePath = path.join(directory, "workspace-v1.json");
  let state = emptyState();
  let loadPromise;
  let writeQueue = Promise.resolve();
  let storageMessage = "";

  async function load() {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      try {
        const content = await readFile(filePath, "utf8");
        if (Buffer.byteLength(content) > MAX_STORE_BYTES) throw new Error("工作区存储超过 64 MiB 上限。");
        state = validateState(JSON.parse(content));
      } catch (error) {
        if (error.code === "ENOENT") return;
        storageMessage = `无法读取本地保存数据：${error instanceof Error ? error.message : String(error)}`;
        try { await rename(filePath, `${filePath}.corrupt-${Date.now()}`); } catch {}
        state = emptyState();
      }
    })();
    return loadPromise;
  }

  async function persist() {
    const operation = writeQueue.then(async () => {
      await load();
      const serialized = JSON.stringify(state);
      if (Buffer.byteLength(serialized) > MAX_STORE_BYTES) throw new Error("本地保存空间达到 64 MiB 上限。");
      await mkdir(directory, { recursive: true });
      const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
        await rename(temporaryPath, filePath);
        storageMessage = "";
      } catch (error) {
        try { await rename(temporaryPath, `${temporaryPath}.failed`); } catch {}
        storageMessage = `无法保存本地数据：${error instanceof Error ? error.message : String(error)}`;
      }
    });
    writeQueue = operation.catch(() => {});
    await operation;
    return { persisted: !storageMessage, warning: storageMessage || undefined };
  }

  async function mutate(change) {
    await load();
    change(state);
    return persist();
  }

  return {
    async get() { await load(); await writeQueue; return { ...clone(state), warning: storageMessage || undefined }; },
    async getRepository(repositoryId) {
      await load(); await writeQueue;
      const prefix = `repolens:${repositoryId}:`;
      return {
        version: VERSION,
        recentRepositories: clone(state.recentRepositories),
        aiResults: clone(state.aiResults[repositoryId] ?? {}),
        aiRoute: clone(state.aiRoutes[repositoryId] ?? null),
        progress: Object.fromEntries(Object.entries(state.progress).filter(([key]) => key.startsWith(prefix))),
        nodePositions: clone(state.nodePositions[repositoryId] ?? {}),
        conversations: clone(state.conversations[repositoryId] ?? []),
        warning: storageMessage || undefined,
      };
    },
    async touchRecent(repository) {
      return mutate((current) => {
        current.recentRepositories = [
          { ...repository, lastOpenedAt: Date.now() },
          ...current.recentRepositories.filter((item) => item.id !== repository.id),
        ].slice(0, 20);
      });
    },
    async removeRecent(repositoryId) { return mutate((current) => { current.recentRepositories = current.recentRepositories.filter((item) => item.id !== repositoryId); }); },
    async saveAiResult(repositoryId, fileId, result) {
      return mutate((current) => {
        current.aiResults[repositoryId] ??= {};
        current.aiResults[repositoryId][fileId] = result;
      });
    },
    async saveAiRoute(repositoryId, route) { return mutate((current) => { current.aiRoutes[repositoryId] = route; }); },
    async saveProgress(repositoryId, key, value) {
      if (typeof key !== "string" || !key.startsWith(`repolens:${repositoryId}:`) || typeof value !== "string" || Buffer.byteLength(value) > MAX_PROGRESS_BYTES) throw new Error("阅读进度格式无效。");
      return mutate((current) => { current.progress[key] = value; });
    },
    async saveNodePositions(repositoryId, positions) {
      if (!positions || typeof positions !== "object" || Array.isArray(positions) || Object.keys(positions).length > 5000) throw new Error("节点位置数据格式无效。");
      for (const point of Object.values(positions)) if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error("节点坐标无效。");
      return mutate((current) => { current.nodePositions[repositoryId] = positions; });
    },
    async saveConversations(repositoryId, conversations) {
      if (!Array.isArray(conversations) || conversations.length > 100) throw new Error("问答会话数量超出限制。");
      return mutate((current) => { current.conversations[repositoryId] = conversations; });
    },
    async clearRepository(repositoryId) {
      return mutate((current) => {
        current.recentRepositories = current.recentRepositories.filter((item) => item.id !== repositoryId);
        delete current.aiResults[repositoryId]; delete current.aiRoutes[repositoryId];
        delete current.nodePositions[repositoryId]; delete current.conversations[repositoryId];
        for (const key of Object.keys(current.progress)) if (key.startsWith(`repolens:${repositoryId}:`)) delete current.progress[key];
      });
    },
    async clearAll() { return mutate((current) => Object.assign(current, emptyState())); },
  };
}
