import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

const SAFE_KEYS = new Set(["repositoryId", "mode", "sequence", "fileCount", "dependencyCount", "sourceReadCount", "sourceParseCount", "configParseCount", "cached", "action"]);
const SAFE_ACTIONS = new Set(["recent-touch", "recent-remove", "progress", "node-positions", "ai-result", "ai-route", "conversations", "clear-all", "clear-repository"]);

function safeDetails(value = {}) {
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!SAFE_KEYS.has(key)) continue;
    if (key === "action") {
      if (typeof item === "string" && SAFE_ACTIONS.has(item)) result[key] = item;
    } else if (typeof item === "string" && item.length <= 160) result[key] = item;
    else if (typeof item === "number" && Number.isFinite(item)) result[key] = item;
    else if (typeof item === "boolean") result[key] = item;
  }
  return result;
}

export function createOperationRecorder({ capacity = 200, onRecord = () => {} } = {}) {
  const records = [];
  return {
    start(operation, details = {}) {
      const id = randomUUID();
      const startedAt = performance.now();
      let finished = false;
      return {
        id,
        finish(status, outcome = {}) {
          if (finished) return null;
          finished = true;
          const record = {
            id,
            operation,
            status: ["ok", "error", "cancelled", "stale"].includes(status) ? status : "error",
            durationMs: Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100),
            ...safeDetails(details),
            ...safeDetails(outcome),
          };
          records.push(record);
          while (records.length > capacity) records.shift();
          onRecord(record);
          return { ...record };
        },
      };
    },
    recent() { return records.map((record) => ({ ...record })); },
  };
}
