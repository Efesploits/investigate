"use strict";

/*
 * OSINT username scanner — plain HTTP, no headless browser.
 *
 * The previous version drove Puppeteer and visited each platform sequentially
 * with a 20s navigation timeout. That cost minutes per scan and, on a 512MB
 * Render instance, launching Chromium routinely pushed the process past its
 * memory limit and killed the server mid-search.
 *
 * This version issues one ordinary HTTP request per platform, all in parallel
 * (bounded), and decides from the status code plus a marker in the returned
 * HTML/JSON. A whole scan now takes a few seconds and a few MB.
 *
 * Honesty rule (unchanged): we only report `exists: true` with real evidence.
 * Sites that render profiles purely client-side, or that wall anonymous
 * visitors, report `null` (UNKNOWN) rather than a guess — those carry
 * `strict200: false` below.
 */

const REQUEST_TIMEOUT_MS = 8000;
const MAX_CONCURRENCY = 8;
const MAX_BODY_CHARS = 300000;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Generic blocking / captcha / bot-protection markers (site independent)
const BLOCKED_PATTERNS =
  /verify you.?re (a )?human|are you a robot|unusual traffic|automated queries|checking your browser|just a moment|captcha|rate limit(ed)?|too many requests|try again later|access denied\b/i;

// "You can't see this without logging in" markers
const LOGIN_WALL_PATTERNS =
  /log ?in to (continue|see)|sign in to (continue|see)|create an account or log in|you must log ?in|join (linkedin|facebook) to|giriş yap(ın)? veya kaydol/i;

// Strip scripts/styles/markup so the wall heuristics only see visible copy.
// Without this, ordinary inline JS trips them — github.com/<user> ships the
// word "captcha" in a bundle and every real profile looked "blocked".
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function classifyWall(text, currentUrl, loginUrlPattern) {
  if (loginUrlPattern && loginUrlPattern.test(currentUrl)) return "login_wall";
  if (LOGIN_WALL_PATTERNS.test(text)) return "login_wall";
  if (BLOCKED_PATTERNS.test(text)) return "blocked";
  if (text.replace(/\s+/g, "").length < 40) return "empty_page";
  return null;
}

/*
 * strict200      — a 200 by itself proves the account exists (the site 404s for
 *                  unknown names). Gives clean FOUND / NOT FOUND answers.
 * strict200:false — the page renders in JS or walls anonymous visitors, so a 200
 *                  proves nothing; without a positive marker it stays UNKNOWN.
 * found/notFound — markers matched against the body; they beat the status code.
 * json           — endpoint returns JSON; the predicate decides existence.
 * profileUrl     — human-facing link when we query an API endpoint instead.
 */
const PLATFORMS = [
  // ---- status-code reliable ----
  {
    name: "GitHub",
    url: (h) => `https://github.com/${encodeURIComponent(h)}`,
    strict200: true,
    notFound: /This is not the web page you are looking for|Page not found/i,
  },
  {
    name: "YouTube",
    url: (h) => `https://www.youtube.com/@${encodeURIComponent(h)}`,
    strict200: true,
    notFound: /This page isn.?t available/i,
  },
  {
    name: "Linktree",
    url: (h) => `https://linktr.ee/${encodeURIComponent(h)}`,
    strict200: true,
    notFound: /isn.?t claimed yet|page not found/i,
  },
  {
    // soft-404s: a missing profile still returns 200, but with an empty <title>
    name: "Pinterest",
    url: (h) => `https://www.pinterest.com/${encodeURIComponent(h)}/`,
    strict200: false,
    found: /<title[^>]*>[^<]*-\s*Profile\s*\|\s*Pinterest/i,
    notFound: /Sorry! We couldn.?t find that page/i,
  },
  {
    name: "DeviantArt",
    url: (h) => `https://www.deviantart.com/${encodeURIComponent(h)}`,
    strict200: true,
    notFound: /doesn.?t exist|couldn.?t find that page/i,
  },
  {
    name: "Dribbble",
    url: (h) => `https://dribbble.com/${encodeURIComponent(h)}`,
    strict200: true,
    notFound: /Whoops, that page is gone|page not found/i,
  },
  {
    // Spotify serves an identical web-player shell whether or not the user
    // exists, so an anonymous request can never confirm one — always UNKNOWN.
    name: "Spotify",
    url: (h) => `https://open.spotify.com/user/${encodeURIComponent(h)}`,
    strict200: false,
    notFound: /Page not found|Not Found/i,
    unreliable: true,
  },

  // ---- JSON APIs: cheapest and most reliable of all ----
  {
    name: "Reddit",
    url: (h) => `https://www.reddit.com/user/${encodeURIComponent(h)}/about.json`,
    profileUrl: (h) => `https://www.reddit.com/user/${encodeURIComponent(h)}/`,
    json: (data) => !!(data && data.data && (data.data.name || data.data.id)),
  },
  {
    name: "Kick",
    url: (h) => `https://kick.com/api/v2/channels/${encodeURIComponent(h)}`,
    profileUrl: (h) => `https://kick.com/${encodeURIComponent(h)}`,
    json: (data) => !!(data && (data.id || data.user_id || data.slug)),
  },
  {
    name: "Keybase",
    url: (h) => `https://keybase.io/_/api/1.0/user/lookup.json?username=${encodeURIComponent(h)}`,
    profileUrl: (h) => `https://keybase.io/${encodeURIComponent(h)}`,
    // status.code 0 = found, 205 = not found
    json: (data) => !!(data && data.status && data.status.code === 0 && data.them),
  },
  {
    name: "Roblox",
    url: () => "https://users.roblox.com/v1/usernames/users",
    profileUrl: (h) => `https://www.roblox.com/users/profile?username=${encodeURIComponent(h)}`,
    request: (h) => ({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usernames: [h], excludeBannedUsers: false }),
    }),
    json: (data) => !!(data && Array.isArray(data.data) && data.data.length > 0),
  },

  // ---- body-marker reliable ----
  {
    name: "Steam",
    url: (h) => `https://steamcommunity.com/id/${encodeURIComponent(h)}`,
    strict200: false,
    notFound: /The specified profile could not be found/i,
    found: /g_rgProfileData|profile_header/i,
  },
  {
    name: "Telegram",
    url: (h) => `https://t.me/${encodeURIComponent(h)}`,
    strict200: false,
    found: /tgme_page_title|tgme_page_extra/i,
    unreliable: true, // t.me previews look similar whether or not the name is taken
  },
  {
    name: "Twitch",
    url: (h) => `https://www.twitch.tv/${encodeURIComponent(h)}`,
    strict200: false,
    notFound: /Sorry\. Unless you.?ve got a time machine/i,
    unreliable: true,
  },
  {
    name: "VK",
    url: (h) => `https://vk.com/${encodeURIComponent(h)}`,
    strict200: false,
    notFound: /This page has been deleted or is not available|page does not exist/i,
    unreliable: true,
  },

  // ---- login-walled / JS-rendered: usually honest UNKNOWNs ----
  {
    name: "Instagram",
    url: (h) => `https://www.instagram.com/${encodeURIComponent(h)}/`,
    strict200: false,
    notFound: /Sorry, this page isn't available|Üzgünüz, bu sayfa/i,
    loginUrlPattern: /\/accounts\/login/,
  },
  {
    name: "TikTok",
    url: (h) => `https://www.tiktok.com/@${encodeURIComponent(h)}`,
    strict200: false,
    notFound: /Couldn't find this account|kullanıcı bulunamadı/i,
  },
  {
    name: "X (Twitter)",
    url: (h) => `https://x.com/${encodeURIComponent(h)}`,
    strict200: false,
    notFound: /This account doesn.?t exist/i,
    loginUrlPattern: /\/(i\/flow\/login|login)/,
  },
  {
    name: "Threads",
    url: (h) => `https://www.threads.net/@${encodeURIComponent(h)}`,
    strict200: false,
    notFound: /Sorry, this page isn't available/i,
    loginUrlPattern: /\/login/,
  },
  {
    name: "Facebook",
    url: (h) => `https://www.facebook.com/${encodeURIComponent(h)}`,
    strict200: false,
    notFound: /This content isn.?t available|content isn.?t available right now/i,
    loginUrlPattern: /\/login/,
    unreliable: true,
  },
  {
    name: "LinkedIn",
    url: (h) => `https://www.linkedin.com/in/${encodeURIComponent(h)}`,
    strict200: false,
    notFound: /This page doesn.?t exist|Page not found/i,
    loginUrlPattern: /\/authwall|\/uas\/login/,
    unreliable: true,
  },
];

async function checkOne(platform, handle) {
  const requestUrl = platform.url(handle);
  const shownUrl = platform.profileUrl ? platform.profileUrl(handle) : requestUrl;
  const result = { name: platform.name, url: shownUrl, exists: null, reason: null };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const extra = platform.request ? platform.request(handle) : {};
    const res = await fetch(requestUrl, {
      method: extra.method || "GET",
      body: extra.body,
      redirect: "follow",
      signal: controller.signal,
      headers: Object.assign(
        {
          "User-Agent": UA,
          "Accept-Language": "en-US,en;q=0.9",
          Accept: platform.json
            ? "application/json,text/plain,*/*"
            : "text/html,application/xhtml+xml,*/*;q=0.8",
        },
        extra.headers || {}
      ),
    });

    const status = res.status;
    if (status === 404 || status === 410) {
      result.exists = false;
      result.reason = `http_${status}`;
      return result;
    }
    if (status === 403 || status === 429) {
      result.exists = null;
      result.reason = status === 429 ? "rate_limited" : "blocked";
      return result;
    }

    const finalUrl = res.url || requestUrl;
    const body = (await res.text()).slice(0, MAX_BODY_CHARS);

    // JSON endpoints answer definitively
    if (platform.json) {
      let data = null;
      try { data = JSON.parse(body); } catch (_) {}
      if (data == null) { result.exists = null; result.reason = "error"; return result; }
      result.exists = !!platform.json(data);
      if (result.exists && platform.unreliable) result.reason = "unreliable_check";
      return result;
    }

    // explicit markers beat everything else (matched against raw HTML —
    // `found` markers are often script/attribute names, not visible copy)
    if (platform.notFound && platform.notFound.test(body)) { result.exists = false; return result; }
    if (platform.found && platform.found.test(body)) {
      result.exists = true;
      if (platform.unreliable) result.reason = "unreliable_check";
      return result;
    }

    // On a strict200 site the server 404s for unknown names, so a 200 with no
    // not-found marker is proof. Decide here, before the fuzzy wall heuristics.
    if (status >= 200 && status < 300 && platform.strict200) {
      result.exists = true;
      if (platform.unreliable) result.reason = "unreliable_check";
      return result;
    }

    const wall = classifyWall(htmlToText(body), finalUrl, platform.loginUrlPattern);
    if (wall) { result.exists = null; result.reason = wall; return result; }

    // a 200 from a JS-rendered or walled site proves nothing — stay honest
    result.exists = null;
    result.reason = "unreliable_check";
    return result;
  } catch (err) {
    result.exists = null;
    result.reason = err.name === "AbortError" ? "timeout" : "error";
    result.error = err.message;
    return result;
  } finally {
    clearTimeout(timer);
  }
}

// bounded parallelism — each result is handed to onResult the moment it lands
async function runPool(items, limit, fn, onResult) {
  const results = [];
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      const r = await fn(items[i]);
      results.push(r);
      if (onResult) { try { onResult(r); } catch (_) {} }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function checkHandle(handle, onResult) {
  return runPool(PLATFORMS, MAX_CONCURRENCY, (p) => checkOne(p, handle), onResult);
}

module.exports = { checkHandle, PLATFORMS };
