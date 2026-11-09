export function rendererUnavailableError() {
  return Object.assign(new Error("窗口页面已停止响应，退出前将清理本地服务。"), { code: "RENDERER_UNAVAILABLE" });
}

export async function waitForRendererDrafts({ window, ipc, uiOrigin, requestId, isTrustedSender, timeoutMs = 4000 }) {
  if (!window) return;
  if (window.isDestroyed()) throw rendererUnavailableError();
  const contents = window.webContents;
  if (contents.isDestroyed() || contents.isCrashed()) throw rendererUnavailableError();
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      ipc.removeListener("desktop:prepared-close", prepared);
      contents.removeListener("render-process-gone", unavailable);
      contents.removeListener("destroyed", unavailable);
    };
    const unavailable = () => { cleanup(); reject(rendererUnavailableError()); };
    const prepared = (event, result) => {
      if (!isTrustedSender(event, contents, uiOrigin) || result?.id !== requestId) return;
      cleanup();
      if (result.ok === true) resolve();
      else reject(new Error("聊天草稿尚未保存。请重试草稿保存后再退出。"));
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error("未能确认聊天草稿已保存，请稍后重试退出。")); }, timeoutMs);
    ipc.on("desktop:prepared-close", prepared);
    contents.once("render-process-gone", unavailable);
    contents.once("destroyed", unavailable);
    try { contents.send("desktop:prepare-close", requestId); }
    catch { unavailable(); }
  });
}
