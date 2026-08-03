"use strict";

/*
 * Persistence layer for accounts / tokens / bookmarks / search logs.
 *
 * Two interchangeable backends behind one async API:
 *   - Postgres  (when DATABASE_URL is set)  — durable, used in production
 *   - JSON file (otherwise)                 — for local dev; NOTE this file is
 *                                             wiped on every Render redeploy, so
 *                                             production MUST set DATABASE_URL.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const START_TOKENS = parseInt(process.env.START_TOKENS || "10", 10);
const ACTIVE_WINDOW_MS = 5 * 60 * 1000; // "active" = seen in the last 5 minutes
const HAS_FB = !!(process.env.FIREBASE_SERVICE_ACCOUNT || process.env.GOOGLE_APPLICATION_CREDENTIALS);
const HAS_PG = !!process.env.DATABASE_URL;

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

// Redeem codes are case-insensitive and stored upper-case, so "summer-26" and
// "SUMMER-26" are the same code everywhere (lookup key, uniqueness, redemption).
const normCode = (c) => String(c == null ? "" : c).trim().toUpperCase();

// Shared, backend-independent redemption checks — the single place the refusal
// ORDER is decided, so all three backends answer identically. "already" is
// deliberately ahead of expired/exhausted: to someone who personally used a
// one-shot code, "you already redeemed this" is the truthful answer, whereas
// "fully claimed" would read as if somebody else had taken it.
function codeProblem(c, alreadyRedeemed) {
  if (!c) return "not_found";
  if (alreadyRedeemed) return "already";
  if (c.expires_at && new Date(c.expires_at).getTime() <= Date.now()) return "expired";
  if ((c.max_uses || 0) > 0 && (c.uses || 0) >= c.max_uses) return "exhausted";
  return null;
}

// Fields that are safe to expose about *other* users (no hash).
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    tokens: u.tokens,
    banner: u.banner || null,
    avatar: u.avatar || null,
    bio: u.bio || null,
    discord_id: u.discord_id || null,
    discord_username: u.discord_username || null,
    discord_avatar: u.discord_avatar || null,
    created_at: u.created_at,
    last_seen: u.last_seen,
  };
}

/* ================================================================
 * Postgres backend
 * ============================================================== */
let pool = null;

async function pgInit() {
  const { Pool } = require("pg");
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "off" ? false : { rejectUnauthorized: false },
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      username      TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'user',
      tokens        INTEGER NOT NULL DEFAULT ${START_TOKENS},
      banner        TEXT,
      avatar        TEXT,
      bio           TEXT,
      discord_id       TEXT,
      discord_username TEXT,
      discord_avatar   TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users (lower(username));
    CREATE INDEX IF NOT EXISTS users_discord ON users (discord_id);

    CREATE TABLE IF NOT EXISTS search_logs (
      id         TEXT PRIMARY KEY,
      user_id    TEXT,
      username   TEXT,
      type       TEXT,
      query      TEXT,
      ultra      BOOLEAN NOT NULL DEFAULT false,
      cost       INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS logs_created ON search_logs (created_at DESC);

    CREATE TABLE IF NOT EXISTS bookmarks (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      label      TEXT,
      type       TEXT,
      query      TEXT,
      data       JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS bm_user ON bookmarks (user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS announcements (
      id         TEXT PRIMARY KEY,
      author_id  TEXT,
      author     TEXT,
      title      TEXT,
      body       TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS ann_created ON announcements (created_at DESC);

    CREATE TABLE IF NOT EXISTS codes (
      id         TEXT PRIMARY KEY,
      code       TEXT NOT NULL,
      tokens     INTEGER NOT NULL,
      max_uses   INTEGER NOT NULL DEFAULT 0,
      uses       INTEGER NOT NULL DEFAULT 0,
      note       TEXT,
      expires_at TIMESTAMPTZ,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS codes_code ON codes (code);
    CREATE INDEX IF NOT EXISTS codes_created ON codes (created_at DESC);

    -- one row per (code, user): the primary key is what makes "each account may
    -- redeem a given code once" impossible to race past.
    CREATE TABLE IF NOT EXISTS code_redemptions (
      code_id    TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      username   TEXT,
      tokens     INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (code_id, user_id)
    );
  `);
}

const pgStore = {
  async createUser({ username, password_hash, role }) {
    const id = uid();
    const { rows } = await pool.query(
      `INSERT INTO users (id, username, password_hash, role, tokens)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [id, username, password_hash, role || "user", START_TOKENS]
    );
    return rows[0];
  },
  async getUserByUsername(username) {
    const { rows } = await pool.query(`SELECT * FROM users WHERE lower(username)=lower($1)`, [username]);
    return rows[0] || null;
  },
  async getUserById(id) {
    const { rows } = await pool.query(`SELECT * FROM users WHERE id=$1`, [id]);
    return rows[0] || null;
  },
  async getUserByDiscordId(did) {
    const { rows } = await pool.query(`SELECT * FROM users WHERE discord_id=$1`, [did]);
    return rows[0] || null;
  },
  // Rename: id is a UUID here, so references (bookmarks.user_id, logs.user_id)
  // stay valid — only the username column moves. The unique lower(username)
  // index is the real guard; we check first for a friendly error.
  async renameUser(id, newUsername) {
    const me = await this.getUserById(id);
    if (!me) return { error: "notfound" };
    const clash = await pool.query(`SELECT id FROM users WHERE lower(username)=lower($1) AND id<>$2`, [newUsername, id]);
    if (clash.rows.length) return { error: "taken" };
    try {
      const { rows } = await pool.query(`UPDATE users SET username=$1 WHERE id=$2 RETURNING *`, [newUsername, id]);
      return { user: rows[0] };
    } catch (e) {
      if (e.code === "23505") return { error: "taken" };
      throw e;
    }
  },
  async updateUser(id, patch) {
    const allowed = ["username", "password_hash", "role", "tokens", "banner", "avatar", "bio", "discord_id", "discord_username", "discord_avatar"];
    const sets = [], vals = [];
    let i = 1;
    for (const k of allowed) {
      if (k in patch) { sets.push(`${k}=$${i++}`); vals.push(patch[k]); }
    }
    if (!sets.length) return this.getUserById(id);
    vals.push(id);
    const { rows } = await pool.query(`UPDATE users SET ${sets.join(", ")} WHERE id=$${i} RETURNING *`, vals);
    return rows[0] || null;
  },
  async addTokens(id, delta) {
    const { rows } = await pool.query(`UPDATE users SET tokens = GREATEST(0, tokens + $1) WHERE id=$2 RETURNING *`, [delta, id]);
    return rows[0] || null;
  },
  // atomic spend — only succeeds if the balance covers `cost`
  async spendTokens(id, cost) {
    const { rows } = await pool.query(
      `UPDATE users SET tokens = tokens - $1 WHERE id=$2 AND tokens >= $1 RETURNING *`,
      [cost, id]
    );
    return rows[0] || null; // null => insufficient
  },
  async deleteUser(id) {
    await pool.query(`DELETE FROM bookmarks WHERE user_id=$1`, [id]);
    await pool.query(`DELETE FROM code_redemptions WHERE user_id=$1`, [id]);
    await pool.query(`DELETE FROM users WHERE id=$1`, [id]);
    return true;
  },
  async listUsers() {
    const { rows } = await pool.query(`SELECT * FROM users ORDER BY created_at ASC`);
    return rows;
  },
  async touchLastSeen(id) {
    await pool.query(`UPDATE users SET last_seen=now() WHERE id=$1`, [id]);
  },
  async countUsers() {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM users`);
    return rows[0].n;
  },
  async countActiveUsers() {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM users WHERE last_seen > now() - interval '5 minutes'`
    );
    return rows[0].n;
  },
  async addSearchLog(log) {
    const id = uid();
    await pool.query(
      `INSERT INTO search_logs (id,user_id,username,type,query,ultra,cost) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, log.user_id, log.username, log.type, log.query, !!log.ultra, log.cost || 1]
    );
    return id;
  },
  async listLogs(limit = 200) {
    const { rows } = await pool.query(`SELECT * FROM search_logs ORDER BY created_at DESC LIMIT $1`, [limit]);
    return rows;
  },
  async addBookmark(bm) {
    const id = uid();
    const { rows } = await pool.query(
      `INSERT INTO bookmarks (id,user_id,label,type,query,data) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [id, bm.user_id, bm.label, bm.type, bm.query, bm.data ? JSON.stringify(bm.data) : null]
    );
    return rows[0];
  },
  async listBookmarks(userId) {
    const { rows } = await pool.query(`SELECT * FROM bookmarks WHERE user_id=$1 ORDER BY created_at DESC`, [userId]);
    return rows;
  },
  async deleteBookmark(userId, id) {
    await pool.query(`DELETE FROM bookmarks WHERE id=$1 AND user_id=$2`, [id, userId]);
    return true;
  },
  async addAnnouncement(a) {
    const id = uid();
    const { rows } = await pool.query(
      `INSERT INTO announcements (id,author_id,author,title,body) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [id, a.author_id, a.author, a.title, a.body]
    );
    return rows[0];
  },
  async listAnnouncements(limit = 20) {
    const { rows } = await pool.query(`SELECT * FROM announcements ORDER BY created_at DESC LIMIT $1`, [limit]);
    return rows;
  },
  async deleteAnnouncement(id) {
    await pool.query(`DELETE FROM announcements WHERE id=$1`, [id]);
    return true;
  },
  async createCode(c) {
    const id = uid();
    try {
      const { rows } = await pool.query(
        `INSERT INTO codes (id,code,tokens,max_uses,note,expires_at,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [id, normCode(c.code), c.tokens, c.max_uses || 0, c.note || null, c.expires_at || null, c.created_by || null]
      );
      return { code: rows[0] };
    } catch (e) {
      if (e.code === "23505") return { error: "taken" };
      throw e;
    }
  },
  async listCodes() {
    const { rows } = await pool.query(`SELECT * FROM codes ORDER BY created_at DESC`);
    return rows;
  },
  async deleteCode(id) {
    await pool.query(`DELETE FROM code_redemptions WHERE code_id=$1`, [id]);
    const { rowCount } = await pool.query(`DELETE FROM codes WHERE id=$1`, [id]);
    return rowCount > 0;
  },
  // Atomic: the code row is locked FOR UPDATE, so two simultaneous redeems of
  // the last remaining use serialise instead of both succeeding.
  async redeemCode(userId, codeStr) {
    const code = normCode(codeStr);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(`SELECT * FROM codes WHERE code=$1 FOR UPDATE`, [code]);
      const c = rows[0];
      if (!c) { await client.query("ROLLBACK"); return { ok: false, error: "not_found" }; }

      const dup = await client.query(`SELECT 1 FROM code_redemptions WHERE code_id=$1 AND user_id=$2`, [c.id, userId]);
      const bad = codeProblem(c, dup.rows.length > 0);
      if (bad) { await client.query("ROLLBACK"); return { ok: false, error: bad }; }

      const u = await client.query(`UPDATE users SET tokens = tokens + $1 WHERE id=$2 RETURNING *`, [c.tokens, userId]);
      if (!u.rows[0]) { await client.query("ROLLBACK"); return { ok: false, error: "no_user" }; }

      await client.query(
        `INSERT INTO code_redemptions (code_id,user_id,username,tokens) VALUES ($1,$2,$3,$4)`,
        [c.id, userId, u.rows[0].username, c.tokens]
      );
      await client.query(`UPDATE codes SET uses = uses + 1 WHERE id=$1`, [c.id]);
      await client.query("COMMIT");
      return { ok: true, tokens: c.tokens, user: u.rows[0] };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      if (e.code === "23505") return { ok: false, error: "already" }; // lost the race on the PK
      throw e;
    } finally {
      client.release();
    }
  },
};

/* ================================================================
 * Firestore backend (Firebase) — used when FIREBASE_SERVICE_ACCOUNT set
 *   users doc id = lowercased username (guarantees unique usernames);
 *   our user.id === that key, so getUserById / getUserByUsername are the
 *   same direct doc read. Usernames are immutable in the app, so this is safe.
 * ============================================================== */
let fbdb = null;

function loadServiceAccount() {
  let raw = (process.env.FIREBASE_SERVICE_ACCOUNT || "").trim();
  if (!raw) return null;
  if (raw[0] !== "{") { // allow base64-encoded JSON (avoids env-var newline issues)
    try { raw = Buffer.from(raw, "base64").toString("utf8"); } catch (_) {}
  }
  const sa = JSON.parse(raw);
  if (sa.private_key && sa.private_key.indexOf("\\n") !== -1) sa.private_key = sa.private_key.replace(/\\n/g, "\n");
  return sa;
}

async function fbInit() {
  const { initializeApp, getApps, cert, applicationDefault } = require("firebase-admin/app");
  const { getFirestore } = require("firebase-admin/firestore");
  const sa = loadServiceAccount();
  if (!getApps().length) {
    if (process.env.FIRESTORE_EMULATOR_HOST) {
      // local emulator ignores credentials — just need a project id
      initializeApp({ projectId: (sa && sa.project_id) || process.env.GCLOUD_PROJECT || "demo-app" });
    } else {
      initializeApp({ credential: sa ? cert(sa) : applicationDefault(), projectId: sa ? sa.project_id : undefined });
    }
  }
  if (sa) console.log("[store] Firebase credential loaded — project: " + sa.project_id + ", client_email: " + sa.client_email);
  fbdb = getFirestore();
  try { fbdb.settings({ ignoreUndefinedProperties: true }); } catch (_) {}
}
// a tiny read that surfaces auth/permission problems at startup, not mid-request
async function fbSelfTest() { await fbUsers().limit(1).get(); }

const fbUsers = () => fbdb.collection("users");
const fbLogs = () => fbdb.collection("search_logs");
const fbBookmarks = () => fbdb.collection("bookmarks");
const fbAnnouncements = () => fbdb.collection("announcements");
// codes doc id = the upper-cased code (uniqueness for free, like users);
// redemption doc id = "<CODE>__<userId>" so one account can only ever hold one.
const fbCodes = () => fbdb.collection("codes");
const fbRedemptions = () => fbdb.collection("code_redemptions");
const fbRedemptionKey = (code, userId) => normCode(code) + "__" + String(userId);
const FB_USER_FIELDS = ["username", "password_hash", "role", "tokens", "banner", "avatar", "bio", "discord_id", "discord_username", "discord_avatar"];

const fbStore = {
  async createUser({ username, password_hash, role }) {
    const key = username.toLowerCase();
    const u = {
      id: key, username, password_hash, role: role || "user", tokens: START_TOKENS,
      banner: null, avatar: null, bio: null,
      discord_id: null, discord_username: null, discord_avatar: null,
      created_at: now(), last_seen: now(),
    };
    await fbUsers().doc(key).create(u); // throws if the username already exists
    return u;
  },
  async getUserByUsername(username) {
    const s = await fbUsers().doc(String(username).toLowerCase()).get();
    return s.exists ? s.data() : null;
  },
  async getUserById(id) {
    const s = await fbUsers().doc(String(id)).get();
    return s.exists ? s.data() : null;
  },
  async getUserByDiscordId(did) {
    const q = await fbUsers().where("discord_id", "==", did).limit(1).get();
    return q.empty ? null : q.docs[0].data();
  },
  async updateUser(id, patch) {
    const ref = fbUsers().doc(String(id));
    const clean = {};
    for (const k of FB_USER_FIELDS) if (k in patch) clean[k] = patch[k];
    if (Object.keys(clean).length) await ref.update(clean);
    const s = await ref.get();
    return s.exists ? s.data() : null;
  },
  // Rename. The doc id === the lowercased username, so unless only the CASE
  // changed, the user's key moves: create a new doc, carry every field and its
  // bookmarks over, then delete the old. Returns the user under its NEW id.
  async renameUser(id, newUsername) {
    const oldKey = String(id);
    const newKey = newUsername.toLowerCase();
    const oldRef = fbUsers().doc(oldKey);
    const oldSnap = await oldRef.get();
    if (!oldSnap.exists) return { error: "notfound" };
    if (newKey === oldKey) {                       // case-only change — just the field
      await oldRef.update({ username: newUsername });
      const s = await oldRef.get();
      return { user: s.data() };
    }
    const newRef = fbUsers().doc(newKey);
    if ((await newRef.get()).exists) return { error: "taken" };
    const migrated = { ...oldSnap.data(), id: newKey, username: newUsername };
    const bms = await fbBookmarks().where("user_id", "==", oldKey).get();
    const reds = await fbRedemptions().where("user_id", "==", oldKey).get();
    const batch = fbdb.batch();
    batch.set(newRef, migrated);                   // Table entries follow the user to the new key
    bms.forEach((d) => batch.update(d.ref, { user_id: newKey }));
    // redemption doc ids embed the user id, so these move rather than update —
    // otherwise a rename would hand back every code the account already used.
    reds.forEach((d) => {
      const r = d.data();
      batch.set(fbRedemptions().doc(fbRedemptionKey(r.code_id, newKey)), { ...r, user_id: newKey, username: newUsername });
      batch.delete(d.ref);
    });
    batch.delete(oldRef);
    await batch.commit();
    return { user: migrated };
  },
  async addTokens(id, delta) {
    const ref = fbUsers().doc(String(id));
    return fbdb.runTransaction(async (t) => {
      const s = await t.get(ref);
      if (!s.exists) return null;
      const tokens = Math.max(0, (s.data().tokens || 0) + delta);
      t.update(ref, { tokens });
      return { ...s.data(), tokens };
    });
  },
  async spendTokens(id, cost) {
    const ref = fbUsers().doc(String(id));
    return fbdb.runTransaction(async (t) => {
      const s = await t.get(ref);
      if (!s.exists) return null;
      const tokens = s.data().tokens || 0;
      if (tokens < cost) return null;
      t.update(ref, { tokens: tokens - cost });
      return { ...s.data(), tokens: tokens - cost };
    });
  },
  async deleteUser(id) {
    const bms = await fbBookmarks().where("user_id", "==", id).get();
    const reds = await fbRedemptions().where("user_id", "==", String(id)).get();
    const batch = fbdb.batch();
    bms.forEach((d) => batch.delete(d.ref));
    reds.forEach((d) => batch.delete(d.ref));
    batch.delete(fbUsers().doc(String(id)));
    await batch.commit();
    return true;
  },
  async listUsers() {
    const q = await fbUsers().get();
    return q.docs.map((d) => d.data()).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  },
  async touchLastSeen(id) {
    await fbUsers().doc(String(id)).update({ last_seen: now() }).catch(() => {});
  },
  async countUsers() { return (await fbUsers().get()).size; },
  async countActiveUsers() {
    const cut = Date.now() - ACTIVE_WINDOW_MS;
    const q = await fbUsers().get();
    return q.docs.filter((d) => new Date(d.data().last_seen).getTime() > cut).length;
  },
  async addSearchLog(log) {
    const ref = await fbLogs().add({
      user_id: log.user_id, username: log.username, type: log.type, query: log.query,
      ultra: !!log.ultra, cost: log.cost || 1, created_at: now(),
    });
    return ref.id;
  },
  async listLogs(limit = 200) {
    const q = await fbLogs().orderBy("created_at", "desc").limit(limit).get();
    return q.docs.map((d) => ({ id: d.id, ...d.data() }));
  },
  async addBookmark(bm) {
    const doc = { user_id: bm.user_id, label: bm.label, type: bm.type, query: bm.query, data: bm.data || null, created_at: now() };
    const ref = await fbBookmarks().add(doc);
    return { id: ref.id, ...doc };
  },
  async listBookmarks(userId) {
    const q = await fbBookmarks().where("user_id", "==", userId).get();
    return q.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  },
  async deleteBookmark(userId, id) {
    const ref = fbBookmarks().doc(String(id));
    const s = await ref.get();
    if (s.exists && s.data().user_id === userId) await ref.delete();
    return true;
  },
  async addAnnouncement(a) {
    const doc = { author_id: a.author_id, author: a.author, title: a.title, body: a.body, created_at: now() };
    const ref = await fbAnnouncements().add(doc);
    return { id: ref.id, ...doc };
  },
  async listAnnouncements(limit = 20) {
    const q = await fbAnnouncements().orderBy("created_at", "desc").limit(limit).get();
    return q.docs.map((d) => ({ id: d.id, ...d.data() }));
  },
  async deleteAnnouncement(id) {
    await fbAnnouncements().doc(String(id)).delete();
    return true;
  },
  async createCode(c) {
    const key = normCode(c.code);
    const doc = {
      id: key, code: key, tokens: c.tokens, max_uses: c.max_uses || 0, uses: 0,
      note: c.note || null, expires_at: c.expires_at || null,
      created_by: c.created_by || null, created_at: now(),
    };
    try {
      await fbCodes().doc(key).create(doc); // throws if that code already exists
      return { code: doc };
    } catch (e) {
      if (e && (e.code === 6 || String(e.message || "").includes("ALREADY_EXISTS"))) return { error: "taken" };
      throw e;
    }
  },
  async listCodes() {
    const q = await fbCodes().get();
    return q.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  },
  async deleteCode(id) {
    const key = normCode(id);
    const reds = await fbRedemptions().where("code_id", "==", key).get();
    const batch = fbdb.batch();
    reds.forEach((d) => batch.delete(d.ref));
    batch.delete(fbCodes().doc(key));
    await batch.commit();
    return true;
  },
  // All reads happen before any write, as Firestore transactions require.
  async redeemCode(userId, codeStr) {
    const key = normCode(codeStr);
    const codeRef = fbCodes().doc(key);
    const userRef = fbUsers().doc(String(userId));
    const redRef = fbRedemptions().doc(fbRedemptionKey(key, userId));
    return fbdb.runTransaction(async (t) => {
      const cs = await t.get(codeRef);
      const us = await t.get(userRef);
      const rs = await t.get(redRef);
      const c = cs.exists ? cs.data() : null;
      const bad = codeProblem(c, rs.exists);
      if (bad) return { ok: false, error: bad };
      if (!us.exists) return { ok: false, error: "no_user" };

      const user = us.data();
      const tokens = (user.tokens || 0) + c.tokens;
      t.create(redRef, {
        code_id: key, user_id: String(userId), username: user.username || null,
        tokens: c.tokens, created_at: now(),
      });
      t.update(codeRef, { uses: (c.uses || 0) + 1 });
      t.update(userRef, { tokens });
      return { ok: true, tokens: c.tokens, user: { ...user, tokens } };
    });
  },
};

/* ================================================================
 * JSON-file backend (dev / fallback)
 * ============================================================== */
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");
let mem = { users: [], logs: [], bookmarks: [], announcements: [], codes: [], redemptions: [] };

function jsonLoad() {
  try {
    if (fs.existsSync(DATA_FILE)) mem = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (_) {}
  mem.users = mem.users || [];
  mem.logs = mem.logs || [];
  mem.bookmarks = mem.bookmarks || [];
  mem.announcements = mem.announcements || [];
  mem.codes = mem.codes || [];
  mem.redemptions = mem.redemptions || [];
}
let saveTimer = null;
function jsonSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(mem, null, 2));
    } catch (_) {}
  }, 50);
}

const jsonStore = {
  async createUser({ username, password_hash, role }) {
    const u = {
      id: uid(), username, password_hash, role: role || "user", tokens: START_TOKENS,
      banner: null, avatar: null, bio: null,
      discord_id: null, discord_username: null, discord_avatar: null,
      created_at: now(), last_seen: now(),
    };
    mem.users.push(u); jsonSave(); return u;
  },
  async getUserByUsername(username) {
    return mem.users.find((u) => u.username.toLowerCase() === String(username).toLowerCase()) || null;
  },
  async getUserById(id) { return mem.users.find((u) => u.id === id) || null; },
  async getUserByDiscordId(did) { return mem.users.find((u) => u.discord_id === did) || null; },
  async updateUser(id, patch) {
    const u = mem.users.find((x) => x.id === id);
    if (!u) return null;
    const allowed = ["username", "password_hash", "role", "tokens", "banner", "avatar", "bio", "discord_id", "discord_username", "discord_avatar"];
    for (const k of allowed) if (k in patch) u[k] = patch[k];
    jsonSave(); return u;
  },
  async renameUser(id, newUsername) {
    const u = mem.users.find((x) => x.id === id);
    if (!u) return { error: "notfound" };
    const taken = mem.users.some((x) => x.id !== id && x.username.toLowerCase() === newUsername.toLowerCase());
    if (taken) return { error: "taken" };
    u.username = newUsername; jsonSave(); return { user: u };
  },
  async addTokens(id, delta) {
    const u = mem.users.find((x) => x.id === id);
    if (!u) return null;
    u.tokens = Math.max(0, (u.tokens || 0) + delta); jsonSave(); return u;
  },
  async spendTokens(id, cost) {
    const u = mem.users.find((x) => x.id === id);
    if (!u || (u.tokens || 0) < cost) return null;
    u.tokens -= cost; jsonSave(); return u;
  },
  async deleteUser(id) {
    mem.users = mem.users.filter((u) => u.id !== id);
    mem.bookmarks = mem.bookmarks.filter((b) => b.user_id !== id);
    mem.redemptions = mem.redemptions.filter((r) => r.user_id !== id);
    jsonSave(); return true;
  },
  async listUsers() { return mem.users.slice().sort((a, b) => a.created_at.localeCompare(b.created_at)); },
  async touchLastSeen(id) {
    const u = mem.users.find((x) => x.id === id);
    if (u) { u.last_seen = now(); jsonSave(); }
  },
  async countUsers() { return mem.users.length; },
  async countActiveUsers() {
    const cut = Date.now() - ACTIVE_WINDOW_MS;
    return mem.users.filter((u) => new Date(u.last_seen).getTime() > cut).length;
  },
  async addSearchLog(log) {
    const id = uid();
    mem.logs.push({ id, user_id: log.user_id, username: log.username, type: log.type, query: log.query, ultra: !!log.ultra, cost: log.cost || 1, created_at: now() });
    if (mem.logs.length > 5000) mem.logs = mem.logs.slice(-5000);
    jsonSave(); return id;
  },
  async listLogs(limit = 200) {
    return mem.logs.slice().sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
  },
  async addBookmark(bm) {
    const b = { id: uid(), user_id: bm.user_id, label: bm.label, type: bm.type, query: bm.query, data: bm.data || null, created_at: now() };
    mem.bookmarks.push(b); jsonSave(); return b;
  },
  async listBookmarks(userId) {
    return mem.bookmarks.filter((b) => b.user_id === userId).sort((a, b) => b.created_at.localeCompare(a.created_at));
  },
  async deleteBookmark(userId, id) {
    mem.bookmarks = mem.bookmarks.filter((b) => !(b.id === id && b.user_id === userId));
    jsonSave(); return true;
  },
  async addAnnouncement(a) {
    const an = { id: uid(), author_id: a.author_id, author: a.author, title: a.title, body: a.body, created_at: now() };
    mem.announcements.push(an); jsonSave(); return an;
  },
  async listAnnouncements(limit = 20) {
    return mem.announcements.slice().sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
  },
  async deleteAnnouncement(id) {
    mem.announcements = mem.announcements.filter((a) => a.id !== id);
    jsonSave(); return true;
  },
  async createCode(c) {
    const code = normCode(c.code);
    if (mem.codes.some((x) => x.code === code)) return { error: "taken" };
    const row = {
      id: uid(), code, tokens: c.tokens, max_uses: c.max_uses || 0, uses: 0,
      note: c.note || null, expires_at: c.expires_at || null,
      created_by: c.created_by || null, created_at: now(),
    };
    mem.codes.push(row); jsonSave(); return { code: row };
  },
  async listCodes() {
    return mem.codes.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  },
  async deleteCode(id) {
    const before = mem.codes.length;
    mem.codes = mem.codes.filter((c) => c.id !== id);
    mem.redemptions = mem.redemptions.filter((r) => r.code_id !== id);
    jsonSave(); return mem.codes.length < before;
  },
  // Node is single-threaded and nothing awaits mid-check, so this whole body is
  // effectively atomic — no interleaving is possible between check and write.
  async redeemCode(userId, codeStr) {
    const code = normCode(codeStr);
    const c = mem.codes.find((x) => x.code === code);
    const dup = !!c && mem.redemptions.some((r) => r.code_id === c.id && r.user_id === userId);
    const bad = codeProblem(c, dup);
    if (bad) return { ok: false, error: bad };
    const u = mem.users.find((x) => x.id === userId);
    if (!u) return { ok: false, error: "no_user" };

    u.tokens = (u.tokens || 0) + c.tokens;
    c.uses = (c.uses || 0) + 1;
    mem.redemptions.push({ code_id: c.id, user_id: userId, username: u.username, tokens: c.tokens, created_at: now() });
    jsonSave();
    return { ok: true, tokens: c.tokens, user: u };
  },
};

/* ================================================================
 * Backend selection with graceful fallback — a broken database must
 * never crash the site; it falls back to JSON and logs why.
 * ============================================================== */
const METHODS = [
  "createUser", "getUserByUsername", "getUserById", "getUserByDiscordId", "updateUser", "renameUser",
  "addTokens", "spendTokens", "deleteUser", "listUsers", "touchLastSeen", "countUsers",
  "countActiveUsers", "addSearchLog", "listLogs", "addBookmark", "listBookmarks", "deleteBookmark",
  "addAnnouncement", "listAnnouncements", "deleteAnnouncement",
  "createCode", "listCodes", "deleteCode", "redeemCode",
];
let activeBackend = jsonStore; // real backend is chosen in init()
// diagnostics so the app can SHOW whether storage is durable (accounts survive
// Render's free-plan spin-down only when this is "firestore" or "postgres").
let backendName = "json";
let backendError = null;
const api = {};
for (const m of METHODS) api[m] = (...args) => activeBackend[m](...args);

// backend === "json" means data lives on Render's ephemeral disk and is WIPED
// on every spin-down / redeploy. Only firestore/postgres are durable.
function backendInfo() {
  return {
    backend: backendName,
    durable: backendName === "firestore" || backendName === "postgres",
    error: backendError,
    configured: HAS_FB ? "firebase" : HAS_PG ? "postgres" : "none",
  };
}

async function init() {
  if (HAS_FB) {
    try {
      await fbInit();
      await fbSelfTest();
      activeBackend = fbStore; backendName = "firestore"; backendError = null;
      console.log("[store] Firebase (Firestore) backend ready — accounts are DURABLE.");
      return;
    } catch (e) {
      backendError = e && e.message ? e.message : String(e);
      console.error("\n[store] ⚠️  FIRESTORE UNAVAILABLE — falling back to an EPHEMERAL JSON store (data resets on redeploy / spin-down).");
      console.error("[store]     Firestore said: " + backendError);
      console.error("[store]     Fix: (1) Firestore must be in NATIVE mode, not Datastore. (2) FIREBASE_SERVICE_ACCOUNT must be the FULL service-account JSON for THIS project. (3) If pasting raw JSON mangles the private key, paste its base64 instead (base64 -w0 key.json).\n");
      jsonLoad(); activeBackend = jsonStore; backendName = "json"; return;
    }
  }
  if (HAS_PG) {
    try { await pgInit(); activeBackend = pgStore; backendName = "postgres"; console.log("[store] Postgres backend ready — accounts are DURABLE."); return; }
    catch (e) { backendError = e.message; console.error("[store] Postgres unavailable, falling back to JSON: " + e.message); }
  }
  jsonLoad(); activeBackend = jsonStore; backendName = "json";
  console.warn("[store] Using JSON file at " + DATA_FILE + " (WIPED on every Render redeploy / spin-down). Set FIREBASE_SERVICE_ACCOUNT for durable storage.");
}

module.exports = Object.assign({ init, publicUser, backendInfo, START_TOKENS, HAS_FB, HAS_PG }, api);
