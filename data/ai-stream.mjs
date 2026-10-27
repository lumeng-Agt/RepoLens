/** Decode SSE incrementally, including UTF-8 characters split across network packets. */
export async function* readSseData(body, signal) {
  if (!body) throw new Error("模型服务没有返回响应内容。");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data = [];
  let eventSize = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > 2_000_000) throw new Error("流式消息过大。");
      if (done && buffer && !buffer.endsWith("\n")) buffer += "\n";
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line) {
          if (data.length) yield data.join("\n");
          data = []; eventSize = 0;
        } else if (line.startsWith("data:")) {
          const part = line.slice(5).replace(/^ /, "");
          eventSize += part.length;
          if (eventSize > 2_000_000) throw new Error("流式消息过大。");
          data.push(part);
        }
      }
      if (done) { if (data.length) yield data.join("\n"); break; }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

// Extract only a top-level JSON answer string. Never expose other fields or raw JSON.
export function partialAnswer(text) {
  const source = text.replace(/^\s*```(?:json)?\s*/, "");
  let depth = 0;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === "{" || char === "[") depth++;
    if (char === "}" || char === "]") depth--;
    if (char !== '"') continue;
    const start = i++;
    while (i < source.length && source[i] !== '"') { if (source[i] === "\\") i++; i++; }
    if (i >= source.length) return "";
    if (depth !== 1 || source.slice(start, i + 1) !== '"answer"') continue;
    let position = i + 1;
    while (/\s/.test(source[position] ?? "") && position < source.length) position++;
    if (source[position++] !== ":") continue;
    while (/\s/.test(source[position] ?? "") && position < source.length) position++;
    if (source[position++] !== '"') return "";
    let encoded = "";
    while (position < source.length) {
      const next = source[position++];
      if (next === '"') break;
      if (next === "\\") {
        if (position >= source.length) break;
        const escape = source[position++];
        if (escape === "u") {
          if (position + 4 > source.length) break;
          encoded += `\\u${source.slice(position, position + 4)}`; position += 4;
        } else encoded += `\\${escape}`;
      } else encoded += next;
    }
    try { return JSON.parse(`"${encoded}"`).replace(/[\uD800-\uDBFF]$/, ""); }
    catch { return ""; }
  }
  return "";
}
