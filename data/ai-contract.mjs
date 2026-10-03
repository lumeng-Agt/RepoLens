import { z } from "zod";

export const AiGenerationEnvelopeSchema = z.object({
  result: z.record(z.string(), z.unknown()),
  cached: z.boolean(),
  revision: z.string().min(1),
  repositoryId: z.string().min(1),
  entryFileId: z.string().min(1),
  mode: z.enum(["explanation", "route", "question"]),
}).strict();

export const AiScopeCandidateSchema = z.object({
  fileId: z.string().min(1),
  characters: z.number().int().nonnegative(),
  lineCount: z.number().int().positive(),
  oversizedLines: z.array(z.number().int().positive()),
}).strict().superRefine((candidate, context) => {
  if (candidate.oversizedLines.some((line) => line > candidate.lineCount)) context.addIssue({ code: "custom", message: "oversized line exceeds candidate line count" });
});

export const AiPreviewScopeRequiredSchema = z.object({
  scopeRequired: z.literal(true),
  candidates: z.array(AiScopeCandidateSchema),
  maxFiles: z.number().int().positive(),
  maxCharacters: z.number().int().positive(),
  retrievalInsufficient: z.boolean().optional(),
}).strict();

export const AiPreviewSuccessSchema = z.object({
  scopeRequired: z.literal(false),
  preview: z.object({
    id: z.string().min(1), repositoryId: z.string().min(1), revision: z.string().min(1),
    entryFileId: z.string().min(1), mode: z.enum(["explanation", "route", "question"]),
    baseUrl: z.string().min(1), model: z.string().min(1),
    files: z.array(z.object({ fileId: z.string().min(1), startLine: z.number().int().positive(), endLine: z.number().int().positive(), contentHash: z.string().min(1) }).strict()),
    characters: z.number().int().nonnegative(), expiresAt: z.number().int().positive(),
    question: z.string().optional(),
    history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }).strict()).max(6).optional(),
    retrievalInsufficient: z.boolean().optional(),
  }).strict(),
}).strict();

export const AiPreviewResponseSchema = z.union([AiPreviewSuccessSchema, AiPreviewScopeRequiredSchema]);

export function createAiGenerationEnvelope(result, context, cached) {
  return AiGenerationEnvelopeSchema.parse({
    result,
    cached,
    revision: context.revision,
    repositoryId: context.repositoryId,
    entryFileId: context.entryFileId,
    mode: context.mode,
  });
}
