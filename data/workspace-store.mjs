import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const VERSION = 1;
const MAX_STORE_BYTES = 64 * 1024 * 1024;
const MAX_PROGRESS_BYTES = 16 * 1024;
const emptyState = () => ({ version: VERSION, recentRepositories: [], aiResults: {}, aiRoutes: {}, progress: {}, nodePositions: {}, conversations: {}, readingNotes: {}, savedTours: {}, guidePreferences: null });
const clone = (value) => structuredClone(value);

class UnsupportedStoreVersionError extends Error {}

function validateState(value) {
  if (!value || typeof value !== "object" || value.version !== VERSION) throw new UnsupportedStoreVersionError("工作区存储版本不受支持。");
  const state = emptyState();
  state.recentRepositories = Array.isArray(value.recentRepositories) ? value.recentRepositories.filter((item) => item && typeof item.id === "string" && typeof item.name === "string" && typeof item.location === "string").slice(0, 20) : [];
  for (const key of ["aiResults", "aiRoutes", "progress", "nodePositions", "conversations", "readingNotes", "savedTours"]) {
    if (value[key] && typeof value[key] === "object" && !Array.isArray(value[key])) state[key] = value[key];
  }
  if (Object.hasOwn(value, "guidePreferences")) state.guidePreferences = value.guidePreferences;
  return state;
}

export function createWorkspaceStore(directory) {
  const filePath = path.join(directory, "workspace-v1.json");
  const baseName = path.basename(filePath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const managedCopyPattern = new RegExp(`^${baseName}\\.(?:[0-9a-f-]{36}\\.tmp(?:\\.failed)?|corrupt-\\d+)(?:\\.[0-9a-f-]{36}\\.scrub\\.tmp)?$`, "i");
  let state = emptyState();
  let loadPromise;
  let loaded = false;
  let writeQueue = Promise.resolve();
  let storageMessage = "";

  async function load() {
    if (loaded) return true;
    if (loadPromise) return loadPromise;
    const attempt = (async () => {
      let content;
      try {
        content = await readFile(filePath, "utf8");
      } catch (error) {
        if (error.code === "ENOENT") {
          state = emptyState();
          loaded = true;
          storageMessage = "";
          return true;
        }
        storageMessage = `无法读取本地保存数据；已暂停写入并会重试：${error instanceof Error ? error.message : String(error)}`;
        return false;
      }

      let parsed;
      try {
        if (Buffer.byteLength(content) > MAX_STORE_BYTES) throw new Error("工作区存储超过 64 MiB 上限。");
        parsed = JSON.parse(content);
      } catch (error) {
        return quarantineCorruptFile(error);
      }
      try {
        state = validateState(parsed);
      } catch (error) {
        if (error instanceof UnsupportedStoreVersionError) {
          storageMessage = `${error.message}；已暂停写入以保护原数据。`;
          return false;
        }
        return quarantineCorruptFile(error);
      }
      loaded = true;
      storageMessage = "";
      return true;
    })();
    loadPromise = attempt;
    try { return await attempt; }
    finally { if (loadPromise === attempt) loadPromise = undefined; }
  }

  async function quarantineCorruptFile(cause) {
    const quarantinePath = `${filePath}.corrupt-${Date.now()}`;
    try {
      await rename(filePath, quarantinePath);
      state = emptyState();
      loaded = true;
      storageMessage = `无法读取本地保存数据，原文件已保留为 ${path.basename(quarantinePath)}：${cause instanceof Error ? cause.message : String(cause)}`;
      return true;
    } catch (error) {
      storageMessage = `本地保存数据格式异常，原文件无法安全隔离，已暂停写入：${error instanceof Error ? error.message : String(error)}`;
      return false;
    }
  }

  async function persist(nextState) {
    try {
      const serialized = JSON.stringify(nextState);
      if (Buffer.byteLength(serialized) > MAX_STORE_BYTES) throw new Error("本地保存空间达到 64 MiB 上限。");
      await mkdir(directory, { recursive: true });
      const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
        await rename(temporaryPath, filePath);
      } catch (error) {
        try { await unlink(temporaryPath); } catch (cleanupError) {
          error.cleanupError = cleanupError;
        }
        throw error;
      }
      state = nextState;
      storageMessage = "";
      return { persisted: true };
    } catch (error) {
      const cleanup = error?.cleanupError instanceof Error ? `；未提交临时文件清理失败（${path.basename(error.cleanupError.path ?? "临时文件")}）：${error.cleanupError.message}` : "";
      storageMessage = `无法保存本地数据：${error instanceof Error ? error.message : String(error)}${cleanup}`;
      return { persisted: false, warning: storageMessage };
    }
  }

  async function listManagedCopies() {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if (error.code === "ENOENT") return [];
      throw new Error(`无法检查本地保存副本：${error.message}`);
    }
    return entries.filter((entry) => managedCopyPattern.test(entry.name));
  }

  function removeRepositoryFromState(target, repositoryId) {
    target.recentRepositories = target.recentRepositories.filter((item) => (item.workspaceId ?? item.id) !== repositoryId);
    delete target.aiResults[repositoryId]; delete target.aiRoutes[repositoryId]; delete target.readingNotes[repositoryId]; delete target.savedTours[repositoryId];
    delete target.nodePositions[repositoryId]; delete target.conversations[repositoryId];
    for (const key of Object.keys(target.progress)) if (key.startsWith(`repolens:${repositoryId}:`)) delete target.progress[key];
  }

  async function cleanManagedCopies(repositoryId) {
    const entries = await listManagedCopies();
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (!repositoryId) {
        if (entry.isDirectory()) throw new Error(`应用保存副本不是普通文件，无法安全清除：${entry.name}`);
        try { await unlink(candidate); }
        catch (error) { throw new Error(`无法清理本地保存副本 ${entry.name}：${error.message}`); }
        continue;
      }
      if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`无法安全识别本地保存副本 ${entry.name}；请使用“清除全部”完成清理。`);
      let parsed;
      try {
        const content = await readFile(candidate, "utf8");
        if (Buffer.byteLength(content) > MAX_STORE_BYTES) throw new Error("副本超过 64 MiB 上限");
        parsed = validateState(JSON.parse(content));
      } catch (error) {
        throw new Error(`无法确认副本 ${entry.name} 中的数据归属；当前仓库未报告清除完成：${error.message}`);
      }
      removeRepositoryFromState(parsed, repositoryId);
      const temporaryPath = `${candidate}.${randomUUID()}.scrub.tmp`;
      try {
        await writeFile(temporaryPath, JSON.stringify(parsed), { encoding: "utf8", flag: "wx", mode: 0o600 });
        await rename(temporaryPath, candidate);
      } catch (error) {
        try { await unlink(temporaryPath); } catch {}
        throw new Error(`无法更新本地保存副本 ${entry.name}：${error.message}`);
      }
    }
    return { persisted: true };
  }

  async function mutate(change, afterCommit) {
    if (!await load()) return { persisted: false, warning: storageMessage };
    const operation = writeQueue.then(async () => {
      const nextState = clone(state);
      change(nextState);
      const result = await persist(nextState);
      if (!result.persisted || !afterCommit) return result;
      try {
        await afterCommit();
        return result;
      } catch (error) {
        storageMessage = error instanceof Error ? error.message : String(error);
        return { persisted: false, warning: storageMessage };
      }
    });
    writeQueue = operation.catch(() => {});
    return operation;
  }

  return {
    async get() { await load(); await writeQueue; return { ...clone(state), persistenceReady: loaded, warning: storageMessage || undefined }; },
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
        readingNotes: clone(state.readingNotes[repositoryId] ?? []),
        savedTours: clone(state.savedTours[repositoryId] ?? []),
        guidePreferences: clone(state.guidePreferences),
        persistenceReady: loaded,
        warning: storageMessage || undefined,
      };
    },
    async touchRecent(repository) {
      return mutate((current) => {
        const targetId = repository.targetId ?? repository.id;
        current.recentRepositories = [
          { ...repository, id: targetId, targetId, workspaceId: repository.workspaceId ?? repository.id, lastOpenedAt: Date.now() },
          ...current.recentRepositories.filter((item) => (item.targetId ?? item.id) !== targetId),
        ].slice(0, 20);
      });
    },
    async removeRecent(targetId) { return mutate((current) => { current.recentRepositories = current.recentRepositories.filter((item) => (item.targetId ?? item.id) !== targetId); }); },
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
    async saveReadingNotes(repositoryId, notes) {
      if (!Array.isArray(notes) || notes.length > 10_000) throw new Error("阅读笔记数量超出限制。");
      return mutate((current) => { current.readingNotes[repositoryId] = notes; });
    },
    async saveTours(repositoryId, tours) {
      if (!Array.isArray(tours) || tours.length > 100) throw new Error("保存路线数量超出限制。");
      return mutate((current) => { current.savedTours[repositoryId] = tours; });
    },
    async saveGuidePreferences(preferences) { return mutate((current) => { current.guidePreferences = preferences; }); },
    async clearRepository(repositoryId) {
      return mutate((current) => removeRepositoryFromState(current, repositoryId), () => cleanManagedCopies(repositoryId));
    },
    async clearAll() { return mutate((current) => Object.assign(current, emptyState()), () => cleanManagedCopies()); },
  };
}
