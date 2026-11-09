import { createServer } from "node:http";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RepositorySnapshot } from "../../data/model";
import type { Page } from "@playwright/test";

export async function withRealWorkspace(page: Page, run: (app: { repo: string; data: string; api: string; snapshot: RepositorySnapshot; open: () => Promise<RepositorySnapshot> }) => Promise<void>, options = { desktop: true }) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "repolens-real-ui-"));
  const repo = path.join(temp, "repo"), data = path.join(temp, "data");
  const renderer = path.resolve("desktop/renderer");
  let api = "", logs = "";
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      const file = path.resolve(renderer, "." + (pathname === "/" ? "/index.html" : decodeURIComponent(pathname)));
      if (!file.startsWith(renderer + path.sep)) { response.writeHead(403).end(); return; }
      let content = await readFile(file);
      if (file.endsWith(".html")) content = Buffer.from(content.toString().replace("</head>", `<script>globalThis.__REPOLENS_RUNTIME__=${JSON.stringify({ desktop: options.desktop, apiOrigin: api })}</script></head>`));
      response.setHeader("Content-Type", file.endsWith(".html") ? "text/html" : file.endsWith(".js") ? "application/javascript" : file.endsWith(".css") ? "text/css" : "application/octet-stream");
      response.end(content);
    } catch { response.writeHead(404).end(); }
  });
  await mkdir(repo); await mkdir(data); await writeFile(path.join(repo, "main.ts"), "export const value = 1;\n");
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const ui = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const child = fork("scripts/local-server.mjs", [], { env: { ...process.env, REPOLENS_PORT: "0", REPOLENS_USER_DATA_PATH: data, REPOLENS_ALLOWED_ORIGINS: ui }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  child.stdout?.on("data", chunk => { logs += chunk; }); child.stderr?.on("data", chunk => { logs += chunk; });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    const [ready] = await once(child, "message", { signal: AbortSignal.timeout(15000) }); api = `http://127.0.0.1:${ready.port}`;
    page.on("dialog", dialog => void dialog.accept());
    await page.goto(ui);
    const open = async () => {
      await page.locator("#repository-path").fill(repo);
      const response = page.waitForResponse(r => r.url() === api + "/api/open" && r.status() === 200);
      await page.getByRole("button", { name: "打开仓库", exact: true }).click();
      const snapshot = await (await response).json() as RepositorySnapshot;
      await page.getByRole("treeitem", { name: "main.ts", exact: true }).waitFor();
      await page.getByRole("tab", { name: "讲解", exact: true }).click();
      return snapshot;
    };
    await run({ repo, data, api, snapshot: await open(), open });
    if (errors.length) throw new Error(errors.join("\n"));
  } catch (error) { console.error(logs); throw error; }
  finally {
    if (child.exitCode === null) { const exited = once(child, "exit"); child.send({ type: "shutdown" }); await exited; }
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (!path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Unexpected temporary path");
    await rm(temp, { recursive: true, force: true });
  }
}
