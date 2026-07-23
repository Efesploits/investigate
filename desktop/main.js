"use strict";
const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const db = require("./db");

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: "#000000",
    title: "m3's investigation tool",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", async () => {
  await db.disconnect();
  if (process.platform !== "darwin") app.quit();
});

// ---------- IPC ----------
ipcMain.handle("db:connect", async (_e, cfg) => {
  try {
    return await db.connect(cfg);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("db:disconnect", async () => {
  await db.disconnect();
  return { ok: true };
});

ipcMain.handle("db:search", async (_e, term) => {
  try {
    return await db.search(term);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("db:pickSqlite", async () => {
  const res = await dialog.showOpenDialog(win, {
    title: "Select a SQLite database file",
    properties: ["openFile"],
    filters: [
      { name: "SQLite database", extensions: ["db", "sqlite", "sqlite3", "db3"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (res.canceled || !res.filePaths.length) return { ok: false };
  return { ok: true, path: res.filePaths[0] };
});
