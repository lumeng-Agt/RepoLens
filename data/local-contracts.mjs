import { z } from "zod";
import { InvestigationSchema, InvestigationResultSchema } from "./investigation.mjs";

const referenceSchema = z.object({ fileId: z.string().min(1), line: z.number().int().positive(), endLine: z.number().int().positive().optional() }).passthrough();
// Language parsers preserve source-level imports before resolution. Python and Go
// records intentionally have no targetPath: the indexer resolves them later into
// dependency edges or unresolved diagnostics.
const importSchema = z.object({
  targetPath: z.string().optional(), specifier: z.string(), resolution: z.enum(["file", "package"]).optional(),
  line: z.number().int().positive().optional(), kind: z.string().optional(),
  members: z.array(z.string()).optional(), alias: z.string().optional(),
}).passthrough();
const fileSchema = z.object({
  id: z.string().min(1), path: z.string(), name: z.string(), kind: z.enum(["typescript", "style", "python", "go"]),
  role: z.string().optional(), summary: z.string().optional(), source: z.string().optional(), language: z.string().optional(),
  contentHash: z.string().optional(), symbols: z.array(z.string()).optional(),
  symbolDetails: z.array(z.object({ name: z.string().min(1), kind: z.enum(["function", "class", "interface", "type", "enum", "method"]), startLine: z.number().int().positive(), endLine: z.number().int().positive() }).passthrough()).optional(),
  imports: z.array(importSchema),
}).passthrough();
const edgeSchema = z.object({
  id: z.string().min(1), fromId: z.string().min(1), toId: z.string().min(1), specifier: z.string(),
  kind: z.enum(["import", "export", "dynamic", "require", "style", "from-import", "package"]).optional(),
  resolution: z.enum(["file", "package"]).optional(), resolutionBasis: z.enum(["relative-path", "config-alias", "typescript-resolution", "python-module", "python-submodule", "go-package-expanded"]).optional(), typeOnly: z.boolean().optional(), reference: referenceSchema,
}).passthrough();
const tourStepSchema = z.object({ id: z.string(), title: z.string(), focusFileId: z.string(), description: z.string(), reference: referenceSchema, relationship: z.string().optional(), question: z.string().optional() }).passthrough();
const githubOriginSchema = z.object({ kind: z.literal("github"), url: z.string(), owner: z.string(), repository: z.string(), requestedRef: z.string(), resolvedRef: z.string(), commit: z.string(), subdirectory: z.string() }).passthrough();

export const RepositorySnapshotSchema = z.object({
  id: z.string().min(1), workspaceId: z.string().optional(), persistenceSessionId: z.string().optional(), version: z.string(),
  name: z.string(), description: z.string(), files: z.array(fileSchema), dependencies: z.array(edgeSchema), tour: z.array(tourStepSchema),
  source: z.enum(["sample", "local"]).optional(), origin: githubOriginSchema.optional(), revision: z.string().optional(), sequence: z.number().int().nonnegative().optional(),
  configPath: z.array(z.string()).optional(), diagnostics: z.array(z.object({ path: z.string().optional(), message: z.string() }).passthrough()).optional(),
  unresolved: z.array(z.object({ fileId: z.string(), specifier: z.string(), line: z.number().int().positive(), kind: z.string(), external: z.boolean() }).passthrough()).optional(),
}).passthrough();

const recentRepositorySchema = z.object({
  id: z.string(), name: z.string(), location: z.string(), kind: z.enum(["local", "github"]), lastOpenedAt: z.number(),
  targetId: z.string().optional(), workspaceId: z.string().optional(), requestedRef: z.string().optional(), resolvedRef: z.string().optional(),
  commit: z.string().optional(), subdirectory: z.string().optional(),
}).passthrough();
export const UsageGuidePreferencesSchema = z.object({
  version: z.literal(1),
  welcomeHandled: z.boolean(),
  completedTaskIds: z.array(z.enum(["source", "dependencies", "tour", "note", "repository"])).max(5),
  checklistOpen: z.boolean(),
  noticeDismissed: z.boolean(),
}).passthrough();
const layoutSharesSchema = z.object({ files: z.number().finite().positive().max(100), graph: z.number().finite().positive().max(100), details: z.number().finite().positive().max(100) }).passthrough();
const readingLayoutSharesSchema = z.object({ files: z.number().finite().positive().max(100), details: z.number().finite().positive().max(100) }).passthrough();
export const WorkspaceLayoutPreferencesSchema = z.object({ version: z.literal(1), structure: layoutSharesSchema, reading: readingLayoutSharesSchema, chatWidth: z.number().finite().min(320).max(800).optional() }).passthrough();
const questionReferenceSchema = z.object({ fileId: z.string(), startLine: z.number().int().positive(), endLine: z.number().int().positive().optional() }).passthrough();
const routeSourceReferenceSchema = z.object({ fileId: z.string(), startLine: z.number().int().positive(), endLine: z.union([z.number().int().positive(), z.null()]).optional() }).passthrough();
const questionMessageSchema = z.object({
  id: z.string(), role: z.enum(["user", "assistant"]), content: z.string(),
  references: z.array(questionReferenceSchema).default([]),
  contextFiles: z.array(z.object({ fileId: z.string(), contentHash: z.string(), startLine: z.number().int().positive().optional(), endLine: z.number().int().positive().optional() }).passthrough()).default([]),
  investigation: InvestigationResultSchema.optional(), investigationQuestion: z.string().optional(), excludedFileIds: z.array(z.string()).optional(), selectionReasons: z.record(z.string(), z.array(z.string())).optional(),
  claims: z.array(z.object({ text: z.string(), referenceIndices: z.array(z.number().int().nonnegative()) }).passthrough()).optional(),
  insufficientEvidence: z.boolean().optional(), stale: z.boolean().optional(),
}).passthrough();
const conversationSchema = z.object({ id: z.string(), title: z.string(), messages: z.array(questionMessageSchema), updatedAt: z.number() }).passthrough();
const readingNoteSchema = z.object({ id: z.string(), fileId: z.string(), path: z.string(), startLine: z.number().int().positive(), endLine: z.number().int().positive().optional(), text: z.string().max(20_000), contentHash: z.string(), commit: z.string().optional(), createdAt: z.number(), stale: z.boolean().optional(), kind: z.enum(["note", "bookmark", "question"]) }).passthrough();
const savedAiResultSchema = z.object({
  __repositoryId: z.string().optional(), __entryFileId: z.string().optional(), __revision: z.string().optional(),
  __mode: z.enum(["explanation", "route", "question"]).optional(),
  __contextFiles: z.array(z.object({ fileId: z.string(), contentHash: z.string() }).passthrough()).optional(),
  __routeSteps: z.array(tourStepSchema).optional(),
  role: z.string().optional(), title: z.string().optional(), answer: z.string().optional(),
  keyPoints: z.array(z.string()).optional(), references: z.array(questionReferenceSchema).optional(),
  insufficientEvidence: z.boolean().optional(),
}).passthrough();
const savedAiRouteSchema = z.object({
  repositoryId: z.string().optional(), entryFileId: z.string().optional(), revision: z.string().optional(),
  title: z.string().optional(), goal: z.string().optional(), signature: z.string().optional(),
  sourceSteps: z.array(z.object({ fileId: z.string(), purpose: z.string(), references: z.array(routeSourceReferenceSchema) }).passthrough()).optional(),
  steps: z.array(tourStepSchema).optional(),
  contextFiles: z.array(z.object({ fileId: z.string(), contentHash: z.string() }).passthrough()).optional(),
}).passthrough();

export const LocalWorkspaceStateSchema = z.object({
  version: z.number().int().positive(), recentRepositories: z.array(recentRepositorySchema),
  aiResults: z.record(z.string(), savedAiResultSchema), aiRoute: savedAiRouteSchema.nullable(),
  progress: z.record(z.string(), z.string()), nodePositions: z.record(z.string(), z.object({ x: z.number(), y: z.number() }).passthrough()),
  conversations: z.array(conversationSchema), warning: z.string().optional(), persistenceReady: z.boolean().optional(),
  investigations: z.array(InvestigationSchema).optional(), readingNotes: z.array(readingNoteSchema).optional(), savedTours: z.array(savedAiRouteSchema).optional(),
  guidePreferences: UsageGuidePreferencesSchema.nullable().optional(),
  layoutPreferences: WorkspaceLayoutPreferencesSchema.nullable().optional(),
}).passthrough();

export const SourceResponseSchema = z.object({ source: z.string(), repositoryId: z.string().optional(), revision: z.string().optional() }).passthrough();
export const WorkspaceSaveResponseSchema = z.object({ ok: z.boolean(), warning: z.string().optional() }).passthrough();
export const RepositoryRevisionEventSchema = z.object({ repositoryId: z.string().min(1), revision: z.string().min(1), sequence: z.number().int().nonnegative() }).passthrough();
export const RepositoryDiagnosticEventSchema = z.object({ message: z.string().min(1) }).passthrough();
export const LocalHealthResponseSchema = z.object({ ok: z.literal(true) }).passthrough();
export const AiSettingsResponseSchema = z.object({ baseUrl: z.string(), model: z.string(), configured: z.boolean() }).passthrough();

const repositoryCommandSchema = z.object({ clientId: z.string().min(1).max(160), intentSequence: z.number().int().positive() }).passthrough();
export const RepositoryOpenRequestSchema = z.object({ path: z.string().min(1).max(32_000), command: repositoryCommandSchema }).passthrough();
export const RepositoryCloseRequestSchema = z.object({ command: repositoryCommandSchema }).passthrough();
export const RepositoryRescanRequestSchema = z.object({ repositoryId: z.string().min(1).max(160) }).passthrough();
const repositorySessionSchema = z.object({ repositoryId: z.string().min(1).max(160), workspaceId: z.string().min(1).max(200).optional(), persistenceSessionId: z.string().min(1).max(200).optional() }).passthrough();
const workspaceRequestBase = repositorySessionSchema.extend({ action: z.string() }).passthrough();
export const WorkspaceMutationRequestSchema = z.discriminatedUnion("action", [
  workspaceRequestBase.extend({ action: z.literal("recent-touch") }),
  z.object({ action: z.literal("recent-remove"), targetId: z.string().min(1).max(240).optional(), repositoryId: z.string().min(1).max(160).optional() }).passthrough(),
  workspaceRequestBase.extend({ action: z.literal("progress"), key: z.string().min(1).max(500), value: z.string() }),
  workspaceRequestBase.extend({ action: z.literal("node-positions"), positions: z.record(z.string(), z.object({ x: z.number().finite(), y: z.number().finite() }).passthrough()) }),
  workspaceRequestBase.extend({ action: z.literal("ai-result"), fileId: z.string().min(1), record: savedAiResultSchema }),
  workspaceRequestBase.extend({ action: z.literal("ai-route"), record: savedAiRouteSchema.nullable() }),
  workspaceRequestBase.extend({ action: z.literal("conversations"), conversations: z.array(conversationSchema) }),
  workspaceRequestBase.extend({ action: z.literal("reading-notes"), notes: z.array(readingNoteSchema).max(10_000) }),
  workspaceRequestBase.extend({ action: z.literal("investigations"), records: z.array(InvestigationSchema).max(100) }),
  workspaceRequestBase.extend({ action: z.literal("saved-tours"), tours: z.array(savedAiRouteSchema).max(100) }),
  workspaceRequestBase.extend({ action: z.literal("clear-repository") }),
  z.object({ action: z.literal("guide-preferences"), preferences: UsageGuidePreferencesSchema }).passthrough(),
  z.object({ action: z.literal("layout-preferences"), preferences: WorkspaceLayoutPreferencesSchema }).passthrough(),
  z.object({ action: z.literal("clear-all"), repositoryId: z.string().max(160) }).passthrough(),
]);
export const AiSettingsRequestSchema = z.object({ baseUrl: z.string().max(4_096), model: z.string().max(500), apiKey: z.string().max(10_000).optional(), clearKey: z.boolean().optional() }).passthrough();
export const AiGenerationRequestSchema = z.object({ previewId: z.string().min(1).max(200), stream: z.boolean().optional(), chat: z.object({ conversationId: z.string().min(1).max(160), userMessageId: z.string().min(1).max(160), answerMessageId: z.string().min(1).max(160) }).strict().optional() }).passthrough();
export const AiPreviewRequestSchema = z.object({ repositoryId: z.string().min(1).max(160), fileId: z.string().min(1).max(4_096), mode: z.enum(["explanation", "route", "investigation"]), question: z.string().min(1).max(12000).optional(), excludedFileIds: z.array(z.string().max(4096)).max(5000).optional(), goal: z.string().max(300).optional(), fileIds: z.array(z.string().min(1).max(4_096)).max(5_000).optional(), scopePrefix: z.string().max(4_096).optional(), ranges: z.record(z.string(), z.object({ startLine: z.number().int().positive(), endLine: z.number().int().positive() }).passthrough()).optional() }).passthrough();
export const AiQuestionPreviewRequestSchema = z.object({ repositoryId: z.string().min(1).max(160), fileId: z.string().min(1).max(4_096), question: z.string().min(1).max(12_000), history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(12_000) }).passthrough()).max(6).optional(), fileIds: z.array(z.string().min(1).max(4_096)).max(5_000).optional(), ranges: z.record(z.string(), z.object({ startLine: z.number().int().positive(), endLine: z.number().int().positive() }).passthrough()).optional() }).passthrough();
export const SearchRequestSchema = z.object({ repositoryId: z.string().min(1).max(160), revision: z.string().min(1).max(200), query: z.string().min(1).max(256), offset: z.number().int().min(0).max(10_000).optional(), pathPrefix: z.string().max(4_096).optional(), language: z.string().max(24).optional(), matchCase: z.boolean().optional(), wholeWord: z.boolean().optional(), regex: z.boolean().optional(), excludeTests: z.boolean().optional() }).passthrough();
export const SearchResponseSchema = z.object({ revision: z.string().min(1), filesSearched: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), pageSize: z.number().int().positive(), total: z.number().int().nonnegative(), results: z.array(z.object({ fileId: z.string(), path: z.string(), language: z.string(), line: z.number().int().positive(), text: z.string(), contextStartColumn: z.number().int().positive(), contextEndColumn: z.number().int().nonnegative(), lineLength: z.number().int().nonnegative(), matchStartColumn: z.number().int().positive(), matchEndColumn: z.number().int().positive() }).passthrough()), hasMore: z.boolean(), capped: z.boolean() }).passthrough();
export const RepositoryOverviewSchema = z.object({ revision: z.string(), readme: z.object({ path: z.string(), summary: z.string().nullable() }).nullable(), manifests: z.array(z.string()), candidates: z.array(z.object({ fileId: z.string(), path: z.string(), reason: z.string() }).passthrough()), directories: z.array(z.object({ name: z.string(), files: z.number().int().nonnegative() }).passthrough()), languages: z.array(z.object({ name: z.string(), files: z.number().int().nonnegative() }).passthrough()), tests: z.array(z.string()), testCount: z.number().int().nonnegative(), diagnosticCount: z.number().int().nonnegative(), limitations: z.string() }).passthrough();
export const RevisionComparisonRequestSchema = z.object({ repositoryId: z.string().min(1).max(160), revision: z.string().min(1).max(200), mode: z.enum(["working-tree", "commits"]), baseRef: z.string().max(200).optional(), headRef: z.string().max(200).optional() }).strict().superRefine((value, context) => { if (value.mode === "commits" && (!value.baseRef || !value.headRef)) context.addIssue({ code: "custom", message: "提交比较需要起始和目标提交。" }); });
export const RevisionComparisonResponseSchema = z.object({ revision: z.string(), mode: z.enum(["working-tree", "commits"]), baseCommit: z.string(), headCommit: z.string(), files: z.array(z.object({ status: z.enum(["added", "modified", "deleted", "renamed"]), path: z.string(), oldPath: z.string().optional() }).passthrough()), diff: z.string(), limits: z.object({ maxFiles: z.number().int().positive(), maxDiffBytes: z.number().int().positive() }).passthrough() }).passthrough();
export const RevisionFetchRequestSchema = z.object({ repositoryId: z.string().min(1).max(160), workspaceId: z.string().min(1).max(200), persistenceSessionId: z.string().min(1).max(200), revision: z.string().min(1).max(200), target: z.string().min(1).max(256).regex(/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64}|refs\/(?:heads|tags)\/[^\s\0]+)$/) }).strict();
export const RevisionFetchResponseSchema = z.object({ repositoryId: z.string().min(1), workspaceId: z.string().min(1), revision: z.string().min(1), target: z.string().min(1), commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/), objectsAvailable: z.literal(true) }).strict();

/** Parse a response body without discarding legacy fields; callers decide endpoint-specific fallback text. */
export function parseLocalApiResponse(value, status, schema, fallback = "本地服务响应格式无效。") {
  if (status < 200 || status >= 300) {
    const error = new Error(value && typeof value === "object" && typeof value.error === "string" ? value.error : `本地服务返回 ${status}`);
    error.status = status;
    if (value && typeof value === "object" && typeof value.code === "string") error.code = value.code;
    throw error;
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`${fallback} ${parsed.error.issues.map((issue) => issue.path.join(".") || "响应").join("、")}`);
  if (parsed.data && typeof parsed.data === "object" && "ok" in parsed.data && parsed.data.ok === false) {
    const warning = "warning" in parsed.data && typeof parsed.data.warning === "string" ? parsed.data.warning : "本地数据未能保存。";
    throw new Error(warning);
  }
  return parsed.data;
}

export function parseRepositoryEvent(type, data) {
  let value;
  try { value = JSON.parse(data); }
  catch { return { success: false, message: "仓库监听收到无法解析的事件，正在重新同步。" }; }
  const schema = type === "revision" ? RepositoryRevisionEventSchema : type === "diagnostic" ? RepositoryDiagnosticEventSchema : null;
  if (!schema) return { success: false, message: "仓库监听收到未知事件，正在重新同步。" };
  const parsed = schema.safeParse(value);
  if (!parsed.success) return { success: false, message: "仓库监听事件格式无效，正在重新同步。" };
  return { success: true, value: parsed.data };
}
