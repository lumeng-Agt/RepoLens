import { checkModel, allowsNoKey } from "../../data/model-check.mjs";
import { sendJson } from "../../data/local-http.mjs";
import { AiSettingsRequestSchema, AiSettingsResponseSchema } from "../../data/local-contracts.mjs";

export function createModelSettingsRoutes({
  body, clearCoordinator, invalidatePreviews, parseRequest, persistModelSettings,
  runPersistence, settings, validatedJson,
}, route) {
  return [
    route("POST", "/api/ai/settings/check", async (request, response, url) => {
      const input = parseRequest(await body(request), AiSettingsRequestSchema, "模型检测请求");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      response.on("close", () => controller.abort());
      try {
        const apiKey = input.apiKey || (input.baseUrl === settings.baseUrl ? settings.apiKey : "");
        return sendJson(response, 200, await checkModel({ ...input, apiKey }, input.action, controller.signal));
      } finally { clearTimeout(timeout); }
    }),
    route("GET", "/api/ai/settings", async (request, response, url) => {
      return validatedJson(response, 200, { authMode: settings.authMode, baseUrl: settings.baseUrl, model: settings.model, configured: Boolean(settings.baseUrl && settings.model && (settings.apiKey || settings.authMode === "none" && allowsNoKey(settings.baseUrl))) }, AiSettingsResponseSchema, "模型设置");
    }),
    route("POST", "/api/ai/settings", async (request, response, url) => {
      const input = parseRequest(await body(request), AiSettingsRequestSchema, "模型设置请求");
      const baseUrl = String(input.baseUrl ?? "").trim();
      if (baseUrl) { const parsed = new URL(baseUrl); if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("模型地址须为不含账号信息的 HTTP(S) 服务地址。"); }
      if (input.authMode === "none" && !allowsNoKey(baseUrl)) throw new Error("免密模式仅用于本机回环地址。");
      return await runPersistence(async () => {
      await clearCoordinator.run(async () => {
      const serviceChanged = baseUrl !== settings.baseUrl;
      const nextSettings = { authMode: input.authMode === "none" ? "none" : "key", baseUrl, model: String(input.model ?? "").trim(), apiKey: input.authMode === "none" ? "" : typeof input.apiKey === "string" && input.apiKey ? input.apiKey : input.clearKey || serviceChanged ? "" : settings.apiKey };
      await persistModelSettings(nextSettings); Object.assign(settings, nextSettings); invalidatePreviews();
      });
      return validatedJson(response, 200, { authMode: settings.authMode, baseUrl: settings.baseUrl, model: settings.model, configured: Boolean(settings.baseUrl && settings.model && (settings.apiKey || settings.authMode === "none" && allowsNoKey(settings.baseUrl))) }, AiSettingsResponseSchema, "模型设置");
      });
    }),
  ];
}
