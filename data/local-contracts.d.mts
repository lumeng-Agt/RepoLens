import type { z } from "zod";

export const RepositorySnapshotSchema: z.ZodTypeAny;
export const LocalWorkspaceStateSchema: z.ZodTypeAny;
export const SourceResponseSchema: z.ZodTypeAny;
export const WorkspaceSaveResponseSchema: z.ZodTypeAny;
export const RepositoryRevisionEventSchema: z.ZodTypeAny;
export const RepositoryDiagnosticEventSchema: z.ZodTypeAny;
export const LocalHealthResponseSchema: z.ZodTypeAny;
export const AiSettingsResponseSchema: z.ZodTypeAny;
export const RepositoryOpenRequestSchema: z.ZodTypeAny;
export const RepositoryCloseRequestSchema: z.ZodTypeAny;
export const RepositoryRescanRequestSchema: z.ZodTypeAny;
export const WorkspaceMutationRequestSchema: z.ZodTypeAny;
export const AiSettingsRequestSchema: z.ZodTypeAny;
export const AiGenerationRequestSchema: z.ZodTypeAny;
export const AiPreviewRequestSchema: z.ZodTypeAny;
export const AiQuestionPreviewRequestSchema: z.ZodTypeAny;
export const SearchRequestSchema: z.ZodTypeAny;
export const SearchResponseSchema: z.ZodTypeAny;
export const RepositoryOverviewSchema: z.ZodTypeAny;
export const RevisionComparisonRequestSchema: z.ZodTypeAny;
export const RevisionComparisonResponseSchema: z.ZodTypeAny;
export const RevisionFetchRequestSchema: z.ZodTypeAny;
export const RevisionFetchResponseSchema: z.ZodTypeAny;

export function parseLocalApiResponse<T>(value: unknown, status: number, schema: z.ZodType<T>, fallback?: string): T;
export type RepositoryEventParseResult =
  | { success: true; value: { repositoryId: string; revision: string; sequence: number } | { message: string } }
  | { success: false; message: string };
export function parseRepositoryEvent(type: string, data: string): RepositoryEventParseResult;
