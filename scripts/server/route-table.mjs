// @ts-check

/** @typedef {(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse, url: URL) => Promise<void>} Handler */
/** @typedef {[string, Handler]} Route */

/** @param {"GET" | "POST"} method @param {string | string[]} paths @param {Handler} handler @returns {Route[]} */
export function route(method, paths, handler) {
  return [paths].flat().map(path => [`${method} ${path}`, handler]);
}

/** @param {Route[][]} groups */
export function createRouteTable(groups) {
  /** @type {Map<string, Handler>} */
  const table = new Map();
  for (const [key, handler] of groups.flat()) {
    if (table.has(key)) throw new Error(`Duplicate local API route: ${key}`);
    table.set(key, handler);
  }
  return table;
}
