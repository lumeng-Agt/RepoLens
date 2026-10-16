import { AiExplanationSchema, AiQuestionAnswerSchema, AiRouteSchema } from "./ai-contract.mjs";

export const AI_PROMPT_VERSION = "prompt-v3";

function schemaFor(mode) {
  if (mode === "route") return AiRouteSchema;
  if (mode === "question") return AiQuestionAnswerSchema;
  return AiExplanationSchema;
}

/** Validate model output against both the response contract and the immutable sent-source range. */
export function validateAiResult(value, preview) {
  const parsed = schemaFor(preview.mode).safeParse(value);
  if (!parsed.success) throw new Error("模型返回的内容不符合讲解、路线或问答格式。");
  const sources = new Map(preview.sources.map((source) => [source.fileId, source]));
  const references = preview.mode === "route" ? parsed.data.steps.flatMap((step, index) => {
    if (index === 0 && step.fileId !== preview.entryFileId) throw new Error("阅读路线第一步必须从所选入口文件开始，并引用该文件源码。");
    if (!step.references.some((reference) => reference.fileId === step.fileId)) throw new Error("路线步骤必须引用本步骤对应文件的源码。");
    return step.references;
  }) : parsed.data.references;
  if (preview.mode === "explanation" && !parsed.data.references.some((reference) => reference.fileId === preview.entryFileId)) {
    throw new Error("文件讲解必须引用所选入口文件的源码。");
  }
  if (!references.length && !(preview.mode === "question" && parsed.data.insufficientEvidence)) throw new Error("模型没有返回可用的源码引用。");
  for (const reference of references) {
    const source = sources.get(reference.fileId);
    const endLine = reference.endLine ?? reference.startLine;
    if (!source || reference.startLine < source.startLine || endLine < reference.startLine || endLine > source.endLine) throw new Error("模型返回了发送范围之外或行号无效的源码引用。");
  }
  return parsed.data;
}

export function buildChatCompletionRequest(context, mode, repair = false) {
  const configured = new URL(context.baseUrl);
  const pathname = configured.pathname.replace(/\/+$/, "");
  configured.pathname = /\/chat\/completions$/i.test(pathname) ? pathname : `${pathname}${/\/v1$/i.test(pathname) ? "" : "/v1"}/chat/completions`;
  const lines = context.sources.map(({ fileId, source, startLine, endLine }) => `FILE ${fileId} LINES ${startLine}-${endLine}\n${source}`).join("\n\n");
  const taskMetadata = `任务信息：${JSON.stringify({ promptVersion: AI_PROMPT_VERSION, mode, entryFileId: context.entryFileId })}`;
  const modeText = mode === "route"
    ? `从入口文件 ${context.entryFileId} 开始，按静态依赖关系安排阅读。第一步的 fileId 必须是该入口，且引用它的源码。返回 JSON: {"title":string,"steps":[{"fileId":string,"purpose":string,"references":[{"fileId":string,"startLine":number,"endLine":number}]}]}。steps 需 3 到 7 个，每步都引用本步骤对应文件的源码。`
    : mode === "question"
      ? `回答用户当前问题：${context.question}\n仅依据下面发送的源码片段。若证据不足，明确说明无法从已发送源码判断，返回 insufficientEvidence=true 且 references=[]；否则返回 insufficientEvidence=false，并给出至少一条支持回答的有效引用。JSON 格式：{"answer":string,"insufficientEvidence":boolean,"references":[{"fileId":string,"startLine":number,"endLine":number}]}。不要提出或执行任何操作。`
      : `只讲解入口文件 ${context.entryFileId} 的职责和关键逻辑。references 至少包含一条对该入口文件的有效源码引用。返回 JSON: {"role":string,"keyPoints":[string],"references":[{"fileId":string,"startLine":number,"endLine":number}]}。`;
  const repairText = repair ? "上一次输出没有满足格式、所选入口或源码引用校验。请严格按任务信息和入口约束重新生成；只返回有效 JSON。\n" : "";
  const systemMessage = { role: "system", content: "你是只读代码库导览助手。只依据提供的源码，不推断未发送文件，不给出可执行操作。引用必须使用给定文件路径与真实行号，并遵守用户任务中明确指定的入口文件。仅输出 JSON，不要 Markdown。" };
  const messages = mode === "question"
    ? [systemMessage, ...(context.history ?? []).map((item) => ({ role: item.role, content: item.content })), { role: "user", content: `${taskMetadata}\n${repairText}${modeText}\n仓库快照: ${context.revision}\n\n发送范围：\n${lines}` }]
    : [systemMessage, { role: "user", content: `${taskMetadata}\n${repairText}${modeText}\n仓库快照: ${context.revision}\n\n${lines}` }];
  return {
    url: configured.toString(),
    body: { model: context.model, temperature: 0.2, messages },
  };
}

export async function requestChatCompletion(context, mode, signal, repair = false, fetchImpl = fetch) {
  if (!context.baseUrl || !context.model || !context.apiKey) throw new Error("请先在本地服务配置模型地址、模型名称和 API 密钥。");
  const { url, body } = buildChatCompletionRequest(context, mode, repair);
  const response = await fetchImpl(url, { method: "POST", signal, headers: { Authorization: `Bearer ${context.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`模型服务返回 ${response.status}。`);
  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("模型服务未返回文本结果。");
  return JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, ""));
}
