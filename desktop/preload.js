"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  connect: (cfg) => ipcRenderer.invoke("db:connect", cfg),
  disconnect: () => ipcRenderer.invoke("db:disconnect"),
  search: (term) => ipcRenderer.invoke("db:search", term),
  pickSqlite: () => ipcRenderer.invoke("db:pickSqlite"),
  listTables: () => ipcRenderer.invoke("db:listTables"),
  searchTable: (table, term) => ipcRenderer.invoke("db:searchTable", { table, term }),
});
