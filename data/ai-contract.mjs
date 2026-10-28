import { z } from "zod";
export { InvestigationResultSchema } from "./investigation.mjs";

export const AiSourceReferenceSchema = z.object({ fileId: z.string().min(1), startLine: z.number().int().positive(), endLine: z.number().int().positive().optional() }).strict();
export const AiExplanationSchema = z.object({ role: z.string().min(1), keyPoints: z.array(z.string()), references: z.array(AiSourceReferenceSchema).min(1) }).strict();
export const AiRouteSchema = z.object({ title: z.string().min(1), steps: z.array(z.object({ fileId: z.string().min(1), purpose: z.string().min(1), relationship: z.string().trim().min(1), question: z.string().trim().min(1), references: z.array(AiSourceReferenceSchema).min(1) }).strict()).min(3).max(7) }).strict();
export const AiQuestionAnswerSchema = z.object({ answer: z.string().min(1), insufficientEvidence: z.boolean(), references: z.array(AiSourceReferenceSchema), claims: z.array(z.object({ text: z.string().min(1), referenceIndices: z.array(z.number().int().nonnegative()).min(1) }).strict()).optional() }).strict().superRefine((value, context) => {
  if (value.insufficientEvidence && value.references.length) context.addIssue({ code: "custom", message: "insufficientEvidence answers cannot claim source citations" });
  if (value.insufficientEvidence && value.claims?.length) context.addIssue({ code: "custom", message: "insufficientEvidence answers cannot include source-backed claims" });
  if (!value.insufficientEvidence && value.references.length === 0) context.addIssue({ code: "custom", message: "source-based answers require references" });
  for (const claim of value.claims ?? []) if (claim.referenceIndices.some((index) => index >= value.references.length)) context.addIssue({ code: "custom", message: "claim reference index is invalid" });
});

export const AiGenerationEnvelopeSchema = z.object({
  result: z.record(z.string(), z.unknown()),
  cached: z.boolean(),
  revision: z.string().min(1),
  repositoryId: z.string().min(1),
  entryFileId: z.string().min(1),
  mode: z.enum(["explanation", "route", "question", "investigation"]),
  chatPersisted: z.boolean().optional(),
  warning: z.string().optional(),
}).strict();

export const AiStreamEventSchema = z.object({
  type: z.enum(["status", "text", "replace", "complete", "error"]),
  requestId: z.string().min(1), repositoryId: z.string().min(1), revision: z.string().min(1),
  text: z.string().max(1_000_000).optional(),
  status: z.enum(["generating", "validating", "repairing"]).optional(),
  result: AiGenerationEnvelopeSchema.optional(), code: z.string().optional(), error: z.string().optional(),
}).strict().superRefine((event, context) => {
  if (["text", "replace"].includes(event.type) && event.text === undefined || event.type === "complete" && !event.result || event.type === "error" && !event.error || event.type === "status" && !event.status) context.addIssue({ code: "custom", message: "incomplete stream event" });
});

export const AiScopeCandidateSchema = z.object({
  fileId: z.string().min(1),
  characters: z.number().int().nonnegative(),
  lineCount: z.number().int().positive(),
  oversizedLines: z.array(z.number().int().positive()),
  reasons: z.array(z.string().min(1)).optional(),
  suggestedRange: z.object({ startLine: z.number().int().positive(), endLine: z.number().int().positive() }).strict().optional(),
}).strict().superRefine((candidate, context) => {
  if (candidate.oversizedLines.some((line) => line > candidate.lineCount)) context.addIssue({ code: "custom", message: "oversized line exceeds candidate line count" });
  if (candidate.suggestedRange && (candidate.suggestedRange.startLine > candidate.suggestedRange.endLine || candidate.suggestedRange.endLine > candidate.lineCount)) context.addIssue({ code: "custom", message: "suggested range exceeds candidate line count" });
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
    entryFileId: z.string().min(1), mode: z.enum(["explanation", "route", "question", "investigation"]),
    goal: z.string().max(300).optional(),
    baseUrl: z.string().min(1), model: z.string().min(1),
    files: z.array(z.object({ fileId: z.string().min(1), startLine: z.number().int().positive(), endLine: z.number().int().positive(), contentHash: z.string().min(1), reasons: z.array(z.string().min(1)).optional() }).strict()),
    characters: z.number().int().nonnegative(), tokenEstimate: z.number().int().nonnegative().optional(), expiresAt: z.number().int().positive(),
    excludedFileIds: z.array(z.string()).optional(), question: z.string().optional(),
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
