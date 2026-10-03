import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { fork } from "node:child_process";
import { createServer } from "node:http";
import { access, readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const rendererRoot = path.join(here, "renderer");
const backendPath = path.join(projectRoot, "scripts", "local-server.mjs");
const uiFiles = new Map([
  [".css", "text/css; charset=utf-8"], [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"], [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"], [".png", "image/png"],
  [".svg", "image/svg+xml"], [".wasm", "application/wasm"], [".woff2", "font/woff2"],
]);

let backend;
let uiServer;
let mainWindow;
let quitting = false;
let shutdownPromise;
const logs = [];

// Allow isolated desktop smoke runs without touching a user's normal AppData.
if (process.env.REPOLENS_USER_DATA_PATH) app.setPath("userData", path.resolve(process.env.REPOLENS_USER_DATA_PATH));

function log(message) {
  logs.push(`${new Date().toISOString()} ${message}`);
  if (logs.length > 200) logs.shift();
  process.stdout.write(`[RepoLens] ${message}\n`);
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        reject(new Error("无法为本地索引服务分配端口。"));
        return;
      }
      probe.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function safeUiPath(requestUrl) {
  const pathname = new URL(requestUrl, "http://127.0.0.1").pathname;
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes("\\") || decoded.split("/").includes("..")) return null;
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const absolute = path.resolve(rendererRoot, relative);
  return absolute.startsWith(rendererRoot + path.sep) || absolute === path.join(rendererRoot, "index.html") ? absolute : null;
}

async function startUiServer(apiOrigin) {
  const server = createServer(async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    const target = safeUiPath(request.url ?? "/");
    if (!target) {
      response.writeHead(400).end();
      return;
    }
    try {
      let contents = await readFile(target);
      const extension = path.extname(target).toLowerCase();
      response.setHeader("Content-Type", uiFiles.get(extension) ?? "application/octet-stream");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("Cache-Control", extension === ".html" ? "no-store" : "public, max-age=31536000, immutable");
      const nonce = randomBytes(18).toString("base64");
      response.setHeader("Content-Security-Policy", `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${apiOrigin}; img-src 'self' data: blob:; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);
      if (extension === ".html") {
        const runtime = `<script nonce="${nonce}">globalThis.__REPOLENS_RUNTIME__=${JSON.stringify({ apiOrigin, desktop: true })}</script>`;
        contents = Buffer.from(contents.toString("utf8").replace("</head>", `${runtime}</head>`));
      }
      response.writeHead(200, { "Content-Length": contents.length });
      response.end(request.method === "HEAD" ? undefined : contents);
    } catch {
      response.writeHead(404).end("Not found");
    }
  });
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法启动桌面界面服务。");
  uiServer = server;
  return `http://127.0.0.1:${address.port}`;
}

async function waitForBackend(origin, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`本地索引服务提前退出（${child.exitCode}）。`);
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error("本地索引服务启动超时。");
}

function stopBackend() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    if (backend && backend.exitCode === null) {
      const exited = new Promise((resolve) => backend.once("exit", (code, signal) => resolve({ code, signal })));
      const timer = new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 20_000));
      backend.send({ type: "shutdown" });
      const result = await Promise.race([exited, timer]);
      if ("timeout" in result) {
        backend.kill();
        await exited;
        throw new Error("本地索引服务未在 20 秒内完成清理，已结束服务进程。\n" + logs.join("\n"));
      }
      if (result.code !== 0 || result.signal) throw new Error(`本地索引服务退出异常：${JSON.stringify(result)}\n${logs.join("\n")}`);
    }
    if (uiServer) await new Promise((resolve, reject) => uiServer.close((error) => error ? reject(error) : resolve()));
  })();
  return shutdownPromise;
}

async function createMainWindow(uiOrigin) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 375,
    minHeight: 600,
    backgroundColor: "#0b1015",
    show: false,
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(uiOrigin + "/")) event.preventDefault();
  });
  mainWindow.once("ready-to-show", () => { if (process.env.REPOLENS_SMOKE_HIDDEN !== "1") mainWindow?.show(); });
  await mainWindow.loadURL(`${uiOrigin}/`);
  mainWindow.on("closed", () => { mainWindow = undefined; });
}

async function start() {
  await app.whenReady();
  const rendererIndex = path.join(rendererRoot, "index.html");
  await access(rendererIndex);
  await access(backendPath);
  const apiPort = await reservePort();
  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  const uiOrigin = await startUiServer(apiOrigin);
  ipcMain.handle("repository:select-directory", async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: "打开本地仓库", properties: ["openDirectory"] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  backend = fork(backendPath, [], {
    cwd: app.getPath("userData"),
    execArgv: [],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      REPOLENS_PORT: String(apiPort),
      REPOLENS_UI_PORT: new URL(uiOrigin).port,
      REPOLENS_ALLOWED_ORIGINS: uiOrigin,
      REPOLENS_USER_DATA_PATH: app.getPath("userData"),
      REPOLENS_TEMP_ROOT: path.join(app.getPath("temp"), "repolens"),
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  backend.stdout?.on("data", (chunk) => log(chunk.toString("utf8").trimEnd()));
  backend.stderr?.on("data", (chunk) => log(chunk.toString("utf8").trimEnd()));
  await waitForBackend(apiOrigin, backend);
  await createMainWindow(uiOrigin);
}

ipcMain.handle("desktop:quit", () => app.quit());
app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void stopBackend().then(() => app.exit(0), async (error) => {
    await dialog.showMessageBox({ type: "error", title: "RepoLens 清理失败", message: error.message });
    app.exit(1);
  });
});
app.on("window-all-closed", () => app.quit());
app.on("activate", () => {
  if (!mainWindow && !quitting) void createMainWindow(`http://127.0.0.1:${uiServer.address().port}`);
});
app.on("render-process-gone", (_event, _webContents, details) => log(`渲染页面退出：${JSON.stringify(details)}`));
app.on("child-process-gone", (_event, details) => log(`子进程退出：${JSON.stringify(details)}`));
app.on("will-quit", () => { ipcMain.removeHandler("repository:select-directory"); });
app.on("ready", () => {
  app.setAppUserModelId("org.repolens.desktop");
  void start().catch(async (error) => {
    log(error instanceof Error ? error.stack ?? error.message : String(error));
    await dialog.showMessageBox({ type: "error", title: "RepoLens 启动失败", message: String(error) });
    app.quit();
  });
});
