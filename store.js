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
const HAS_PG = !!process.env.DATABASE_URL;

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

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
};

/* ================================================================
 * JSON-file backend (dev / fallback)
 * ============================================================== */
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");
let mem = { users: [], logs: [], bookmarks: [] };

function jsonLoad() {
  try {
    if (fs.existsSync(DATA_FILE)) mem = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (_) {}
  mem.users = mem.users || [];
  mem.logs = mem.logs || [];
  mem.bookmarks = mem.bookmarks || [];
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
};

/* ================================================================ */
const backend = HAS_PG ? pgStore : jsonStore;

async function init() {
  if (HAS_PG) {
    await pgInit();
    console.log("[store] Postgres backend ready.");
  } else {
    jsonLoad();
    console.warn("[store] No DATABASE_URL — using JSON file at " + DATA_FILE + ". This is WIPED on every Render redeploy; set DATABASE_URL for production.");
  }
}

module.exports = Object.assign({ init, publicUser, START_TOKENS, HAS_PG }, backend);
