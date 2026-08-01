const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");
const { checkHandle } = require("./checker");
const store = require("./store");
const auth = require("./auth");

// Never let a stray async error take the whole server down (Render restart loop).
process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e && e.stack ? e.stack : e));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e && e.stack ? e.stack : e));

const app = express();
const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === "production";

const SEARCH_COST = 1;
const ULTRA_COST = 3;

app.set("trust proxy", 1);
app.use(express.json({ limit: "8mb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

/* ---------------- Discord search webhook (unchanged, fire-and-forget) --------- */
function notifyDiscord(req, type, query, username) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;
  const content = [
    "🔎 **New investigation search**",
    "• User: `" + (username || "anon") + "`",
    "• Type: `" + type + "`",
    "• Query: `" + String(query).slice(0, 200) + "`",
    "• Device: `" + String(req.headers["user-agent"] || "unknown").slice(0, 300) + "`",
  ].join("\n");
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: content.slice(0, 1900) }),
  }).catch(() => {});
}

/* ============================= auth middleware ============================= */
// resolve the logged-in user from cookie/bearer; also refresh last_seen
async function loadUser(req) {
  const tok = auth.tokenFromReq(req);
  if (!tok) return null;
  const payload = auth.verify(tok);
  if (!payload || payload.kind !== "session" || !payload.uid) return null;
  const user = await store.getUserById(payload.uid);
  return user || null;
}
async function optionalAuth(req, _res, next) {
  try { req.user = await loadUser(req); } catch (_) { req.user = null; }
  if (req.user) store.touchLastSeen(req.user.id).catch(() => {});
  next();
}
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "Not signed in." });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.user || !auth.isAdmin(req.user)) return res.status(403).json({ ok: false, error: "Admins only." });
  next();
}
app.use("/api", optionalAuth);

const meShape = (u) => ({ ...store.publicUser(u), is_admin: auth.isAdmin(u) });
function setSessionCookie(res, token) {
  res.cookie("session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: PROD,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: "/",
  });
}

const USERNAME_RE = /^[A-Za-z0-9._-]{3,20}$/;

/* ============================= auth routes ============================= */
app.post("/api/auth/register", async (req, res) => {
  const username = String((req.body && req.body.username) || "").trim();
  const password = String((req.body && req.body.password) || "");
  if (!USERNAME_RE.test(username)) return res.status(400).json({ ok: false, error: "Username must be 3–20 chars (letters, numbers, . _ -)." });
  if (password.length < 6) return res.status(400).json({ ok: false, error: "Password must be at least 6 characters." });
  if (await store.getUserByUsername(username)) return res.status(409).json({ ok: false, error: "That username is taken." });

  const isAdminName = username.toLowerCase() === auth.ADMIN_USERNAME;
  const user = await store.createUser({
    username,
    password_hash: await auth.hashPassword(password),
    role: isAdminName ? "admin" : "user",
  });
  const token = auth.signSession(user);
  setSessionCookie(res, token);
  res.json({ ok: true, user: meShape(user), token });
});

app.post("/api/auth/login", async (req, res) => {
  const username = String((req.body && req.body.username) || "").trim();
  const password = String((req.body && req.body.password) || "");
  const user = await store.getUserByUsername(username);
  if (!user || !(await auth.verifyPassword(password, user.password_hash))) {
    return res.status(401).json({ ok: false, error: "Wrong username or password." });
  }
  // keep the configured admin promoted
  if (username.toLowerCase() === auth.ADMIN_USERNAME && user.role !== "admin") {
    await store.updateUser(user.id, { role: "admin" });
    user.role = "admin";
  }
  await store.touchLastSeen(user.id);
  const token = auth.signSession(user);
  setSessionCookie(res, token);
  res.json({ ok: true, user: meShape(user), token });
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("session", { path: "/" });
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  if (!req.user) return res.json({ ok: true, user: null });
  res.json({ ok: true, user: meShape(req.user) });
});

/* ============================= profile ============================= */
app.patch("/api/me", requireAuth, async (req, res) => {
  const patch = {};
  const b = req.body || {};
  if (typeof b.banner === "string") patch.banner = b.banner.slice(0, 2_000_000) || null;
  if (typeof b.avatar === "string") patch.avatar = b.avatar.slice(0, 2_000_000) || null;
  if (typeof b.bio === "string") patch.bio = b.bio.slice(0, 300);
  if (typeof b.password === "string" && b.password) {
    if (b.password.length < 6) return res.status(400).json({ ok: false, error: "Password must be at least 6 characters." });
    patch.password_hash = await auth.hashPassword(b.password);
  }
  const updated = await store.updateUser(req.user.id, patch);
  res.json({ ok: true, user: meShape(updated) });
});

/* ============================= token metering ============================= */
// start a search: charge tokens up-front, hand back a short-lived search token
app.post("/api/search/start", requireAuth, async (req, res) => {
  const ultra = !!(req.body && req.body.ultra);
  const type = String((req.body && req.body.type) || "").toLowerCase();
  const query = String((req.body && req.body.query) || "").trim();
  const cost = ultra ? ULTRA_COST : SEARCH_COST;

  const spent = await store.spendTokens(req.user.id, cost);
  if (!spent) {
    return res.status(402).json({ ok: false, error: "Not enough tokens.", need: cost, have: req.user.tokens });
  }
  store.addSearchLog({ user_id: req.user.id, username: req.user.username, type, query, ultra, cost }).catch(() => {});
  const searchToken = auth.signSearch(spent, ultra);
  res.json({ ok: true, searchToken, tokens: spent.tokens, cost });
});

// a request carries a valid paid search session (in header, or ?st= for EventSource)
function searchSession(req) {
  const st = (req.headers["x-search-token"]) || (req.query && req.query.st) || null;
  if (!st) return null;
  const p = auth.verify(st);
  if (!p || p.kind !== "search" || !p.uid) return null;
  return p;
}
function requireSearch(req, res, next) {
  const s = searchSession(req);
  if (!s) return res.status(402).json({ ok: false, error: "No paid search session. Press Search to spend a token." });
  req.search = s;
  next();
}

/* ============================= health / storage ============================= */
// Tells the UI whether accounts are stored durably. When durable is false the
// app is on the ephemeral JSON store and accounts vanish on Render spin-down —
// admins get the underlying error + fix hint so it can be corrected.
app.get("/api/health", (req, res) => {
  const info = store.backendInfo();
  const out = { ok: true, durable: info.durable, backend: info.backend };
  if (req.user && auth.isAdmin(req.user)) {
    out.configured = info.configured;
    out.error = info.error;
    if (!info.durable) {
      out.hint = "Set FIREBASE_SERVICE_ACCOUNT on Render (full service-account JSON, or its base64). Firestore must be in NATIVE mode. Until then accounts reset on every spin-down.";
    }
  }
  res.json(out);
});

/* ============================= stats / users ============================= */
app.get("/api/stats", async (_req, res) => {
  const users = await store.listUsers();
  const cut = Date.now() - 5 * 60 * 1000;
  // public card shape — never leak token balances or last_seen precision
  const card = (u) => ({
    id: u.id, username: u.username, role: u.role,
    banner: u.banner || null, avatar: u.avatar || null, bio: u.bio || null,
    discord_id: u.discord_id || null, discord_username: u.discord_username || null,
    online: new Date(u.last_seen).getTime() > cut,
  });
  const list = users.map(card);
  res.json({
    ok: true,
    totalUsers: users.length,
    activeUsers: list.filter((u) => u.online).length,
    users: list,
  });
});

/* ============================= table (saved results) ============================= */
// Everyone gets the same allowance; a saved entry carries the whole result
// snapshot, so we also cap its size to stay well under Firestore's 1MB doc limit.
const TABLE_LIMIT = parseInt(process.env.TABLE_LIMIT || "10", 10);
const TABLE_MAX_BYTES = 600 * 1024;

app.get("/api/bookmarks", requireAuth, async (req, res) => {
  const bookmarks = await store.listBookmarks(req.user.id);
  res.json({ ok: true, bookmarks, limit: TABLE_LIMIT, used: bookmarks.length });
});
app.post("/api/bookmarks", requireAuth, async (req, res) => {
  const b = req.body || {};
  const existing = await store.listBookmarks(req.user.id);
  if (existing.length >= TABLE_LIMIT) {
    return res.status(409).json({
      ok: false,
      error: `Your table is full (${TABLE_LIMIT} saved max) — delete one to make room.`,
      limit: TABLE_LIMIT, used: existing.length,
    });
  }
  const data = b.data || null;
  if (data && JSON.stringify(data).length > TABLE_MAX_BYTES) {
    return res.status(413).json({ ok: false, error: "That result set is too large to save." });
  }
  const bm = await store.addBookmark({
    user_id: req.user.id,
    label: String(b.label || "").slice(0, 120) || "Investigation",
    type: String(b.type || "").slice(0, 20),
    query: String(b.query || "").slice(0, 200),
    data,
  });
  res.json({ ok: true, bookmark: bm, limit: TABLE_LIMIT, used: existing.length + 1 });
});
app.delete("/api/bookmarks/:id", requireAuth, async (req, res) => {
  await store.deleteBookmark(req.user.id, req.params.id);
  res.json({ ok: true });
});

/* ============================= announcements ============================= */
// Everyone signed in can read them; only admins post or remove.
app.get("/api/announcements", requireAuth, async (_req, res) => {
  res.json({ ok: true, announcements: await store.listAnnouncements(20) });
});
app.post("/api/announcements", requireAuth, requireAdmin, async (req, res) => {
  const b = req.body || {};
  const title = String(b.title || "").trim().slice(0, 120);
  const body = String(b.body || "").trim().slice(0, 2000);
  if (!title && !body) return res.status(400).json({ ok: false, error: "Write something first." });
  const ann = await store.addAnnouncement({
    author_id: req.user.id, author: req.user.username,
    title: title || "Announcement", body,
  });
  res.json({ ok: true, announcement: ann });
});
app.delete("/api/announcements/:id", requireAuth, requireAdmin, async (req, res) => {
  await store.deleteAnnouncement(req.params.id);
  res.json({ ok: true });
});

/* ============================= admin ============================= */
app.get("/api/admin/users", requireAuth, requireAdmin, async (_req, res) => {
  const users = await store.listUsers();
  res.json({ ok: true, users: users.map((u) => ({ ...store.publicUser(u), is_admin: auth.isAdmin(u) })) });
});
app.patch("/api/admin/users/:id", requireAuth, requireAdmin, async (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.role === "user" || b.role === "admin") patch.role = b.role;
  if (typeof b.tokens === "number" && b.tokens >= 0) patch.tokens = Math.floor(b.tokens);
  if (typeof b.banner === "string") patch.banner = b.banner.slice(0, 2_000_000) || null;
  if (typeof b.avatar === "string") patch.avatar = b.avatar.slice(0, 2_000_000) || null;
  const updated = await store.updateUser(req.params.id, patch);
  if (!updated) return res.status(404).json({ ok: false, error: "No such user." });
  res.json({ ok: true, user: { ...store.publicUser(updated), is_admin: auth.isAdmin(updated) } });
});
app.post("/api/admin/users/:id/tokens", requireAuth, requireAdmin, async (req, res) => {
  const delta = Math.floor(Number((req.body && req.body.delta) || 0));
  const updated = await store.addTokens(req.params.id, delta);
  if (!updated) return res.status(404).json({ ok: false, error: "No such user." });
  res.json({ ok: true, user: store.publicUser(updated) });
});
app.delete("/api/admin/users/:id", requireAuth, requireAdmin, async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ ok: false, error: "You can't delete your own account here." });
  await store.deleteUser(req.params.id);
  res.json({ ok: true });
});
app.get("/api/admin/logs", requireAuth, requireAdmin, async (req, res) => {
  const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit || "200", 10)));
  res.json({ ok: true, logs: await store.listLogs(limit) });
});

/* ============================= social scan (SSE) ============================= */
const HANDLE_RE = /^[A-Za-z0-9._-]{1,30}$/;
app.get("/api/check", requireAuth, requireSearch, async (req, res) => {
  const handle = String(req.query.handle || "").trim();
  if (!HANDLE_RE.test(handle)) { res.status(400).json({ error: "Geçersiz kullanıcı adı." }); return; }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  req.on("close", () => res.end());
  try {
    await checkHandle(handle, (result) => send("result", result));
    send("done", {});
  } catch (err) {
    send("error", { message: err.message });
  } finally {
    res.end();
  }
});

/* ============================= OSINT proxy ============================= */
const OSINT_TYPES = new Set(["email", "username", "password"]);
app.get("/api/osint", requireAuth, requireSearch, async (req, res) => {
  const query = String(req.query.q || "").trim();
  const type = String(req.query.type || "").trim().toLowerCase();
  if (!query) return res.status(400).json({ ok: false, error: "Boş sorgu." });
  if (!OSINT_TYPES.has(type)) return res.status(400).json({ ok: false, error: `Geçersiz tür: "${type}".` });

  const key = process.env.NICOTINE_API_KEY;
  if (!key) return res.status(503).json({ ok: false, error: "Sunucuda API anahtarı ayarlı değil (NICOTINE_API_KEY)." });

  notifyDiscord(req, type, query, req.user && req.user.username);

  const url = `https://nicotine.ws/api/v1/osint?q=${encodeURIComponent(query)}&type=${encodeURIComponent(type)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: controller.signal });
    const raw = await r.text();
    let data;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
    if (!r.ok) return res.json({ ok: false, status: r.status, error: `HTTP ${r.status}`, data });
    res.json({ ok: true, status: r.status, query, type, data });
  } catch (err) {
    res.json({ ok: false, error: err.name === "AbortError" ? "Zaman aşımı (30 sn)." : err.message });
  } finally {
    clearTimeout(timer);
  }
});

store.init()
  .then(() => app.listen(PORT, () => console.log(`İz Sürücü http://localhost:${PORT} adresinde çalışıyor`)))
  .catch((e) => { console.error("Store init failed:", e); process.exit(1); });
