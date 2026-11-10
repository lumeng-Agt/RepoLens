import { fetchGitHubRevision } from "../../data/githubRepository.mjs";
import { compareRepositoryRevisions } from "../../data/revision-comparison.mjs";
import { RevisionFetchRequestSchema, RevisionFetchResponseSchema, RevisionComparisonRequestSchema, RevisionComparisonResponseSchema } from "../../data/local-contracts.mjs";

export function createComparisonRoutes({
  beginGitHubOperation, body, enqueueGitHubRescan, githubOperations, json,
  matchesPersistenceSession, operationRecorder, parseRequest, state, validatedJson,
}, route) {
  return [
    route("POST", "/api/compare/fetch", async (request, response, url) => {
      const input = parseRequest(await body(request), RevisionFetchRequestSchema, "获取 GitHub 版本请求");
      if (!matchesPersistenceSession(input)) return json(response, 409, { error: "仓库会话已变化，请重新打开后再获取版本。" });
      if (input.revision !== state.session.snapshot.revision) return json(response, 409, { error: "仓库内容已变化，请重新打开获取窗口。" });
      if (!state.session.githubWorkspace) return json(response, 409, { error: "只有 RepoLens 管理的 GitHub 仓库支持获取历史；本地仓库不会被修改。" });
      const activeSession = state.session;
      const workspace = activeSession.githubWorkspace;
      const generation = state.sessionGeneration;
      const operation = beginGitHubOperation(activeSession.snapshot.id, generation);
      response.on("close", () => { if (!response.writableEnded) operation.controller.abort(); });
      const telemetry = operationRecorder.start("github.history.fetch", { repositoryId: activeSession.snapshot.id, targetKind: /^[0-9a-f]{40,64}$/i.test(input.target) ? "commit" : "named-ref" });
      try {
        const outcome = await enqueueGitHubRescan(operation, async () => {
          const fetched = await fetchGitHubRevision(workspace, input.target, { signal: operation.controller.signal });
          if (operation.controller.signal.aborted || generation !== state.sessionGeneration || state.session !== activeSession || state.session.snapshot.revision !== input.revision) {
            return { status: 409, value: { error: "仓库会话已变化，获取结果已失效。" } };
          }
          return { status: 200, value: { repositoryId: input.repositoryId, workspaceId: input.workspaceId, revision: input.revision, ...fetched } };
        });
        telemetry.finish(outcome.status === 200 ? "ok" : "stale");
        return outcome.status === 200
          ? validatedJson(response, outcome.status, outcome.value, RevisionFetchResponseSchema, "GitHub 版本获取")
          : json(response, outcome.status, outcome.value);
      } catch (error) {
        telemetry.finish(error?.name === "AbortError" ? "cancelled" : "error", { message: error instanceof Error ? error.message : "GitHub 版本获取失败" });
        if (error?.name === "AbortError" && !response.destroyed) return json(response, 409, { code: "OPERATION_CANCELLED", error: "GitHub 版本获取已取消。" });
        if (error?.code && error?.status) return json(response, error.status, { code: error.code, error: error.message });
        throw error;
      } finally {
        githubOperations.delete(operation);
        operation.finish();
      }
    }),
    route("POST", "/api/compare", async (request, response, url) => {
      const input = parseRequest(await body(request), RevisionComparisonRequestSchema, "版本比较请求");
      if (!state.session || input.repositoryId !== state.session.snapshot.id) return json(response, 409, { error: "仓库会话已变化，请重新选择比较范围。" });
      if (input.revision !== state.session.snapshot.revision) return json(response, 409, { error: "仓库内容已变化，请重新运行版本比较。" });
      const controller = new AbortController();
      response.on("close", () => { if (!response.writableEnded) controller.abort(); });
      const telemetry = operationRecorder.start("repository.compare", { repositoryId: input.repositoryId, revision: input.revision, mode: input.mode });
      try {
        const value = await compareRepositoryRevisions({
          root: state.session.root,
          ...(state.session.githubWorkspace ? { gitDir: state.session.githubWorkspace.mirrorPath, currentCommit: state.session.githubWorkspace.origin.commit } : {}),
          mode: input.mode, baseRef: input.baseRef, headRef: input.headRef, revision: input.revision, signal: controller.signal,
        });
        if (controller.signal.aborted || state.session?.snapshot.id !== input.repositoryId || state.session.snapshot.revision !== input.revision) return json(response, 409, { error: "仓库已变化，比较结果已失效。" });
        telemetry.finish("ok", { changedFiles: value.files.length, diffBytes: Buffer.byteLength(value.diff) });
        return validatedJson(response, 200, value, RevisionComparisonResponseSchema, "版本比较");
      } catch (error) {
        telemetry.finish(error?.name === "AbortError" ? "cancelled" : "error", { message: error instanceof Error ? error.message : "比较失败" });
        if (error?.code === "REVISION_OBJECT_MISSING" && state.session.githubWorkspace) return json(response, 409, { code: error.code, error: error.message });
        throw error;
      }
    }),
  ];
}
