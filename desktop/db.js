"use strict";

/*
 * Database layer for the investigation desktop client.
 * Supports MySQL, PostgreSQL and SQLite (via sql.js / WASM — no native build).
 * Pure Node so it can be unit-tested without Electron.
 */

const fs = require("fs");
const path = require("path");

// text-ish column types we bother searching, per engine
const MYSQL_TEXT = new Set([
  "char", "varchar", "tinytext", "text", "mediumtext", "longtext", "enum", "set", "json",
]);
const PG_TEXT = new Set([
  "character varying", "varchar", "character", "char", "text", "citext", "name", "json", "jsonb", "uuid",
]);

const MAX_TABLES = 300;      // safety cap
const ROWS_PER_TABLE = 25;   // rows collected per table
const SHOW_ROWS = 12;        // rows returned to UI per table

let state = null; // { type, mysql?, pg?, sqlite?, label }

function truncate(v, n = 160) {
  if (v === null || v === undefined) return null;
  let s = typeof v === "string" ? v : (Buffer.isBuffer(v) ? "<binary>" : JSON.stringify(v));
  if (s.length > n) s = s.slice(0, n) + "…";
  return s;
}

async function connect(cfg) {
  await disconnect();
  const type = cfg.type;

  if (type === "mysql") {
    const mysql = require("mysql2/promise");
    const conn = await mysql.createConnection({
      host: cfg.host || "127.0.0.1",
      port: Number(cfg.port) || 3306,
      user: cfg.user,
      password: cfg.password || "",
      database: cfg.database,
      connectTimeout: 8000,
    });
    await conn.query("SELECT 1");
    state = { type, mysql: conn, database: cfg.database, label: `MySQL · ${cfg.database} @ ${cfg.host || "127.0.0.1"}` };
    return { ok: true, label: state.label };
  }

  if (type === "postgres") {
    const { Client } = require("pg");
    const client = new Client({
      host: cfg.host || "127.0.0.1",
      port: Number(cfg.port) || 5432,
      user: cfg.user,
      password: cfg.password || "",
      database: cfg.database,
      connectionTimeoutMillis: 8000,
    });
    await client.connect();
    await client.query("SELECT 1");
    state = { type, pg: client, database: cfg.database, label: `PostgreSQL · ${cfg.database} @ ${cfg.host || "127.0.0.1"}` };
    return { ok: true, label: state.label };
  }

  if (type === "sqlite") {
    const initSqlJs = require("sql.js");
    const wasmPath = path.join(path.dirname(require.resolve("sql.js")), "sql-wasm.wasm");
    const wasmBinary = fs.readFileSync(wasmPath);
    const SQL = await initSqlJs({ wasmBinary });
    const fileBuf = fs.readFileSync(cfg.sqlitePath);
    const db = new SQL.Database(fileBuf);
    state = { type, sqlite: db, SQL, label: `SQLite · ${path.basename(cfg.sqlitePath)}` };
    return { ok: true, label: state.label };
  }

  throw new Error("Unknown database type: " + type);
}

async function disconnect() {
  if (!state) return;
  try {
    if (state.type === "mysql" && state.mysql) await state.mysql.end();
    else if (state.type === "postgres" && state.pg) await state.pg.end();
    else if (state.type === "sqlite" && state.sqlite) state.sqlite.close();
  } catch (_) { /* ignore */ }
  state = null;
}

function isConnected() { return !!state; }

// ---- schema introspection -> [{ table, columns:[names] }] ----
async function getTextColumns() {
  if (state.type === "mysql") {
    const [rows] = await state.mysql.query(
      `SELECT TABLE_NAME t, COLUMN_NAME c, DATA_TYPE d
       FROM information_schema.columns WHERE TABLE_SCHEMA = ?`,
      [state.database]
    );
    return groupCols(rows.map((r) => ({ t: r.t, c: r.c, d: String(r.d).toLowerCase() })), MYSQL_TEXT);
  }
  if (state.type === "postgres") {
    const res = await state.pg.query(
      `SELECT table_name t, column_name c, data_type d
       FROM information_schema.columns
       WHERE table_schema = 'public'`
    );
    return groupCols(res.rows.map((r) => ({ t: r.t, c: r.c, d: String(r.d).toLowerCase() })), PG_TEXT);
  }
  // sqlite
  const tables = [];
  const res = state.sqlite.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  if (res[0]) {
    for (const row of res[0].values) {
      const table = row[0];
      const info = state.sqlite.exec(`PRAGMA table_info("${table.replace(/"/g, '""')}")`);
      const cols = info[0] ? info[0].values.map((v) => v[1]) : []; // name is index 1
      if (cols.length) tables.push({ table, columns: cols });
    }
  }
  return tables;
}

function groupCols(rows, textSet) {
  const map = new Map();
  for (const r of rows) {
    if (!textSet.has(r.d)) continue;
    if (!map.has(r.t)) map.set(r.t, []);
    map.get(r.t).push(r.c);
  }
  return [...map.entries()].map(([table, columns]) => ({ table, columns }));
}

// ---- search ----
async function search(term) {
  if (!state) throw new Error("Not connected to a database.");
  const q = String(term || "").trim();
  if (!q) throw new Error("Enter a search term.");
  const like = "%" + q + "%";

  const schema = (await getTextColumns()).slice(0, MAX_TABLES);
  const matches = [];
  let tablesScanned = 0;

  for (const { table, columns } of schema) {
    if (!columns.length) continue;
    tablesScanned++;
    try {
      const rows = await queryTable(table, columns, like);
      if (rows.length) {
        matches.push({ table, columns, count: rows.length, rows: rows.slice(0, SHOW_ROWS) });
      }
    } catch (_) { /* skip tables we can't read */ }
  }

  return { ok: true, term: q, tablesScanned, matched: matches.length, matches };
}

async function queryTable(table, columns, like) {
  if (state.type === "mysql") {
    const cols = columns.map((c) => "`" + c.replace(/`/g, "``") + "` LIKE ?").join(" OR ");
    const sql = "SELECT * FROM `" + table.replace(/`/g, "``") + "` WHERE " + cols + " LIMIT " + ROWS_PER_TABLE;
    const [rows] = await state.mysql.query(sql, columns.map(() => like));
    return rows.map(normalizeRow);
  }
  if (state.type === "postgres") {
    const cols = columns.map((c) => '"' + c.replace(/"/g, '""') + '"::text ILIKE $1').join(" OR ");
    const sql = 'SELECT * FROM "' + table.replace(/"/g, '""') + '" WHERE ' + cols + " LIMIT " + ROWS_PER_TABLE;
    const res = await state.pg.query(sql, [like]);
    return res.rows.map(normalizeRow);
  }
  // sqlite
  const cols = columns.map((c) => 'CAST("' + c.replace(/"/g, '""') + '" AS TEXT) LIKE :term').join(" OR ");
  const sql = 'SELECT * FROM "' + table.replace(/"/g, '""') + '" WHERE ' + cols + " LIMIT " + ROWS_PER_TABLE;
  const stmt = state.sqlite.prepare(sql);
  stmt.bind({ ":term": like });
  const out = [];
  while (stmt.step()) out.push(normalizeRow(stmt.getAsObject()));
  stmt.free();
  return out;
}

function normalizeRow(row) {
  const o = {};
  for (const k of Object.keys(row)) o[k] = truncate(row[k]);
  return o;
}

module.exports = { connect, disconnect, isConnected, search };
