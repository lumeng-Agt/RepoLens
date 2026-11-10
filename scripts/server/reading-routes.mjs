import { searchRepositoryContent } from "../../data/repository-search.mjs";
import { buildRepositoryOverview } from "../../data/repository-overview.mjs";
import { SearchRequestSchema, SearchResponseSchema, RepositoryOverviewSchema, SourceResponseSchema } from "../../data/local-contracts.mjs";

export function createReadingRoutes({
  body, json, operationRecorder, parseRequest, safeSource,
  state, validatedJson,
}, route) {
  return [
    route("GET", "/api/source", async (request, response, url) => {
      const repositoryId = url.searchParams.get("repositoryId");
      if (!state.session || repositoryId !== state.session.snapshot.id) return json(response, 409, { error: "仓库会话已变化，请重新打开。" });
      if (!url.searchParams.get("revision")) return json(response, 400, { error: "源码请求必须包含当前修订号。" });
      if (url.searchParams.get("revision") !== state.session.snapshot.revision) return json(response, 409, { error: "源码已更新，请重新读取。" });
      const source = safeSource(url.searchParams.get("file"), repositoryId);
      return source === undefined ? json(response, 404, { error: "文件不存在。" }) : validatedJson(response, 200, { source, repositoryId, revision: state.session.snapshot.revision }, SourceResponseSchema, "源码");
    }),
    route("POST", "/api/search", async (request, response, url) => {
      const input = parseRequest(await body(request), SearchRequestSchema, "源码搜索请求");
      if (!state.session || input.repositoryId !== state.session.snapshot.id) return json(response, 409, { error: "仓库会话已变化，请重新搜索。" });
      if (input.revision !== state.session.snapshot.revision) return json(response, 409, { error: "仓库内容已更新，请重新搜索。" });
      const controller = new AbortController();
      response.on("close", () => { if (!response.writableEnded) controller.abort(); });
      const telemetry = operationRecorder.start("repository.search", { repositoryId: input.repositoryId, revision: input.revision, queryLength: input.query.length });
      try {
        const result = await searchRepositoryContent({ files: state.session.snapshot.files, sourceById: state.session.sourceCache, input, signal: controller.signal });
        if (controller.signal.aborted || state.session?.snapshot.id !== input.repositoryId || state.session.snapshot.revision !== input.revision) return json(response, 409, { error: "仓库已变化，搜索结果已失效。" });
        telemetry.finish("ok", { matches: result.total, files: result.filesSearched });
        return validatedJson(response, 200, result, SearchResponseSchema, "源码搜索");
      } catch (error) {
        telemetry.finish(error?.name === "AbortError" ? "cancelled" : "error", { message: error instanceof Error ? error.message : "搜索失败" });
        throw error;
      }
    }),
    route("GET", "/api/overview", async (request, response, url) => {
      const repositoryId = url.searchParams.get("repositoryId");
      const revision = url.searchParams.get("revision");
      if (!state.session || repositoryId !== state.session.snapshot.id) return json(response, 409, { error: "仓库会话已变化，请重新载入概览。" });
      if (!revision || revision !== state.session.snapshot.revision) return json(response, 409, { error: "仓库内容已更新，请重新载入概览。" });
      const value = await buildRepositoryOverview(state.session.root, state.session.snapshot);
      if (state.session?.snapshot.id !== repositoryId || state.session.snapshot.revision !== revision) return json(response, 409, { error: "仓库已变化，概览结果已失效。" });
      return validatedJson(response, 200, value, RepositoryOverviewSchema, "仓库概览");
    }),
  ];
}
