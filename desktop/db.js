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

// ---- table list, for auto-generated per-table search sections ----
async function listTables() {
  if (!state) throw new Error("Not connected to a database.");
  const schema = (await getTextColumns()).slice(0, MAX_TABLES);
  return { ok: true, tables: schema.filter((t) => t.columns.length) };
}

// ---- search a single table ----
async function searchTable(table, term) {
  if (!state) throw new Error("Not connected to a database.");
  const q = String(term || "").trim();
  if (!q) throw new Error("Enter a search term.");
  const like = "%" + q + "%";

  const schema = await getTextColumns();
  const entry = schema.find((t) => t.table === table);
  if (!entry) throw new Error("Unknown table: " + table);

  const rows = await queryTable(entry.table, entry.columns, like, q);
  return { ok: true, table, term: q, columns: entry.columns, count: rows.length, rows: rows.slice(0, SHOW_ROWS) };
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
      const rows = await queryTable(table, columns, like, q);
      if (rows.length) {
        matches.push({ table, columns, count: rows.length, rows: rows.slice(0, SHOW_ROWS) });
      }
    } catch (_) { /* skip tables we can't read */ }
  }

  return { ok: true, term: q, tablesScanned, matched: matches.length, matches };
}

// builds a boolean-mode fulltext query term: each word required (+) and
// prefix-matched (*), e.g. "m3 alice" -> "+m3* +alice*"
function booleanFtTerm(term) {
  const words = term
    .split(/\s+/)
    .map((w) => w.replace(/[+\-><()~*:@"]/g, ""))
    .filter(Boolean);
  if (!words.length) return null;
  return words.map((w) => "+" + w + "*").join(" ");
}

const ER_FT_MATCHING_KEY_NOT_FOUND = 1191;

async function queryTable(table, columns, like, term) {
  if (state.type === "mysql") {
    const ftTerm = term ? booleanFtTerm(term) : null;
    if (ftTerm) {
      try {
        const matchCols = columns.map((c) => "`" + c.replace(/`/g, "``") + "`").join(",");
        const sql =
          "SELECT * FROM `" + table.replace(/`/g, "``") + "` WHERE MATCH(" + matchCols +
          ") AGAINST (? IN BOOLEAN MODE) LIMIT " + ROWS_PER_TABLE;
        const [rows] = await state.mysql.query(sql, [ftTerm]);
        return rows.map(normalizeRow);
      } catch (err) {
        // no FULLTEXT index covering exactly these columns -> fall back to LIKE below
        if (!err || err.errno !== ER_FT_MATCHING_KEY_NOT_FOUND) throw err;
      }
    }
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

// ================= .sql dump import =================
// Streams a mysqldump/phpMyAdmin .sql export, translates the MySQL-specific
// bits (ENGINE=, KEY defs, AUTO_INCREMENT, backslash string escapes, ...)
// into SQLite-compatible statements, and loads them into an in-memory sql.js
// database. Once done, it becomes the active connection — every existing
// search/listTables/searchTable code path works on it unchanged.
//
// Note: sql.js is WASM SQLite, capped at roughly a few GB of heap. Multi-GB
// dumps (several GB+) will not fully fit; import is best-effort and stops
// gracefully rather than crashing when a statement can't be applied.

function cleanCreateTable(stmt) {
  let s = stmt;
  // drop table-level options that trail the closing paren (ENGINE=, CHARSET=, ...).
  // the "=" is mandatory here so this can't accidentally match column-level
  // modifiers like `COLLATE utf8mb4_unicode_ci` or bare `AUTO_INCREMENT`,
  // which never carry an "=" the way the trailing table options do.
  s = s.replace(/\)\s*(ENGINE|DEFAULT CHARSET|CHARSET|COLLATE|AUTO_INCREMENT|ROW_FORMAT|COMMENT)\s*=[^;]*$/i, ")");

  // drop index/constraint-only lines inside the column list (SQLite doesn't
  // take inline KEY defs); PRIMARY KEY (...) is kept, SQLite understands it.
  const kept = s.split("\n").filter((line) => {
    const t = line.trim();
    return !/^(UNIQUE\s+KEY|KEY|FULLTEXT\s+KEY|SPATIAL\s+KEY|CONSTRAINT\b|FOREIGN\s+KEY)\b/i.test(t);
  });
  s = kept.join("\n");

  // fix a dangling trailing comma left before the closing paren
  s = s.replace(/,(\s*)\)/g, "$1)");

  // column-level MySQL-only tokens that SQLite doesn't need/understand
  s = s.replace(/\bAUTO_INCREMENT\b/gi, "");
  s = s.replace(/\bUNSIGNED\b/gi, "");
  s = s.replace(/\bZEROFILL\b/gi, "");
  s = s.replace(/\bCHARACTER SET\s+\w+/gi, "");
  s = s.replace(/\bCOLLATE\s+\w+/gi, "");
  s = s.replace(/COMMENT\s+'(?:[^'\\]|\\.)*'/gi, "");
  s = s.replace(/\bENUM\s*\([^)]*\)/gi, "TEXT");
  s = s.replace(/\bSET\s*\([^)]*\)/gi, "TEXT");

  return s;
}

// Converts MySQL backslash-escaped string literals to SQLite's doubled-quote
// escaping so the statement parses; other backslash escapes are left as
// literal 2-char sequences (harmless for text search, avoids a full decode table).
function cleanInsert(stmt) {
  let s = stmt.replace(/\b_(?:utf8mb4|utf8mb3|utf8|binary|latin1|ascii|ucs2|utf16|utf32)'/gi, "'");
  let out = "";
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\" && i + 1 < s.length) {
        const next = s[i + 1];
        if (next === "'") { out += "''"; i++; continue; }
        if (next === "\\") { out += "\\"; i++; continue; }
        out += c;
        continue;
      }
      if (c === "'") {
        if (s[i + 1] === "'") { out += "''"; i++; continue; }
        inStr = false;
        out += c;
        continue;
      }
      out += c;
    } else {
      if (c === "'") inStr = true;
      out += c;
    }
  }
  return out;
}

function countTuples(insertStmt) {
  const m = insertStmt.match(/\),\s*\(/g);
  return (m ? m.length : 0) + 1;
}

// finds the first top-level (outside a '...' string) ';' in text, starting
// from the given quote state; returns { idx, inSingle } where inSingle is
// the state after scanning up to idx (or to the end, if none found)
function scanForTerminator(text, inSingleStart) {
  let inSingle = inSingleStart;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inSingle) {
      if (c === "\\") { i++; continue; }
      if (c === "'") inSingle = false;
      continue;
    }
    if (c === "'") { inSingle = true; continue; }
    if (c === ";") return { idx: i, inSingle: false };
  }
  return { idx: -1, inSingle };
}

async function importSqlFile(filePath, onProgress) {
  await disconnect();
  const initSqlJs = require("sql.js");
  const wasmPath = path.join(path.dirname(require.resolve("sql.js")), "sql-wasm.wasm");
  const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(wasmPath) });
  const db = new SQL.Database();

  const totalBytes = fs.statSync(filePath).size;
  const readline = require("readline");
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let acc = "";
  let inSingle = false;
  let statements = 0, rowsInserted = 0, bytesRead = 0;
  const tablesCreated = new Set();
  let pendingCommit = 0;
  const COMMIT_EVERY = 200;

  db.exec("BEGIN;");

  function handleStatement(raw) {
    const s = raw.trim();
    if (!s) return;
    statements++;
    if (/^CREATE TABLE/i.test(s)) {
      try {
        db.run(cleanCreateTable(s));
        const m = s.match(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?[`"]?([^`"\s(]+)/i);
        if (m) tablesCreated.add(m[1]);
      } catch (_) { /* skip a table we couldn't translate */ }
    } else if (/^INSERT INTO/i.test(s)) {
      try {
        db.run(cleanInsert(s));
        rowsInserted += countTuples(s);
        pendingCommit++;
        if (pendingCommit >= COMMIT_EVERY) {
          db.exec("COMMIT;");
          db.exec("BEGIN;");
          pendingCommit = 0;
        }
      } catch (_) { /* skip rows we couldn't parse/insert (e.g. heap limit hit) */ }
    }
    // everything else (SET, LOCK/UNLOCK TABLES, DROP TABLE, ALTER TABLE, comments) is skipped on purpose
  }

  let lastEmit = Date.now();
  for await (const line of rl) {
    bytesRead += Buffer.byteLength(line, "utf8") + 1;

    if (!inSingle) {
      const t = line.trimStart();
      if (t === "" || t.startsWith("--") || t.startsWith("/*")) continue;
    }

    acc += (acc ? "\n" : "") + line;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { idx, inSingle: nextState } = scanForTerminator(acc, inSingle);
      if (idx === -1) { inSingle = nextState; break; }
      handleStatement(acc.slice(0, idx));
      acc = acc.slice(idx + 1);
      inSingle = false;
    }

    if (Date.now() - lastEmit > 400) {
      onProgress && onProgress({ statements, tables: tablesCreated.size, rows: rowsInserted, bytesRead, totalBytes });
      lastEmit = Date.now();
    }
  }
  if (acc.trim()) handleStatement(acc);

  try { db.exec("COMMIT;"); } catch (_) { /* nothing pending */ }

  onProgress && onProgress({ statements, tables: tablesCreated.size, rows: rowsInserted, bytesRead, totalBytes, done: true });

  const label = `Imported · ${path.basename(filePath)} (${tablesCreated.size} table(s), ~${rowsInserted.toLocaleString()} row(s))`;
  state = { type: "sqlite", sqlite: db, SQL, label };
  return { ok: true, label, tables: tablesCreated.size, rows: rowsInserted, statements };
}

module.exports = { connect, disconnect, isConnected, search, listTables, searchTable, importSqlFile };
