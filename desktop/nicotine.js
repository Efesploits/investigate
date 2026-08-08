"use strict";

// nicotine.ws OSINT API istemcisi.
// curl yerine Node'un yerleşik fetch'i (normal bir request library) kullanılır.
//
// API anahtarı git'e girmez. Önce NICOTINE_API_KEY ortam değişkeni, yoksa
// yerel secret.js (gitignore'da; paketlenmiş .exe içine gömülür) kullanılır.
let fileKey = "";
try {
  fileKey = require("./secret").NICOTINE_API_KEY || "";
} catch (_) {
  // secret.js yok (ör. taze klon) — anahtar env'den gelmeli
}
const API_KEY = process.env.NICOTINE_API_KEY || fileKey;
const BASE_URL = "https://nicotine.ws/api/v1/osint";

const VALID_TYPES = new Set(["email", "username", "password"]);

// query: aranacak değer (e-posta / kullanıcı adı / parola)
// type:  "email" | "username" | "password"
async function osintLookup(query, type) {
  const q = String(query || "").trim();
  const t = String(type || "").trim().toLowerCase();

  if (!q) return { ok: false, error: "Boş sorgu." };
  if (!VALID_TYPES.has(t)) {
    return { ok: false, error: `Geçersiz tür: "${type}". email, username veya password olmalı.` };
  }
  if (!API_KEY) {
    return { ok: false, error: "API anahtarı ayarlı değil (secret.js veya NICOTINE_API_KEY)." };
  }

  const url = `${BASE_URL}?q=${encodeURIComponent(q)}&type=${encodeURIComponent(t)}`;

  // Ağ takılırsa süresiz beklememek için zaman aşımı.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    const raw = await res.text();
    let data;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = raw; // JSON değilse ham metni geri ver
    }

    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}`, data };
    }
    return { ok: true, status: res.status, query: q, type: t, data };
  } catch (err) {
    if (err.name === "AbortError") return { ok: false, error: "Zaman aşımı (30 sn)." };
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- nüfus kayıtları ---------- */
// Aynı hesap, farklı uç nokta. Arama-özel bir anahtar tanımlıysa o kullanılır,
// yoksa hesabın genel anahtarı (ikisi de bu uç noktada geçerli).
let fileSearchKey = "";
try {
  const s = require("./secret");
  fileSearchKey = s.NICOTINE_SEARCH_KEY || s.NICOTINE_API_KEY || "";
} catch (_) {}
const SEARCH_KEY = process.env.NICOTINE_SEARCH_KEY || process.env.NICOTINE_API_KEY || fileSearchKey;

const PERSON_FILTERS = new Set([
  "tc", "adi", "soyadi", "dogumtarihi", "nufusil", "nufusilce",
  "anneadi", "annetc", "babaadi", "babatc", "uyruk",
]);
const LIVE_TYPES = new Set(["detailed"]);
const TC_RE = /^[1-9][0-9]{10}$/;
const DOB_RE = /^\d{4}-\d{2}-\d{2}$/;

// Tek yerden istek: zaman aşımı ve JSON çözümlemesi her ikisi için de aynı.
async function nicRequest(url) {
  if (!SEARCH_KEY) {
    return { ok: false, error: "API anahtarı ayarlı değil (secret.js veya NICOTINE_SEARCH_KEY)." };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${SEARCH_KEY}`, Accept: "application/json" },
      signal: controller.signal,
    });
    const raw = await res.text();
    let data;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}`, data };
    return { ok: true, status: res.status, data };
  } catch (err) {
    if (err.name === "AbortError") return { ok: false, error: "Zaman aşımı (30 sn)." };
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

// filters: { tc, adi, soyadi, ... } — beyaz listede olmayan alanlar yok sayılır
async function personSearch(filters, page) {
  const qs = new URLSearchParams({ database: "prd", page: String(Math.max(1, parseInt(page, 10) || 1)) });
  let any = false;
  for (const name of PERSON_FILTERS) {
    const v = String((filters && filters[name]) == null ? "" : filters[name]).trim();
    if (!v) continue;
    qs.set(name, v.slice(0, 100));
    any = true;
  }
  if (!any) return { ok: false, error: "En az bir filtre gerekli (TC, ad veya soyad)." };
  const r = await nicRequest(`https://nicotine.ws/api/v1/search?${qs}`);
  return r.ok ? { ...r, filters, page: Math.max(1, parseInt(page, 10) || 1) } : r;
}

// Canlı kayıt: TC ve doğum tarihi birlikte zorunlu.
async function personLive(tc, dob, type) {
  const t = String(type || "detailed").toLowerCase();
  const id = String(tc || "").trim();
  const d = String(dob || "").trim();
  if (!LIVE_TYPES.has(t)) return { ok: false, error: `Geçersiz tür: "${type}".` };
  if (!TC_RE.test(id)) return { ok: false, error: "TC kimlik no 11 haneli olmalı." };
  if (!DOB_RE.test(d)) return { ok: false, error: "Doğum tarihi YYYY-AA-GG olmalı." };
  const qs = new URLSearchParams({ type: t, tc: id, dob: d });
  const r = await nicRequest(`https://nicotine.ws/api/v1/live?${qs}`);
  return r.ok ? { ...r, tc: id, dob: d, type: t } : r;
}

module.exports = { osintLookup, personSearch, personLive, VALID_TYPES: [...VALID_TYPES] };
