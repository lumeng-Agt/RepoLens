import { randomUUID } from "node:crypto";
import { LocalWorkspaceStateSchema, WorkspaceMutationRequestSchema, WorkspaceSaveResponseSchema } from "../../data/local-contracts.mjs";

export function createWorkspaceRoutes({
  body, clearCoordinator, digest, json, matchesPersistenceSession,
  operationRecorder, parseRequest, runPersistence, state, validatedJson,
  workspaceStore,
}, route) {
  return [
    route("GET", "/api/workspace", async (request, response, url) => {
      const repositoryId = url.searchParams.get("repositoryId");
      if (!repositoryId || repositoryId.length > 160) return json(response, 400, { error: "工作区编号无效。" });
      const workspaceId = state.session?.snapshot.id === repositoryId ? state.session.snapshot.workspaceId ?? repositoryId : repositoryId;
      return validatedJson(response, 200, await workspaceStore.getRepository(workspaceId), LocalWorkspaceStateSchema, "工作区读取");
    }),
    route("POST", "/api/workspace", async (request, response, url) => {
      const input = parseRequest(await body(request), WorkspaceMutationRequestSchema, "工作区操作");
      if (input.repositoryId && input.repositoryId.length > 160) return json(response, 400, { error: "工作区编号无效。" });
      return await runPersistence(async () => {
      const { repositoryId } = input;
      let result;
      const telemetry = operationRecorder.start("workspace.mutate", { repositoryId: repositoryId ?? "global", action: String(input.action ?? "unknown") });
      try {
      if (input.action === "guide-preferences") {
        result = await workspaceStore.saveGuidePreferences(input.preferences);
      } else if (input.action === "layout-preferences") {
        result = await workspaceStore.saveLayoutPreferences(input.preferences);
      } else if (input.action === "recent-touch") {
        if (!matchesPersistenceSession(input)) return json(response, 409, { error: "仓库会话已变化，最近记录未保存。" });
        const originInfo = state.session.snapshot.origin?.kind === "github" ? state.session.snapshot.origin : null;
        const workspaceId = state.session.snapshot.workspaceId ?? repositoryId;
        const locationRef = originInfo
          ? /^[0-9a-f]{7,64}$/i.test(originInfo.resolvedRef) ? originInfo.commit : originInfo.resolvedRef
          : "";
        const encodedLocationPath = [locationRef, originInfo?.subdirectory].filter(Boolean).flatMap((part) => part.split("/")).map(encodeURIComponent).join("/");
        const location = originInfo && encodedLocationPath
          ? `${originInfo.url}/tree/${encodedLocationPath}`
          : originInfo?.url ?? state.session.root;
        result = await workspaceStore.touchRecent({
          id: workspaceId,
          targetId: originInfo ? `github-target-${digest(`${originInfo.owner.toLowerCase()}/${originInfo.repository.toLowerCase()}\0${/^([0-9a-f]{7,64})$/i.test(originInfo.resolvedRef) ? originInfo.commit : originInfo.resolvedRef}\0${originInfo.subdirectory}`)}` : workspaceId,
          workspaceId,
          repositoryId,
          name: state.session.snapshot.name,
          location,
          kind: originInfo ? "github" : "local",
          ...(originInfo ? { requestedRef: originInfo.requestedRef, resolvedRef: originInfo.resolvedRef, commit: originInfo.commit, subdirectory: originInfo.subdirectory } : {}),
        });
      } else if (input.action === "recent-remove") {
        result = await workspaceStore.removeRecent(input.targetId ?? repositoryId);
      } else if (input.action === "progress") {
        const sampleWorkspace = repositoryId === "taskflow-sample";
        if (!sampleWorkspace && !matchesPersistenceSession(input)) return json(response, 409, { error: "仓库会话已变化，阅读进度未保存。" });
        result = await workspaceStore.saveProgress(sampleWorkspace ? repositoryId : state.session.snapshot.workspaceId ?? repositoryId, input.key, input.value);
      } else if (input.action === "node-positions" || input.action === "ai-result" || input.action === "ai-route" || input.action === "conversations" || input.action === "chat-preferences" || input.action === "reading-notes" || input.action === "saved-tours" || input.action === "investigations") {
        const sampleWorkspace = repositoryId === "taskflow-sample";
        if (!sampleWorkspace && !matchesPersistenceSession(input)) return json(response, 409, { error: "当前仓库会话已变化，保存请求已丢弃。" });
        const workspaceId = sampleWorkspace ? repositoryId : state.session.snapshot.workspaceId ?? repositoryId;
        if (input.action === "node-positions") result = await workspaceStore.saveNodePositions(workspaceId, input.positions);
        else if (input.action === "ai-result") result = await workspaceStore.saveAiResult(workspaceId, input.fileId, input.record);
        else if (input.action === "ai-route") result = await workspaceStore.saveAiRoute(workspaceId, input.record);
        else if (input.action === "conversations") result = await workspaceStore.saveConversations(workspaceId, input.conversations);
        else if (input.action === "chat-preferences") result = await workspaceStore.saveChatPreferences(workspaceId, input.preferences);
        else if (input.action === "investigations") result = await workspaceStore.saveInvestigations(workspaceId, input.records);
        else if (input.action === "reading-notes") result = await workspaceStore.saveReadingNotes(workspaceId, input.notes);
        else result = await workspaceStore.saveTours(workspaceId, input.tours);
      } else if (input.action === "clear-all") {
        state.clearingCount++;
        try { const cleared = await clearCoordinator.clear(input.operationId ?? randomUUID()); result = { persisted: cleared.ok }; json(response, 200, cleared); return result; } finally { state.clearingCount--; }
      } else if (input.action === "clear-repository") {
        if (!matchesPersistenceSession(input)) return json(response, 409, { error: "仓库会话已变化，保存数据未清除。" });
        state.clearingCount++;
        try { const cleared = await clearCoordinator.clear(input.operationId ?? randomUUID(), state.session.snapshot.workspaceId ?? repositoryId); result = { persisted: cleared.ok }; json(response, 200, cleared); return result; } finally { state.clearingCount--; }
      } else return json(response, 400, { error: "工作区操作类型无效。" });
      validatedJson(response, 200, { ok: result.persisted, warning: result.warning }, WorkspaceSaveResponseSchema, "工作区保存");
      return result;
      } finally {
        telemetry.finish(result?.persisted ? "ok" : result ? "error" : "stale", { action: String(input.action ?? "unknown") });
      }
      });
    }),
  ];
}
