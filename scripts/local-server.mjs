import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { watch } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanRepository } from "../data/localRepository.mjs";
import { cleanupGitHubRepository, cleanupPendingGitHubContent, parseGitHubRepositoryUrl, prepareGitHubRepository } from "../data/githubRepository.mjs";
import { createAiGenerationEnvelope } from "../data/ai-contract.mjs";
import { createRepositoryCommandRegistry } from "../data/repository-command.mjs";
import { createWorkspaceStore } from "../data/workspace-store.mjs";
import { z } from "zod";

const port = Number(process.env.REPOLENS_PORT ?? 4318);
const uiPort = Number(process.env.REPOLENS_UI_PORT ?? 5173);
const workspaceDirectory = process.env.REPOLENS_USER_DATA_PATH
  ?? (process.platform === "win32" ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "RepoLens") : path.join(os.homedir(), ".local", "share", "repolens"));
const workspaceStore = createWorkspaceStore(workspaceDirectory);
const modelTimeoutMs = Math.max(100, Number(process.env.REPOLENS_AI_TIMEOUT_MS ?? 45_000));
const allowedOrigins = new Set([`http://127.0.0.1:${uiPort}`, `http://localhost:${uiPort}`, "http://127.0.0.1:8787", "http://localhost:8787", ...(process.env.REPOLENS_ALLOWED_ORIGINS ?? "").split(",").filter(Boolean)]);
let session = null;
let watcher = null;
let debounceTimer = null;
let pollTimer = null;
let pendingChangedPaths = new Set();
let pendingVerifyScan = false;
let scanQueue = Promise.resolve();
const subscribers = new Set();
const previews = new Map();
let sessionGeneration = 0;
const repositoryCommands = createRepositoryCommandRegistry();
const pendingOpenByClient = new Map();
const pendingOpenOperations = new Set();
const closeOperations = new Map();
// Ownership survives snapshot replacement and a failed directory removal.
const ownedWorkspaces = new Map();
function ownWorkspace(workspace, command) {
  ownedWorkspaces.set(workspace.storageRoot, { workspace, command });
}
async function cleanOwnedWorkspace(workspace) {
  if (!workspace) return true;
  const record = ownedWorkspaces.get(workspace.storageRoot);
  const cleaned = await cleanupGitHubRepository(workspace);
  if (cleaned !== false && ownedWorkspaces.get(workspace.storageRoot) === record) ownedWorkspaces.delete(workspace.storageRoot);
  return cleaned !== false;
}
const sequenceHistory = new Map();
const githubOperations = new Set();
let githubRescanQueue = Promise.resolve();
const settings = { baseUrl: process.env.REPOLENS_AI_BASE_URL ?? "", model: process.env.REPOLENS_AI_MODEL ?? "", apiKey: process.env.REPOLENS_AI_API_KEY ?? "" };
const cache = new Map();
const AI_PROMPT_VERSION = "prompt-v3";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const json = (response, status, value) => { response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); response.end(JSON.stringify(value)); };
function snapshotView() {
  if (!session) return null;
  return { ...session.snapshot, files: session.snapshot.files.map(({ ...file }) => { delete file.source; return file; }) };
}
function attachGitHubMetadata(value, workspace, previousSnapshot = null) {
  const snapshot = value.snapshot;
  const id = `github-${digest(`${workspace.origin.owner.toLowerCase()}/${workspace.origin.repository.toLowerCase()}`).slice(0, 32)}`;
  snapshot.id = id;
  snapshot.name = workspace.origin.repository;
  snapshot.description = `GitHub 静态索引 · ${workspace.origin.url} · ${workspace.origin.commit.slice(0, 12)}`;
  snapshot.source = "local";
  snapshot.origin = workspace.origin;
  snapshot.revision = digest(`${snapshot.revision}\0${workspace.origin.commit}`);
  if (previousSnapshot?.id === id && previousSnapshot.revision === snapshot.revision) snapshot.sequence = previousSnapshot.sequence ?? snapshot.sequence;
  value.githubWorkspace = workspace;
  return value;
}
function publish() {
  const value = JSON.stringify({ repositoryId: session?.snapshot.id, revision: session?.snapshot.revision, sequence: session?.snapshot.sequence ?? 0 });
  for (const subscriber of subscribers) if (subscriber.repositoryId === session?.snapshot.id) subscriber.response.write(`event: revision\ndata: ${value}\n\n`);
}
function trackSequence(value) {
  const id = value.snapshot.id;
  const previous = sequenceHistory.get(id);
  if (previous) value.snapshot.sequence = Math.max(value.snapshot.sequence ?? 1, previous.sequence + Number(previous.revision !== value.snapshot.revision));
  sequenceHistory.set(id, { revision: value.snapshot.revision, sequence: value.snapshot.sequence ?? 1 });
  return value;
}
function updateSession(value) {
  const isSameRepository = session?.snapshot.id === value.snapshot.id;
  const owner = isSameRepository
    ? { ownerClientId: session.ownerClientId, ownerIntentSequence: session.ownerIntentSequence }
    : {};
  const githubWorkspace = value.githubWorkspace ?? (isSameRepository ? session.githubWorkspace : undefined);
  session = trackSequence({ ...value, ...owner, ...(githubWorkspace ? { githubWorkspace } : {}) });
  return session;
}
function beginGitHubOperation(repositoryId, generation) {
  let finish;
  const operation = { repositoryId, generation, ownerClientId: session?.ownerClientId, ownerIntentSequence: session?.ownerIntentSequence, controller: new AbortController(), done: new Promise((resolve) => { finish = resolve; }), finish };
  operation.finish = finish;
  githubOperations.add(operation);
  return operation;
}
function enqueueGitHubRescan(operation, task) {
  const result = githubRescanQueue.catch(() => {}).then(async () => {
    if (operation.controller.signal.aborted || operation.generation !== sessionGeneration || session?.snapshot.id !== operation.repositoryId) {
      throw conflict("仓库操作已结束，请重新扫描。");
    }
    return task();
  });
  githubRescanQueue = result.catch(() => {});
  return result;
}
async function cancelGitHubOperations(repositoryId) {
  const active = [...githubOperations].filter((operation) => repositoryId === undefined || operation.repositoryId === repositoryId);
  for (const operation of active) operation.controller.abort();
  await Promise.all(active.map((operation) => operation.done));
}
function stopWatching() { if (watcher) watcher.close(); watcher = null; clearTimeout(debounceTimer); clearInterval(pollTimer); debounceTimer = null; pollTimer = null; pendingChangedPaths.clear(); pendingVerifyScan = false; }
function enqueueScan(root, generation, fallbackPrevious = null, options = {}) {
  const task = scanQueue.catch(() => {}).then(async () => {
    if (generation !== sessionGeneration) throw conflict("扫描结果已过期，请重新扫描。");
    const previous = session?.root === root ? session : fallbackPrevious?.root === root ? fallbackPrevious : null;
    const next = await scanRepository(root, previous, options);
    if (generation !== sessionGeneration) throw conflict("扫描结果已过期，请重新扫描。");
    return next;
  });
  scanQueue = task.catch(() => {});
  return task;
}
function enqueueOpenScan(root, operation) {
  const task = scanQueue.catch(() => {}).then(async () => {
    if (operation.cancelled || !repositoryCommands.isCurrent(operation.command, "open")) throw conflict("仓库打开请求已被更新请求取代。");
    let scanRoot = root;
    let workspace = null;
    if (parseGitHubRepositoryUrl(root)) {
      workspace = await prepareGitHubRepository(root, null, {
        signal: operation.controller.signal,
        onWorkspace: (allocated) => { operation.githubWorkspace = allocated; ownWorkspace(allocated, operation.command); },
      });
      operation.githubWorkspace = workspace;
      scanRoot = workspace.root;
    }
    const previous = !workspace && session?.root === path.resolve(scanRoot) ? session : null;
    let next = await scanRepository(scanRoot, previous);
    if (workspace) next = attachGitHubMetadata(next, workspace);
    if (operation.cancelled || !repositoryCommands.isCurrent(operation.command, "open")) throw conflict("仓库打开请求已被更新请求取代。");
    return next;
  });
  scanQueue = task.catch(() => {});
  return task;
}
function startWatching() {
  stopWatching();
  if (session?.githubWorkspace) return;
  const generation = sessionGeneration;
  const update = (_eventType, filename) => {
    if (filename && session?.root) {
      const relative = Buffer.isBuffer(filename) ? filename.toString() : String(filename);
      const normalized = relative.replaceAll("\\", "/").replace(/^\.\//, "");
      if (/\.(?:tsx?|jsx?|mts|cts|mjs|cjs|css|scss|sass|less|pyi?|go)$/i.test(normalized)) pendingChangedPaths.add(normalized);
      else pendingVerifyScan = true;
    } else pendingVerifyScan = true;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const mode = !pendingVerifyScan && pendingChangedPaths.size > 0 ? "incremental" : "verify";
      const changedPaths = [...pendingChangedPaths];
      pendingChangedPaths = new Set(); pendingVerifyScan = false;
      enqueueScan(session?.root, generation, null, { mode, changedPaths }).then(async (next) => {
        if (!session || generation !== sessionGeneration) return;
        if (generation === sessionGeneration && next.snapshot.revision !== session.snapshot.revision) { updateSession(next); invalidatePreviews(); publish(); }
      }).catch((error) => { for (const subscriber of subscribers) if (subscriber.repositoryId === session?.snapshot.id) subscriber.response.write(`event: diagnostic\ndata: ${JSON.stringify({ message: error.message })}\n\n`); });
    }, 300);
  };
  try { watcher = watch(session.root, { recursive: true }, update); watcher.on("error", () => { if (watcher) watcher.close(); watcher = null; pollTimer = setInterval(update, 2500); }); }
  catch { pollTimer = setInterval(update, 2500); }
}
async function body(request) {
  let text = "";
  for await (const chunk of request) { text += chunk; if (text.length > 2_000_000) throw new Error("请求过大。"); }
  return text ? JSON.parse(text) : {};
}
const SourceRefSchema = z.object({ fileId: z.string().min(1), startLine: z.number().int().positive(), endLine: z.number().int().positive().optional() }).strict();
const ExplanationSchema = z.object({ role: z.string().min(1), keyPoints: z.array(z.string()), references: z.array(SourceRefSchema).min(1) }).strict();
const RouteSchema = z.object({ title: z.string().min(1), steps: z.array(z.object({ fileId: z.string().min(1), purpose: z.string().min(1), references: z.array(SourceRefSchema).min(1) }).strict()).min(3).max(7) }).strict();
const QuestionAnswerSchema = z.object({ answer: z.string().min(1), insufficientEvidence: z.boolean(), references: z.array(SourceRefSchema) }).strict().superRefine((value, context) => {
  if (value.insufficientEvidence && value.references.length) context.addIssue({ code: "custom", message: "insufficientEvidence answers cannot claim source citations" });
  if (!value.insufficientEvidence && value.references.length === 0) context.addIssue({ code: "custom", message: "source-based answers require references" });
});
function safeSource(fileId, expectedRepositoryId) {
  if (!session || session.snapshot.id !== expectedRepositoryId) return undefined;
  return session.files.has(fileId) ? session.sourceCache.get(fileId) : undefined;
}
function invalidatePreviews() { previews.clear(); }
function conflict(message) { const error = new Error(message); error.status = 409; return error; }
function collectCandidates(fileId, mode) {
  const file = session?.files.get(fileId);
  if (!file) throw new Error("目标文件已不存在，请重新选择文件。");
  const selected = new Set([fileId]);
  if (mode === "explanation") for (const edge of session.snapshot.dependencies.filter((edge) => edge.fromId === fileId)) selected.add(edge.toId);
  else {
    const queue = [fileId];
    while (queue.length) {
      const id = queue.shift();
      for (const edge of session.snapshot.dependencies.filter((item) => item.fromId === id)) if (!selected.has(edge.toId)) { selected.add(edge.toId); queue.push(edge.toId); }
    }
  }
  return [...selected].sort((a, b) => a.localeCompare(b));
}
function collectQuestionCandidates(fileId, question) {
  if (!session?.files.has(fileId)) throw new Error("目标文件已不存在，请重新选择文件。");
  const tokens = [...new Set((String(question).match(/[A-Za-z_][\w./-]{1,}|[\u4e00-\u9fff]{2,}/g) ?? []).map((token) => token.toLowerCase()))].slice(0, 80);
  const direct = new Set([fileId, ...session.snapshot.dependencies.filter((edge) => edge.fromId === fileId || edge.toId === fileId).flatMap((edge) => [edge.fromId, edge.toId])]);
  const scored = session.snapshot.files.map((file) => {
    const searchable = `${file.path} ${file.role ?? ""} ${file.summary ?? ""} ${(file.symbols ?? []).join(" ")}`.toLowerCase();
    let score = file.id === fileId ? 8 : direct.has(file.id) ? 3 : 0;
    for (const token of tokens) {
      if (searchable.includes(token)) score += 7;
      const source = session.sourceCache.get(file.id) ?? "";
      const sourceHits = source.toLowerCase().split(token).length - 1;
      if (sourceHits) score += Math.min(sourceHits, 4);
    }
    return { id: file.id, score };
  });
  const matched = scored.some((item) => item.score > (item.id === fileId ? 8 : direct.has(item.id) ? 3 : 0));
  scored.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  return { ids: scored.map((item) => item.id), retrievalInsufficient: !tokens.length || !matched };
}
function selectedContext(fileIds, candidateIds, entryFileId, ranges = {}, requireEntry = true) {
  const allowed = new Set(candidateIds);
  if (!Array.isArray(fileIds) || (requireEntry && !fileIds.includes(entryFileId)) || fileIds.some((id) => !allowed.has(id))) throw new Error("选择范围已变化，请重新预览。");
  const sources = [...new Set(fileIds)].sort((a, b) => a.localeCompare(b)).map((fileId) => {
    const fullSource = session.sourceCache.get(fileId);
    if (fullSource === undefined) throw new Error("预览中的文件已不存在，请重新选择。");
    const lines = fullSource.split("\n");
    const requestedRange = ranges[fileId] ?? { startLine: 1, endLine: lines.length };
    const startLine = requestedRange.startLine; const endLine = requestedRange.endLine;
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine > lines.length) throw new Error(`文件 ${fileId} 的行范围无效。`);
    return { fileId, source: lines.slice(startLine - 1, endLine).join("\n"), contentHash: digest(fullSource), startLine, endLine };
  });
  const characters = sources.reduce((sum, item) => sum + item.source.length, 0);
  return { sources, characters };
}
function buildPreview(input) {
  if (!session || input.repositoryId !== session.snapshot.id || !["explanation", "route", "question"].includes(input.mode)) throw new Error("仓库或生成类型无效。");
  if (!settings.baseUrl || !settings.model || !settings.apiKey) throw new Error("请先配置完整的本地模型服务、模型名称和密钥。预览不会发送源码。");
  if (input.mode === "question" && (!String(input.question ?? "").trim() || String(input.question).length > 12_000)) throw new Error("请输入不超过 12,000 字符的问题。");
  const retrieval = input.mode === "question" ? collectQuestionCandidates(input.fileId, input.question) : null;
  const candidates = (retrieval?.ids ?? collectCandidates(input.fileId, input.mode)).filter((fileId) => !input.scopePrefix || fileId.startsWith(`${input.scopePrefix}/`));
  if (input.mode !== "question" && !candidates.includes(input.fileId)) throw new Error("所选目录不包含当前入口文件，请调整图谱目录范围。");
  if (input.mode === "question" && candidates.length === 0) throw new Error("仓库中没有可用于回答的源码文件。");
  const questionHistory = input.mode === "question" ? input.history ?? [] : [];
  if (!Array.isArray(questionHistory) || questionHistory.length > 6 || questionHistory.some((item) => !item || !["user", "assistant"].includes(item.role) || typeof item.content !== "string" || item.content.length > 12_000)) throw new Error("问答历史格式无效，请重新选择对话内容。");
  const requested = input.fileIds ?? (input.mode === "question" ? candidates.slice(0, 12) : candidates);
  const context = selectedContext(requested, candidates, input.fileId, input.ranges, input.mode !== "question");
  const historyCharacters = questionHistory.reduce((sum, item) => sum + item.content.length, 0);
  const totalCharacters = context.characters + (input.mode === "question" ? String(input.question).length + historyCharacters : 0);
  const tooMany = context.sources.length > 12 || totalCharacters > 60_000 || (input.mode === "question" && !input.fileIds && candidates.length > 12) || (input.mode === "question" && retrieval.retrievalInsufficient && !input.fileIds);
  if (tooMany) {
    return { scopeRequired: true, candidates: candidates.map((fileId) => { const lines = (session.sourceCache.get(fileId) ?? "").split("\n"); return { fileId, characters: lines.join("\n").length, lineCount: lines.length, oversizedLines: lines.flatMap((line, index) => line.length > 60_000 ? [index + 1] : []) }; }), maxFiles: 12, maxCharacters: 60_000, ...(retrieval ? { retrievalInsufficient: retrieval.retrievalInsufficient } : {}) };
  }
  const preview = { id: randomUUID(), repositoryId: session.snapshot.id, revision: session.snapshot.revision, sequence: session.snapshot.sequence, entryFileId: input.fileId, mode: input.mode, baseUrl: settings.baseUrl, model: settings.model, apiKeyHash: digest(settings.apiKey), sources: context.sources, characters: totalCharacters, expiresAt: Date.now() + 10 * 60_000, used: false, ...(input.mode === "question" ? { question: String(input.question).trim(), history: questionHistory, retrievalInsufficient: retrieval.retrievalInsufficient } : {}) };
  previews.set(preview.id, preview);
  while (previews.size > 50) previews.delete(previews.keys().next().value);
  return { scopeRequired: false, preview: { id: preview.id, repositoryId: preview.repositoryId, revision: preview.revision, entryFileId: preview.entryFileId, mode: preview.mode, baseUrl: preview.baseUrl, model: preview.model, files: preview.sources.map(({ fileId, startLine, endLine, contentHash }) => ({ fileId, startLine, endLine, contentHash })), characters: preview.characters, expiresAt: preview.expiresAt, ...(preview.mode === "question" ? { question: preview.question, history: preview.history, retrievalInsufficient: preview.retrievalInsufficient } : {}) } };
}
function contextFromPreview(preview) {
  if (!session || preview.expiresAt < Date.now() || preview.repositoryId !== session.snapshot.id || preview.revision !== session.snapshot.revision || preview.baseUrl !== settings.baseUrl || preview.model !== settings.model || preview.apiKeyHash !== digest(settings.apiKey)) throw new Error("仓库或模型配置已变化，必须重新确认发送范围。");
  for (const source of preview.sources) if (digest(session.sourceCache.get(source.fileId) ?? "") !== source.contentHash) throw new Error("预览中的源码已变化，必须重新确认发送范围。");
  return { ...preview, apiKey: settings.apiKey };
}
function validateAiResult(value, preview) {
  const parsed = (preview.mode === "route" ? RouteSchema : preview.mode === "question" ? QuestionAnswerSchema : ExplanationSchema).safeParse(value);
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
async function refreshPreviewRepository(preview) {
  if (!session || session.snapshot.id !== preview.repositoryId) throw conflict("当前仓库已切换，请重新预览发送范围。");
  const generation = sessionGeneration;
  const nextRaw = await enqueueScan(session.root, generation, session, { mode: "verify" });
  if (generation !== sessionGeneration || session?.snapshot.id !== preview.repositoryId) throw conflict("当前仓库已切换，请重新预览发送范围。");
  const current = session;
  const next = current.githubWorkspace
    ? attachGitHubMetadata(nextRaw, current.githubWorkspace, current.snapshot)
    : nextRaw;
  if (next.snapshot.revision !== current.snapshot.revision) {
    updateSession(next);
    invalidatePreviews();
    publish();
    throw conflict("仓库内容已变化，请重新确认发送范围。");
  }
}
async function callModel(context, mode, signal, repair = false) {
  if (!context.baseUrl || !context.model || !context.apiKey) throw new Error("请先在本地服务配置模型地址、模型名称和 API 密钥。");
  const configured = new URL(context.baseUrl);
  const pathname = configured.pathname.replace(/\/+$/, "");
  configured.pathname = /\/chat\/completions$/i.test(pathname) ? pathname : `${pathname}${/\/v1$/i.test(pathname) ? "" : "/v1"}/chat/completions`;
  const url = configured.toString();
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
    ? [systemMessage, ...context.history.map((item) => ({ role: item.role, content: item.content })), { role: "user", content: `${taskMetadata}\n${repairText}${modeText}\n仓库快照: ${context.revision}\n\n发送范围：\n${lines}` }]
    : [systemMessage, { role: "user", content: `${taskMetadata}\n${repairText}${modeText}\n仓库快照: ${context.revision}\n\n${lines}` }];
  const response = await fetch(url, { method: "POST", signal, headers: { Authorization: `Bearer ${context.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: context.model, temperature: 0.2, messages }) });
  if (!response.ok) throw new Error(`模型服务返回 ${response.status}。`);
  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("模型服务未返回文本结果。");
  return JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, ""));
}

const server = createServer(async (request, response) => {
  const origin = request.headers.origin;
  const host = request.headers.host ?? "";
  let hostAllowed = false;
  try { const parsedHost = new URL(`http://${host}`); hostAllowed = ["127.0.0.1", "localhost"].includes(parsedHost.hostname) && Number(parsedHost.port || 80) === port; } catch {}
  if (!hostAllowed) return json(response, 403, { error: "只允许通过本机 RepoLens 地址访问。" });
  if (origin && !allowedOrigins.has(origin)) return json(response, 403, { error: "只允许 RepoLens 本地页面访问。" });
  const healthRequest = request.method === "GET" && request.url?.startsWith("/api/health");
  if (!healthRequest && !origin) return json(response, 403, { error: "本地页面来源校验失败。" });
  if (origin) { response.setHeader("Access-Control-Allow-Origin", origin); response.setHeader("Vary", "Origin"); }
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (request.method === "OPTIONS") { response.writeHead(204); return response.end(); }
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  try {
    if (request.method === "GET" && url.pathname === "/api/health") return json(response, 200, { ok: true });
    if (request.method === "GET" && url.pathname === "/api/workspace") {
      const repositoryId = url.searchParams.get("repositoryId");
      if (!repositoryId || repositoryId.length > 160) return json(response, 400, { error: "工作区编号无效。" });
      return json(response, 200, await workspaceStore.getRepository(repositoryId));
    }
    if (request.method === "POST" && url.pathname === "/api/workspace") {
      const input = await body(request);
      if (typeof input.repositoryId !== "string" || input.repositoryId.length > 160) return json(response, 400, { error: "工作区编号无效。" });
      const { repositoryId } = input;
      let result;
      if (input.action === "recent-touch") {
        if (!session || session.snapshot.id !== repositoryId) return json(response, 409, { error: "只有当前已打开的仓库可以加入最近记录。" });
        const originInfo = session.snapshot.origin?.kind === "github" ? session.snapshot.origin : null;
        result = await workspaceStore.touchRecent({
          id: repositoryId,
          name: session.snapshot.name,
          location: originInfo?.url ?? session.root,
          kind: originInfo ? "github" : "local",
          ...(originInfo ? { requestedRef: originInfo.requestedRef, resolvedRef: originInfo.resolvedRef, commit: originInfo.commit, subdirectory: originInfo.subdirectory } : {}),
        });
      } else if (input.action === "recent-remove") {
        result = await workspaceStore.removeRecent(repositoryId);
      } else if (input.action === "progress") {
        result = await workspaceStore.saveProgress(repositoryId, input.key, input.value);
      } else if (input.action === "node-positions" || input.action === "ai-result" || input.action === "ai-route" || input.action === "conversations") {
        const sampleWorkspace = repositoryId === "taskflow-sample" && input.action === "node-positions";
        if (!sampleWorkspace && (!session || session.snapshot.id !== repositoryId)) return json(response, 409, { error: "当前仓库会话已变化，保存请求已丢弃。" });
        if (input.action === "node-positions") result = await workspaceStore.saveNodePositions(repositoryId, input.positions);
        else if (input.action === "ai-result") result = await workspaceStore.saveAiResult(repositoryId, input.fileId, input.record);
        else if (input.action === "ai-route") result = await workspaceStore.saveAiRoute(repositoryId, input.record);
        else result = await workspaceStore.saveConversations(repositoryId, input.conversations);
      } else if (input.action === "clear-all") {
        result = await workspaceStore.clearAll();
      } else if (input.action === "clear-repository") {
        result = await workspaceStore.clearRepository(repositoryId);
      } else return json(response, 400, { error: "工作区操作类型无效。" });
      return json(response, 200, { ok: result.persisted, warning: result.warning });
    }
    if (request.method === "GET" && url.pathname === "/api/snapshot") {
      if (!session || url.searchParams.get("repositoryId") !== session.snapshot.id) return json(response, 409, { error: "仓库会话已变化，请重新打开。" });
      return json(response, 200, snapshotView());
    }
    if (request.method === "POST" && url.pathname === "/api/open") {
      const input = await body(request);
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
        const previousSession = session;
        if (previousSession?.snapshot.id) await cancelGitHubOperations(previousSession.snapshot.id);
        if (operation.cancelled || !repositoryCommands.isCurrent(operation.command, "open")) return json(response, 409, { error: "仓库打开请求已被更新请求取代。" });
        ++sessionGeneration; stopWatching(); invalidatePreviews();
        session = trackSequence({ ...next, ownerClientId: input.command.clientId, ownerIntentSequence: input.command.intentSequence });
        operation.committed = true;
        startWatching();
        if (previousSession?.githubWorkspace && previousSession.githubWorkspace.storageRoot !== session.githubWorkspace?.storageRoot) await cleanOwnedWorkspace(previousSession.githubWorkspace);
        return json(response, 200, snapshotView());
      } finally {
        if (!operation.committed && operation.githubWorkspace) await cleanOwnedWorkspace(operation.githubWorkspace);
        if (pendingOpenByClient.get(input.command.clientId) === operation) pendingOpenByClient.delete(input.command.clientId);
        pendingOpenOperations.delete(operation);
        operation.finish();
      }
    }
    if (request.method === "POST" && url.pathname === "/api/rescan") {
      const input = await body(request);
      if (!session || input.repositoryId !== session.snapshot.id) return json(response, 409, { error: "仓库会话已变化，请重新打开。" });
      const generation = sessionGeneration;
      if (session.githubWorkspace) {
        const previousSession = session;
        const operation = beginGitHubOperation(previousSession.snapshot.id, generation);
        response.on("close", () => { if (!response.writableEnded) operation.controller.abort(); });
        try {
          const outcome = await enqueueGitHubRescan(operation, async () => {
            let nextWorkspace = null;
            try {
              nextWorkspace = await prepareGitHubRepository(previousSession.githubWorkspace.input, previousSession.githubWorkspace, { signal: operation.controller.signal });
              const next = attachGitHubMetadata(await scanRepository(nextWorkspace.root), nextWorkspace, previousSession.snapshot);
              if (operation.controller.signal.aborted || generation !== sessionGeneration || session?.snapshot.id !== input.repositoryId) {
                await cleanupGitHubRepository({ ...nextWorkspace, storageRoot: nextWorkspace.checkoutRoot });
                return { status: 409, value: { error: "重扫结果已过期，请重新扫描。" } };
              }
              if (next.snapshot.revision !== session.snapshot.revision) {
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
          return json(response, outcome.status, outcome.value);
        }
        finally { githubOperations.delete(operation); operation.finish(); }
      }
      const next = await enqueueScan(session.root, generation, session);
      if (generation !== sessionGeneration || session?.snapshot.id !== input.repositoryId) {
        return json(response, 409, { error: "重扫结果已过期，请重新扫描。" });
      }
      if (next.snapshot.revision !== session.snapshot.revision) {
        updateSession(next); invalidatePreviews(); publish();
      }
      return json(response, 200, snapshotView());
    }
    if (request.method === "POST" && url.pathname === "/api/close") {
      const input = await body(request);
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
      if (session?.ownerClientId === command.clientId && session.ownerIntentSequence < command.intentSequence) {
        const closedId = session.snapshot.id;
        ++sessionGeneration; stopWatching(); session = null; invalidatePreviews(); cache.clear();
        // End only subscriptions captured from the old session, before any await.
        for (const subscriber of subscribers) if (subscriber.repositoryId === closedId) {
          subscriber.response.write(`event: diagnostic\ndata: ${JSON.stringify({ message: "仓库索引已关闭。" })}\n\n`); subscriber.response.end();
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
      return json(response, result.status, result.value);
    }
    if (request.method === "GET" && url.pathname === "/api/source") {
      const repositoryId = url.searchParams.get("repositoryId");
      if (!session || repositoryId !== session.snapshot.id) return json(response, 409, { error: "仓库会话已变化，请重新打开。" });
      if (!url.searchParams.get("revision")) return json(response, 400, { error: "源码请求必须包含当前修订号。" });
      if (url.searchParams.get("revision") !== session.snapshot.revision) return json(response, 409, { error: "源码已更新，请重新读取。" });
      const source = safeSource(url.searchParams.get("file"), repositoryId);
      return source === undefined ? json(response, 404, { error: "文件不存在。" }) : json(response, 200, { source, repositoryId, revision: session.snapshot.revision });
    }
    if (request.method === "GET" && url.pathname === "/api/events") {
      const repositoryId = url.searchParams.get("repositoryId");
      if (!session || repositoryId !== session.snapshot.id) return json(response, 409, { error: "仓库会话已变化，请重新打开。" });
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "Access-Control-Allow-Origin": origin, Vary: "Origin" });
      response.write("retry: 1500\n\n"); subscribers.add({ response, repositoryId });
      response.write(`event: revision\ndata: ${JSON.stringify({ repositoryId, revision: session.snapshot.revision, sequence: session.snapshot.sequence })}\n\n`);
      request.on("close", () => { for (const subscriber of subscribers) if (subscriber.response === response) subscribers.delete(subscriber); }); return;
    }
    if (request.method === "GET" && url.pathname === "/api/ai/settings") return json(response, 200, { baseUrl: settings.baseUrl, model: settings.model, configured: Boolean(settings.baseUrl && settings.model && settings.apiKey) });
    if (request.method === "POST" && url.pathname === "/api/ai/settings") {
      const input = await body(request);
      const baseUrl = String(input.baseUrl ?? "").trim();
      if (baseUrl) { const parsed = new URL(baseUrl); if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("模型地址须为不含账号信息的 HTTP(S) 服务地址。"); }
      const serviceChanged = baseUrl !== settings.baseUrl || String(input.model ?? "").trim() !== settings.model;
      settings.baseUrl = baseUrl; settings.model = String(input.model ?? "").trim();
      if (typeof input.apiKey === "string" && input.apiKey) settings.apiKey = input.apiKey;
      else if (input.clearKey || serviceChanged) settings.apiKey = "";
      invalidatePreviews();
      return json(response, 200, { baseUrl: settings.baseUrl, model: settings.model, configured: Boolean(settings.baseUrl && settings.model && settings.apiKey) });
    }
    if (request.method === "POST" && url.pathname === "/api/ai/generate") {
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
        if (!controller.signal.aborted) return;
        const error = new Error(timedOut ? "模型请求超时或已取消。" : "模型请求已取消。");
        error.name = "AbortError";
        throw error;
      };
      request.once("aborted", cancelForClient);
      response.once("close", () => {
        if (!response.writableEnded) cancelForClient();
      });
      try {
        const input = await body(request);
        ensureActive();
        const preview = previews.get(input.previewId);
        if (!preview || preview.used) return json(response, 409, { error: "发送确认已失效或已使用，请重新预览。" });
        // Claim the confirmation before the first asynchronous verification.
        preview.used = true;
        await refreshPreviewRepository(preview);
        ensureActive();
        const context = contextFromPreview(preview);
        const key = digest(JSON.stringify([AI_PROMPT_VERSION, context.baseUrl, context.model, digest(context.apiKey), context.mode, context.entryFileId, context.question ?? null, context.history ?? [], context.sources.map((source) => [source.fileId, source.contentHash, source.startLine, source.endLine])]));
        if (cache.has(key)) {
          const result = validateAiResult(cache.get(key), context);
          ensureActive();
          return json(response, 200, createAiGenerationEnvelope(result, context, true));
        }

        timeout = setTimeout(cancelForTimeout, modelTimeoutMs);
        timeout.unref?.();
        ensureActive();
        let raw; let result; let needsRepair = false;
        try { raw = await callModel(context, context.mode, controller.signal); result = validateAiResult(raw, context); }
        catch (error) {
          if (error.name === "AbortError") {
            if (clientCancelled) throw error;
            throw new Error("模型请求超时或已取消。");
          }
          if (error instanceof SyntaxError || /格式|引用|源码/.test(error.message)) needsRepair = true;
          else throw error;
        }
        ensureActive();
        if (needsRepair) {
          ensureActive();
          raw = await callModel(context, context.mode, controller.signal, true);
          result = validateAiResult(raw, context);
        }
        ensureActive();
        await refreshPreviewRepository(context);
        ensureActive();
        if (!session || session.snapshot.id !== context.repositoryId || session.snapshot.revision !== context.revision) throw new Error("生成期间仓库内容发生变化，结果已丢弃。");
        cache.set(key, result);
        if (cache.size > 50) cache.delete(cache.keys().next().value);
        ensureActive();
        return json(response, 200, createAiGenerationEnvelope(result, context, false));
      } finally {
        clearTimeout(timeout);
        request.off("aborted", cancelForClient);
      }
    }
    if (request.method === "POST" && (url.pathname === "/api/ai/preview" || url.pathname === "/api/ai/question/preview")) {
      const input = await body(request);
      if (url.pathname === "/api/ai/question/preview") input.mode = "question";
      const value = buildPreview(input);
      return json(response, value.scopeRequired ? 413 : 200, value);
    }
    return json(response, 404, { error: "接口不存在。" });
  } catch (error) {
    if (response.destroyed || response.writableEnded) return;
    return json(response, error?.status ?? 400, { error: error instanceof Error ? error.message : "本地服务发生错误。" });
  }
});
server.listen(port, "127.0.0.1", () => process.stdout.write(`RepoLens 本地服务已启动: http://127.0.0.1:${port}\n`));
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopWatching(); invalidatePreviews();
  const openingOperations = [...pendingOpenOperations];
  const activeGitHubOperations = [...githubOperations];
  for (const operation of openingOperations) operation.cancel();
  for (const operation of activeGitHubOperations) operation.controller.abort();
  const cleanup = (async () => {
    await Promise.allSettled([
    ...openingOperations.map((operation) => operation.done),
    ...activeGitHubOperations.map((operation) => operation.done),
    ...[...closeOperations.values()].map(operation => operation.done),
    ]);
    const results = await Promise.allSettled([
      ...[...ownedWorkspaces.values()].map(record => cleanOwnedWorkspace(record.workspace)),
      cleanupPendingGitHubContent(),
    ]);
    return results.every((result) => result.status === "fulfilled" && result.value !== false);
  })();
  for (const subscriber of subscribers) { subscriber.response.end(); }
  subscribers.clear();
  const forceExit = setTimeout(() => process.exit(1), 15_000);
  forceExit.unref();
  server.close(() => { void cleanup.then((cleaned) => { clearTimeout(forceExit); process.exit(cleaned ? 0 : 1); }, () => { clearTimeout(forceExit); process.exit(1); }); });
  server.closeAllConnections();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("message", (message) => { if (message?.type === "shutdown") shutdown(); });
