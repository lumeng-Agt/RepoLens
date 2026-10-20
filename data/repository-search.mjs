import { Worker } from "node:worker_threads";

export const SEARCH_PAGE_SIZE = 100;
export const SEARCH_MAX_RESULTS = 10_000;
export const SEARCH_TIMEOUT_MS = 5_000;

export function validateSearchRequest(input) {
  if (!input || typeof input !== "object") throw new Error("搜索条件格式无效。");
  const query = String(input.query ?? "");
  if (!query.trim() || query.length > 256) throw new Error("请输入 1–256 个字符的搜索内容。");
  const offset = Number(input.offset ?? 0);
  if (!Number.isInteger(offset) || offset < 0 || offset > SEARCH_MAX_RESULTS) throw new Error("搜索页码无效，请重新搜索。");
  const pathPrefix = String(input.pathPrefix ?? "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (pathPrefix.split("/").some((part) => part === "..")) throw new Error("搜索目录范围无效。");
  const language = String(input.language ?? "");
  if (language && !/^[a-z0-9+#-]{1,24}$/i.test(language)) throw new Error("搜索语言筛选无效。");
  return {
    query,
    offset,
    pathPrefix,
    language,
    matchCase: Boolean(input.matchCase),
    wholeWord: Boolean(input.wholeWord),
    regex: Boolean(input.regex),
    excludeTests: Boolean(input.excludeTests),
  };
}

const SEARCH_WORKER = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
let matcher;
try {
  const escaped = workerData.regex ? workerData.query : workerData.query.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
  const source = workerData.wholeWord ? '(?<![\\p{L}\\p{N}_])(?:' + escaped + ')(?![\\p{L}\\p{N}_])' : escaped;
  matcher = new RegExp(source, 'gu' + (workerData.matchCase ? '' : 'i'));
  if (!workerData.query.trim()) throw new Error('搜索内容不能为空。');
} catch (error) {
  parentPort.postMessage({ type: 'error', message: '正则表达式无效：' + error.message });
}
if (matcher) {
  let total = 0;
  const page = [];
  let capped = false;
  parentPort.on('message', (message) => {
    if (message.type === 'file') {
      const { file, source } = message;
      if (!capped && file && source) {
        const lines = source.split('\n');
        for (let index = 0; index < lines.length; index++) {
          matcher.lastIndex = 0;
          const match = matcher.exec(lines[index]);
          if (!match) continue;
          if (total >= workerData.offset && page.length < workerData.pageSize) {
            const line = lines[index];
            const matchLength = Math.max(1, match[0].length);
            const matchStart = match.index;
            const matchEnd = Math.min(line.length, match.index + matchLength);
            let contextStart = Math.max(0, matchStart - Math.floor((400 - Math.min(matchLength, 400)) / 2));
            let contextEnd = Math.min(line.length, contextStart + 400);
            contextStart = Math.max(0, contextEnd - 400);
            page.push({ fileId: file.id, path: file.path, language: file.language || '', line: index + 1, text: line.slice(contextStart, contextEnd), contextStartColumn: contextStart + 1, contextEndColumn: contextEnd, lineLength: line.length, matchStartColumn: matchStart + 1, matchEndColumn: Math.max(matchStart + 1, matchEnd) });
          }
          total++;
          if (total >= workerData.maxResults) { capped = true; break; }
        }
      }
      parentPort.postMessage({ type: 'ack' });
    } else if (message.type === 'finish') {
      parentPort.postMessage({ type: 'done', total, results: page, hasMore: total > workerData.offset + page.length, capped });
    }
  });
}
`;

function filterFiles(files, sourceById, options) {
  return files.filter((file) => {
    if (!sourceById.has(file.id)) return false;
    if (options.pathPrefix && file.path !== options.pathPrefix && !file.path.startsWith(`${options.pathPrefix}/`)) return false;
    if (options.language && String(file.language ?? "").toLowerCase() !== options.language.toLowerCase()) return false;
    if (options.excludeTests && /(^|[/_.-])(test|tests|spec|specs)([/_.-]|$)|\.(test|spec)\./i.test(file.path)) return false;
    return true;
  }).sort((a, b) => a.path.localeCompare(b.path));
}

export async function searchRepositoryContent({ files, sourceById, input, signal, timeoutMs = SEARCH_TIMEOUT_MS }) {
  const options = validateSearchRequest(input);
  const candidates = filterFiles(files, sourceById, options);
  if (signal?.aborted) throw Object.assign(new Error("搜索已取消。"), { name: "AbortError" });
  const worker = new Worker(SEARCH_WORKER, { eval: true, workerData: { ...options, pageSize: SEARCH_PAGE_SIZE, maxResults: SEARCH_MAX_RESULTS } });
  let timer;
  let abortListener;
  const outcome = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    worker.on("error", (error) => finish(reject, error));
    worker.on("exit", (code) => { if (code !== 0) finish(reject, new Error("搜索任务异常结束。")); });
    timer = setTimeout(() => finish(reject, Object.assign(new Error("搜索耗时过长，已停止。请缩小目录或调整关键词。"), { status: 408 })), timeoutMs);
    abortListener = () => finish(reject, Object.assign(new Error("搜索已取消。"), { name: "AbortError" }));
    signal?.addEventListener("abort", abortListener, { once: true });
    worker.on("message", (message) => {
      if (message.type === "error") return finish(reject, new Error(message.message));
      if (message.type === "done") return finish(resolve, message);
    });
  });
  try {
    for (const file of candidates) {
      if (signal?.aborted) throw Object.assign(new Error("搜索已取消。"), { name: "AbortError" });
      const ack = new Promise((resolve, reject) => {
        const onMessage = (message) => { if (message.type === "ack") { worker.off("message", onMessage); worker.off("error", onError); resolve(); } };
        const onError = (error) => { worker.off("message", onMessage); reject(error); };
        worker.on("message", onMessage); worker.once("error", onError);
      });
      worker.postMessage({ type: "file", file: { id: file.id, path: file.path, language: file.language ?? "" }, source: sourceById.get(file.id) });
      await Promise.race([ack, outcome.then(() => { throw new Error("搜索任务已结束。"); })]);
    }
    worker.postMessage({ type: "finish" });
    const result = await outcome;
    return { ...result, revision: input.revision, filesSearched: candidates.length, offset: options.offset, pageSize: SEARCH_PAGE_SIZE };
  } finally {
    clearTimeout(timer);
    if (abortListener) signal?.removeEventListener("abort", abortListener);
    await worker.terminate();
  }
}
