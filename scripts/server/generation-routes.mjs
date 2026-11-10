import { buildRepositorySummary, retrieveFromSummary } from "../../data/summary-retrieval.mjs";
import { randomUUID } from "node:crypto";
import { AiGenerationEnvelopeSchema, AiPreviewResponseSchema, AiStreamEventSchema, createAiGenerationEnvelope } from "../../data/ai-contract.mjs";
import { AI_PROMPT_VERSION, ModelRedirectError, requestChatCompletion, validateAiResult } from "../../data/ai-generation.mjs";
import { buildAiChatCompletion } from "../../data/ai-chat-completion.mjs";
import { AiGenerationRequestSchema, AiPreviewRequestSchema, AiQuestionPreviewRequestSchema } from "../../data/local-contracts.mjs";

export function createGenerationRoutes({
  aiOperations, body, buildPreview, conflict, contextFromPreview,
  digest, json, modelTimeoutMs, operationRecorder, parseRequest,
  previews, refreshPreviewRepository, runPersistence, settings, state,
  summaryPreviews, validatedJson, workspaceStore,
}, route) {
  return [
    route("POST", ["/api/ai/retrieve/preview","/api/ai/retrieve"], async (request, response, url) => {
      const input = await body(request);
      const origin = state.session;
      if (!origin || input.repositoryId !== origin.snapshot.id || input.persistenceSessionId !== origin.snapshot.persistenceSessionId || input.revision !== origin.snapshot.revision) throw conflict("仓库会话已变化。");
      if (url.pathname.endsWith('/preview')) {
        if (typeof input.question !== 'string' || !input.question.trim() || input.question.length > 12000 || input.prefix && typeof input.prefix !== 'string') throw new Error("请输入有效的问题与目录范围。");
        const summary = buildRepositorySummary(origin.snapshot, input.prefix ?? '');
        const text = JSON.stringify(summary); const characters = text.length + input.question.length;
        if (characters > 60000) return json(response, 413, { error: "索引摘要超过 60,000 字符，请选择更小的目录。" });
        const id = randomUUID();
        summaryPreviews.set(id, { origin, question: input.question, summary, settingsSignature: digest(JSON.stringify(settings)), expires: Date.now() + 600000 });
        if (summaryPreviews.size > 16) summaryPreviews.delete(summaryPreviews.keys().next().value);
        return json(response, 200, { id, summary, characters });
      }
      const preview = summaryPreviews.get(input.previewId); summaryPreviews.delete(input.previewId);
      if (!preview || preview.origin !== origin || preview.expires < Date.now() || preview.settingsSignature !== digest(JSON.stringify(settings))) throw conflict("摘要预览已失效，请重新查看。");
      const controller = new AbortController(); const operation = aiOperations.begin(origin.snapshot.workspaceId ?? origin.snapshot.id, controller);
      const timer = setTimeout(() => controller.abort(), modelTimeoutMs); response.on('close', () => controller.abort());
      try { const candidates = await retrieveFromSummary(settings, preview.summary, preview.question, controller.signal); if (!operation.isActive() || state.session !== origin) throw conflict("检索已取消或会话已变化。"); return json(response, 200, { candidates: candidates.map(item => ({ ...item, contentHash: origin.snapshot.files.find(file => file.id === item.fileId)?.contentHash ?? '' })) }); }
      finally { clearTimeout(timer); operation.finish(); }
    }),
    route("POST", "/api/ai/generate", async (request, response, url) => {
      const controller = new AbortController();
      let clientCancelled = request.aborted || response.destroyed;
      let timedOut = false;
      let timeout = null;
      const cancelForClient = () => {
        clientCancelled = true;
        controller.abort();
      };
      const cancelForTimeout = () => {
        timedOut = true;
        controller.abort();
      };
      const ensureActive = () => {
        if (!controller.signal.aborted && (!generationOperation || generationOperation.isActive())) return;
        const error = new Error(timedOut ? "模型请求超时或已取消。" : "模型请求已取消。");
        error.name = "AbortError";
        throw error;
      };
      request.once("aborted", cancelForClient);
      response.once("close", () => {
        if (!response.writableEnded) cancelForClient();
      });
      let aiTelemetry;
      let aiOutcome = "error";
      let aiCached = false;
      let generationOperation;
      let emit;
      try {
        const input = parseRequest(await body(request), AiGenerationRequestSchema, "AI 生成请求");
        ensureActive();
        const preview = previews.get(input.previewId);
        if (!preview || preview.used) return json(response, 409, { error: "发送确认已失效或已使用，请重新预览。" });
        // Claim the confirmation before the first asynchronous verification.
        preview.used = true;
        const originSession = state.session;
        generationOperation = aiOperations.begin(originSession.snapshot.workspaceId ?? preview.repositoryId, controller);
        aiTelemetry = operationRecorder.start("ai.generate", { repositoryId: preview.repositoryId, mode: preview.mode });
        await refreshPreviewRepository(preview);
        ensureActive();
        const context = contextFromPreview(preview);
        const stream = request.headers.accept?.includes("text/event-stream") === true;
        let shownAnswer = "";
        if (stream) {
          response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
          response.flushHeaders();
          emit = (event, allowAborted = false) => {
            if (!allowAborted) ensureActive();
            response.write(`data: ${JSON.stringify(AiStreamEventSchema.parse({ requestId: input.previewId, repositoryId: context.repositoryId, revision: context.revision, ...event }))}\n\n`);
          };
          emit({ type: "status", status: "generating" });
        }
        const streamOptions = stream && context.mode === "question" && input.stream !== false ? { stream: true, onAnswer: (answer) => {
          if (answer.startsWith(shownAnswer)) emit({ type: "text", text: answer.slice(shownAnswer.length) });
          else emit({ type: "replace", text: answer });
          shownAnswer = answer;
        } } : {};
        const respond = async (result, cached) => {
          ensureActive();
          const envelope = createAiGenerationEnvelope(result, context, cached);
          if (input.chat) {
            ensureActive();
            const completion = buildAiChatCompletion(context, result, input.chat);
            const persisted = await runPersistence(() => workspaceStore.commitAiChatCompletion(generationOperation.workspaceId, input.chat.conversationId, completion.messages, completion.artifacts, generationOperation.isActive, { repositoryId: originSession.snapshot.id, workspaceId: generationOperation.workspaceId, persistenceSessionId: originSession.snapshot.persistenceSessionId }));
            ensureActive();
            envelope.chatPersisted = persisted.persisted;
            if (persisted.routePersisted !== undefined) envelope.routePersisted = persisted.routePersisted;
            if (persisted.warning) envelope.warning = persisted.warning;
          }
          if (!cached && envelope.chatPersisted !== false) generationOperation.cache(key, result);
          if (emit) { emit({ type: "complete", result: AiGenerationEnvelopeSchema.parse(envelope) }); response.end(); return; }
          return validatedJson(response, 200, envelope, AiGenerationEnvelopeSchema, "AI 生成");
        };
        const key = digest(JSON.stringify([AI_PROMPT_VERSION, context.baseUrl, context.model, digest(context.apiKey), context.mode, context.conversation === true, context.entryFileId, context.goal ?? null, context.refinement ?? null, context.question ?? null, context.history ?? [], context.sources.map((source) => [source.fileId, source.contentHash, source.startLine, source.endLine])]));
        const cachedResult = generationOperation.getCached(key);
        if (cachedResult !== undefined) {
          const result = validateAiResult(cachedResult, context);
          ensureActive();
          aiOutcome = "ok";
          aiCached = true;
          return await respond(result, true);
        }

        timeout = setTimeout(cancelForTimeout, modelTimeoutMs);
        timeout.unref?.();
        ensureActive();
        let raw; let result; let needsRepair = false;
        try { raw = await requestChatCompletion(context, context.mode, controller.signal, false, fetch, streamOptions); emit?.({ type: "status", status: "validating" }); result = validateAiResult(raw, context); }
        catch (error) {
          if (error.name === "AbortError") {
            if (clientCancelled) throw error;
            throw new Error("模型请求超时或已取消。");
          }
          if (error instanceof ModelRedirectError) throw error;
          if (error.code) throw error;
          if (error instanceof SyntaxError || /格式|引用|源码/.test(error.message)) needsRepair = true;
          else throw error;
        }
        ensureActive();
        if (needsRepair) {
          ensureActive();
          emit?.({ type: "replace", text: "" });
          shownAnswer = "";
          emit?.({ type: "status", status: "repairing" });
          raw = await requestChatCompletion(context, context.mode, controller.signal, true, fetch, streamOptions);
          result = validateAiResult(raw, context);
        }
        ensureActive();
        // A confirmed chat owns immutable source text in memory. Switching to a
        // different repository releases its checkout but does not cancel this job.
        // If the originating session is still open, retain the final source check.
        const originatingSessionIsOpen = () => state.session?.persistenceSessionId === originSession.persistenceSessionId
          && state.session?.snapshot.id === originSession.snapshot.id
          && (state.session?.snapshot.workspaceId ?? state.session?.snapshot.id) === (originSession.snapshot.workspaceId ?? originSession.snapshot.id);
        if (!input.chat || originatingSessionIsOpen()) await refreshPreviewRepository(context);
        ensureActive();
        if ((!input.chat || originatingSessionIsOpen()) && (!state.session || state.session.snapshot.id !== context.repositoryId || state.session.snapshot.revision !== context.revision)) throw conflict("生成期间仓库内容发生变化，结果已丢弃。");
        ensureActive();
        aiOutcome = "ok";
        return await respond(result, false);
      } catch (error) {
        if (emit && !response.destroyed && !response.writableEnded) {
          // Error events must still be sent after a model timeout aborted its controller.
          const event = { type: "error", error: error instanceof Error ? error.message : "模型请求失败。", code: error.code };
          emit(event, true);
          response.end(); return;
        }
        throw error;
      } finally {
        if (aiTelemetry) aiTelemetry.finish(controller.signal.aborted ? "cancelled" : aiOutcome, { cached: aiCached });
        clearTimeout(timeout);
        generationOperation?.finish();
        request.off("aborted", cancelForClient);
      }
    }),
    route("POST", ["/api/ai/preview","/api/ai/question/preview"], async (request, response, url) => {
      const input = url.pathname === "/api/ai/question/preview"
        ? { ...parseRequest(await body(request), AiQuestionPreviewRequestSchema, "AI 问答预览请求"), mode: "question" }
        : parseRequest(await body(request), AiPreviewRequestSchema, "AI 预览请求");
      const value = buildPreview(input);
      const parsed = AiPreviewResponseSchema.safeParse(value);
      if (!parsed.success) return json(response, 500, { error: "AI 预览响应未通过本地数据校验。" });
      return json(response, value.scopeRequired ? 413 : 200, value);
    }),
  ];
}
