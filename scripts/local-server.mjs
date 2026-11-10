import { allowsNoKey } from "../data/model-check.mjs";
import { createClearCoordinator } from "../data/clear-coordinator.mjs";
import { createAiOperationScope } from "../data/ai-operation-scope.mjs";
import { resolveEditorTarget } from "../data/editor-target.mjs";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { watch } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanRepository } from "../data/localRepository.mjs";
import { cleanupGitHubRepository, cleanupPendingGitHubContent, parseGitHubRepositoryUrl, prepareGitHubRepository } from "../data/githubRepository.mjs";
import { collectAiCandidates, questionCandidateIds, rankGoalCandidates, prepareAiContext, prepareConversationContext } from "../data/ai-context.mjs";
import { rankQuestionCandidates, rankInvestigationCandidates } from "../data/question-retrieval.mjs";
import { estimateTokens } from "../data/token-estimate.mjs";
import { createRepositoryCommandRegistry } from "../data/repository-command.mjs";
import { createWorkspaceStore } from "../data/workspace-store.mjs";
import { readJsonRequestBody, sendJson, validateLocalRequest } from "../data/local-http.mjs";
import { createSerialTaskQueue } from "../data/serial-task-queue.mjs";
import { createOperationRecorder } from "../data/operation-log.mjs";
import { RepositoryDiagnosticEventSchema, RepositoryRevisionEventSchema } from "../data/local-contracts.mjs";
import { createRepositoryRoutes } from "./server/repository-routes.mjs";
import { createWorkspaceRoutes } from "./server/workspace-routes.mjs";
import { createReadingRoutes } from "./server/reading-routes.mjs";
import { createComparisonRoutes } from "./server/comparison-routes.mjs";
import { createGenerationRoutes } from "./server/generation-routes.mjs";
import { createModelSettingsRoutes } from "./server/model-settings-routes.mjs";
import { createRouteTable, route } from "./server/route-table.mjs";

const port = Number(process.env.REPOLENS_PORT ?? 4318);
let boundPort = port;
const uiPort = Number(process.env.REPOLENS_UI_PORT ?? 5173);
const workspaceDirectory = process.env.REPOLENS_USER_DATA_PATH
  ?? (process.platform === "win32" ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "RepoLens") : path.join(os.homedir(), ".local", "share", "repolens"));
const workspaceStore = createWorkspaceStore(workspaceDirectory);
const aiOperations = createAiOperationScope();
const activePersistence = new Set();
const state = { session: null, sessionGeneration: 0, clearingCount: 0 };
let shuttingDown = false;
function runPersistence(work) {
  const pending = Promise.resolve().then(work);
  activePersistence.add(pending);
  const remove = () => activePersistence.delete(pending);
  void pending.then(remove, remove);
  return pending;
}
const modelTimeoutMs = Math.max(100, Number(process.env.REPOLENS_AI_TIMEOUT_MS ?? 45_000));
const allowedOrigins = new Set([`http://127.0.0.1:${uiPort}`, `http://localhost:${uiPort}`, "http://127.0.0.1:8787", "http://localhost:8787", ...(process.env.REPOLENS_ALLOWED_ORIGINS ?? "").split(",").filter(Boolean)]);
let watcher = null;
let debounceTimer = null;
let pollTimer = null;
let pendingChangedPaths = new Set();
let pendingVerifyScan = false;
const scanQueue = createSerialTaskQueue();
const subscribers = new Set();
const summaryPreviews = new Map();
const previews = new Map();
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
const settings = { authMode: process.env.REPOLENS_AI_AUTH_MODE ?? "key", baseUrl: process.env.REPOLENS_AI_BASE_URL ?? "", model: process.env.REPOLENS_AI_MODEL ?? "", apiKey: process.env.REPOLENS_AI_API_KEY ?? "" };
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
  const current = state.session;
  try {
    const target = await resolveEditorTarget(current, message.input);
    if (state.session !== current) throw new Error("仓库会话已变化，请重新打开源码。");
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

const clearCoordinator = createClearCoordinator({ store: workspaceStore,
  beforeClear: workspaceId => { invalidatePreviews(); return aiOperations.clear(workspaceId); },
  deleteModel: async () => { await persistModelSettings(null); Object.assign(settings, { baseUrl: "", model: "", apiKey: "" }); invalidatePreviews(); },
});
const digest = (value) => createHash("sha256").update(value).digest("hex");
const json = sendJson;
const shutdownMessage = "本地服务正在关闭，请重新打开 RepoLens 后重试。";
async function body(request) {
  const value = await readJsonRequestBody(request);
  if (shuttingDown) throw Object.assign(new Error(shutdownMessage), { status: 503 });
  return value;
}
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
  if (!state.session) return null;
  return { ...state.session.snapshot, files: state.session.snapshot.files.map(({ ...file }) => { delete file.source; return file; }) };
}
function matchesPersistenceSession(input) {
  return Boolean(state.session && input.repositoryId === state.session.snapshot.id
    && input.workspaceId === (state.session.snapshot.workspaceId ?? state.session.snapshot.id)
    && input.persistenceSessionId === state.session.persistenceSessionId);
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
  const value = { repositoryId: state.session?.snapshot.id, revision: state.session?.snapshot.revision, sequence: state.session?.snapshot.sequence ?? 0 };
  for (const subscriber of subscribers) if (subscriber.repositoryId === state.session?.snapshot.id) writeEvent(subscriber.response, "revision", value);
}
function trackSequence(value) {
  const id = value.snapshot.id;
  const previous = sequenceHistory.get(id);
  if (previous) value.snapshot.sequence = Math.max(value.snapshot.sequence ?? 1, previous.sequence + Number(previous.revision !== value.snapshot.revision));
  sequenceHistory.set(id, { revision: value.snapshot.revision, sequence: value.snapshot.sequence ?? 1 });
  return value;
}
function updateSession(value) {
  const isSameRepository = state.session?.snapshot.id === value.snapshot.id;
  const owner = isSameRepository
    ? { ownerClientId: state.session.ownerClientId, ownerIntentSequence: state.session.ownerIntentSequence }
    : {};
  const githubWorkspace = value.githubWorkspace ?? (isSameRepository ? state.session.githubWorkspace : undefined);
  const persistenceSessionId = isSameRepository ? state.session.persistenceSessionId : value.persistenceSessionId;
  if (persistenceSessionId) value.snapshot.persistenceSessionId = persistenceSessionId;
  state.session = trackSequence({ ...value, ...owner, persistenceSessionId, ...(githubWorkspace ? { githubWorkspace } : {}) });
  return state.session;
}
function beginGitHubOperation(repositoryId, generation) {
  let finish;
  const operation = { repositoryId, generation, ownerClientId: state.session?.ownerClientId, ownerIntentSequence: state.session?.ownerIntentSequence, controller: new AbortController(), done: new Promise((resolve) => { finish = resolve; }), finish };
  operation.finish = finish;
  githubOperations.add(operation);
  return operation;
}
function enqueueGitHubRescan(operation, task) {
  return githubRescanQueue.enqueue(async () => {
    if (operation.controller.signal.aborted || operation.generation !== state.sessionGeneration || state.session?.snapshot.id !== operation.repositoryId) {
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
    if (generation !== state.sessionGeneration) throw conflict("扫描结果已过期，请重新扫描。");
    const previous = state.session?.root === root ? state.session : fallbackPrevious?.root === root ? fallbackPrevious : null;
    const telemetry = operationRecorder.start("repository.scan", { repositoryId: previous?.snapshot.id ?? state.session?.snapshot.id ?? "", mode: options.mode ?? "verify" });
    let next;
    try {
      next = await scanRepository(root, previous, options);
      telemetry.finish("ok", { fileCount: next.snapshot.files.length, dependencyCount: next.snapshot.dependencies.length, sourceReadCount: next.stats.sourceReadCount, sourceParseCount: next.stats.sourceParseCount, configParseCount: next.stats.configParseCount });
    } catch (error) {
      telemetry.finish(error?.name === "AbortError" ? "cancelled" : "error");
      throw error;
    }
    if (generation !== state.sessionGeneration) throw conflict("扫描结果已过期，请重新扫描。");
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
      const previous = !workspace && state.session?.root === path.resolve(scanRoot) ? state.session : null;
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
  if (state.session?.githubWorkspace) return;
  const generation = state.sessionGeneration;
  const update = (_eventType, filename) => {
    if (filename && state.session?.root) {
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
      enqueueScan(state.session?.root, generation, null, { mode, changedPaths }).then(async (next) => {
        if (!state.session || generation !== state.sessionGeneration) return;
        if (generation === state.sessionGeneration && next.snapshot.revision !== state.session.snapshot.revision) { updateSession(next); invalidatePreviews(); publish(); }
      }).catch((error) => { for (const subscriber of subscribers) if (subscriber.repositoryId === state.session?.snapshot.id) writeEvent(subscriber.response, "diagnostic", { message: error.message }); });
    }, 300);
  };
  try { watcher = watch(state.session.root, { recursive: true }, update); watcher.on("error", () => { if (watcher) watcher.close(); watcher = null; pollTimer = setInterval(update, 2500); }); }
  catch { pollTimer = setInterval(update, 2500); }
}
function safeSource(fileId, expectedRepositoryId) {
  if (!state.session || state.session.snapshot.id !== expectedRepositoryId) return undefined;
  return state.session.files.has(fileId) ? state.session.sourceCache.get(fileId) : undefined;
}
function invalidatePreviews() { previews.clear(); summaryPreviews.clear(); }
function conflict(message) { const error = new Error(message); error.status = 409; return error; }
function collectQuestionCandidates(fileId, question) {
  if (!state.session?.files.has(fileId)) throw new Error("目标文件已不存在，请重新选择文件。");
  return rankQuestionCandidates({ files: state.session.snapshot.files, dependencies: state.session.snapshot.dependencies, sourceById: state.session.sourceCache, entryFileId: fileId, question });
}
function buildPreview(input) {
  const questionLike = input.mode === "question" || input.mode === "investigation";
  if (!state.session || input.repositoryId !== state.session.snapshot.id || !["explanation", "route", "question", "investigation"].includes(input.mode)) throw new Error("仓库或生成类型无效。");
  if (!settings.baseUrl || !settings.model || (!settings.apiKey && !(settings.authMode === "none" && allowsNoKey(settings.baseUrl)))) throw new Error("请先填写模型服务地址、模型名称和 API 密钥。预览不会发送源码。");
  if (questionLike && (!String(input.question ?? "").trim() || String(input.question).length > 12_000)) throw new Error("请输入不超过 12,000 字符的问题。");
  if (input.mode === "route" && String(input.goal ?? "").length > 300) throw new Error("导览目标不能超过 300 个字符。");
  const conversation = input.mode === "question" && input.conversation === true;
  const sourceFreeConversation = conversation && (input.fileIds?.length === 0 || input.fileIds === undefined && state.session.snapshot.files.length === 0);
  const lastQuestion = input.history?.filter(item => item.role === "user").at(-1)?.content;
  const retrievalQuestion = conversation && lastQuestion && /继续|详细|展开|举.*例|为什么|它|刚才|上面|\b(?:continue|more|why|that|example)\b/i.test(input.question) ? `${lastQuestion}\n${input.question}` : input.question;
  const retrieval = sourceFreeConversation ? { candidates: [], retrievalInsufficient: true, searchSuggestions: [] } : input.mode === "investigation" ? rankInvestigationCandidates({ files: state.session.snapshot.files, dependencies: state.session.snapshot.dependencies, sourceById: state.session.sourceCache, question: input.question, excludedFileIds: input.excludedFileIds }) : questionLike ? collectQuestionCandidates(input.fileId, retrievalQuestion) : null;
  if (input.mode === "investigation") {
    const excluded = new Set(input.excludedFileIds ?? []);
    retrieval.candidates = retrieval.candidates.filter(candidate => !excluded.has(candidate.id));
    if (input.fileIds?.some(id => excluded.has(id))) throw new Error("发送范围包含已排除的文件，请重新选择。");
  }
  const goalRetrieval = input.mode === "route" && String(input.goal ?? "").trim()
    ? rankGoalCandidates(state.session.snapshot, input.fileId, String(input.goal).trim(), state.session.sourceCache)
    : null;
  const questionCandidates = !sourceFreeConversation && retrieval && input.fileIds ? questionCandidateIds(state.session.snapshot, input.mode === "investigation" ? "" : input.fileId, input.question, state.session.sourceCache, input.fileIds) : null;
  const rankedContextCandidates = retrieval?.candidates ?? goalRetrieval?.candidates ?? null;
  const candidates = (questionCandidates?.candidates ?? rankedContextCandidates?.map((candidate) => candidate.id) ?? collectAiCandidates(state.session.snapshot, input.fileId, input.mode)).filter((fileId) => (!input.scopePrefix || fileId.startsWith(`${input.scopePrefix}/`)) && !(input.excludedFileIds ?? []).includes(fileId));
  if (!questionLike && !candidates.includes(input.fileId)) throw new Error("所选目录不包含当前入口文件，请调整图谱目录范围。");
  if (questionLike && !conversation && candidates.length === 0) throw new Error("仓库中没有可用于回答的源码文件。");
  const questionHistory = input.mode === "question" ? input.history ?? [] : [];
  if (!Array.isArray(questionHistory) || questionHistory.length > 6 || questionHistory.some((item) => !item || !["user", "assistant"].includes(item.role) || typeof item.content !== "string" || item.content.length > (conversation ? 60_000 : 12_000))) throw new Error("问答历史格式无效，请重新选择对话内容。");
  const requested = input.fileIds ?? (questionLike ? candidates.slice(0, 12) : goalRetrieval ? goalRetrieval.selectedFileIds.filter((fileId) => candidates.includes(fileId)) : candidates);
  const selected = (conversation ? prepareConversationContext : prepareAiContext)({ candidates, rankedCandidates: rankedContextCandidates ?? [], fileIds: input.fileIds ?? (questionLike ? undefined : requested), ranges: input.ranges, sourceById: state.session.sourceCache, entryFileId: input.fileId, requireEntry: !questionLike, question: input.question, history: questionHistory, retrievalInsufficient: retrieval?.retrievalInsufficient, questionLike });
  const context = { ...selected, sources: selected.sources.map((source) => ({ ...source, contentHash: digest(state.session.sourceCache.get(source.fileId) ?? "") })) };
  const refinement = input.refinement;
  if (refinement && (!['route', 'investigation'].includes(input.mode) || typeof refinement !== 'object' || typeof refinement.instruction !== 'string' || !refinement.instruction.trim() || refinement.instruction.length > 12000 || JSON.stringify(refinement).length > 60000)) throw new Error("结果调整内容无效或过长。");
  const totalCharacters = selected.totalCharacters + (refinement ? JSON.stringify(refinement).length : 0);
  if (totalCharacters > 60000 && !selected.blockers.includes('character_limit')) { selected.scopeRequired = true; selected.blockers.push('character_limit'); }
  const tooMany = selected.scopeRequired;
  if (tooMany) {
    return { scopeRequired: true, blockers: selected.blockers, searchSuggestions: retrieval?.searchSuggestions ?? [], candidates: candidates.map((fileId) => { const lines = (state.session.sourceCache.get(fileId) ?? "").split("\n"); const candidate = rankedContextCandidates?.find((item) => item.id === fileId); return { fileId, characters: lines.join("\n").length, lineCount: lines.length, oversizedLines: lines.flatMap((line, index) => line.length > 60_000 ? [index + 1] : []), ...(candidate?.reasons.length ? { reasons: candidate.reasons } : {}), ...(candidate?.suggestedRange ? { suggestedRange: candidate.suggestedRange } : {}), alternativeRanges: candidate?.alternativeRanges ?? [], ...(candidate?.rangeRequired ? { rangeRequired: true } : {}) }; }), maxFiles: 12, maxCharacters: 60_000, ...(retrieval ? { retrievalInsufficient: retrieval.retrievalInsufficient } : {}) };
  }
  const preview = { ...(refinement ? { refinement: structuredClone(refinement) } : {}), excludedFileIds: input.excludedFileIds ?? [], id: randomUUID(), repositoryId: state.session.snapshot.id, revision: state.session.snapshot.revision, sequence: state.session.snapshot.sequence, entryFileId: input.fileId, mode: input.mode, authMode: settings.authMode, ...(conversation ? { conversation: true, ...(selected.contextNotice ? { contextNotice: selected.contextNotice } : {}) } : {}), ...(input.mode === "route" ? { goal: String(input.goal ?? "").trim() } : {}), baseUrl: settings.baseUrl, model: settings.model, apiKeyHash: digest(settings.apiKey), sources: context.sources, characters: totalCharacters, expiresAt: Date.now() + 10 * 60_000, used: false, ...(questionLike ? { question: String(input.question).trim(), history: questionHistory, retrievalInsufficient: retrieval.retrievalInsufficient } : {}) };
  const tokenEstimate = estimateTokens(`${context.sources.map((item) => item.source).join("\n")}\n${questionLike ? `${String(input.question)}\n${questionHistory.map((item) => item.content).join("\n")}` : ""}`);
  const previewFiles = preview.sources.map(({ fileId, startLine, endLine, contentHash }) => {
    const candidateReasons = rankedContextCandidates?.find((candidate) => candidate.id === fileId)?.reasons;
    const reasons = candidateReasons?.length ? candidateReasons : fileId === input.fileId
      ? ["当前选中的入口文件"]
      : state.session.snapshot.dependencies.some((edge) => edge.fromId === input.fileId && edge.toId === fileId)
        ? ["当前文件的直接导入"]
        : input.mode === "route" ? ["从入口沿静态导入关系展开"] : ["经用户确认纳入"];
    return { fileId, startLine, endLine, contentHash, reasons, alternativeRanges: rankedContextCandidates?.find(candidate => candidate.id === fileId)?.alternativeRanges ?? [] };
  });
  preview.selectionReasons = Object.fromEntries(previewFiles.map(file => [file.fileId, file.reasons]));
  previews.set(preview.id, preview);
  while (previews.size > 50) previews.delete(previews.keys().next().value);
  return { scopeRequired: false, preview: { id: preview.id, repositoryId: preview.repositoryId, revision: preview.revision, entryFileId: preview.entryFileId, mode: preview.mode, ...(preview.conversation ? { conversation: true, ...(preview.contextNotice ? { contextNotice: preview.contextNotice } : {}) } : {}), ...(preview.mode === "investigation" ? { excludedFileIds: preview.excludedFileIds } : {}), ...(preview.mode === "route" ? { goal: preview.goal } : {}), baseUrl: preview.baseUrl, model: preview.model, files: previewFiles, characters: preview.characters, tokenEstimate, expiresAt: preview.expiresAt, ...(questionLike ? { question: preview.question, history: preview.history, retrievalInsufficient: preview.retrievalInsufficient } : {}) } };
}
function contextFromPreview(preview) {
  if (!state.session || preview.expiresAt < Date.now() || preview.repositoryId !== state.session.snapshot.id || preview.revision !== state.session.snapshot.revision || preview.baseUrl !== settings.baseUrl || preview.model !== settings.model || preview.apiKeyHash !== digest(settings.apiKey)) throw new Error("仓库或模型配置已变化，必须重新确认发送范围。");
  for (const source of preview.sources) if (digest(state.session.sourceCache.get(source.fileId) ?? "") !== source.contentHash) throw new Error("预览中的源码已变化，必须重新确认发送范围。");
  return { ...preview, authMode: settings.authMode, apiKey: settings.apiKey };
}
async function refreshPreviewRepository(preview) {
  if (!state.session || state.session.snapshot.id !== preview.repositoryId) throw conflict("当前仓库已切换，请重新预览发送范围。");
  const generation = state.sessionGeneration;
  const nextRaw = await enqueueScan(state.session.root, generation, state.session, { mode: "verify" });
  if (generation !== state.sessionGeneration || state.session?.snapshot.id !== preview.repositoryId) throw conflict("当前仓库已切换，请重新预览发送范围。");
  const current = state.session;
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
const routes = createRouteTable([
  ...createRepositoryRoutes({
    aiOperations, attachGitHubMetadata, beginGitHubOperation, body, cancelGitHubOperations,
    cleanOwnedWorkspace, closeOperations, enqueueGitHubRescan, enqueueOpenScan, enqueueScan,
    githubOperations, invalidatePreviews, json, ownedWorkspaces, parseRequest,
    pendingOpenByClient, pendingOpenOperations, publish, repositoryCommands, snapshotView,
    startWatching, state, stopWatching, subscribers, trackSequence,
    updateSession, validatedJson, writeEvent,
  }, route),
  ...createWorkspaceRoutes({
    body, clearCoordinator, digest, json, matchesPersistenceSession,
    operationRecorder, parseRequest, runPersistence, state, validatedJson,
    workspaceStore,
  }, route),
  ...createReadingRoutes({
    body, json, operationRecorder, parseRequest, safeSource,
    state, validatedJson,
  }, route),
  ...createComparisonRoutes({
    beginGitHubOperation, body, enqueueGitHubRescan, githubOperations, json,
    matchesPersistenceSession, operationRecorder, parseRequest, state, validatedJson,
  }, route),
  ...createGenerationRoutes({
    aiOperations, body, buildPreview, conflict, contextFromPreview,
    digest, json, modelTimeoutMs, operationRecorder, parseRequest,
    previews, refreshPreviewRepository, runPersistence, settings, state,
    summaryPreviews, validatedJson, workspaceStore,
  }, route),
  ...createModelSettingsRoutes({
    body, clearCoordinator, invalidatePreviews, parseRequest, persistModelSettings,
    runPersistence, settings, validatedJson,
  }, route),
]);

const server = createServer(async (request, response) => {
  const origin = request.headers.origin;
  const requestPolicy = validateLocalRequest({ host: request.headers.host, origin, method: request.method, url: request.url, port: boundPort, allowedOrigins });
  if (!requestPolicy.allowed) return json(response, requestPolicy.status, { error: requestPolicy.error });
  if (origin) { response.setHeader("Access-Control-Allow-Origin", origin); response.setHeader("Vary", "Origin"); }
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (shuttingDown) return json(response, 503, { error: shutdownMessage });
  if (request.method === "OPTIONS") { response.writeHead(204); return response.end(); }
  const url = new URL(request.url, `http://127.0.0.1:${boundPort}`);
  try {
    if (state.clearingCount && request.method === "POST" && url.pathname.startsWith("/api/ai/")) return json(response, 409, { error: "正在清除保存数据，请完成清除后再操作 AI。" });
    const handler = routes.get(`${request.method} ${url.pathname}`);
    if (handler) return await handler(request, response, url);
    return json(response, 404, { error: "接口不存在。" });
  } catch (error) {
    if (response.destroyed || response.writableEnded) return;
    return json(response, error?.status ?? 400, { error: error instanceof Error ? error.message : "本地服务发生错误。" });
  }
});
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  boundPort = actualPort;
  process.stdout.write(`RepoLens 本地服务已启动: http://127.0.0.1:${actualPort}\n`);
  if (process.connected) {
    process.send({ type: "backend:ready", port: actualPort });
  }
});
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopWatching(); invalidatePreviews();
  const openingOperations = [...pendingOpenOperations];
  const activeGitHubOperations = [...githubOperations];
  for (const operation of openingOperations) operation.cancel();
  for (const operation of activeGitHubOperations) operation.controller.abort();
  const activeAiOperations = aiOperations.clear();
  const cleanup = (async () => {
    await Promise.allSettled([
    activeAiOperations,
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
  const forceExit = setTimeout(() => {
    process.stderr.write("[RepoLens shutdown] 本地服务未能在时限内完成保存与清理。\n");
    process.exit(1);
  }, 15_000);
  const closed = new Promise(resolve => server.close(error => resolve(!error)));
  const drained = Promise.allSettled(activePersistence).then(results => {
    server.closeAllConnections();
    return results.every(result => result.status === "fulfilled" ? result.value?.persisted !== false : result.reason?.name === "AbortError");
  });
  void Promise.all([closed, cleanup, drained]).then(results => {
    clearTimeout(forceExit);
    process.exit(results.every(Boolean) ? 0 : 1);
  }, () => { clearTimeout(forceExit); process.exit(1); });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("message", (message) => { if (message?.type === "shutdown") shutdown(); });
