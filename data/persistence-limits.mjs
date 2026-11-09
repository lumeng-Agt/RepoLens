// Shared by browser preflight and the local service; measure the actual UTF-8 envelope.
export const MAX_WORKSPACE_REQUEST_BYTES = 2_000_000;
export const MAX_SAVED_TOURS = 100;
export const MAX_CONVERSATIONS = 100;
export const CONVERSATION_CAPACITY_MESSAGE = "每个工作区最多保存 100 个对话。请先删除不再需要的对话；原有记录不会自动删除。";
export function assertConversationCapacity(conversations) {
  if (!Array.isArray(conversations) || conversations.length > MAX_CONVERSATIONS) throw Object.assign(new Error(CONVERSATION_CAPACITY_MESSAGE), { code: "CONVERSATION_CAPACITY" });
}
export function assertConversationPersistenceCapacity(conversations) {
  assertConversationCapacity(conversations);
  try {
    // Reserve the longest legal session envelope so later saves in a new
    // repository session cannot exceed the unchanged HTTP request limit.
    serializeWorkspaceMutation({ action: "conversations", repositoryId: "r".repeat(160), workspaceId: "w".repeat(200), persistenceSessionId: "s".repeat(200), conversations });
  } catch (cause) {
    throw Object.assign(new Error("聊天记录已达到保存容量上限，本次修改尚未保存。请先复制需要保留的内容，再删除不再需要的对话。", { cause }), { code: "CONVERSATION_BYTES" });
  }
}
export const MAX_READING_NOTES = 10_000;

export function assertBoundedData(value) {
  const stack = [{ value, depth: 0, exit: false }];
  const ancestors = new Set();
  let nodes = 0;
  while (stack.length) {
    const item = stack.pop();
    if (item.exit) { ancestors.delete(item.value); continue; }
    if (++nodes > 200_000) throw new Error("记录内容过于复杂，请分批导入或减少扩展字段。");
    if (item.depth > 64) throw new Error("记录嵌套层级超过 64 层，请减少扩展字段后重试。");
    if (!item.value || typeof item.value !== "object") continue;
    if (ancestors.has(item.value)) throw new Error("记录包含循环引用，无法保存。");
    ancestors.add(item.value);
    stack.push({ ...item, exit: true });
    for (const child of Object.values(item.value)) stack.push({ value: child, depth: item.depth + 1, exit: false });
  }
}

export function serializeWorkspaceMutation(value) {
  assertBoundedData(value);
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string") throw new Error("保存内容格式无效。");
  if (new TextEncoder().encode(serialized).byteLength > MAX_WORKSPACE_REQUEST_BYTES)
    throw new Error("本次保存超过 2 MB 限制，请减少记录或扩展字段后重试。");
  return serialized;
}

export function assertReadingArtifactCapacity({ notes, tours }, session = {}) {
  if (notes !== undefined) {
    if (!Array.isArray(notes) || notes.length > MAX_READING_NOTES) throw new Error("笔记合计不能超过 10,000 条，请先导出并删除不再需要的记录。");
    serializeWorkspaceMutation({ action: "reading-notes", ...session, notes });
  }
  if (tours !== undefined) {
    if (!Array.isArray(tours) || tours.length > MAX_SAVED_TOURS) throw new Error("路线合计不能超过 100 条，请先导出并删除不再需要的路线。");
    serializeWorkspaceMutation({ action: "saved-tours", ...session, tours });
  }
}
