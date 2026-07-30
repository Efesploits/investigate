"use strict";

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// Never ship a guessable default: if JWT_SECRET is unset we mint a random
// per-boot secret. That keeps forged tokens impossible, at the cost of
// sessions not surviving a restart until JWT_SECRET is set in the env.
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || "m3fxn").toLowerCase();
const SESSION_TTL = "30d";     // login session (cookie / bearer)
const SEARCH_TTL = "15m";      // per-search session (covers ultra's recursive lookups)

if (!process.env.JWT_SECRET) {
  console.warn("[auth] JWT_SECRET not set — using a random per-boot secret; sessions won't survive restarts. Set JWT_SECRET in production.");
}

const hashPassword = (pw) => bcrypt.hash(String(pw), 10);
const verifyPassword = (pw, hash) => bcrypt.compare(String(pw), String(hash || ""));

const signSession = (user) => jwt.sign({ uid: user.id, kind: "session" }, JWT_SECRET, { expiresIn: SESSION_TTL });
const signSearch = (user, ultra) => jwt.sign({ uid: user.id, kind: "search", ultra: !!ultra }, JWT_SECRET, { expiresIn: SEARCH_TTL });

function verify(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch (_) { return null; }
}

// admin = explicit role, OR the configured admin username (default "m3fxn")
const isAdmin = (user) => !!user && (user.role === "admin" || String(user.username || "").toLowerCase() === ADMIN_USERNAME);

// pull a bearer/cookie token off a request
function tokenFromReq(req) {
  const h = req.headers["authorization"] || "";
  if (h.startsWith("Bearer ")) return h.slice(7).trim();
  if (req.cookies && req.cookies.session) return req.cookies.session;
  return null;
}

module.exports = {
  JWT_SECRET, ADMIN_USERNAME,
  hashPassword, verifyPassword,
  signSession, signSearch, verify,
  isAdmin, tokenFromReq,
};
