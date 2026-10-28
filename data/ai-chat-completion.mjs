import { createAiRouteRecord } from "./ai-route.mjs";

// The task and citations come exclusively from the consumed preview and validated
// model output, never from a newly selected file or another repository session.
export function buildAiChatCompletion(context, result, chat) {
  const contextFiles = context.sources.map(({ fileId, contentHash, startLine, endLine }) => ({ fileId, contentHash, startLine, endLine }));
  const prompt = ["question", "investigation"].includes(context.mode) ? context.question : context.mode === "route" ? `生成阅读路线：${context.goal || context.entryFileId}` : `讲解文件：${context.entryFileId}`;
  const route = context.mode === "route" ? createAiRouteRecord({ repositoryId: context.repositoryId, revision: context.revision, entryFileId: context.entryFileId, title: result.title, goal: context.goal, steps: result.steps, contextFiles }) : null;
  const explanation = context.mode === "explanation" ? { ...result, __repositoryId: context.repositoryId, __revision: context.revision, __entryFileId: context.entryFileId, __mode: "explanation", __contextFiles: contextFiles } : null;
  const references = context.mode === "route" ? result.steps.flatMap((step) => step.references) : context.mode === "investigation" ? result.items.flatMap(item => item.references) : result.references ?? [];
  const content = context.mode === "investigation" ? result.summary : context.mode === "question" ? result.answer : context.mode === "route" ? result.title : `${result.role}\n\n${result.keyPoints.join("\n")}`;
  return {
    messages: [
      { id: chat.userMessageId, role: "user", content: prompt, references: [], contextFiles },
      { id: chat.answerMessageId, role: "assistant", content, references, contextFiles, ...(context.mode === "investigation" ? { investigation: result, selectionReasons: context.selectionReasons ?? Object.fromEntries((context.files ?? []).map(file => [file.fileId, file.reasons ?? []])), investigationQuestion: context.question, excludedFileIds: context.excludedFileIds ?? [] } : {}), ...(route ? { route } : {}), ...(explanation ? { explanation } : {}), ...(result.claims ? { claims: result.claims } : {}), ...(result.insufficientEvidence !== undefined ? { insufficientEvidence: result.insufficientEvidence } : {}) },
    ],
    artifacts: { route, explanation },
  };
}
