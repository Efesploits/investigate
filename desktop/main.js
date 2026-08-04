"use strict";
const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const db = require("./db");
const checker = require("./checker");
const nicotine = require("./nicotine");
const updater = require("./updater");

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
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

/* ---------- account session (talks to the hosted server) ---------- */
const SERVER = process.env.M3_SERVER || "https://investigate.onrender.com";
let sessionToken = null;
const sessionFile = () => path.join(app.getPath("userData"), "session.json");
function loadSession() {
  try { sessionToken = JSON.parse(fs.readFileSync(sessionFile(), "utf8")).token || null; } catch (_) { sessionToken = null; }
}
function saveSession(token) {
  sessionToken = token || null;
  try {
    if (token) fs.writeFileSync(sessionFile(), JSON.stringify({ token }));
    else if (fs.existsSync(sessionFile())) fs.unlinkSync(sessionFile());
  } catch (_) {}
}
async function serverFetch(pathname, opts) {
  opts = opts || {};
  const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
  if (sessionToken) headers["Authorization"] = "Bearer " + sessionToken;
  const r = await fetch(SERVER + pathname, { method: opts.method || "GET", headers, body: opts.body });
  const text = await r.text();
  try { return text ? JSON.parse(text) : {}; } catch (_) { return {}; }
}

app.whenReady().then(() => {
  loadSession();
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

ipcMain.handle("db:listTables", async () => {
  try {
    return await db.listTables();
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("db:searchTable", async (_e, { table, term }) => {
  try {
    return await db.searchTable(table, term);
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

ipcMain.handle("db:pickSqlFile", async () => {
  const res = await dialog.showOpenDialog(win, {
    title: "Select a .sql dump file",
    properties: ["openFile"],
    filters: [
      { name: "SQL dump", extensions: ["sql"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (res.canceled || !res.filePaths.length) return { ok: false };
  const stat = fs.statSync(res.filePaths[0]);
  return { ok: true, path: res.filePaths[0], size: stat.size };
});

ipcMain.handle("db:importSqlFile", async (event, filePath) => {
  try {
    return await db.importSqlFile(filePath, (progress) => {
      event.sender.send("db:importProgress", progress);
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("update:check", async () => {
  try {
    return await updater.check(app.getVersion());
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("update:install", async (event, url) => {
  try {
    const res = await updater.install(url, (p) => {
      event.sender.send("update:progress", p);
    });
    // hand over to the swap script
    setTimeout(() => app.quit(), 400);
    return res;
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("app:version", async () => app.getVersion());

ipcMain.handle("osint:check", async (event, handle) => {
  try {
    const results = await checker.checkHandle(handle, (result) => {
      event.sender.send("osint:result", result);
    });
    return { ok: true, results };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("osint:lookup", async (_e, { query, type }) => {
  try {
    return await nicotine.osintLookup(query, type);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/* ---------- account auth (via the hosted server) ---------- */
ipcMain.handle("auth:me", async () => {
  if (!sessionToken) return { ok: true, user: null };
  try { return await serverFetch("/api/auth/me"); } catch (_) { return { ok: true, user: null }; }
});
ipcMain.handle("auth:register", async (_e, { username, password }) => {
  try {
    const r = await serverFetch("/api/auth/register", { method: "POST", body: JSON.stringify({ username, password }) });
    if (r && r.ok && r.token) saveSession(r.token);
    return r;
  } catch (_) { return { ok: false, error: "Connection error." }; }
});
ipcMain.handle("auth:login", async (_e, { username, password }) => {
  try {
    const r = await serverFetch("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
    if (r && r.ok && r.token) saveSession(r.token);
    return r;
  } catch (_) { return { ok: false, error: "Connection error." }; }
});
ipcMain.handle("auth:logout", async () => { saveSession(null); return { ok: true }; });
ipcMain.handle("search:start", async (_e, { ultra, type, query }) => {
  try { return await serverFetch("/api/search/start", { method: "POST", body: JSON.stringify({ ultra, type, query }) }); }
  catch (_) { return { ok: false, error: "Connection error." }; }
});

/* ---------- profile + bookmarks (via the hosted server) ---------- */
ipcMain.handle("me:update", async (_e, patch) => {
  try { return await serverFetch("/api/me", { method: "PATCH", body: JSON.stringify(patch || {}) }); }
  catch (_) { return { ok: false, error: "Connection error." }; }
});
ipcMain.handle("discord:connect", async (_e, discord_id) => {
  try { return await serverFetch("/api/discord/connect", { method: "POST", body: JSON.stringify({ discord_id }) }); }
  catch (_) { return { ok: false, error: "Connection error." }; }
});
ipcMain.handle("discord:disconnect", async () => {
  try { return await serverFetch("/api/discord/disconnect", { method: "POST" }); }
  catch (_) { return { ok: false, error: "Connection error." }; }
});
// open a vetted external link (the Lanyard invite) in the user's real browser
ipcMain.handle("open:external", async (_e, url) => {
  try { if (/^https:\/\//i.test(String(url))) await shell.openExternal(String(url)); } catch (_) {}
  return { ok: true };
});
ipcMain.handle("bookmarks:list", async () => {
  try { return await serverFetch("/api/bookmarks"); }
  catch (_) { return { ok: false, error: "Connection error." }; }
});
ipcMain.handle("bookmarks:add", async (_e, bm) => {
  try { return await serverFetch("/api/bookmarks", { method: "POST", body: JSON.stringify(bm || {}) }); }
  catch (_) { return { ok: false, error: "Connection error." }; }
});
ipcMain.handle("bookmarks:delete", async (_e, id) => {
  try { return await serverFetch("/api/bookmarks/" + encodeURIComponent(id), { method: "DELETE" }); }
  catch (_) { return { ok: false, error: "Connection error." }; }
});

/* ---------- members, announcements, admin (via the hosted server) ---------- */
const relay = (name, fn) => ipcMain.handle(name, async (_e, arg) => {
  try { return await fn(arg); } catch (_) { return { ok: false, error: "Connection error." }; }
});

relay("stats:get", () => serverFetch("/api/stats"));
relay("ann:list", () => serverFetch("/api/announcements"));
relay("ann:post", ({ title, body }) => serverFetch("/api/announcements", { method: "POST", body: JSON.stringify({ title, body }) }));
relay("ann:delete", (id) => serverFetch("/api/announcements/" + encodeURIComponent(id), { method: "DELETE" }));
relay("admin:users", () => serverFetch("/api/admin/users"));
relay("admin:patchUser", ({ id, patch }) => serverFetch("/api/admin/users/" + encodeURIComponent(id), { method: "PATCH", body: JSON.stringify(patch || {}) }));
relay("admin:grantTokens", ({ id, delta }) => serverFetch("/api/admin/users/" + encodeURIComponent(id) + "/tokens", { method: "POST", body: JSON.stringify({ delta }) }));
relay("admin:renameUser", ({ id, username }) => serverFetch("/api/admin/users/" + encodeURIComponent(id) + "/username", { method: "POST", body: JSON.stringify({ username }) }));
relay("admin:deleteUser", (id) => serverFetch("/api/admin/users/" + encodeURIComponent(id), { method: "DELETE" }));
relay("admin:logs", (limit) => serverFetch("/api/admin/logs?limit=" + (parseInt(limit, 10) || 200)));
relay("codes:redeem", (code) => serverFetch("/api/codes/redeem", { method: "POST", body: JSON.stringify({ code }) }));
relay("geoint:analyze", (payload) => serverFetch("/api/geoint/analyze", { method: "POST", body: JSON.stringify(payload || {}) }));
relay("geoint:streetview", ({ lat, lon }) => serverFetch("/api/geoint/streetview?lat=" + encodeURIComponent(lat) + "&lon=" + encodeURIComponent(lon)));
relay("geoint:regions", () => serverFetch("/api/geoint/regions"));
relay("geoint:pick", (payload) => serverFetch("/api/geoint/pick", { method: "POST", body: JSON.stringify(payload || {}) }));
relay("admin:codesList", () => serverFetch("/api/admin/codes"));
relay("admin:codeCreate", (payload) => serverFetch("/api/admin/codes", { method: "POST", body: JSON.stringify(payload || {}) }));
relay("admin:codeDelete", (id) => serverFetch("/api/admin/codes/" + encodeURIComponent(id), { method: "DELETE" }));
