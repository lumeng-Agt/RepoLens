import assert from "node:assert/strict";
import test from "node:test";
import {
  AiGenerationRequestSchema,
  AiPreviewRequestSchema,
  AiQuestionPreviewRequestSchema,
  LocalWorkspaceStateSchema,
  RepositoryCloseRequestSchema,
  RepositoryOpenRequestSchema,
  RepositoryRescanRequestSchema,
  RepositorySnapshotSchema,
  SourceResponseSchema,
  UsageGuidePreferencesSchema,
  WorkspaceSaveResponseSchema,
  WorkspaceMutationRequestSchema,
  parseLocalApiResponse,
  parseRepositoryEvent,
} from "./local-contracts.mjs";

const snapshot = {
  id: "sample", version: "v1", name: "Sample", description: "Fixture",
  files: [{ id: "src/main.ts", path: "src/main.ts", name: "main.ts", kind: "typescript", imports: [], legacyTag: "keep" }],
  dependencies: [], tour: [], futureField: { value: 1 },
};

test("snapshot contract validates the required structure and preserves forward-compatible fields", () => {
  const parsed = parseLocalApiResponse(snapshot, 200, RepositorySnapshotSchema);
  assert.equal(parsed.files[0].legacyTag, "keep");
  assert.deepEqual(parsed.futureField, { value: 1 });
  assert.throws(() => parseLocalApiResponse({ ...snapshot, files: [{ id: "broken" }] }, 200, RepositorySnapshotSchema), /快照|格式/);
});

test("snapshot contract accepts unresolved parser imports before they become dependency edges", () => {
  const parsed = RepositorySnapshotSchema.parse({
    ...snapshot,
    files: [
      { id: "app.py", path: "app.py", name: "app.py", kind: "python", imports: [{ specifier: "pkg.worker", line: 3, kind: "from-import", members: ["run"], alias: "worker_run" }] },
      { id: "main.go", path: "main.go", name: "main.go", kind: "go", imports: [{ specifier: "fmt", line: 2, kind: "import" }] },
    ],
  });
  assert.equal(parsed.files[0].imports[0].targetPath, undefined);
  assert.equal(parsed.files[0].imports[0].members[0], "run");
  assert.equal(parsed.files[1].imports[0].specifier, "fmt");
});

test("workspace contract preserves valid legacy records and optional historical fields", () => {
  const stored = {
    version: 1, recentRepositories: [], aiResults: { "src/main.ts": { role: "Old result", custom: "preserve" } },
    aiRoute: null, progress: {}, nodePositions: {},
    conversations: [{ id: "c1", title: "Old conversation", updatedAt: 1, oldMetadata: 7, messages: [{ id: "m1", role: "assistant", content: "old", oldFlag: true }] }],
  };
  const parsed = LocalWorkspaceStateSchema.parse(stored);
  assert.equal(parsed.conversations[0].oldMetadata, 7);
  assert.equal(parsed.conversations[0].messages[0].oldFlag, true);
  assert.deepEqual(parsed.conversations[0].messages[0].references, []);
  assert.deepEqual(parsed.aiResults["src/main.ts"], { role: "Old result", custom: "preserve" });
  assert.throws(() => LocalWorkspaceStateSchema.parse({ ...stored, nodePositions: { file: { x: "bad", y: 1 } } }));
  assert.throws(() => LocalWorkspaceStateSchema.parse({ ...stored, aiResults: { file: { role: 12 } } }));
});

test("workspace contract checks saved routes and answers without stripping future fields", () => {
  const stored = {
    version: 1, recentRepositories: [], aiResults: { "main.ts": {
      __repositoryId: "repo", __entryFileId: "main.ts", __revision: "r1", __mode: "explanation",
      __contextFiles: [{ fileId: "main.ts", contentHash: "h1" }], role: "入口", keyPoints: ["挂载应用"],
      references: [{ fileId: "main.ts", startLine: 1 }], futureResultField: true,
    } },
    aiRoute: {
      repositoryId: "repo", entryFileId: "main.ts", revision: "r1", title: "路线", signature: "sig",
      sourceSteps: [{ fileId: "main.ts", purpose: "入口", references: [{ fileId: "main.ts", startLine: 1, endLine: null }] }],
      steps: [{ id: "s1", title: "main.ts", focusFileId: "main.ts", description: "入口", reference: { fileId: "main.ts", line: 1 } }],
      contextFiles: [{ fileId: "main.ts", contentHash: "h1" }], futureRouteField: 2,
    },
    progress: {}, nodePositions: {}, conversations: [],
  };
  const parsed = LocalWorkspaceStateSchema.parse(stored);
  assert.equal(parsed.aiResults["main.ts"].futureResultField, true);
  assert.equal(parsed.aiRoute.futureRouteField, 2);
  assert.throws(() => LocalWorkspaceStateSchema.parse({ ...stored, aiRoute: { ...stored.aiRoute, steps: [{ ...stored.aiRoute.steps[0], reference: { fileId: "main.ts", line: 0 } }] } }));
});

test("HTTP success with ok false and warnings is treated as a failed persistence operation", () => {
  assert.throws(
    () => parseLocalApiResponse({ ok: false, warning: "保存失败，原记录保留" }, 200, WorkspaceSaveResponseSchema),
    /保存失败，原记录保留/,
  );
  assert.deepEqual(parseLocalApiResponse({ ok: true }, 200, WorkspaceSaveResponseSchema), { ok: true });
});

test("source response contract rejects missing source and accepts legacy extra metadata", () => {
  assert.throws(() => parseLocalApiResponse({ repositoryId: "repo" }, 200, SourceResponseSchema, "源码响应格式无效。"), /源码响应格式无效/);
  assert.deepEqual(parseLocalApiResponse({ source: "const x = 1", cached: true }, 200, SourceResponseSchema), { source: "const x = 1", cached: true });
});

test("SSE parser safely reports malformed, unknown, stale-shaped and valid events", () => {
  assert.equal(parseRepositoryEvent("revision", "{").success, false);
  assert.equal(parseRepositoryEvent("unknown", "{}").success, false);
  assert.equal(parseRepositoryEvent("revision", JSON.stringify({ revision: "r1", sequence: 2 })).success, false);
  assert.deepEqual(parseRepositoryEvent("revision", JSON.stringify({ repositoryId: "repo", revision: "r1", sequence: 2 })), {
    success: true, value: { repositoryId: "repo", revision: "r1", sequence: 2 },
  });
  assert.deepEqual(parseRepositoryEvent("diagnostic", JSON.stringify({ message: "index failed" })), {
    success: true, value: { message: "index failed" },
  });
});

test("server request contracts reject malformed actions before route logic and preserve forward-compatible fields", () => {
  const command = { clientId: "client", intentSequence: 1 };
  assert.equal(RepositoryOpenRequestSchema.safeParse({ path: "C:/repo", command }).success, true);
  assert.equal(RepositoryOpenRequestSchema.safeParse({ path: "", command }).success, false);
  assert.equal(RepositoryCloseRequestSchema.safeParse({ command: { ...command, intentSequence: 0 } }).success, false);
  assert.equal(RepositoryRescanRequestSchema.safeParse({ repositoryId: "repo" }).success, true);
  assert.equal(AiGenerationRequestSchema.safeParse({ previewId: "p1" }).success, true);
  assert.equal(AiPreviewRequestSchema.safeParse({ repositoryId: "repo", fileId: "src/a.ts", mode: "explanation", futureFlag: true }).data.futureFlag, true);
  assert.equal(AiQuestionPreviewRequestSchema.safeParse({ repositoryId: "repo", fileId: "src/a.ts", question: "why?", history: [{ role: "user", content: "previous" }] }).success, true);
  assert.equal(AiQuestionPreviewRequestSchema.safeParse({ repositoryId: "repo", fileId: "src/a.ts", question: "why?", history: Array(7).fill({ role: "user", content: "x" }) }).success, false);
  assert.equal(WorkspaceMutationRequestSchema.safeParse({ action: "progress", repositoryId: "repo", key: "repolens:repo:v1", value: "{}" }).success, true);
  assert.equal(WorkspaceMutationRequestSchema.safeParse({ action: "node-positions", repositoryId: "repo", positions: { "a.ts": { x: Number.NaN, y: 1 } } }).success, false);
  assert.equal(WorkspaceMutationRequestSchema.safeParse({ action: "unknown", repositoryId: "repo" }).success, false);
});

test("usage guide preferences are optional in workspace records and validated by the existing mutation route", () => {
  const preferences = { version: 1, welcomeHandled: true, completedTaskIds: ["source", "tour"], checklistOpen: true, noticeDismissed: true, futureField: "keep" };
  assert.equal(UsageGuidePreferencesSchema.parse(preferences).futureField, "keep");
  assert.equal(UsageGuidePreferencesSchema.safeParse({ ...preferences, completedTaskIds: ["unknown"] }).success, false);
  assert.equal(WorkspaceMutationRequestSchema.safeParse({ action: "guide-preferences", preferences }).success, true);
  assert.equal(WorkspaceMutationRequestSchema.safeParse({ action: "guide-preferences", preferences: { ...preferences, version: 2 } }).success, false);
  const state = LocalWorkspaceStateSchema.parse({ version: 1, recentRepositories: [], aiResults: {}, aiRoute: null, progress: {}, nodePositions: {}, conversations: [], readingNotes: [], savedTours: [], guidePreferences: preferences });
  assert.equal(state.guidePreferences.futureField, "keep");
});
