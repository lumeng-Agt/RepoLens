/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("repoLens", Object.freeze({
  selectDirectory: () => ipcRenderer.invoke("repository:select-directory"),
  quit: () => ipcRenderer.invoke("desktop:quit"),
}));
