const express = require("express");
const path = require("path");
const { checkHandle } = require("./checker");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

// Kullanıcı adında sadece bu platformların izin verdiği karakterlere izin veriyoruz.
const HANDLE_RE = /^[A-Za-z0-9._-]{1,30}$/;

app.get("/api/check", async (req, res) => {
  const handle = String(req.query.handle || "").trim();
  if (!HANDLE_RE.test(handle)) {
    res.status(400).json({ error: "Geçersiz kullanıcı adı." });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  req.on("close", () => {
    res.end();
  });

  try {
    await checkHandle(handle, (result) => send("result", result));
    send("done", {});
  } catch (err) {
    send("error", { message: err.message });
  } finally {
    res.end();
  }
});

// nicotine.ws OSINT lookup — proxied through the server so the API key stays
// server-side (in the NICOTINE_API_KEY env var) and never reaches the browser.
const OSINT_TYPES = new Set(["email", "username", "password"]);

app.get("/api/osint", async (req, res) => {
  const query = String(req.query.q || "").trim();
  const type = String(req.query.type || "").trim().toLowerCase();

  if (!query) {
    res.status(400).json({ ok: false, error: "Boş sorgu." });
    return;
  }
  if (!OSINT_TYPES.has(type)) {
    res.status(400).json({ ok: false, error: `Geçersiz tür: "${type}". email, username veya password olmalı.` });
    return;
  }
  const key = process.env.NICOTINE_API_KEY;
  if (!key) {
    res.status(503).json({ ok: false, error: "Sunucuda API anahtarı ayarlı değil (NICOTINE_API_KEY)." });
    return;
  }

  const url = `https://nicotine.ws/api/v1/osint?q=${encodeURIComponent(query)}&type=${encodeURIComponent(type)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: controller.signal,
    });
    const raw = await r.text();
    let data;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = raw;
    }
    if (!r.ok) {
      res.json({ ok: false, status: r.status, error: `HTTP ${r.status}`, data });
      return;
    }
    res.json({ ok: true, status: r.status, query, type, data });
  } catch (err) {
    res.json({ ok: false, error: err.name === "AbortError" ? "Zaman aşımı (30 sn)." : err.message });
  } finally {
    clearTimeout(timer);
  }
});

app.listen(PORT, () => {
  console.log(`İz Sürücü http://localhost:${PORT} adresinde çalışıyor`);
});
