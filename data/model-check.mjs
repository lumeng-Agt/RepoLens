export function modelEndpoint(baseUrl, resource) {
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('请输入有效的 HTTP(S) 模型地址。');
  url.pathname = url.pathname.replace(/\/+$/, '');
  const completeEndpoint = /\/chat\/completions$/i.test(url.pathname);
  if (completeEndpoint && resource === 'chat/completions') return url.toString();
  if (completeEndpoint) url.pathname = url.pathname.replace(/\/chat\/completions$/i, '');
  else if (!/\/v1$/i.test(url.pathname)) url.pathname += '/v1';
  url.pathname += `/${resource}`;
  return url.toString();
}
export function allowsNoKey(baseUrl) {
  try { const url = new URL(baseUrl); return ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname); } catch { return false; }
}
export const MAX_MODEL_RESPONSE_BYTES = 1_000_000;
export function modelResponseLimitError() {
  return Object.assign(new Error('模型回答超过 1 MB 上限，请缩小问题后重新发送。'), { code: 'MODEL_RESPONSE_TOO_LARGE', status: 502 });
}
export async function readBoundedModelJson(response) {
  if (!response.body) throw new Error('模型服务没有返回内容。');
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let text = ''; let bytes = 0;
  try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > MAX_MODEL_RESPONSE_BYTES) throw modelResponseLimitError(); text += decoder.decode(chunk.value, { stream: true }); } text += decoder.decode(); }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  try { return JSON.parse(text); } catch { throw new Error('模型服务返回的 JSON 格式无效。'); }
}
export async function checkModel(settings, action, signal, fetchImpl = fetch) {
  const noKey = settings.authMode === 'none';
  if (noKey && !allowsNoKey(settings.baseUrl)) throw new Error('免密模式仅用于本机回环地址。');
  if (!noKey && !settings.apiKey) throw new Error('请填写 API 密钥。');
  if (!['models', 'test'].includes(action)) throw new Error('无效的模型检查操作。');
  const response = await fetchImpl(modelEndpoint(settings.baseUrl, action === 'models' ? 'models' : 'chat/completions'), {
    method: action === 'models' ? 'GET' : 'POST', redirect: 'manual', signal,
    headers: { ...(noKey ? {} : { Authorization: `Bearer ${settings.apiKey}` }), 'Content-Type': 'application/json' },
    ...(action === 'test' ? { body: JSON.stringify({ model: settings.model, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with OK.' }] }) } : {}),
  });
  if (response.redirected || response.status >= 300 && response.status < 400) throw new Error('模型服务返回重定向，请填写最终接口地址。');
  if (!response.ok) throw new Error(`模型服务返回 ${response.status}。`);
  const value = await readBoundedModelJson(response);
  if (action === 'models') return { models: (Array.isArray(value.data) ? value.data : []).filter(item => typeof item?.id === 'string').slice(0, 500).map(item => item.id) };
  const content = value.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('模型未返回有效文本。');
  return { ok: true };
}
