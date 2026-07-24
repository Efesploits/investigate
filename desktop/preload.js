"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  connect: (cfg) => ipcRenderer.invoke("db:connect", cfg),
  disconnect: () => ipcRenderer.invoke("db:disconnect"),
  search: (term) => ipcRenderer.invoke("db:search", term),
  pickSqlite: () => ipcRenderer.invoke("db:pickSqlite"),
  listTables: () => ipcRenderer.invoke("db:listTables"),
  searchTable: (table, term) => ipcRenderer.invoke("db:searchTable", { table, term }),
  pickSqlFile: () => ipcRenderer.invoke("db:pickSqlFile"),
  importSqlFile: (filePath) => ipcRenderer.invoke("db:importSqlFile", filePath),
  onImportProgress: (cb) => ipcRenderer.on("db:importProgress", (_e, data) => cb(data)),
  checkHandle: (handle) => ipcRenderer.invoke("osint:check", handle),
  onOsintResult: (cb) => ipcRenderer.on("osint:result", (_e, data) => cb(data)),
  appVersion: () => ipcRenderer.invoke("app:version"),
  checkUpdate: () => ipcRenderer.invoke("update:check"),
  installUpdate: (url) => ipcRenderer.invoke("update:install", url),
  onUpdateProgress: (cb) => ipcRenderer.on("update:progress", (_e, data) => cb(data)),
});
