import { readFile } from "node:fs/promises";

/**
 * Sites hosting bindings are deployment-specific and are absent from a clean
 * source checkout. Local development and the browser build use empty bindings.
 *
 * @param {string | URL} configPath
 * @returns {Promise<{d1: string | null, r2: string | null}>}
 */
export async function readSitesHostingConfig(configPath) {
  let content;
  try {
    content = await readFile(configPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { d1: null, r2: null };
    throw error;
  }

  const config = JSON.parse(content);
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(".openai/hosting.json 必须是 JSON 对象。");
  }
  const binding = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
  return { d1: binding(config.d1), r2: binding(config.r2) };
}
