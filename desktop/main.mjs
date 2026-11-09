import { waitForRendererDrafts } from "./renderer-close.mjs";
import { createModelSettingsStore } from "./model-settings.mjs";
import {
  readEditorPreference,
  validateCodeExecutable,
  findDefaultCodeExecutable,
  saveEditorPreference,
  launchCodeEditor,
} from "./editor-preference.mjs";
import { app, BrowserWindow, dialog, ipcMain, shell, safeStorage } from "electron";
import { fork } from "node:child_process";
import { createServer } from "node:http";
import { access, readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isTrustedDesktopSender, isTrustedDesktopUrl, isAllowedExternalLink } from "./security-policy.mjs";

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
let backendFailure = null;
let rendererFailure = null;
const logs = [];

// Allow isolated desktop smoke runs without touching a user's normal AppData.
if (process.env.REPOLENS_USER_DATA_PATH) app.setPath("userData", path.resolve(process.env.REPOLENS_USER_DATA_PATH));
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
let secondInstancePendingFocus = false;
function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}
if (hasSingleInstanceLock) app.on("second-instance", () => { if (mainWindow) focusMainWindow(); else secondInstancePendingFocus = true; });

function log(message) {
  logs.push(`${new Date().toISOString()} ${message}`);
  if (logs.length > 200) logs.shift();
  process.stdout.write(`[RepoLens] ${message}\n`);
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

async function startUiServer() {
  let targetApiOrigin = null;
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
    if (!targetApiOrigin) {
      response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" }).end("本地索引服务尚未就绪。");
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
      response.setHeader("Content-Security-Policy", `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${targetApiOrigin}; img-src 'self' data: blob:; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);
      if (extension === ".html") {
        const runtime = `<script nonce="${nonce}">globalThis.__REPOLENS_RUNTIME__=${JSON.stringify({ apiOrigin: targetApiOrigin, desktop: true })}</script>`;
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
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    setTargetApiOrigin(origin) { targetApiOrigin = origin; },
  };
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
    if (backendFailure) throw new Error(`本地索引服务曾意外退出：${backendFailure}`);
  })();
  return shutdownPromise;
}

async function createMainWindow(uiOrigin) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 375,
    minHeight: 600,
    backgroundColor: "#f6f7f8",
    show: false,
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalLink(url)) void shell.openExternal(url).catch(() => {});
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedDesktopUrl(url, uiOrigin)) event.preventDefault();
  });
  mainWindow.once("ready-to-show", () => { if (process.env.REPOLENS_SMOKE_HIDDEN !== "1") mainWindow?.show(); });
  await mainWindow.loadURL(`${uiOrigin}/`);
  mainWindow.on("close", (event) => {
    event.preventDefault();
    if (!quitting) app.quit();
  });
  mainWindow.on("closed", () => { mainWindow = undefined; });
}

async function start() {
  await app.whenReady();
  if (!hasSingleInstanceLock) return;
  const rendererIndex = path.join(rendererRoot, "index.html");
  await access(rendererIndex);
  await access(backendPath);
  const uiService = await startUiServer();
  const uiOrigin = uiService.origin;
  ipcMain.handle("repository:select-directory", async (event) => {
    if (!isTrustedDesktopSender(event, mainWindow?.webContents, uiOrigin)) throw new Error("未授权的桌面目录选择请求。");
    const result = await dialog.showOpenDialog(mainWindow, { title: "打开本地仓库", properties: ["openDirectory"] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  let editorBusy = false;
  ipcMain.handle("editor:open", async (event, input) => {
    if (!isTrustedDesktopSender(event, mainWindow?.webContents, uiOrigin)) throw new Error("未授权的编辑器请求。");
    if (editorBusy) throw new Error("正在打开源码，请稍候。");
    editorBusy = true;
    try {
      if (!input || typeof input !== "object" || Object.keys(input).some(key => !["repositoryId", "revision", "persistenceSessionId", "fileId", "contentHash", "line"].includes(key))) throw new Error("源码位置无效。");
      const pref = await readEditorPreference(app.getPath("userData"));
      let executable = null;
      if (pref.status === "configured") {
        const check = await validateCodeExecutable(pref.executable);
        if (check.ok) executable = pref.executable;
      }
      if (!executable) {
        executable = await findDefaultCodeExecutable();
        if (!executable) {
          const selected = await dialog.showOpenDialog(mainWindow, {
            title: "选择 VS Code 程序 Code.exe",
            filters: [{ name: "VS Code", extensions: ["exe"] }],
            properties: ["openFile"],
          });
          if (selected.canceled) return false;
          const chosen = selected.filePaths[0];
          const check = await validateCodeExecutable(chosen);
          if (!check.ok) throw new Error(check.reason);
          executable = chosen;
        }
        await saveEditorPreference(app.getPath("userData"), executable);
      }
      const target = await new Promise((resolve, reject) => {
        const id = randomBytes(16).toString("hex"); const child = backend;
        const cleanup = () => { clearTimeout(timer); child?.off("message", onMessage); child?.off("exit", onExit); };
        const onExit = () => { cleanup(); reject(new Error("本地服务已停止。")); };
        const onMessage = message => { if (message?.type !== "editor:resolved" || message.id !== id) return; cleanup(); if (message.error) reject(new Error(message.error)); else resolve(message.target); };
        const timer = setTimeout(() => { cleanup(); reject(new Error("源码核验超时，请重试。")); }, 5000);
        child?.on("message", onMessage); child?.once("exit", onExit);
        if (!child?.connected) { cleanup(); reject(new Error("本地服务已停止。")); } else child.send({ type: "editor:resolve", id, input });
      });
      await launchCodeEditor(executable, target, { cwd: app.getPath("userData") });
      return true;
    } finally { editorBusy = false; }
  });
  const modelSettingsStore = createModelSettingsStore(app.getPath("userData"), safeStorage);
  let restoredModelSettings = null;
  let settingsWarning = false;
  try { restoredModelSettings = await modelSettingsStore.read(); } catch { settingsWarning = true; }
  backend = fork(backendPath, [], {
    cwd: app.getPath("userData"),
    execArgv: [],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      REPOLENS_DESKTOP: "1",
      REPOLENS_PORT: "0",
      REPOLENS_DESKTOP_SETTINGS: "1",
      ...(restoredModelSettings ? { REPOLENS_AI_AUTH_MODE: restoredModelSettings.authMode ?? "key", REPOLENS_AI_BASE_URL: restoredModelSettings.baseUrl, REPOLENS_AI_MODEL: restoredModelSettings.model, REPOLENS_AI_API_KEY: restoredModelSettings.apiKey } : {}),
      REPOLENS_UI_PORT: new URL(uiOrigin).port,
      REPOLENS_ALLOWED_ORIGINS: uiOrigin,
      REPOLENS_USER_DATA_PATH: app.getPath("userData"),
      REPOLENS_TEMP_ROOT: path.join(app.getPath("temp"), "repolens"),
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  backend.on("message", (message) => {
    if (message?.type !== "model-settings:save" || typeof message.id !== "number") return;
    void modelSettingsStore.save(message.settings).then(() => {
      if (backend?.connected) backend.send({ type: "model-settings:saved", id: message.id, ok: true });
    }, () => {
      if (backend?.connected) backend.send({ type: "model-settings:saved", id: message.id, ok: false });
    });
  });
  backend.stdout?.on("data", (chunk) => log(chunk.toString("utf8").trimEnd()));
  backend.stderr?.on("data", (chunk) => log(chunk.toString("utf8").trimEnd()));
  backend.on("error", (error) => {
    log(`本地服务无法运行：${error.message}`);
    reportBackendFailure("本地服务无法启动。请重新启动 RepoLens 后再试。");
  });
  backend.on("exit", (code, signal) => {
    if (!quitting) {
      log(`本地服务意外退出：${JSON.stringify({ code, signal })}`);
      reportBackendFailure("本地服务意外停止。请重新启动 RepoLens 后继续操作。");
    }
  });

  const apiPort = await new Promise((resolve, reject) => {
    const child = backend;
    const cleanup = () => {
      clearTimeout(timer);
      child?.off("message", onMessage);
      child?.off("exit", onExit);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`本地索引服务在就绪前退出（code: ${code}, signal: ${signal}）。`));
    };
    const onMessage = (message) => {
      if (message?.type !== "backend:ready") return;
      const port = Number(message.port);
      if (Number.isInteger(port) && port > 0 && port <= 65535) {
        cleanup();
        resolve(port);
      } else {
        cleanup();
        reject(new Error(`本地索引服务报告的端口无效：${message?.port}。`));
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("等待本地索引服务就绪超时。"));
    }, 20_000);
    child?.on("message", onMessage);
    child?.once("exit", onExit);
  });

  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  await waitForBackend(apiOrigin, backend);
  uiService.setTargetApiOrigin(apiOrigin);
  await createMainWindow(uiOrigin);
  if (settingsWarning) await dialog.showMessageBox(mainWindow, { type: "warning", message: "无法恢复上次的模型配置，请重新配置。原文件已保留。" });
  if (secondInstancePendingFocus) { secondInstancePendingFocus = false; focusMainWindow(); }
}

ipcMain.handle("desktop:quit", (event) => {
  const uiOrigin = uiServer?.address()?.port ? `http://127.0.0.1:${uiServer.address().port}` : "";
  if (!isTrustedDesktopSender(event, mainWindow?.webContents, uiOrigin)) {
    const senderFrame = event?.senderFrame;
    throw new Error(`未授权的桌面退出请求（sender=${event?.sender === mainWindow?.webContents}, primaryFrame=${senderFrame === event?.sender?.mainFrame}, frameUrl=${senderFrame?.url ?? "unavailable"}, expectedOrigin=${uiOrigin || "unavailable"}）。`);
  }
  app.quit();
});
function reportBackendFailure(message) {
  if (backendFailure || quitting) return;
  backendFailure = message;
  log(message);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("desktop:backend-status", { available: false, message });
}
async function flushRendererDrafts() {
  const uiOrigin = uiServer?.address()?.port ? `http://127.0.0.1:${uiServer.address().port}` : "";
  return waitForRendererDrafts({ window: mainWindow, ipc: ipcMain, uiOrigin, requestId: randomBytes(24).toString("hex"), isTrustedSender: isTrustedDesktopSender });
}
app.on("before-quit", (event) => {
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  void (async () => {
    try { await flushRendererDrafts(); }
    catch (error) {
      if (error.code === "RENDERER_UNAVAILABLE") rendererFailure ??= error.message;
      if (!backendFailure && !rendererFailure) {
        quitting = false;
        if (process.env.REPOLENS_SMOKE_HIDDEN === "1") { log(error.message); return; }
        await dialog.showMessageBox(mainWindow, { type: "error", title: "草稿尚未保存", message: error.message });
        return;
      }
    }
    await stopBackend();
    app.exit(rendererFailure ? 1 : 0);
  })().catch(async (error) => {
    if (process.env.REPOLENS_SMOKE_HIDDEN === "1") { log(error.message); app.exit(1); return; }
    await dialog.showMessageBox({ type: "error", title: backendFailure ? "RepoLens 服务异常" : "RepoLens 清理失败", message: backendFailure ? "本地索引服务曾意外停止。请重新启动 RepoLens。" : "RepoLens 未能完成退出清理。请检查应用日志后重试。", detail: error.message });
    app.exit(1);
  });
});
app.on("window-all-closed", () => app.quit());
app.on("activate", () => {
  if (!mainWindow && !quitting) void createMainWindow(`http://127.0.0.1:${uiServer.address().port}`);
});
app.on("render-process-gone", (_event, contents, details) => {
  log(`渲染页面退出：${JSON.stringify(details)}`);
  if (contents === mainWindow?.webContents && details.reason !== "clean-exit") rendererFailure = "窗口页面曾意外停止。";
});
app.on("child-process-gone", (_event, details) => log(`子进程退出：${JSON.stringify(details)}`));
app.on("will-quit", () => { ipcMain.removeHandler("repository:select-directory"); });
app.on("ready", () => {
  app.setAppUserModelId("org.repolens.desktop");
  void start().catch(async (error) => {
    log(error instanceof Error ? error.stack ?? error.message : String(error));
    await dialog.showMessageBox({ type: "error", title: "RepoLens 启动失败", message: "RepoLens 未能启动。请检查应用日志后重试。", detail: error instanceof Error ? error.message : String(error) });
    app.quit();
  });
});
