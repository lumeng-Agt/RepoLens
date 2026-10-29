import { resolveEditorTarget } from "../data/editor-target.mjs";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { watch } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanRepository } from "../data/localRepository.mjs";
import { cleanupGitHubRepository, cleanupPendingGitHubContent, fetchGitHubRevision, parseGitHubRepositoryUrl, prepareGitHubRepository } from "../data/githubRepository.mjs";
import { AiGenerationEnvelopeSchema, AiPreviewResponseSchema, AiStreamEventSchema, createAiGenerationEnvelope } from "../data/ai-contract.mjs";
import { AI_PROMPT_VERSION, ModelRedirectError, requestChatCompletion, validateAiResult } from "../data/ai-generation.mjs";
import { collectAiCandidates, questionCandidateIds, rankGoalCandidates, prepareAiContext } from "../data/ai-context.mjs";
import { rankQuestionCandidates, rankInvestigationCandidates } from "../data/question-retrieval.mjs";
import { estimateTokens } from "../data/token-estimate.mjs";
import { searchRepositoryContent } from "../data/repository-search.mjs";
import { buildRepositoryOverview } from "../data/repository-overview.mjs";
import { compareRepositoryRevisions } from "../data/revision-comparison.mjs";
import { createRepositoryCommandRegistry } from "../data/repository-command.mjs";
import { createWorkspaceStore } from "../data/workspace-store.mjs";
import { buildAiChatCompletion } from "../data/ai-chat-completion.mjs";
import { readJsonRequestBody, sendJson, validateLocalRequest } from "../data/local-http.mjs";
import { createSerialTaskQueue } from "../data/serial-task-queue.mjs";
import { createOperationRecorder } from "../data/operation-log.mjs";
import {
  AiGenerationRequestSchema,
  AiPreviewRequestSchema,
  AiQuestionPreviewRequestSchema,
  AiSettingsRequestSchema,
  AiSettingsResponseSchema,
  LocalHealthResponseSchema,
  LocalWorkspaceStateSchema,
  RepositoryCloseRequestSchema,
  RepositoryDiagnosticEventSchema,
  RepositoryOpenRequestSchema,
  RepositoryRescanRequestSchema,
  RepositoryRevisionEventSchema,
  RepositorySnapshotSchema,
  RevisionFetchRequestSchema,
  RevisionFetchResponseSchema,
  SearchRequestSchema,
  SearchResponseSchema,
  RepositoryOverviewSchema,
  RevisionComparisonRequestSchema,
  RevisionComparisonResponseSchema,
  SourceResponseSchema,
  WorkspaceMutationRequestSchema,
  WorkspaceSaveResponseSchema,
} from "../data/local-contracts.mjs";

const port = Number(process.env.REPOLENS_PORT ?? 4318);
const uiPort = Number(process.env.REPOLENS_UI_PORT ?? 5173);
const workspaceDirectory = process.env.REPOLENS_USER_DATA_PATH
  ?? (process.platform === "win32" ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "RepoLens") : path.join(os.homedir(), ".local", "share", "repolens"));
const workspaceStore = createWorkspaceStore(workspaceDirectory);
const activeChatOperations = new Set();
const modelTimeoutMs = Math.max(100, Number(process.env.REPOLENS_AI_TIMEOUT_MS ?? 45_000));
const allowedOrigins = new Set([`http://127.0.0.1:${uiPort}`, `http://localhost:${uiPort}`, "http://127.0.0.1:8787", "http://localhost:8787", ...(process.env.REPOLENS_ALLOWED_ORIGINS ?? "").split(",").filter(Boolean)]);
let session = null;
let watcher = null;
let debounceTimer = null;
let pollTimer = null;
let pendingChangedPaths = new Set();
let pendingVerifyScan = false;
const scanQueue = createSerialTaskQueue();
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
const githubRescanQueue = createSerialTaskQueue();
const operationRecorder = createOperationRecorder({ onRecord: (record) => process.stdout.write(`[RepoLens operation] ${JSON.stringify(record)}\n`) });
const settings = { baseUrl: process.env.REPOLENS_AI_BASE_URL ?? "", model: process.env.REPOLENS_AI_MODEL ?? "", apiKey: process.env.REPOLENS_AI_API_KEY ?? "" };
let settingsSaveId = 0;
const settingsSaveWaiters = new Map();
async function persistModelSettings(value) {
  if (process.env.REPOLENS_DESKTOP_SETTINGS !== "1") return;
  if (!process.connected) throw new Error("桌面连接已中断，模型配置未保存。");
  return new Promise((resolve, reject) => {
    const id = ++settingsSaveId;
    const timeout = setTimeout(() => { settingsSaveWaiters.delete(id); reject(new Error("保存模型配置超时，请重试。")); }, 5000);
    settingsSaveWaiters.set(id, { resolve, reject, timeout });
    process.send({ type: "model-settings:save", id, settings: value });
  });
}
process.on("message", async (message) => {
  if (message?.type !== "editor:resolve" || !process.connected) return;
  const current = session;
  try {
    const target = await resolveEditorTarget(current, message.input);
    if (session !== current) throw new Error("仓库会话已变化，请重新打开源码。");
    process.send({ type: "editor:resolved", id: message.id, target });
  } catch (error) { process.send({ type: "editor:resolved", id: message.id, error: error.message }); }
});
process.on("message", (message) => {
  if (message?.type !== "model-settings:saved") return;
  const pending = settingsSaveWaiters.get(message.id);
  if (!pending) return;
  clearTimeout(pending.timeout); settingsSaveWaiters.delete(message.id);
  if (message.ok) pending.resolve(); else pending.reject(new Error("无法加密保存模型配置，请重试。"));
});

const cache = new Map();
const digest = (value) => createHash("sha256").update(value).digest("hex");
const json = sendJson;
const body = readJsonRequestBody;
function parseRequest(value, schema, label) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const error = new Error(`${label}格式无效：${parsed.error.issues.map((issue) => issue.path.join(".") || "请求").join("、")}`);
    error.status = 400;
    throw error;
  }
  return parsed.data;
}
function validatedJson(response, status, value, schema, label) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".") || "响应").join("、");
    process.stderr.write(`[RepoLens contract] ${label}响应校验失败：${fields}\n`);
    return json(response, 500, { error: `${label}响应未通过本地数据校验。` });
  }
  return json(response, status, value);
}
function writeEvent(response, type, value) {
  const schema = type === "revision" ? RepositoryRevisionEventSchema : type === "diagnostic" ? RepositoryDiagnosticEventSchema : null;
  const parsed = schema?.safeParse(value);
  if (!parsed?.success) {
    process.stderr.write(`[RepoLens contract] 已拒绝格式无效的 ${type} 事件。\n`);
    return false;
  }
  response.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
  return true;
}
function snapshotView() {
  if (!session) return null;
  return { ...session.snapshot, files: session.snapshot.files.map(({ ...file }) => { delete file.source; return file; }) };
}
function matchesPersistenceSession(input) {
  return Boolean(session && input.repositoryId === session.snapshot.id
    && input.workspaceId === (session.snapshot.workspaceId ?? session.snapshot.id)
    && input.persistenceSessionId === session.persistenceSessionId);
}
function attachGitHubMetadata(value, workspace, previousSnapshot = null) {
  const snapshot = value.snapshot;
  const id = `github-${digest(`${workspace.origin.owner.toLowerCase()}/${workspace.origin.repository.toLowerCase()}`).slice(0, 32)}`;
  snapshot.id = id;
  snapshot.name = workspace.origin.repository;
  snapshot.description = `GitHub 静态索引 · ${workspace.origin.url} · ${workspace.origin.commit.slice(0, 12)}`;
  snapshot.source = "local";
  snapshot.origin = workspace.origin;
  const fixedCommitRef = /^([0-9a-f]{7,64})$/i.test(workspace.origin.resolvedRef) ? workspace.origin.commit : workspace.origin.resolvedRef;
  snapshot.workspaceId = `github-${digest(`${workspace.origin.owner.toLowerCase()}/${workspace.origin.repository.toLowerCase()}\0${fixedCommitRef}`)}`;
  snapshot.revision = digest(`${snapshot.revision}\0${workspace.origin.commit}`);
  if (previousSnapshot?.id === id && previousSnapshot.revision === snapshot.revision) snapshot.sequence = previousSnapshot.sequence ?? snapshot.sequence;
  value.githubWorkspace = workspace;
  return value;
}
function publish() {
  const value = { repositoryId: session?.snapshot.id, revision: session?.snapshot.revision, sequence: session?.snapshot.sequence ?? 0 };
  for (const subscriber of subscribers) if (subscriber.repositoryId === session?.snapshot.id) writeEvent(subscriber.response, "revision", value);
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
  const persistenceSessionId = isSameRepository ? session.persistenceSessionId : value.persistenceSessionId;
  if (persistenceSessionId) value.snapshot.persistenceSessionId = persistenceSessionId;
  session = trackSequence({ ...value, ...owner, persistenceSessionId, ...(githubWorkspace ? { githubWorkspace } : {}) });
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
  return githubRescanQueue.enqueue(async () => {
    if (operation.controller.signal.aborted || operation.generation !== sessionGeneration || session?.snapshot.id !== operation.repositoryId) {
      throw conflict("仓库操作已结束，请重新扫描。");
    }
    return task();
  });
}
async function cancelGitHubOperations(repositoryId) {
  const active = [...githubOperations].filter((operation) => repositoryId === undefined || operation.repositoryId === repositoryId);
  for (const operation of active) operation.controller.abort();
  await Promise.all(active.map((operation) => operation.done));
}
function stopWatching() { if (watcher) watcher.close(); watcher = null; clearTimeout(debounceTimer); clearInterval(pollTimer); debounceTimer = null; pollTimer = null; pendingChangedPaths.clear(); pendingVerifyScan = false; }
function enqueueScan(root, generation, fallbackPrevious = null, options = {}) {
  return scanQueue.enqueue(async () => {
    if (generation !== sessionGeneration) throw conflict("扫描结果已过期，请重新扫描。");
    const previous = session?.root === root ? session : fallbackPrevious?.root === root ? fallbackPrevious : null;
    const telemetry = operationRecorder.start("repository.scan", { repositoryId: previous?.snapshot.id ?? session?.snapshot.id ?? "", mode: options.mode ?? "verify" });
    let next;
    try {
      next = await scanRepository(root, previous, options);
      telemetry.finish("ok", { fileCount: next.snapshot.files.length, dependencyCount: next.snapshot.dependencies.length, sourceReadCount: next.stats.sourceReadCount, sourceParseCount: next.stats.sourceParseCount, configParseCount: next.stats.configParseCount });
    } catch (error) {
      telemetry.finish(error?.name === "AbortError" ? "cancelled" : "error");
      throw error;
    }
    if (generation !== sessionGeneration) throw conflict("扫描结果已过期，请重新扫描。");
    return next;
  });
}
function enqueueOpenScan(root, operation) {
  return scanQueue.enqueue(async () => {
    if (operation.cancelled || !repositoryCommands.isCurrent(operation.command, "open")) throw conflict("仓库打开请求已被更新请求取代。");
    const telemetry = operationRecorder.start(parseGitHubRepositoryUrl(root) ? "github.open" : "repository.open", { sequence: operation.command.intentSequence, mode: "open" });
    let scanRoot = root;
    let workspace = null;
    try {
      if (parseGitHubRepositoryUrl(root)) {
        workspace = await prepareGitHubRepository(root, null, {
          signal: operation.controller.signal,
          onWorkspace: (allocated) => { operation.githubWorkspace = allocated; ownWorkspace(allocated, operation.command); },
        });
        operation.githubWorkspace = workspace;
        scanRoot = workspace.root;
      }
      const previous = !workspace && session?.root === path.resolve(scanRoot) ? session : null;
      const next = await scanRepository(scanRoot, previous);
      if (workspace) attachGitHubMetadata(next, workspace);
      if (operation.cancelled || !repositoryCommands.isCurrent(operation.command, "open")) throw conflict("仓库打开请求已被更新请求取代。");
      telemetry.finish("ok", { fileCount: next.snapshot.files.length, dependencyCount: next.snapshot.dependencies.length });
      return next;
    } catch (error) {
      telemetry.finish(error?.name === "AbortError" ? "cancelled" : "error");
      throw error;
    }
  });
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
      }).catch((error) => { for (const subscriber of subscribers) if (subscriber.repositoryId === session?.snapshot.id) writeEvent(subscriber.response, "diagnostic", { message: error.message }); });
    }, 300);
  };
  try { watcher = watch(session.root, { recursive: true }, update); watcher.on("error", () => { if (watcher) watcher.close(); watcher = null; pollTimer = setInterval(update, 2500); }); }
  catch { pollTimer = setInterval(update, 2500); }
}
function safeSource(fileId, expectedRepositoryId) {
  if (!session || session.snapshot.id !== expectedRepositoryId) return undefined;
  return session.files.has(fileId) ? session.sourceCache.get(fileId) : undefined;
}
function invalidatePreviews() { previews.clear(); }
function conflict(message) { const error = new Error(message); error.status = 409; return error; }
function collectQuestionCandidates(fileId, question) {
  if (!session?.files.has(fileId)) throw new Error("目标文件已不存在，请重新选择文件。");
  return rankQuestionCandidates({ files: session.snapshot.files, dependencies: session.snapshot.dependencies, sourceById: session.sourceCache, entryFileId: fileId, question });
}
function buildPreview(input) {
  const questionLike = input.mode === "question" || input.mode === "investigation";
  if (!session || input.repositoryId !== session.snapshot.id || !["explanation", "route", "question", "investigation"].includes(input.mode)) throw new Error("仓库或生成类型无效。");
  if (!settings.baseUrl || !settings.model || !settings.apiKey) throw new Error("请先填写模型服务地址、模型名称和 API 密钥。预览不会发送源码。");
  if (questionLike && (!String(input.question ?? "").trim() || String(input.question).length > 12_000)) throw new Error("请输入不超过 12,000 字符的问题。");
  if (input.mode === "route" && String(input.goal ?? "").length > 300) throw new Error("导览目标不能超过 300 个字符。");
  const retrieval = input.mode === "investigation" ? rankInvestigationCandidates({ files: session.snapshot.files, dependencies: session.snapshot.dependencies, sourceById: session.sourceCache, question: input.question, excludedFileIds: input.excludedFileIds }) : questionLike ? collectQuestionCandidates(input.fileId, input.question) : null;
  if (input.mode === "investigation") {
    const excluded = new Set(input.excludedFileIds ?? []);
    retrieval.candidates = retrieval.candidates.filter(candidate => !excluded.has(candidate.id));
    if (input.fileIds?.some(id => excluded.has(id))) throw new Error("发送范围包含已排除的文件，请重新选择。");
  }
  const goalRetrieval = input.mode === "route" && String(input.goal ?? "").trim()
    ? rankGoalCandidates(session.snapshot, input.fileId, String(input.goal).trim(), session.sourceCache)
    : null;
  const questionCandidates = retrieval && input.fileIds ? questionCandidateIds(session.snapshot, input.mode === "investigation" ? "" : input.fileId, input.question, session.sourceCache, input.fileIds) : null;
  const rankedContextCandidates = retrieval?.candidates ?? goalRetrieval?.candidates ?? null;
  const candidates = (questionCandidates?.candidates ?? rankedContextCandidates?.map((candidate) => candidate.id) ?? collectAiCandidates(session.snapshot, input.fileId, input.mode)).filter((fileId) => (!input.scopePrefix || fileId.startsWith(`${input.scopePrefix}/`)) && !(input.excludedFileIds ?? []).includes(fileId));
  if (!questionLike && !candidates.includes(input.fileId)) throw new Error("所选目录不包含当前入口文件，请调整图谱目录范围。");
  if (questionLike && candidates.length === 0) throw new Error("仓库中没有可用于回答的源码文件。");
  const questionHistory = input.mode === "question" ? input.history ?? [] : [];
  if (!Array.isArray(questionHistory) || questionHistory.length > 6 || questionHistory.some((item) => !item || !["user", "assistant"].includes(item.role) || typeof item.content !== "string" || item.content.length > 12_000)) throw new Error("问答历史格式无效，请重新选择对话内容。");
  const requested = input.fileIds ?? (questionLike ? candidates.slice(0, 12) : goalRetrieval ? goalRetrieval.selectedFileIds.filter((fileId) => candidates.includes(fileId)) : candidates);
  const selected = prepareAiContext({ candidates, rankedCandidates: rankedContextCandidates ?? [], fileIds: input.fileIds ?? (questionLike ? undefined : requested), ranges: input.ranges, sourceById: session.sourceCache, entryFileId: input.fileId, requireEntry: !questionLike, question: input.question, history: questionHistory, retrievalInsufficient: retrieval?.retrievalInsufficient, questionLike });
  const context = { ...selected, sources: selected.sources.map((source) => ({ ...source, contentHash: digest(session.sourceCache.get(source.fileId) ?? "") })) };
  const totalCharacters = selected.totalCharacters;
  const tooMany = selected.scopeRequired;
  if (tooMany) {
    return { scopeRequired: true, searchSuggestions: retrieval?.searchSuggestions ?? [], candidates: candidates.map((fileId) => { const lines = (session.sourceCache.get(fileId) ?? "").split("\n"); const candidate = rankedContextCandidates?.find((item) => item.id === fileId); return { fileId, characters: lines.join("\n").length, lineCount: lines.length, oversizedLines: lines.flatMap((line, index) => line.length > 60_000 ? [index + 1] : []), ...(candidate?.reasons.length ? { reasons: candidate.reasons } : {}), ...(candidate?.suggestedRange ? { suggestedRange: candidate.suggestedRange } : {}), alternativeRanges: candidate?.alternativeRanges ?? [], ...(candidate?.rangeRequired ? { rangeRequired: true } : {}) }; }), maxFiles: 12, maxCharacters: 60_000, ...(retrieval ? { retrievalInsufficient: retrieval.retrievalInsufficient } : {}) };
  }
  const preview = { excludedFileIds: input.excludedFileIds ?? [], id: randomUUID(), repositoryId: session.snapshot.id, revision: session.snapshot.revision, sequence: session.snapshot.sequence, entryFileId: input.fileId, mode: input.mode, ...(input.mode === "route" ? { goal: String(input.goal ?? "").trim() } : {}), baseUrl: settings.baseUrl, model: settings.model, apiKeyHash: digest(settings.apiKey), sources: context.sources, characters: totalCharacters, expiresAt: Date.now() + 10 * 60_000, used: false, ...(questionLike ? { question: String(input.question).trim(), history: questionHistory, retrievalInsufficient: retrieval.retrievalInsufficient } : {}) };
  const tokenEstimate = estimateTokens(`${context.sources.map((item) => item.source).join("\n")}\n${questionLike ? `${String(input.question)}\n${questionHistory.map((item) => item.content).join("\n")}` : ""}`);
  const previewFiles = preview.sources.map(({ fileId, startLine, endLine, contentHash }) => {
    const candidateReasons = rankedContextCandidates?.find((candidate) => candidate.id === fileId)?.reasons;
    const reasons = candidateReasons?.length ? candidateReasons : fileId === input.fileId
      ? ["当前选中的入口文件"]
      : session.snapshot.dependencies.some((edge) => edge.fromId === input.fileId && edge.toId === fileId)
        ? ["当前文件的直接导入"]
        : input.mode === "route" ? ["从入口沿静态导入关系展开"] : ["经用户确认纳入"];
    return { fileId, startLine, endLine, contentHash, reasons, alternativeRanges: rankedContextCandidates?.find(candidate => candidate.id === fileId)?.alternativeRanges ?? [] };
  });
  preview.selectionReasons = Object.fromEntries(previewFiles.map(file => [file.fileId, file.reasons]));
  previews.set(preview.id, preview);
  while (previews.size > 50) previews.delete(previews.keys().next().value);
  return { scopeRequired: false, preview: { id: preview.id, repositoryId: preview.repositoryId, revision: preview.revision, entryFileId: preview.entryFileId, mode: preview.mode, ...(preview.mode === "investigation" ? { excludedFileIds: preview.excludedFileIds } : {}), ...(preview.mode === "route" ? { goal: preview.goal } : {}), baseUrl: preview.baseUrl, model: preview.model, files: previewFiles, characters: preview.characters, tokenEstimate, expiresAt: preview.expiresAt, ...(questionLike ? { question: preview.question, history: preview.history, retrievalInsufficient: preview.retrievalInsufficient } : {}) } };
}
function contextFromPreview(preview) {
  if (!session || preview.expiresAt < Date.now() || preview.repositoryId !== session.snapshot.id || preview.revision !== session.snapshot.revision || preview.baseUrl !== settings.baseUrl || preview.model !== settings.model || preview.apiKeyHash !== digest(settings.apiKey)) throw new Error("仓库或模型配置已变化，必须重新确认发送范围。");
  for (const source of preview.sources) if (digest(session.sourceCache.get(source.fileId) ?? "") !== source.contentHash) throw new Error("预览中的源码已变化，必须重新确认发送范围。");
  return { ...preview, apiKey: settings.apiKey };
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
const server = createServer(async (request, response) => {
  const origin = request.headers.origin;
  const requestPolicy = validateLocalRequest({ host: request.headers.host, origin, method: request.method, url: request.url, port, allowedOrigins });
  if (!requestPolicy.allowed) return json(response, requestPolicy.status, { error: requestPolicy.error });
  if (origin) { response.setHeader("Access-Control-Allow-Origin", origin); response.setHeader("Vary", "Origin"); }
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (request.method === "OPTIONS") { response.writeHead(204); return response.end(); }
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  try {
    if (request.method === "GET" && url.pathname === "/api/health") return validatedJson(response, 200, { ok: true }, LocalHealthResponseSchema, "健康检查");
    if (request.method === "GET" && url.pathname === "/api/workspace") {
      const repositoryId = url.searchParams.get("repositoryId");
      if (!repositoryId || repositoryId.length > 160) return json(response, 400, { error: "工作区编号无效。" });
      const workspaceId = session?.snapshot.id === repositoryId ? session.snapshot.workspaceId ?? repositoryId : repositoryId;
      return validatedJson(response, 200, await workspaceStore.getRepository(workspaceId), LocalWorkspaceStateSchema, "工作区读取");
    }
    if (request.method === "POST" && url.pathname === "/api/workspace") {
      const input = parseRequest(await body(request), WorkspaceMutationRequestSchema, "工作区操作");
      if (input.repositoryId && input.repositoryId.length > 160) return json(response, 400, { error: "工作区编号无效。" });
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
        const originInfo = session.snapshot.origin?.kind === "github" ? session.snapshot.origin : null;
        const workspaceId = session.snapshot.workspaceId ?? repositoryId;
        const locationRef = originInfo
          ? /^[0-9a-f]{7,64}$/i.test(originInfo.resolvedRef) ? originInfo.commit : originInfo.resolvedRef
          : "";
        const encodedLocationPath = [locationRef, originInfo?.subdirectory].filter(Boolean).flatMap((part) => part.split("/")).map(encodeURIComponent).join("/");
        const location = originInfo && encodedLocationPath
          ? `${originInfo.url}/tree/${encodedLocationPath}`
          : originInfo?.url ?? session.root;
        result = await workspaceStore.touchRecent({
          id: workspaceId,
          targetId: originInfo ? `github-target-${digest(`${originInfo.owner.toLowerCase()}/${originInfo.repository.toLowerCase()}\0${/^([0-9a-f]{7,64})$/i.test(originInfo.resolvedRef) ? originInfo.commit : originInfo.resolvedRef}\0${originInfo.subdirectory}`)}` : workspaceId,
          workspaceId,
          repositoryId,
          name: session.snapshot.name,
          location,
          kind: originInfo ? "github" : "local",
          ...(originInfo ? { requestedRef: originInfo.requestedRef, resolvedRef: originInfo.resolvedRef, commit: originInfo.commit, subdirectory: originInfo.subdirectory } : {}),
        });
      } else if (input.action === "recent-remove") {
        result = await workspaceStore.removeRecent(input.targetId ?? repositoryId);
      } else if (input.action === "progress") {
        const sampleWorkspace = repositoryId === "taskflow-sample";
        if (!sampleWorkspace && !matchesPersistenceSession(input)) return json(response, 409, { error: "仓库会话已变化，阅读进度未保存。" });
        result = await workspaceStore.saveProgress(sampleWorkspace ? repositoryId : session.snapshot.workspaceId ?? repositoryId, input.key, input.value);
      } else if (input.action === "node-positions" || input.action === "ai-result" || input.action === "ai-route" || input.action === "conversations" || input.action === "reading-notes" || input.action === "saved-tours" || input.action === "investigations") {
        const sampleWorkspace = repositoryId === "taskflow-sample";
        if (!sampleWorkspace && !matchesPersistenceSession(input)) return json(response, 409, { error: "当前仓库会话已变化，保存请求已丢弃。" });
        const workspaceId = sampleWorkspace ? repositoryId : session.snapshot.workspaceId ?? repositoryId;
        if (input.action === "node-positions") result = await workspaceStore.saveNodePositions(workspaceId, input.positions);
        else if (input.action === "ai-result") result = await workspaceStore.saveAiResult(workspaceId, input.fileId, input.record);
        else if (input.action === "ai-route") result = await workspaceStore.saveAiRoute(workspaceId, input.record);
        else if (input.action === "conversations") result = await workspaceStore.saveConversations(workspaceId, input.conversations);
        else if (input.action === "investigations") result = await workspaceStore.saveInvestigations(workspaceId, input.records);
        else if (input.action === "reading-notes") result = await workspaceStore.saveReadingNotes(workspaceId, input.notes);
        else result = await workspaceStore.saveTours(workspaceId, input.tours);
      } else if (input.action === "clear-all") {
        for (const operation of activeChatOperations) operation.controller.abort();
        result = await workspaceStore.clearAll();
        if (result.persisted) { await persistModelSettings(null); Object.assign(settings, { baseUrl: "", model: "", apiKey: "" }); invalidatePreviews(); }
      } else if (input.action === "clear-repository") {
        if (!matchesPersistenceSession(input)) return json(response, 409, { error: "仓库会话已变化，保存数据未清除。" });
        for (const operation of activeChatOperations) if (operation.workspaceId === (session.snapshot.workspaceId ?? repositoryId)) operation.controller.abort();
        result = await workspaceStore.clearRepository(session.snapshot.workspaceId ?? repositoryId);
      } else return json(response, 400, { error: "工作区操作类型无效。" });
      return validatedJson(response, 200, { ok: result.persisted, warning: result.warning }, WorkspaceSaveResponseSchema, "工作区保存");
      } finally {
        telemetry.finish(result?.persisted ? "ok" : result ? "error" : "stale", { action: String(input.action ?? "unknown") });
      }
    }
    if (request.method === "GET" && url.pathname === "/api/snapshot") {
      if (!session || url.searchParams.get("repositoryId") !== session.snapshot.id) return json(response, 409, { error: "仓库会话已变化，请重新打开。" });
      return validatedJson(response, 200, snapshotView(), RepositorySnapshotSchema, "仓库快照");
    }
    if (request.method === "POST" && url.pathname === "/api/open") {
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
        const previousSession = session;
        if (previousSession?.snapshot.id) await cancelGitHubOperations(previousSession.snapshot.id);
        if (operation.cancelled || !repositoryCommands.isCurrent(operation.command, "open")) return json(response, 409, { error: "仓库打开请求已被更新请求取代。" });
        ++sessionGeneration; stopWatching(); invalidatePreviews();
        next.snapshot.workspaceId ??= next.snapshot.id;
        const persistenceSessionId = randomUUID();
        next.snapshot.persistenceSessionId = persistenceSessionId;
        session = trackSequence({ ...next, persistenceSessionId, ownerClientId: input.command.clientId, ownerIntentSequence: input.command.intentSequence });
        operation.committed = true;
        startWatching();
        if (previousSession?.githubWorkspace && previousSession.githubWorkspace.storageRoot !== session.githubWorkspace?.storageRoot) await cleanOwnedWorkspace(previousSession.githubWorkspace);
        return validatedJson(response, 200, snapshotView(), RepositorySnapshotSchema, "仓库快照");
      } finally {
        if (!operation.committed && operation.githubWorkspace) await cleanOwnedWorkspace(operation.githubWorkspace);
        if (pendingOpenByClient.get(input.command.clientId) === operation) pendingOpenByClient.delete(input.command.clientId);
        pendingOpenOperations.delete(operation);
        operation.finish();
      }
    }
    if (request.method === "POST" && url.pathname === "/api/rescan") {
      const input = parseRequest(await body(request), RepositoryRescanRequestSchema, "重扫请求");
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
          return outcome.status === 200
            ? validatedJson(response, outcome.status, outcome.value, RepositorySnapshotSchema, "仓库快照")
            : json(response, outcome.status, outcome.value);
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
      return validatedJson(response, 200, snapshotView(), RepositorySnapshotSchema, "仓库快照");
    }
    if (request.method === "POST" && url.pathname === "/api/close") {
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
      if (session?.ownerClientId === command.clientId && session.ownerIntentSequence < command.intentSequence) {
        const closedId = session.snapshot.id;
        ++sessionGeneration; stopWatching(); session = null; invalidatePreviews(); cache.clear();
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
    }
    if (request.method === "GET" && url.pathname === "/api/source") {
      const repositoryId = url.searchParams.get("repositoryId");
      if (!session || repositoryId !== session.snapshot.id) return json(response, 409, { error: "仓库会话已变化，请重新打开。" });
      if (!url.searchParams.get("revision")) return json(response, 400, { error: "源码请求必须包含当前修订号。" });
      if (url.searchParams.get("revision") !== session.snapshot.revision) return json(response, 409, { error: "源码已更新，请重新读取。" });
      const source = safeSource(url.searchParams.get("file"), repositoryId);
      return source === undefined ? json(response, 404, { error: "文件不存在。" }) : validatedJson(response, 200, { source, repositoryId, revision: session.snapshot.revision }, SourceResponseSchema, "源码");
    }
    if (request.method === "POST" && url.pathname === "/api/search") {
      const input = parseRequest(await body(request), SearchRequestSchema, "源码搜索请求");
      if (!session || input.repositoryId !== session.snapshot.id) return json(response, 409, { error: "仓库会话已变化，请重新搜索。" });
      if (input.revision !== session.snapshot.revision) return json(response, 409, { error: "仓库内容已更新，请重新搜索。" });
      const controller = new AbortController();
      response.on("close", () => { if (!response.writableEnded) controller.abort(); });
      const telemetry = operationRecorder.start("repository.search", { repositoryId: input.repositoryId, revision: input.revision, queryLength: input.query.length });
      try {
        const result = await searchRepositoryContent({ files: session.snapshot.files, sourceById: session.sourceCache, input, signal: controller.signal });
        if (controller.signal.aborted || session?.snapshot.id !== input.repositoryId || session.snapshot.revision !== input.revision) return json(response, 409, { error: "仓库已变化，搜索结果已失效。" });
        telemetry.finish("ok", { matches: result.total, files: result.filesSearched });
        return validatedJson(response, 200, result, SearchResponseSchema, "源码搜索");
      } catch (error) {
        telemetry.finish(error?.name === "AbortError" ? "cancelled" : "error", { message: error instanceof Error ? error.message : "搜索失败" });
        throw error;
      }
    }
    if (request.method === "GET" && url.pathname === "/api/overview") {
      const repositoryId = url.searchParams.get("repositoryId");
      const revision = url.searchParams.get("revision");
      if (!session || repositoryId !== session.snapshot.id) return json(response, 409, { error: "仓库会话已变化，请重新载入概览。" });
      if (!revision || revision !== session.snapshot.revision) return json(response, 409, { error: "仓库内容已更新，请重新载入概览。" });
      const value = await buildRepositoryOverview(session.root, session.snapshot);
      if (session?.snapshot.id !== repositoryId || session.snapshot.revision !== revision) return json(response, 409, { error: "仓库已变化，概览结果已失效。" });
      return validatedJson(response, 200, value, RepositoryOverviewSchema, "仓库概览");
    }
    if (request.method === "POST" && url.pathname === "/api/compare/fetch") {
      const input = parseRequest(await body(request), RevisionFetchRequestSchema, "获取 GitHub 版本请求");
      if (!matchesPersistenceSession(input)) return json(response, 409, { error: "仓库会话已变化，请重新打开后再获取版本。" });
      if (input.revision !== session.snapshot.revision) return json(response, 409, { error: "仓库内容已变化，请重新打开获取窗口。" });
      if (!session.githubWorkspace) return json(response, 409, { error: "只有 RepoLens 管理的 GitHub 仓库支持获取历史；本地仓库不会被修改。" });
      const activeSession = session;
      const workspace = activeSession.githubWorkspace;
      const generation = sessionGeneration;
      const operation = beginGitHubOperation(activeSession.snapshot.id, generation);
      response.on("close", () => { if (!response.writableEnded) operation.controller.abort(); });
      const telemetry = operationRecorder.start("github.history.fetch", { repositoryId: activeSession.snapshot.id, targetKind: /^[0-9a-f]{40,64}$/i.test(input.target) ? "commit" : "named-ref" });
      try {
        const outcome = await enqueueGitHubRescan(operation, async () => {
          const fetched = await fetchGitHubRevision(workspace, input.target, { signal: operation.controller.signal });
          if (operation.controller.signal.aborted || generation !== sessionGeneration || session !== activeSession || session.snapshot.revision !== input.revision) {
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
    }
    if (request.method === "POST" && url.pathname === "/api/compare") {
      const input = parseRequest(await body(request), RevisionComparisonRequestSchema, "版本比较请求");
      if (!session || input.repositoryId !== session.snapshot.id) return json(response, 409, { error: "仓库会话已变化，请重新选择比较范围。" });
      if (input.revision !== session.snapshot.revision) return json(response, 409, { error: "仓库内容已变化，请重新运行版本比较。" });
      const controller = new AbortController();
      response.on("close", () => { if (!response.writableEnded) controller.abort(); });
      const telemetry = operationRecorder.start("repository.compare", { repositoryId: input.repositoryId, revision: input.revision, mode: input.mode });
      try {
        const value = await compareRepositoryRevisions({
          root: session.root,
          ...(session.githubWorkspace ? { gitDir: session.githubWorkspace.mirrorPath, currentCommit: session.githubWorkspace.origin.commit } : {}),
          mode: input.mode, baseRef: input.baseRef, headRef: input.headRef, revision: input.revision, signal: controller.signal,
        });
        if (controller.signal.aborted || session?.snapshot.id !== input.repositoryId || session.snapshot.revision !== input.revision) return json(response, 409, { error: "仓库已变化，比较结果已失效。" });
        telemetry.finish("ok", { changedFiles: value.files.length, diffBytes: Buffer.byteLength(value.diff) });
        return validatedJson(response, 200, value, RevisionComparisonResponseSchema, "版本比较");
      } catch (error) {
        telemetry.finish(error?.name === "AbortError" ? "cancelled" : "error", { message: error instanceof Error ? error.message : "比较失败" });
        if (error?.code === "REVISION_OBJECT_MISSING" && session.githubWorkspace) return json(response, 409, { code: error.code, error: error.message });
        throw error;
      }
    }
    if (request.method === "GET" && url.pathname === "/api/events") {
      const repositoryId = url.searchParams.get("repositoryId");
      if (!session || repositoryId !== session.snapshot.id) return json(response, 409, { error: "仓库会话已变化，请重新打开。" });
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "Access-Control-Allow-Origin": origin, Vary: "Origin" });
      response.write("retry: 1500\n\n"); subscribers.add({ response, repositoryId });
      writeEvent(response, "revision", { repositoryId, revision: session.snapshot.revision, sequence: session.snapshot.sequence });
      request.on("close", () => { for (const subscriber of subscribers) if (subscriber.response === response) subscribers.delete(subscriber); }); return;
    }
    if (request.method === "GET" && url.pathname === "/api/ai/settings") return validatedJson(response, 200, { baseUrl: settings.baseUrl, model: settings.model, configured: Boolean(settings.baseUrl && settings.model && settings.apiKey) }, AiSettingsResponseSchema, "模型设置");
    if (request.method === "POST" && url.pathname === "/api/ai/settings") {
      const input = parseRequest(await body(request), AiSettingsRequestSchema, "模型设置请求");
      const baseUrl = String(input.baseUrl ?? "").trim();
      if (baseUrl) { const parsed = new URL(baseUrl); if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("模型地址须为不含账号信息的 HTTP(S) 服务地址。"); }
      const serviceChanged = baseUrl !== settings.baseUrl || String(input.model ?? "").trim() !== settings.model;
      const nextSettings = { baseUrl, model: String(input.model ?? "").trim(), apiKey: typeof input.apiKey === "string" && input.apiKey ? input.apiKey : input.clearKey || serviceChanged ? "" : settings.apiKey };
      await persistModelSettings(nextSettings);
      Object.assign(settings, nextSettings);
      invalidatePreviews();
      return validatedJson(response, 200, { baseUrl: settings.baseUrl, model: settings.model, configured: Boolean(settings.baseUrl && settings.model && settings.apiKey) }, AiSettingsResponseSchema, "模型设置");
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
      let aiTelemetry;
      let aiOutcome = "error";
      let aiCached = false;
      let chatOperation;
      let emit;
      try {
        const input = parseRequest(await body(request), AiGenerationRequestSchema, "AI 生成请求");
        ensureActive();
        const preview = previews.get(input.previewId);
        if (!preview || preview.used) return json(response, 409, { error: "发送确认已失效或已使用，请重新预览。" });
        // Claim the confirmation before the first asynchronous verification.
        preview.used = true;
        const originSession = session;
        if (input.chat) {
          chatOperation = { controller, workspaceId: originSession.snapshot.workspaceId ?? preview.repositoryId };
          activeChatOperations.add(chatOperation);
        }
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
          const envelope = createAiGenerationEnvelope(result, context, cached);
          if (input.chat) {
            ensureActive();
            const completion = buildAiChatCompletion(context, result, input.chat);
            const persisted = await workspaceStore.commitAiChatCompletion(chatOperation.workspaceId, input.chat.conversationId, completion.messages, completion.artifacts, () => !controller.signal.aborted);
            ensureActive();
            envelope.chatPersisted = persisted.persisted;
            if (persisted.warning) envelope.warning = persisted.warning;
          }
          if (emit) { emit({ type: "complete", result: AiGenerationEnvelopeSchema.parse(envelope) }); response.end(); return; }
          return validatedJson(response, 200, envelope, AiGenerationEnvelopeSchema, "AI 生成");
        };
        const key = digest(JSON.stringify([AI_PROMPT_VERSION, context.baseUrl, context.model, digest(context.apiKey), context.mode, context.entryFileId, context.goal ?? null, context.question ?? null, context.history ?? [], context.sources.map((source) => [source.fileId, source.contentHash, source.startLine, source.endLine])]));
        if (cache.has(key)) {
          const result = validateAiResult(cache.get(key), context);
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
        const originatingSessionIsOpen = () => session?.persistenceSessionId === originSession.persistenceSessionId
          && session?.snapshot.id === originSession.snapshot.id
          && (session?.snapshot.workspaceId ?? session?.snapshot.id) === (originSession.snapshot.workspaceId ?? originSession.snapshot.id);
        if (!input.chat || originatingSessionIsOpen()) await refreshPreviewRepository(context);
        ensureActive();
        if ((!input.chat || originatingSessionIsOpen()) && (!session || session.snapshot.id !== context.repositoryId || session.snapshot.revision !== context.revision)) throw conflict("生成期间仓库内容发生变化，结果已丢弃。");
        cache.set(key, result);
        if (cache.size > 50) cache.delete(cache.keys().next().value);
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
        if (chatOperation) activeChatOperations.delete(chatOperation);
        request.off("aborted", cancelForClient);
      }
    }
    if (request.method === "POST" && (url.pathname === "/api/ai/preview" || url.pathname === "/api/ai/question/preview")) {
      const input = url.pathname === "/api/ai/question/preview"
        ? { ...parseRequest(await body(request), AiQuestionPreviewRequestSchema, "AI 问答预览请求"), mode: "question" }
        : parseRequest(await body(request), AiPreviewRequestSchema, "AI 预览请求");
      const value = buildPreview(input);
      const parsed = AiPreviewResponseSchema.safeParse(value);
      if (!parsed.success) return json(response, 500, { error: "AI 预览响应未通过本地数据校验。" });
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
