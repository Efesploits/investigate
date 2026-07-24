"use strict";

/*
 * OSINT username scanner for the desktop client.
 * Uses Electron's own Chromium (a hidden BrowserWindow per check) instead of
 * a separately-downloaded Puppeteer browser or a remote server — faster to
 * start and runs several platforms concurrently, unlike the sequential
 * server-side scanner this mirrors (see ../checker.js).
 */

const { BrowserWindow } = require("electron");

const BLOCKED_PATTERNS =
  /verify you.?re (a )?human|are you a robot|unusual traffic|automated queries|checking your browser|just a moment|captcha|rate limit(ed)?|too many requests|try again later|access denied\b/i;

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
    unreliable: true,
  },
  {
    name: "LinkedIn",
    url: (h) => `https://www.linkedin.com/in/${encodeURIComponent(h)}`,
    notFound: /This page doesn.?t exist|Page not found/i,
    loginUrlPattern: /\/authwall|\/uas\/login/,
    unreliable: true,
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
  {
    name: "Roblox",
    url: (h) => `https://www.roblox.com/users/profile?username=${encodeURIComponent(h)}`,
    notFound: /User Not Found|Sorry! This user does not exist|couldn.?t find that user/i,
  },
  {
    name: "GitHub",
    url: (h) => `https://github.com/${encodeURIComponent(h)}`,
    notFound: /This is not the web page you are looking for|Page not found/i,
  },
  {
    name: "Reddit",
    url: (h) => `https://www.reddit.com/user/${encodeURIComponent(h)}/`,
    notFound: /Sorry, nobody on Reddit goes by that name|page not found/i,
  },
  {
    name: "Steam",
    url: (h) => `https://steamcommunity.com/id/${encodeURIComponent(h)}`,
    notFound: /The specified profile could not be found/i,
  },
  {
    name: "VK",
    url: (h) => `https://vk.com/${encodeURIComponent(h)}`,
    notFound: /This page has been deleted or is not available|page does not exist/i,
    unreliable: true,
  },
  {
    name: "Keybase",
    url: (h) => `https://keybase.io/${encodeURIComponent(h)}`,
    notFound: /User not found/i,
  },
  {
    name: "Dribbble",
    url: (h) => `https://dribbble.com/${encodeURIComponent(h)}`,
    notFound: /Whoops, that page is gone|page not found/i,
  },
  {
    name: "Kick",
    url: (h) => `https://kick.com/${encodeURIComponent(h)}`,
    notFound: /Page could not be found|not found/i,
    unreliable: true,
  },
  {
    name: "Spotify",
    url: (h) => `https://open.spotify.com/user/${encodeURIComponent(h)}`,
    notFound: /Page not found|Not Found/i,
    unreliable: true,
  },
  {
    name: "DeviantArt",
    url: (h) => `https://www.deviantart.com/${encodeURIComponent(h)}`,
    notFound: /doesn.?t exist|couldn.?t find that page/i,
    unreliable: true,
  },
  {
    name: "Telegram",
    url: (h) => `https://t.me/${encodeURIComponent(h)}`,
    notFound: /^Telegram Messenger$/i,
    unreliable: true,
  },
];

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function checkOne(platform, handle) {
  const url = platform.url(handle);
  const result = { name: platform.name, url, exists: null, reason: null };
  const win = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: false, sandbox: true },
  });

  let httpStatus = null;
  const onNavigate = (_e, navUrl, code) => { httpStatus = code; };
  win.webContents.on("did-navigate", onNavigate);
  win.webContents.on("did-frame-navigate", onNavigate);
  // some sites (Telegram, TikTok...) try to bounce to an app deep-link
  // (tg://, tiktok://) which has no handler here and aborts the whole load
  win.webContents.on("will-navigate", (e, navUrl) => {
    if (!/^https?:\/\//i.test(navUrl)) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  try {
    win.webContents.setUserAgent(USER_AGENT, "en-US,en;q=0.9,tr;q=0.8");

    await Promise.race([
      win.loadURL(url),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 20000)),
    ]);
    await new Promise((r) => setTimeout(r, 1500));

    if (httpStatus === 404 || httpStatus === 410) {
      result.exists = false;
      result.reason = `http_${httpStatus}`;
      return result;
    }

    const finalUrl = win.webContents.getURL();
    const text = await win.webContents.executeJavaScript("document.body.innerText", true).catch(() => "");

    const wall = classifyWall(text, finalUrl, platform.loginUrlPattern);
    if (wall) {
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
    if (!win.isDestroyed()) win.destroy();
  }
}

const CONCURRENCY = 4;

// runs all platforms with a small concurrency pool, calling onResult as soon
// as each one finishes (order not guaranteed) — much faster than one-by-one
async function checkHandle(handle, onResult) {
  const queue = [...PLATFORMS];
  const results = [];

  async function worker() {
    while (queue.length) {
      const platform = queue.shift();
      if (!platform) return;
      const result = await checkOne(platform, handle);
      results.push(result);
      if (onResult) onResult(result);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return results;
}

module.exports = { checkHandle, PLATFORMS };
