/** @returns {{ allowed: boolean, status?: number, error?: string }} */
export function validateLocalRequest({ host, origin, method, url, port, allowedOrigins }) {
  let hostAllowed = false;
  try {
    const parsed = new URL(`http://${host ?? ""}`);
    hostAllowed = ["127.0.0.1", "localhost"].includes(parsed.hostname) && Number(parsed.port || 80) === port;
  } catch {}
  if (!hostAllowed) return { allowed: false, status: 403, error: "只允许通过本机 RepoLens 地址访问。" };
  if (origin && !allowedOrigins.has(origin)) return { allowed: false, status: 403, error: "只允许 RepoLens 本地页面访问。" };
  const healthRequest = method === "GET" && url?.startsWith("/api/health");
  if (!healthRequest && !origin) return { allowed: false, status: 403, error: "本地页面来源校验失败。" };
  return { allowed: true };
}

export function sendJson(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

export async function readJsonRequestBody(request, maxBytes = 2_000_000) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > maxBytes) throw new Error("请求过大。");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}
