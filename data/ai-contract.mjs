import { z } from "zod";

export const AiSourceReferenceSchema = z.object({ fileId: z.string().min(1), startLine: z.number().int().positive(), endLine: z.number().int().positive().optional() }).strict();
export const AiExplanationSchema = z.object({ role: z.string().min(1), keyPoints: z.array(z.string()), references: z.array(AiSourceReferenceSchema).min(1) }).strict();
export const AiRouteSchema = z.object({ title: z.string().min(1), steps: z.array(z.object({ fileId: z.string().min(1), purpose: z.string().min(1), references: z.array(AiSourceReferenceSchema).min(1) }).strict()).min(3).max(7) }).strict();
export const AiQuestionAnswerSchema = z.object({ answer: z.string().min(1), insufficientEvidence: z.boolean(), references: z.array(AiSourceReferenceSchema) }).strict().superRefine((value, context) => {
  if (value.insufficientEvidence && value.references.length) context.addIssue({ code: "custom", message: "insufficientEvidence answers cannot claim source citations" });
  if (!value.insufficientEvidence && value.references.length === 0) context.addIssue({ code: "custom", message: "source-based answers require references" });
});

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
  reasons: z.array(z.string().min(1)).optional(),
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
    files: z.array(z.object({ fileId: z.string().min(1), startLine: z.number().int().positive(), endLine: z.number().int().positive(), contentHash: z.string().min(1), reasons: z.array(z.string().min(1)).optional() }).strict()),
    characters: z.number().int().nonnegative(), tokenEstimate: z.number().int().nonnegative().optional(), expiresAt: z.number().int().positive(),
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
