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

module.exports = { osintLookup, VALID_TYPES: [...VALID_TYPES] };
