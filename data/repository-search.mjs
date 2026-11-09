import { Worker } from "node:worker_threads";
import { buildSearchMatcher, describeSearchMatch } from "./search-match.mjs";

export const SEARCH_PAGE_SIZE = 100;
export const SEARCH_MAX_RESULTS = 10_000;
export const SEARCH_TIMEOUT_MS = 5_000;
export const SEARCH_BATCH_MAX_FILES = 50;
export const SEARCH_BATCH_MAX_BYTES = 2 * 1024 * 1024;

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

const SEARCH_WORKER = [buildSearchMatcher.toString(), describeSearchMatch.toString(), String.raw`
const { parentPort, workerData } = require('node:worker_threads');
let matcher;
try {
  if (!workerData.query.trim()) throw new Error('搜索内容不能为空。');
  matcher = buildSearchMatcher(workerData);
} catch (error) {
  parentPort.postMessage({ type: 'error', message: '正则表达式无效：' + error.message });
}
if (matcher) {
  let filesSearched = 0;
  let total = 0;
  const page = [];
  let capped = false;

  function processFile(file, source) {
    if (capped || !file) return;
    filesSearched++;
    if (!source) return;
    const lines = source.split('\n');
    for (let index = 0; index < lines.length; index++) {
      matcher.lastIndex = 0;
      const match = matcher.exec(lines[index]);
      if (!match) continue;
      if (total >= workerData.offset && page.length < workerData.pageSize) {
        page.push({ fileId: file.id, path: file.path, language: file.language || '', line: index + 1, ...describeSearchMatch(lines[index], match) });
      }
      total++;
      if (total >= workerData.maxResults) { capped = true; break; }
    }
  }

  parentPort.on('message', (message) => {
    if (message.type === 'batch') {
      const items = message.files;
      if (Array.isArray(items)) {
        for (let i = 0; i < items.length; i++) {
          processFile(items[i].file, items[i].source);
          if (capped) break;
        }
      }
      parentPort.postMessage({ type: 'ack', total, capped });
    } else if (message.type === 'file') {
      processFile(message.file, message.source);
      parentPort.postMessage({ type: 'ack', total, capped });
    } else if (message.type === 'finish') {
      parentPort.postMessage({ type: 'done', filesSearched, total, results: page, hasMore: total > workerData.offset + page.length, capped });
    }
  });
}
`].join("\n");

function filterFiles(files, sourceById, options) {
  return files.filter((file) => {
    if (!sourceById.has(file.id)) return false;
    if (options.pathPrefix && file.path !== options.pathPrefix && !file.path.startsWith(`${options.pathPrefix}/`)) return false;
    if (options.language && String(file.language ?? "").toLowerCase() !== options.language.toLowerCase()) return false;
    if (options.excludeTests && /(^|[/_.-])(test|tests|spec|specs)([/_.-]|$)|\.(test|spec)\./i.test(file.path)) return false;
    return true;
  }).sort((a, b) => a.path.localeCompare(b.path));
}

export function partitionSearchFiles(candidates, sourceById, { maxFiles = SEARCH_BATCH_MAX_FILES, maxBytes = SEARCH_BATCH_MAX_BYTES } = {}) {
  const batches = [];
  let currentBatch = [];
  let currentBytes = 0;
  for (const file of candidates) {
    const source = sourceById.get(file.id);
    if (source === undefined) continue;
    const sourceBytes = Buffer.byteLength(source, "utf8");
    if (currentBatch.length >= maxFiles || (currentBatch.length > 0 && currentBytes + sourceBytes > maxBytes)) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBytes = 0;
    }
    currentBatch.push({ file: { id: file.id, path: file.path, language: file.language ?? "" }, source });
    currentBytes += sourceBytes;
  }
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }
  return batches;
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

  const batches = partitionSearchFiles(candidates, sourceById);

  try {
    for (const batch of batches) {
      if (signal?.aborted) throw Object.assign(new Error("搜索已取消。"), { name: "AbortError" });
      const ack = new Promise((resolve, reject) => {
        const onMessage = (message) => {
          if (message.type === "ack") {
            worker.off("message", onMessage);
            worker.off("error", onError);
            resolve(message);
          }
        };
        const onError = (error) => {
          worker.off("message", onMessage);
          reject(error);
        };
        worker.on("message", onMessage);
        worker.once("error", onError);
      });
      worker.postMessage({ type: "batch", files: batch });
      const ackResult = await Promise.race([ack, outcome.then(() => { throw new Error("搜索任务已结束。"); })]);
      if (ackResult?.capped) {
        break;
      }
    }
    worker.postMessage({ type: "finish" });
    const result = await outcome;
    return { ...result, revision: input.revision, candidateFiles: candidates.length, offset: options.offset, pageSize: SEARCH_PAGE_SIZE };
  } finally {
    clearTimeout(timer);
    if (abortListener) signal?.removeEventListener("abort", abortListener);
    await worker.terminate();
  }
}
