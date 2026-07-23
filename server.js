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

app.listen(PORT, () => {
  console.log(`İz Sürücü http://localhost:${PORT} adresinde çalışıyor`);
});
