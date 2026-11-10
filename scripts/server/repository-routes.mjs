import { randomUUID } from "node:crypto";
import { scanRepository } from "../../data/localRepository.mjs";
import { cleanupGitHubRepository, prepareGitHubRepository } from "../../data/githubRepository.mjs";
import { LocalHealthResponseSchema, RepositoryCloseRequestSchema, RepositoryOpenRequestSchema, RepositoryRescanRequestSchema, RepositorySnapshotSchema, WorkspaceSaveResponseSchema } from "../../data/local-contracts.mjs";

export function createRepositoryRoutes({
  aiOperations, attachGitHubMetadata, beginGitHubOperation, body, cancelGitHubOperations,
  cleanOwnedWorkspace, closeOperations, enqueueGitHubRescan, enqueueOpenScan, enqueueScan,
  githubOperations, invalidatePreviews, json, ownedWorkspaces, parseRequest,
  pendingOpenByClient, pendingOpenOperations, publish, repositoryCommands, snapshotView,
  startWatching, state, stopWatching, subscribers, trackSequence,
  updateSession, validatedJson, writeEvent,
}, route) {
  return [
    route("GET", "/api/health", async (request, response, url) => {
      return validatedJson(response, 200, { ok: true }, LocalHealthResponseSchema, "健康检查");
    }),
    route("GET", "/api/snapshot", async (request, response, url) => {
      if (!state.session || url.searchParams.get("repositoryId") !== state.session.snapshot.id) return json(response, 409, { error: "仓库会话已变化，请重新打开。" });
      return validatedJson(response, 200, snapshotView(), RepositorySnapshotSchema, "仓库快照");
    }),
    route("POST", "/api/open", async (request, response, url) => {
      const input = parseRequest(await body(request), RepositoryOpenRequestSchema, "打开仓库请求");
      const commandStatus = repositoryCommands.accept(input.command, "open");
      if (commandStatus !== "accepted") return json(response, commandStatus === "invalid" ? 400 : 409, { error: commandStatus === "invalid" ? "仓库操作参数无效，请刷新页面。" : "仓库操作已过期，请重试。" });
      const operation = {
        command: input.command,
        cancelled: false,
        committed: false,
        controller: new AbortController(),
        githubWorkspace: null,
        done: null,
        finish: null,
        cancel() { this.cancelled = true; this.controller.abort(); },
      };
      operation.done = new Promise((resolve) => { operation.finish = resolve; });
      const previousPending = pendingOpenByClient.get(input.command.clientId);
      if (previousPending) previousPending.cancel();
      pendingOpenByClient.set(input.command.clientId, operation);
      pendingOpenOperations.add(operation);
      response.on("close", () => { if (!response.writableEnded && !operation.committed) operation.cancel(); });
      try {
        const next = await enqueueOpenScan(input.path, operation);
        if (operation.cancelled || !repositoryCommands.isCurrent(operation.command, "open")) return json(response, 409, { error: "仓库打开请求已被更新请求取代。" });
        const previousSession = state.session;
        if (previousSession?.snapshot.id) await cancelGitHubOperations(previousSession.snapshot.id);
        if (operation.cancelled || !repositoryCommands.isCurrent(operation.command, "open")) return json(response, 409, { error: "仓库打开请求已被更新请求取代。" });
        ++state.sessionGeneration; stopWatching(); invalidatePreviews();
        next.snapshot.workspaceId ??= next.snapshot.id;
        const persistenceSessionId = randomUUID();
        next.snapshot.persistenceSessionId = persistenceSessionId;
        state.session = trackSequence({ ...next, persistenceSessionId, ownerClientId: input.command.clientId, ownerIntentSequence: input.command.intentSequence });
        operation.committed = true;
        startWatching();
        if (previousSession?.githubWorkspace && previousSession.githubWorkspace.storageRoot !== state.session.githubWorkspace?.storageRoot) await cleanOwnedWorkspace(previousSession.githubWorkspace);
        return validatedJson(response, 200, snapshotView(), RepositorySnapshotSchema, "仓库快照");
      } finally {
        if (!operation.committed && operation.githubWorkspace) await cleanOwnedWorkspace(operation.githubWorkspace);
        if (pendingOpenByClient.get(input.command.clientId) === operation) pendingOpenByClient.delete(input.command.clientId);
        pendingOpenOperations.delete(operation);
        operation.finish();
      }
    }),
    route("POST", "/api/rescan", async (request, response, url) => {
      const input = parseRequest(await body(request), RepositoryRescanRequestSchema, "重扫请求");
      if (!state.session || input.repositoryId !== state.session.snapshot.id) return json(response, 409, { error: "仓库会话已变化，请重新打开。" });
      const generation = state.sessionGeneration;
      if (state.session.githubWorkspace) {
        const previousSession = state.session;
        const operation = beginGitHubOperation(previousSession.snapshot.id, generation);
        response.on("close", () => { if (!response.writableEnded) operation.controller.abort(); });
        try {
          const outcome = await enqueueGitHubRescan(operation, async () => {
            let nextWorkspace = null;
            try {
              nextWorkspace = await prepareGitHubRepository(previousSession.githubWorkspace.input, previousSession.githubWorkspace, { signal: operation.controller.signal });
              const next = attachGitHubMetadata(await scanRepository(nextWorkspace.root), nextWorkspace, previousSession.snapshot);
              if (operation.controller.signal.aborted || generation !== state.sessionGeneration || state.session?.snapshot.id !== input.repositoryId) {
                await cleanupGitHubRepository({ ...nextWorkspace, storageRoot: nextWorkspace.checkoutRoot });
                return { status: 409, value: { error: "重扫结果已过期，请重新扫描。" } };
              }
              if (next.snapshot.revision !== state.session.snapshot.revision) {
                updateSession(next); invalidatePreviews(); publish();
                if (previousSession.githubWorkspace.checkoutRoot !== nextWorkspace.checkoutRoot) {
                  await cleanupGitHubRepository({ ...previousSession.githubWorkspace, storageRoot: previousSession.githubWorkspace.checkoutRoot });
                }
              } else await cleanupGitHubRepository({ ...nextWorkspace, storageRoot: nextWorkspace.checkoutRoot });
              return { status: 200, value: snapshotView() };
            } catch (error) {
              if (nextWorkspace) await cleanupGitHubRepository({ ...nextWorkspace, storageRoot: nextWorkspace.checkoutRoot });
              throw error;
            }
          });
          return outcome.status === 200
            ? validatedJson(response, outcome.status, outcome.value, RepositorySnapshotSchema, "仓库快照")
            : json(response, outcome.status, outcome.value);
        }
        finally { githubOperations.delete(operation); operation.finish(); }
      }
      const next = await enqueueScan(state.session.root, generation, state.session);
      if (generation !== state.sessionGeneration || state.session?.snapshot.id !== input.repositoryId) {
        return json(response, 409, { error: "重扫结果已过期，请重新扫描。" });
      }
      if (next.snapshot.revision !== state.session.snapshot.revision) {
        updateSession(next); invalidatePreviews(); publish();
      }
      return validatedJson(response, 200, snapshotView(), RepositorySnapshotSchema, "仓库快照");
    }),
    route("POST", "/api/close", async (request, response, url) => {
      const input = parseRequest(await body(request), RepositoryCloseRequestSchema, "关闭仓库请求");
      const commandStatus = repositoryCommands.accept(input.command, "close");
      if (commandStatus === "duplicate") {
        const previous = closeOperations.get(input.command.clientId);
        if (!previous || previous.sequence !== input.command.intentSequence) return json(response, 409, { error: "关闭结果不可用，请使用新的关闭命令。" });
        const result = await previous.done;
        return json(response, result.status, result.value);
      }
      if (commandStatus !== "accepted") return json(response, commandStatus === "invalid" ? 400 : 409, { error: commandStatus === "invalid" ? "仓库操作参数无效，请刷新页面。" : "仓库操作已过期，请重试。" });
      const command = input.command;
      const previousClose = closeOperations.get(command.clientId);
      const opening = [...pendingOpenOperations].filter(operation => operation.command.clientId === command.clientId && operation.command.intentSequence < command.intentSequence);
      for (const operation of opening) operation.cancel();
      const closingOperations = [...githubOperations].filter(operation => operation.ownerClientId === command.clientId && operation.ownerIntentSequence < command.intentSequence);
      for (const operation of closingOperations) operation.controller.abort();
      if (state.session?.ownerClientId === command.clientId && state.session.ownerIntentSequence < command.intentSequence) {
        const closedId = state.session.snapshot.id;
        ++state.sessionGeneration; stopWatching(); state.session = null; invalidatePreviews(); aiOperations.clearCache();
        // End only subscriptions captured from the old session, before any await.
        for (const subscriber of subscribers) if (subscriber.repositoryId === closedId) {
          writeEvent(subscriber.response, "diagnostic", { message: "仓库索引已关闭。" }); subscriber.response.end();
        }
      }
      const done = (async () => {
        await Promise.allSettled([previousClose?.done, ...opening.map(operation => operation.done), ...closingOperations.map(operation => operation.done)]);
        const owned = [...ownedWorkspaces.values()].filter(record => record.command.clientId === command.clientId && record.command.intentSequence < command.intentSequence);
        const results = await Promise.allSettled(owned.map(record => cleanOwnedWorkspace(record.workspace)));
        return results.every(result => result.status === "fulfilled" && result.value)
          ? { status: 200, value: { ok: true } }
          : { status: 500, value: { ok: false, error: "仓库已关闭，但临时内容未能全部清理；请检查本地服务日志。" } };
      })();
      closeOperations.set(command.clientId, { sequence: command.intentSequence, done });
      const result = await done;
      return result.status === 200
        ? validatedJson(response, result.status, result.value, WorkspaceSaveResponseSchema, "关闭仓库")
        : json(response, result.status, result.value);
    }),
    route("GET", "/api/events", async (request, response, url) => {
      const repositoryId = url.searchParams.get("repositoryId");
      if (!state.session || repositoryId !== state.session.snapshot.id) return json(response, 409, { error: "仓库会话已变化，请重新打开。" });
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      response.write("retry: 1500\n\n"); subscribers.add({ response, repositoryId });
      writeEvent(response, "revision", { repositoryId, revision: state.session.snapshot.revision, sequence: state.session.snapshot.sequence });
      request.on("close", () => { for (const subscriber of subscribers) if (subscriber.response === response) subscribers.delete(subscriber); }); return;
    }),
  ];
}
