const puppeteer = require("puppeteer");

// Genel engelleme / captcha / bot-koruması belirtileri (siteden bağımsız)
const BLOCKED_PATTERNS =
  /verify you.?re (a )?human|are you a robot|unusual traffic|automated queries|checking your browser|just a moment|captcha|rate limit(ed)?|too many requests|try again later|access denied\b/i;

// "Giriş yapmadan göremezsin" duvarı belirtileri
const LOGIN_WALL_PATTERNS =
  /log ?in to (continue|see)|sign in to (continue|see)|create an account or log in|you must log ?in|join (linkedin|facebook) to|giriş yap(ın)? veya kaydol/i;

function classifyWall(text, currentUrl, loginUrlPattern) {
  if (loginUrlPattern && loginUrlPattern.test(currentUrl)) return "login_wall";
  if (LOGIN_WALL_PATTERNS.test(text)) return "login_wall";
  if (BLOCKED_PATTERNS.test(text)) return "blocked";
  if (text.replace(/\s+/g, "").length < 40) return "empty_page";
  return null;
}

const PLATFORMS = [
  {
    name: "Instagram",
    url: (h) => `https://www.instagram.com/${encodeURIComponent(h)}/`,
    notFound: /Sorry, this page isn't available|Üzgünüz, bu sayfa/i,
    loginUrlPattern: /\/accounts\/login/,
  },
  {
    name: "TikTok",
    url: (h) => `https://www.tiktok.com/@${encodeURIComponent(h)}`,
    notFound: /Couldn't find this account|kullanıcı bulunamadı/i,
  },
  {
    name: "X (Twitter)",
    url: (h) => `https://x.com/${encodeURIComponent(h)}`,
    notFound: /This account doesn.?t exist/i,
    loginUrlPattern: /\/(i\/flow\/login|login)/,
  },
  {
    name: "Threads",
    url: (h) => `https://www.threads.net/@${encodeURIComponent(h)}`,
    notFound: /Sorry, this page isn't available/i,
    loginUrlPattern: /\/login/,
  },
  {
    name: "Facebook",
    url: (h) => `https://www.facebook.com/${encodeURIComponent(h)}`,
    notFound: /This content isn.?t available|content isn.?t available right now/i,
    loginUrlPattern: /\/login/,
    unreliable: true, // Facebook, oturum açılmadan hemen her zaman giriş duvarı gösterir
  },
  {
    name: "LinkedIn",
    url: (h) => `https://www.linkedin.com/in/${encodeURIComponent(h)}`,
    notFound: /This page doesn.?t exist|Page not found/i,
    loginUrlPattern: /\/authwall|\/uas\/login/,
    unreliable: true, // LinkedIn, oturum açılmadan çoğu profili "authwall"a yönlendirir
  },
  {
    name: "Pinterest",
    url: (h) => `https://www.pinterest.com/${encodeURIComponent(h)}/`,
    notFound: /Sorry! We couldn.?t find that page/i,
  },
  {
    name: "Twitch",
    url: (h) => `https://www.twitch.tv/${encodeURIComponent(h)}`,
    notFound: /Sorry\. Unless you.?ve got a time machine/i,
  },
  {
    name: "YouTube",
    url: (h) => `https://www.youtube.com/@${encodeURIComponent(h)}`,
    notFound: /This page isn.?t available/i,
  },
  {
    name: "Linktree",
    url: (h) => `https://linktr.ee/${encodeURIComponent(h)}`,
    notFound: /isn.?t claimed yet|page not found/i,
  },
];

async function checkOne(browser, platform, handle) {
  const page = await browser.newPage();
  const url = platform.url(handle);
  const result = { name: platform.name, url, exists: null, reason: null };
  try {
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9,tr;q=0.8" });

    const response = await page.goto(url, { waitUntil: "networkidle2", timeout: 20000 });
    await new Promise((r) => setTimeout(r, 1500));

    const status = response ? response.status() : null;
    if (status === 404 || status === 410) {
      result.exists = false;
      result.reason = `http_${status}`;
      return result;
    }

    const finalUrl = page.url();
    const text = await page.evaluate(() => document.body.innerText);

    const wall = classifyWall(text, finalUrl, platform.loginUrlPattern);
    if (wall) {
      // "Bulunamadı" metni yok diye "var" saymıyoruz — sayfa engellenmiş/duvarlı,
      // yani gerçekte kontrol edilememiş demektir.
      result.exists = null;
      result.reason = wall;
      return result;
    }

    if (platform.notFound.test(text)) {
      result.exists = false;
      return result;
    }

    result.exists = true;
    if (platform.unreliable) result.reason = "unreliable_check";
    return result;
  } catch (err) {
    result.exists = null;
    result.reason = "error";
    result.error = err.message;
    return result;
  } finally {
    await page.close();
  }
}

async function checkHandle(handle, onResult) {
  const browser = await puppeteer.launch({ headless: "new" });
  const results = [];
  try {
    for (const platform of PLATFORMS) {
      const result = await checkOne(browser, platform, handle);
      results.push(result);
      if (onResult) onResult(result);
    }
  } finally {
    await browser.close();
  }
  return results;
}

module.exports = { checkHandle, PLATFORMS };
