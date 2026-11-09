export function isValidChatTimestamp(value) {
  return typeof value === "number" && Number.isFinite(value) && Number.isFinite(new Date(value).getTime());
}

export function formatChatTimestamp(value) {
  if (!isValidChatTimestamp(value)) return "时间未记录";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(value);
}

export async function copyChatText(text, getClipboard = () => globalThis.navigator?.clipboard) {
  try {
    const clipboard = getClipboard();
    if (typeof clipboard?.writeText !== "function") return false;
    await clipboard.writeText(text);
    return true;
  } catch { return false; }
}
