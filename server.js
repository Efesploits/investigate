const express = require("express");
const path = require("path");
const crypto = require("crypto");
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
const GEOINT_COST = 10;

app.set("trust proxy", 1);
// GEOINT needs the ORIGINAL file bytes (re-encoding an image destroys its EXIF),
// so that one route gets a bigger ceiling than everything else.
const jsonStandard = express.json({ limit: "8mb" });
const jsonLarge = express.json({ limit: "26mb" });
app.use((req, res, next) => (req.path === "/api/geoint/analyze" ? jsonLarge : jsonStandard)(req, res, next));
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
/* A picture or a banner is stored verbatim and then rendered in every OTHER
   member's browser — on the home grid, in the profile viewer, in the admin
   list. Storing an arbitrary string there is what turns "set your avatar" into
   stored XSS: a value like  x" onerror="...  breaks out of the <img src="…">
   it gets written into, and one shaped like  a'),url(…  breaks out of a
   background-image: url('…'). The client is careful about how it renders these
   now, but the desktop client renders the same records, so the value is
   refused at the door rather than sanitised at each of the places it is shown.

   What is legitimate: a data: URL from the cropper (it encodes JPEG), and a
   Discord CDN https URL for a linked account. SVG is deliberately not on the
   list — an SVG can carry script. */
const IMG_DATA_RE = /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]+$/;
// no quotes, parentheses or backslashes: those are the characters that let a
// URL escape the context it is printed into
const IMG_HTTPS_RE = /^https:\/\/[A-Za-z0-9._~:/?#@!$&*+,;=%-]+$/;
const IMAGE_MAX = 2_000_000;
// null  -> clear it;  undefined -> the value was rejected
function cleanImage(v) {
  const s = String(v).trim();
  if (!s) return null;                       // "" is how the UI resets one
  if (s.length > IMAGE_MAX) return undefined;
  return (IMG_DATA_RE.test(s) || IMG_HTTPS_RE.test(s)) ? s : undefined;
}
function applyImagePatch(b, patch) {
  for (const field of ["banner", "avatar"]) {
    if (typeof b[field] !== "string") continue;
    const v = cleanImage(b[field]);
    if (v === undefined) return field;        // name the one that was refused
    patch[field] = v;
  }
  return null;
}

app.patch("/api/me", requireAuth, async (req, res) => {
  const patch = {};
  const b = req.body || {};
  const badImage = applyImagePatch(b, patch);
  if (badImage) return res.status(400).json({ ok: false, error: "That " + badImage + " isn't a supported image." });
  if (typeof b.bio === "string") patch.bio = b.bio.slice(0, 300);
  if (typeof b.password === "string" && b.password) {
    if (b.password.length < 6) return res.status(400).json({ ok: false, error: "Password must be at least 6 characters." });
    patch.password_hash = await auth.hashPassword(b.password);
  }
  const updated = await store.updateUser(req.user.id, patch);
  res.json({ ok: true, user: meShape(updated) });
});

/* ============================= Discord (Lanyard) ============================= */
// A Discord account is linked by its user ID, and its live presence is read
// through Lanyard (https://api.lanyard.rest). Lanyard only knows a user once
// they've joined its Discord (discord.gg/lanyard), so a successful connect
// doubles as the presence opt-in — no bot token or OAuth secret to manage.
const DISCORD_ID_RE = /^\d{17,20}$/;

async function fetchLanyard(id) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const r = await fetch(`https://api.lanyard.rest/v1/users/${encodeURIComponent(id)}`, {
      headers: { Accept: "application/json" }, signal: controller.signal,
    });
    const raw = await r.text();
    try { return raw ? JSON.parse(raw) : null; } catch { return null; }
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Build a CDN avatar URL from Lanyard's discord_user object (falls back to the
// user's default embed avatar when they have no custom one).
function discordAvatarUrl(du) {
  if (!du || !du.id) return null;
  if (du.avatar) {
    const ext = String(du.avatar).startsWith("a_") ? "gif" : "png";
    return `https://cdn.discordapp.com/avatars/${du.id}/${du.avatar}.${ext}?size=128`;
  }
  let idx = 0;
  try {
    idx = du.discriminator && du.discriminator !== "0"
      ? Number(du.discriminator) % 5
      : Number((BigInt(du.id) >> 22n) % 6n);
  } catch (_) { idx = 0; }
  return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
}

app.post("/api/discord/connect", requireAuth, async (req, res) => {
  const id = String((req.body && req.body.discord_id) || "").trim();
  if (!DISCORD_ID_RE.test(id)) {
    return res.status(400).json({ ok: false, error: "That doesn't look like a Discord user ID (17–20 digits)." });
  }
  const lany = await fetchLanyard(id);
  if (!lany || !lany.success || !lany.data || !lany.data.discord_user) {
    return res.status(404).json({ ok: false, error: "Lanyard doesn't track that ID yet. Join discord.gg/lanyard with that account, then try again." });
  }
  const existing = await store.getUserByDiscordId(id);
  if (existing && existing.id !== req.user.id) {
    return res.status(409).json({ ok: false, error: "That Discord account is already linked to another member." });
  }
  const du = lany.data.discord_user;
  const updated = await store.updateUser(req.user.id, {
    discord_id: id,
    discord_username: du.global_name || du.username || null,
    discord_avatar: discordAvatarUrl(du),
  });
  res.json({ ok: true, user: meShape(updated) });
});

app.post("/api/discord/disconnect", requireAuth, async (req, res) => {
  const updated = await store.updateUser(req.user.id, {
    discord_id: null, discord_username: null, discord_avatar: null,
  });
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
    discord_avatar: u.discord_avatar || null,
    online: new Date(u.last_seen).getTime() > cut,
    last_seen: u.last_seen,
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

/* ============================= redeem codes ============================= */
// Admins mint codes worth N tokens; any signed-in member may redeem each code
// once. All the race-safety (single use per account, max_uses) lives in the
// store layer — this file only validates input and maps errors to messages.
const CODE_RE = /^[A-Z0-9][A-Z0-9-]{2,31}$/;      // 3–32 chars, starts alphanumeric
const CODE_MAX_TOKENS = 100000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1 — unambiguous when read aloud

function generateCode() {
  const pick = () => CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  const block = () => Array.from({ length: 4 }, pick).join("");
  return block() + "-" + block();
}

// "2026-08-10" means end of that day; a full ISO timestamp is taken as given.
function parseExpiry(raw) {
  const s = String(raw || "").trim();
  if (!s) return { value: null };
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(s) ? s + "T23:59:59.999Z" : s;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return { error: "That expiry date isn't valid." };
  if (d.getTime() <= Date.now()) return { error: "The expiry date must be in the future." };
  return { value: d.toISOString() };
}

const REDEEM_ERRORS = {
  not_found: "That code doesn't exist. Check the spelling and try again.",
  expired: "That code has expired.",
  exhausted: "That code has already been fully claimed.",
  already: "You've already redeemed that code.",
  no_user: "Your account could no longer be found.",
};

// Light per-account throttle so nobody can brute-force their way to a valid code.
const REDEEM_WINDOW_MS = 60 * 1000;
const REDEEM_MAX_TRIES = 10;
const redeemHits = new Map(); // user id -> { count, resetAt }
function redeemThrottled(userId) {
  const nowMs = Date.now();
  const hit = redeemHits.get(userId);
  if (!hit || nowMs > hit.resetAt) {
    redeemHits.set(userId, { count: 1, resetAt: nowMs + REDEEM_WINDOW_MS });
    if (redeemHits.size > 5000) for (const [k, v] of redeemHits) if (nowMs > v.resetAt) redeemHits.delete(k);
    return false;
  }
  hit.count += 1;
  return hit.count > REDEEM_MAX_TRIES;
}

app.post("/api/codes/redeem", requireAuth, async (req, res) => {
  const raw = String((req.body && req.body.code) || "").trim().toUpperCase();
  if (!CODE_RE.test(raw)) return res.status(400).json({ ok: false, error: "That doesn't look like a valid code." });
  if (redeemThrottled(req.user.id)) {
    return res.status(429).json({ ok: false, error: "Too many attempts. Wait a minute and try again." });
  }

  const result = await store.redeemCode(req.user.id, raw);
  if (!result || !result.ok) {
    const key = (result && result.error) || "not_found";
    return res.status(key === "already" ? 409 : 404).json({ ok: false, error: REDEEM_ERRORS[key] || "That code can't be redeemed." });
  }
  res.json({ ok: true, tokens: result.tokens, user: meShape(result.user) });
});

app.get("/api/admin/codes", requireAuth, requireAdmin, async (_req, res) => {
  res.json({ ok: true, codes: await store.listCodes() });
});

app.post("/api/admin/codes", requireAuth, requireAdmin, async (req, res) => {
  const b = req.body || {};

  const tokens = Math.floor(Number(b.tokens));
  if (!Number.isFinite(tokens) || tokens < 1 || tokens > CODE_MAX_TOKENS) {
    return res.status(400).json({ ok: false, error: `Tokens must be a whole number between 1 and ${CODE_MAX_TOKENS}.` });
  }
  const maxUses = b.max_uses === "" || b.max_uses == null ? 0 : Math.floor(Number(b.max_uses));
  if (!Number.isFinite(maxUses) || maxUses < 0 || maxUses > 1000000) {
    return res.status(400).json({ ok: false, error: "Max uses must be 0 (unlimited) or a positive whole number." });
  }
  const expiry = parseExpiry(b.expires_at);
  if (expiry.error) return res.status(400).json({ ok: false, error: expiry.error });
  const note = String(b.note || "").trim().slice(0, 120) || null;

  const wanted = String(b.code || "").trim().toUpperCase();
  if (wanted && !CODE_RE.test(wanted)) {
    return res.status(400).json({ ok: false, error: "Codes are 3–32 characters: letters, numbers and dashes, starting with a letter or number." });
  }

  // A blank code means "generate one" — retry a few times in the (vanishingly
  // unlikely) event of a collision with an existing code.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = wanted || generateCode();
    const created = await store.createCode({
      code, tokens, max_uses: maxUses, note,
      expires_at: expiry.value, created_by: req.user.username,
    });
    if (created && created.code) return res.json({ ok: true, code: created.code });
    if (created && created.error === "taken" && wanted) {
      return res.status(409).json({ ok: false, error: "That code already exists." });
    }
  }
  res.status(500).json({ ok: false, error: "Couldn't generate a unique code. Try again." });
});

app.delete("/api/admin/codes/:id", requireAuth, requireAdmin, async (req, res) => {
  const ok = await store.deleteCode(req.params.id);
  if (!ok) return res.status(404).json({ ok: false, error: "No such code." });
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
  const badImage = applyImagePatch(b, patch);
  if (badImage) return res.status(400).json({ ok: false, error: "That " + badImage + " isn't a supported image." });
  const updated = await store.updateUser(req.params.id, patch);
  if (!updated) return res.status(404).json({ ok: false, error: "No such user." });
  res.json({ ok: true, user: { ...store.publicUser(updated), is_admin: auth.isAdmin(updated) } });
});
app.post("/api/admin/users/:id/username", requireAuth, requireAdmin, async (req, res) => {
  const newUsername = String((req.body && req.body.username) || "").trim();
  if (!USERNAME_RE.test(newUsername)) return res.status(400).json({ ok: false, error: "Username must be 3–20 chars (letters, numbers, . _ -)." });
  // Renaming your own account is blocked: your session token carries the old id
  // (and on Firestore the id itself moves), which would sign you out mid-action.
  if (req.params.id === req.user.id) return res.status(400).json({ ok: false, error: "You can't rename your own account here — do it from your profile." });
  // Don't let a rename silently mint or demote the configured super-admin.
  const target = await store.getUserById(req.params.id);
  if (!target) return res.status(404).json({ ok: false, error: "No such user." });
  const wasAdminName = String(target.username || "").toLowerCase() === auth.ADMIN_USERNAME;
  const willBeAdminName = newUsername.toLowerCase() === auth.ADMIN_USERNAME;
  if (willBeAdminName && !wasAdminName) return res.status(400).json({ ok: false, error: "That username is reserved for the owner account." });

  const result = await store.renameUser(req.params.id, newUsername);
  if (result && result.error === "taken") return res.status(409).json({ ok: false, error: "That username is taken." });
  if (!result || result.error || !result.user) return res.status(404).json({ ok: false, error: "No such user." });
  res.json({ ok: true, user: { ...store.publicUser(result.user), is_admin: auth.isAdmin(result.user) } });
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

/* ============================= person lookup proxy =============================
 * The same upstream as the OSINT proxy above, but its /search endpoint over the
 * civil-registry dataset: a name, a surname or a national ID number, and the
 * record that goes with it.
 *
 * Everything that matters here is the same as /api/osint on purpose — the key
 * stays on the server, the caller has to hold a paid search session, and the
 * query lands in the search log and on the webhook. What is different is the
 * shape of the request: this endpoint takes any combination of filters rather
 * than one q= term, so the whitelist below is what stops a caller inventing
 * parameters and having us forward them upstream verbatim.
 * ============================================================================ */
const PERSON_FILTERS = new Set([
  "tc", "adi", "soyadi", "dogumtarihi", "nufusil", "nufusilce",
  "anneadi", "annetc", "babaadi", "babatc", "uyruk",
]);
const PERSON_DB = "prd";

app.get("/api/lookup", requireAuth, requireSearch, async (req, res) => {
  const filters = {};
  for (const name of PERSON_FILTERS) {
    const v = String(req.query[name] == null ? "" : req.query[name]).trim();
    if (v) filters[name] = v.slice(0, 100);
  }
  if (!Object.keys(filters).length) {
    return res.status(400).json({ ok: false, error: "En az bir filtre gerekli (TC, ad veya soyad)." });
  }

  // the search-only key when one is configured, otherwise the shared account key
  const key = process.env.NICOTINE_SEARCH_KEY || process.env.NICOTINE_API_KEY;
  if (!key) return res.status(503).json({ ok: false, error: "Sunucuda API anahtarı ayarlı değil (NICOTINE_SEARCH_KEY)." });

  const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), 200);
  const qs = new URLSearchParams({ database: PERSON_DB, page: String(page) });
  for (const [k, v] of Object.entries(filters)) qs.set(k, v);

  // Only the first page is a new search; paging through it is the same one.
  if (page === 1) {
    const summary = Object.entries(filters).map(([k, v]) => `${k}=${v}`).join(" ");
    notifyDiscord(req, "person", summary, req.user && req.user.username);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const r = await fetch(`https://nicotine.ws/api/v1/search?${qs}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: controller.signal,
    });
    const raw = await r.text();
    let data;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
    if (!r.ok) return res.json({ ok: false, status: r.status, error: `HTTP ${r.status}`, data });
    res.json({ ok: true, status: r.status, filters, page, data });
  } catch (err) {
    res.json({ ok: false, error: err.name === "AbortError" ? "Zaman aşımı (30 sn)." : err.message });
  } finally {
    clearTimeout(timer);
  }
});

/* Live detail: one person, queried at the source rather than read out of the
 * dump. Needs the ID number AND the date of birth together — upstream rejects
 * either on its own, so both are checked here before we spend the round trip.
 * (Upstream also serves address / gib-* under this endpoint; add them to
 * LIVE_TYPES when there is a UI asking for them.) */
const LIVE_TYPES = new Set(["detailed"]);
const TC_RE = /^[1-9][0-9]{10}$/;
const DOB_RE = /^\d{4}-\d{2}-\d{2}$/;

app.get("/api/lookup/live", requireAuth, requireSearch, async (req, res) => {
  const type = String(req.query.type || "detailed").toLowerCase();
  const tc = String(req.query.tc || "").trim();
  const dob = String(req.query.dob || "").trim();

  if (!LIVE_TYPES.has(type)) return res.status(400).json({ ok: false, error: `Geçersiz tür: "${type}".` });
  if (!TC_RE.test(tc)) return res.status(400).json({ ok: false, error: "TC kimlik no 11 haneli olmalı." });
  if (!DOB_RE.test(dob)) return res.status(400).json({ ok: false, error: "Doğum tarihi YYYY-AA-GG olmalı." });

  const key = process.env.NICOTINE_SEARCH_KEY || process.env.NICOTINE_API_KEY;
  if (!key) return res.status(503).json({ ok: false, error: "Sunucuda API anahtarı ayarlı değil (NICOTINE_SEARCH_KEY)." });

  notifyDiscord(req, "person:live", `${tc} ${dob}`, req.user && req.user.username);

  const qs = new URLSearchParams({ type, tc, dob });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const r = await fetch(`https://nicotine.ws/api/v1/live?${qs}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: controller.signal,
    });
    const raw = await r.text();
    let data;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
    if (!r.ok) return res.json({ ok: false, status: r.status, error: `HTTP ${r.status}`, data });
    res.json({ ok: true, status: r.status, type, tc, dob, data });
  } catch (err) {
    res.json({ ok: false, error: err.name === "AbortError" ? "Zaman aşımı (30 sn)." : err.message });
  } finally {
    clearTimeout(timer);
  }
});

/* ============================= GEOINT =============================
 * Work out where a photograph was taken. Two routes, in order of how much
 * they can be trusted:
 *
 *   1. the file's own EXIF. A GPS-tagged image carries exact coordinates,
 *      which reverse-geocode into a street address. Nothing beats it.
 *   2. the picture itself. Most photographs that have been through a social
 *      network have had their EXIF stripped, so what is left is recognising
 *      the place from what is in frame — the architecture, the vegetation and
 *      climate, the writing on the signs. That is StreetCLIP's job (see
 *      geoint/locate.js), and unlike route 1 it produces a SHORTLIST rather
 *      than an answer, because a single guess from one photograph is wrong
 *      often enough that pretending otherwise would be dishonest.
 *
 * Route 2 needs a model, which needs somewhere to run — see geoint/clip.js.
 * When none is configured the UI says so plainly instead of implying failure.
 * ================================================================= */
const exifParser = require("exif-parser");
const geoRegions = require("./geoint/regions");
const geoClip = require("./geoint/clip");
const geoLocate = require("./geoint/locate");

const GEO_UA = "m3-investigation-tool/1.0 (geoint lookup)";

// Most bodies repeat the manufacturer in the model ("Canon" + "Canon EOS 5D"),
// so only prepend the make when the model doesn't already carry it.
function cameraName(make, model) {
  const mk = String(make || "").trim();
  const md = String(model || "").trim();
  if (!mk && !md) return null;
  if (!md) return mk;
  if (!mk) return md;
  return md.toLowerCase().startsWith(mk.toLowerCase()) ? md : mk + " " + md;
}

// EXIF stores coordinates already signed by exif-parser, but altitude/heading
// and the timestamp need a little shaping before they're fit to show.
function readExif(buf) {
  let tags = null, size = null;
  try {
    const parsed = exifParser.create(buf).parse();
    tags = parsed.tags || {};
    size = parsed.imageSize || null;
  } catch (_) {
    return { ok: false };
  }
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
  const when = (v) => (typeof v === "number" && isFinite(v) ? new Date(v * 1000).toISOString() : null);

  const lat = num(tags.GPSLatitude), lon = num(tags.GPSLongitude);
  const hasFix = lat != null && lon != null && !(lat === 0 && lon === 0) &&
                 Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

  return {
    ok: true,
    coords: hasFix ? { lat, lon } : null,
    altitude: num(tags.GPSAltitude),
    heading: num(tags.GPSImgDirection),
    taken_at: when(tags.DateTimeOriginal) || when(tags.CreateDate) || when(tags.ModifyDate),
    camera: cameraName(tags.Make, tags.Model),
    lens: tags.LensModel || null,
    software: tags.Software || null,
    iso: num(tags.ISO),
    f_number: num(tags.FNumber),
    exposure: num(tags.ExposureTime),
    focal_length: num(tags.FocalLength),
    orientation: num(tags.Orientation),
    width: size ? size.width : null,
    height: size ? size.height : null,
  };
}

// Coordinates -> a human address. Google when a key is configured (better
// coverage and street names), OpenStreetMap's Nominatim otherwise so the
// feature works with no setup at all.
async function reverseGeocode(lat, lon) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    if (key) {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lon}&key=${encodeURIComponent(key)}`;
      const r = await fetch(url, { signal: controller.signal });
      const j = await r.json();
      const best = j && j.results && j.results[0];
      if (best) {
        const part = (t) => {
          const c = (best.address_components || []).find((x) => (x.types || []).includes(t));
          return c ? c.long_name : null;
        };
        return {
          provider: "google",
          address: best.formatted_address || null,
          street: [part("street_number"), part("route")].filter(Boolean).join(" ") || part("route"),
          city: part("locality") || part("postal_town") || part("administrative_area_level_2"),
          state: part("administrative_area_level_1"),
          country: part("country"),
          postcode: part("postal_code"),
        };
      }
      return null;
    }
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`;
    const r = await fetch(url, { headers: { "User-Agent": GEO_UA, Accept: "application/json" }, signal: controller.signal });
    const j = await r.json();
    if (!j || j.error) return null;
    const a = j.address || {};
    return {
      provider: "openstreetmap",
      address: j.display_name || null,
      street: [a.house_number, a.road].filter(Boolean).join(" ") || a.road || null,
      city: a.city || a.town || a.village || a.municipality || a.county || null,
      state: a.state || a.region || null,
      country: a.country || null,
      postcode: a.postcode || null,
    };
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Optional content-based locator. Configure GEOINT_VISION_URL (and usually
// GEOINT_VISION_KEY) to point at a provider that takes an image and answers
// with coordinates; anything shaped {lat, lon, confidence} is understood.
async function visionLocate(base64, region) {
  const url = process.env.GEOINT_VISION_URL;
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    if (process.env.GEOINT_VISION_KEY) headers.Authorization = "Bearer " + process.env.GEOINT_VISION_KEY;
    const r = await fetch(url, {
      method: "POST", headers, signal: controller.signal,
      body: JSON.stringify({ image: base64, region: region || null }),
    });
    const j = await r.json();
    const lat = Number(j && (j.lat != null ? j.lat : j.latitude));
    const lon = Number(j && (j.lon != null ? j.lon : (j.lng != null ? j.lng : j.longitude)));
    if (!isFinite(lat) || !isFinite(lon)) return null;
    return { lat, lon, confidence: Number(j.confidence) || null };
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

app.post("/api/geoint/analyze", requireAuth, async (req, res) => {
  const b = req.body || {};
  const raw = String(b.image || "");
  const m = /^data:([\w/+.-]+);base64,(.+)$/.exec(raw);
  const base64 = m ? m[2] : (/^[A-Za-z0-9+/=\s]+$/.test(raw) ? raw : null);
  if (!base64) return res.status(400).json({ ok: false, error: "Send an image to analyse." });

  let buf;
  try { buf = Buffer.from(base64, "base64"); } catch (_) { buf = null; }
  if (!buf || buf.length < 64) return res.status(400).json({ ok: false, error: "That image couldn't be read." });
  if (buf.length > 25 * 1024 * 1024) return res.status(413).json({ ok: false, error: "Image too large (25MB max)." });

  // Charge only once we know we have something we can actually work on.
  const spent = await store.spendTokens(req.user.id, GEOINT_COST);
  if (!spent) {
    return res.status(402).json({ ok: false, error: "A GEOINT scan costs " + GEOINT_COST + " tokens.", need: GEOINT_COST, have: req.user.tokens });
  }
  store.addSearchLog({
    user_id: req.user.id, username: req.user.username,
    type: "geoint", query: (b.filename || "image").slice(0, 200), ultra: false, cost: GEOINT_COST,
  }).catch(() => {});

  const exif = readExif(buf);
  const meta = exif.ok ? exif : {};
  let coords = exif.ok ? exif.coords : null;
  let source = coords ? "exif" : null;
  let confidence = null;
  let candidates = [], scene = [], aiError = null;

  if (!coords) {
    // a purpose-built locator, if one is wired up, answers with coordinates
    const guess = await visionLocate(base64, b.region || null);
    if (guess) { coords = { lat: guess.lat, lon: guess.lon }; source = "vision"; confidence = guess.confidence; }
  }
  if (!coords && geoClip.available()) {
    try {
      const read = await geoLocate.locate(buf, { country: b.country || null, region: b.region_code || null });
      if (read && read.candidates.length) {
        candidates = read.candidates;
        scene = read.scene;
        source = "ai";
        // the leading candidate is pre-placed so the map has somewhere to open
        const lead = candidates[0];
        if (lead.coords) { coords = lead.coords; confidence = lead.confidence; }
      }
    } catch (e) {
      // a sleeping Space or a bad key shouldn't read as "nothing in this photo"
      aiError = e && e.message ? String(e.message).slice(0, 200) : "image matching failed";
    }
  }

  // an exact fix deserves a street address; a region-level guess does not
  const place = coords && source !== "ai" ? await reverseGeocode(coords.lat, coords.lon) : null;

  res.json({
    ok: true,
    found: !!coords,
    source,                       // "exif" | "vision" | "ai" | null
    confidence,
    coords,
    place,
    candidates,                   // ranked shortlist when the answer came from the picture
    scene,                        // what the model read off the image
    ai: {
      available: geoClip.available(),
      engine: geoClip.engine(),
      model: geoClip.available() ? geoClip.MODEL_ID : null,
      error: aiError,
    },
    metadata: {
      taken_at: meta.taken_at || null, camera: meta.camera || null, lens: meta.lens || null,
      software: meta.software || null, iso: meta.iso || null, f_number: meta.f_number || null,
      exposure: meta.exposure || null, focal_length: meta.focal_length || null,
      altitude: meta.altitude || null, heading: meta.heading || null,
      width: meta.width || null, height: meta.height || null,
      bytes: buf.length,
    },
    // tells the UI whether a content-based locator exists at all, so it can
    // explain the "no GPS" outcome truthfully instead of implying a failure
    vision_configured: !!process.env.GEOINT_VISION_URL || geoClip.available(),
    streetview: !!process.env.GOOGLE_MAPS_API_KEY,
    tokens: spent.tokens,
    cost: GEOINT_COST,
  });
});

/* The country/region pickers. Static for the life of the process and ~200KB,
 * so it's built once and allowed to sit in the browser cache. */
let geoRegionCache = null;
app.get("/api/geoint/regions", requireAuth, (req, res) => {
  if (!geoRegionCache) {
    geoRegionCache = JSON.stringify({ ok: true, countries: geoRegions.pickerList() });
  }
  res.set("Cache-Control", "private, max-age=86400");
  res.type("application/json").send(geoRegionCache);
});

/* Resolve one shortlisted candidate to coordinates. Only the leading guess is
 * geocoded during a scan, so choosing another lands here — and it's free,
 * because the analyst already paid to be given the list. */
app.post("/api/geoint/pick", requireAuth, async (req, res) => {
  const b = req.body || {};
  const c = b.country_code ? geoRegions.country(b.country_code) : null;
  const country = c ? geoRegions.displayName(c) : String(b.country || "").slice(0, 120);
  if (!country) return res.status(400).json({ ok: false, error: "Which country?" });

  const sub = c && b.region_code ? geoRegions.subdivision(c.c, b.region_code) : null;
  const region = sub ? sub.n : String(b.region || "").slice(0, 120) || null;

  const pt = await geoLocate.geocodePlace({ country, region });
  if (!pt) return res.status(404).json({ ok: false, error: "Couldn't place " + (region ? region + ", " : "") + country + " on the map." });
  res.json({
    ok: true,
    coords: { lat: pt.lat, lon: pt.lon },
    zoom: pt.zoom,
    level: pt.level || "region",     // "country" when the region wouldn't resolve
    label: [region, country].filter(Boolean).join(", "),
    address: pt.display || null,
  });
});

// Street View needs Google's key; it stays server-side and is only ever used
// to build the embed URL for a location the user has already located.
app.get("/api/geoint/streetview", requireAuth, (req, res) => {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return res.status(503).json({ ok: false, error: "Street View needs GOOGLE_MAPS_API_KEY on the server." });
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  if (!isFinite(lat) || !isFinite(lon)) return res.status(400).json({ ok: false, error: "Bad coordinates." });
  res.json({ ok: true, url: `https://www.google.com/maps/embed/v1/streetview?key=${encodeURIComponent(key)}&location=${lat},${lon}&heading=0&pitch=0&fov=90` });
});

store.init()
  .then(() => app.listen(PORT, () => console.log(`İz Sürücü http://localhost:${PORT} adresinde çalışıyor`)))
  .catch((e) => { console.error("Store init failed:", e); process.exit(1); });
