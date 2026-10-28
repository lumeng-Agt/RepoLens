import { z } from "zod";

const reference = z.object({ fileId: z.string().min(1).max(4096), startLine: z.number().int().positive(), endLine: z.number().int().positive().optional() }).strict();
// Change checks use the indexed file id (a repository-relative path) as the item
// id, so the cap must match the fileId limit; a 160-character cap rejected deep
// monorepo paths and failed the whole investigation save.
export const InvestigationItemSchema = z.object({
  id: z.string().min(1).max(4096), title: z.string().min(1).max(4096), responsibility: z.string().max(500), reason: z.string().min(1).max(4000),
  references: z.array(reference).min(1).max(20),
}).strict();
export const InvestigationResultSchema = z.object({
  summary: z.string().min(1).max(12000), items: z.array(InvestigationItemSchema).max(40),
  questions: z.array(z.object({ question: z.string().min(1).max(2000), suggestedFileId: z.string().max(4096).optional() }).strict()).max(30),
}).strict().superRefine((value, context) => {
  if (new Set(value.items.map(item => item.id)).size !== value.items.length) context.addIssue({ code: "custom", message: "调查候选编号重复" });
});
export const InvestigationSchema = z.object({
  id: z.string().min(1).max(160), title: z.string().min(1).max(500), question: z.string().min(1).max(12000),
  workspaceId: z.string().min(1), repositoryName: z.string(), ref: z.string().optional(), commit: z.string().optional(),
  summary: z.string(), items: z.array(InvestigationItemSchema.extend({ basis: z.enum(["static-dependency", "retrieval-match", "model-inference"]).optional(), contextFiles: z.array(z.object({ fileId: z.string(), contentHash: z.string(), startLine: z.number().int().positive(), endLine: z.number().int().positive() }).passthrough()).max(20).optional() }).passthrough()).max(200),
  questions: z.array(z.object({ question: z.string(), suggestedFileId: z.string().optional() }).passthrough()).max(200),
  selectionReasons: z.record(z.string(), z.array(z.string())).optional(),
  excludedFileIds: z.array(z.string()).max(5000), verifiedItemIds: z.array(z.string()).max(200),
  checks: z.record(z.string(), z.enum(["pending", "checked", "irrelevant"])).optional(),
  contextFiles: z.array(z.object({ fileId: z.string(), contentHash: z.string(), startLine: z.number().int().positive(), endLine: z.number().int().positive() }).passthrough()).max(5000),
  createdAt: z.number().finite(), updatedAt: z.number().finite(),
}).passthrough();

export function createInvestigation({ result, question, repository, contextFiles, excludedFileIds = [], id = crypto.randomUUID(), now = Date.now() }) {
  return InvestigationSchema.parse({ ...result, id, title: question.slice(0, 80), question,
    workspaceId: repository.workspaceId ?? repository.id, repositoryName: repository.name,
    ...(repository.origin ? { ref: repository.origin.resolvedRef, commit: repository.origin.commit } : {}),
    items: result.items.map(item => ({ ...item, contextFiles: contextFiles.filter(file => item.references.some(ref => ref.fileId === file.fileId)) })), excludedFileIds, verifiedItemIds: [], contextFiles, createdAt: now, updatedAt: now });
}

export function investigationItemIsStale(item, investigation, files) {
  const byId = new Map(files.map(file => [file.id, file]));
  return item.references.some(ref => {
    const saved = (item.contextFiles ?? investigation.contextFiles).find(file => file.fileId === ref.fileId);
    return (ref.endLine ?? ref.startLine) < ref.startLine || !saved || !byId.has(ref.fileId) || byId.get(ref.fileId).contentHash !== saved.contentHash
      || ref.startLine < saved.startLine || (ref.endLine ?? ref.startLine) > saved.endLine;
  });
}

export function appendInvestigationResult(latest, result, contextFiles, exclusions, selectionReasons = {}, createId = () => crypto.randomUUID()) {
  const ids = new Set(latest.items.map(item => item.id));
  const added = result.items.map(item => {
    let id = item.id; while (ids.has(id)) id = createId(); ids.add(id);
    return { ...item, id, contextFiles: contextFiles.filter(file => item.references.some(ref => ref.fileId === file.fileId)) };
  });
  const contexts = [...latest.contextFiles, ...contextFiles].filter((item, index, values) => values.findLastIndex(candidate => candidate.fileId === item.fileId) === index);
  const questions = [...latest.questions, ...result.questions].filter((item, index, values) => values.findIndex(candidate => candidate.question === item.question && candidate.suggestedFileId === item.suggestedFileId) === index);
  return InvestigationSchema.parse({ ...latest, summary: `${latest.summary}\n\n${result.summary}`, items: [...latest.items, ...added], questions,
    contextFiles: contexts, excludedFileIds: [...new Set([...latest.excludedFileIds, ...exclusions])], selectionReasons: { ...latest.selectionReasons, ...selectionReasons }, updatedAt: Date.now() });
}

export function exportInvestigations(records, format) {
  if (format === "json") return JSON.stringify({ version: 1, kind: "repolens-investigations", records }, null, 2);
  return records.map(record => `# ${record.title}\n\n${record.question}\n\n${record.summary}\n\n## 候选位置与依据\n\n${record.items.map(item => `- [${record.verifiedItemIds.includes(item.id) ? "x" : " "}] ${item.title}（${item.responsibility}）\n  ${item.reason}\n  ${item.references.map(ref => `${ref.fileId}:${ref.startLine}${ref.endLine ? `–${ref.endLine}` : ""}`).join("、")}`).join("\n")}\n\n## 待确认与下一步\n\n${record.questions.map(item => `- ${item.question}${item.suggestedFileId ? `；下一步查看 ${item.suggestedFileId}` : ""}`).join("\n")}\n\n排除文件：${record.excludedFileIds.join("、") || "无"}\n\n仓库：${record.repositoryName} ${record.ref ?? ""} ${record.commit ?? ""}\n\n位置有效性与结论正确性需分别核对。`).join("\n\n---\n\n");
}

const MAX_IMPORT_DEPTH = 64;
const MAX_IMPORT_NODES = 200_000;

// Zod validates field types, not the cost of the shape it lets through: a few
// kilobytes of deeply nested unknown fields overflow the recursive compare that
// runs during render. Bound depth and node count before the value reaches state.
function assertBoundedImport(value) {
  const stack = [[value, 0]];
  let nodes = 0;
  while (stack.length) {
    const [current, depth] = stack.pop();
    if (current === null || typeof current !== "object") continue;
    if (depth > MAX_IMPORT_DEPTH) throw new Error(`调查文件嵌套超过 ${MAX_IMPORT_DEPTH} 层，无法导入。`);
    nodes += 1;
    if (nodes > MAX_IMPORT_NODES) throw new Error("调查文件的对象数量超过上限，请减少调查记录。");
    for (const child of Object.values(current)) stack.push([child, depth + 1]);
  }
}

export function parseInvestigationImport(text) {
  if (text.length > 2_000_000) throw new Error("导入文件超过 2 MB，请减少调查记录。");
  const parsed = JSON.parse(text);
  assertBoundedImport(parsed);
  return z.object({ version: z.literal(1), kind: z.literal("repolens-investigations"), records: z.array(InvestigationSchema).max(100) }).parse(parsed).records;
}

// Ignore identity and derived timestamp when comparing imported content; preserve all other fields.
function fingerprint(record) {
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().filter(key => !["id", "createdAt", "updatedAt"].includes(key)).map(key => [key, canonical(value[key])])) : value;
  return JSON.stringify(canonical(record));
}
export function mergeInvestigationImport(existing, incoming, workspaceId, createId = () => crypto.randomUUID()) {
  const records = [...existing]; let conflicts = 0; let skipped = 0;
  for (const item of incoming) {
    const found = records.find(record => record.id === item.id);
    if (found && fingerprint(found) === fingerprint({ ...item, workspaceId })) { skipped++; continue; }
    if (found) conflicts++;
    records.push({ ...item, workspaceId, ...(found ? { id: createId(), title: `${item.title}（导入副本）` } : {}) });
  }
  return { records, conflicts, skipped };
}
