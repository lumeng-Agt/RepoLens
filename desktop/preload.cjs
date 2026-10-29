/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("repoLens", Object.freeze({
  selectDirectory: () => ipcRenderer.invoke("repository:select-directory"),
  openInEditor: (input) => ipcRenderer.invoke("editor:open", input),
  quit: () => ipcRenderer.invoke("desktop:quit"),
  onBackendStatus: (listener) => {
    const handler = (_event, status) => listener(status);
    ipcRenderer.on("desktop:backend-status", handler);
    return () => ipcRenderer.removeListener("desktop:backend-status", handler);
  },
}));
