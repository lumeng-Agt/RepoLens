const { contextBridge, ipcRenderer } = require("electron");
const closeListeners = new Set();
ipcRenderer.on("desktop:prepare-close", async (_event, id) => {
  let ok = true;
  try { await Promise.all([...closeListeners].map(listener => listener())); }
  catch { ok = false; }
  ipcRenderer.send("desktop:prepared-close", { id, ok });
});

contextBridge.exposeInMainWorld("repoLens", Object.freeze({
  selectDirectory: () => ipcRenderer.invoke("repository:select-directory"),
  openInEditor: (input) => ipcRenderer.invoke("editor:open", input),
  quit: () => ipcRenderer.invoke("desktop:quit"),
  onBeforeClose: (listener) => {
    closeListeners.add(listener);
    return () => { closeListeners.delete(listener); };
  },
  onBackendStatus: (listener) => {
    const handler = (_event, status) => listener(status);
    ipcRenderer.on("desktop:backend-status", handler);
    return () => ipcRenderer.removeListener("desktop:backend-status", handler);
  },
}));
