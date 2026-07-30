"use strict";

/*
 * Self-update for the portable client.
 *
 * A running .exe can't overwrite itself on Windows, so the flow is:
 *   1. fetch a small JSON manifest from the site and compare versions
 *   2. download the new .exe next to the current one (as *.new.exe)
 *   3. write a .cmd that waits for this process to exit, swaps the files,
 *      relaunches the app and deletes itself
 *   4. quit — the script takes over
 */

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

// overridable so the update flow can be exercised against a local server
const MANIFEST_URL =
  process.env.M3_UPDATE_MANIFEST || "https://investigate.onrender.com/download/latest.json";

// the portable build runs from a temp extraction dir; this env var points at
// the real .exe the user launched, which is the file we actually replace
function currentExePath() {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}

function get(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("http:") ? http : https;
    const req = lib.get(url, { timeout: 20000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (!redirectsLeft) return reject(new Error("Too many redirects"));
        return resolve(get(new URL(res.headers.location, url).toString(), redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error("HTTP " + res.statusCode));
      }
      resolve(res);
    });
    req.on("timeout", () => req.destroy(new Error("Request timed out")));
    req.on("error", reject);
  });
}

async function fetchJson(url) {
  const res = await get(url);
  let body = "";
  res.setEncoding("utf8");
  for await (const chunk of res) body += chunk;
  return JSON.parse(body);
}

// hard deadline so a stalled connection can never leave the UI spinning forever
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error((label || "Operation") + " timed out")),
      ms
    );
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

// -1 / 0 / 1
function compareVersions(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

async function check(currentVersion) {
  // cache-bust so a stale/hung CDN response can't wedge the check
  const url = MANIFEST_URL + (MANIFEST_URL.indexOf("?") === -1 ? "?" : "&") + "t=" + Date.now();
  const manifest = await withTimeout(fetchJson(url), 20000, "Update check");
  if (!manifest || !manifest.version || !manifest.url) {
    throw new Error("Malformed update manifest.");
  }
  const available = compareVersions(manifest.version, currentVersion) > 0;
  return {
    ok: true,
    available,
    currentVersion,
    latestVersion: manifest.version,
    notes: manifest.notes || "",
    url: manifest.url,
  };
}

async function download(url, destPath, onProgress) {
  const res = await get(url);
  const total = parseInt(res.headers["content-length"] || "0", 10);
  let received = 0;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destPath);
    res.on("data", (chunk) => {
      received += chunk.length;
      if (onProgress) onProgress({ received, total });
    });
    res.on("error", reject);
    out.on("error", reject);
    out.on("finish", resolve);
    res.pipe(out);
  });
  if (total && received !== total) {
    throw new Error("Download incomplete (" + received + "/" + total + " bytes).");
  }
  return destPath;
}

// builds the swap script and hands control to it
function scheduleSwapAndRestart(newExe, targetExe) {
  const cmdPath = path.join(os.tmpdir(), "m3-update-" + process.pid + ".cmd");
  const vbsPath = path.join(os.tmpdir(), "m3-update-" + process.pid + ".vbs");
  // the running process' image name — matched together with the PID so a reused
  // PID (Windows recycles them) can't be mistaken for our still-running app
  const exeImage = path.basename(process.execPath);

  const script = [
    "@echo off",
    "setlocal enabledelayedexpansion",
    'set "TARGET=' + targetExe + '"',
    'set "NEWFILE=' + newExe + '"',
    // wait for the old app to exit — bounded so it can never spin forever, and
    // matched on PID *and* image name to survive PID reuse
    "set /a WAITS=0",
    ":waitloop",
    'tasklist /fi "PID eq ' + process.pid + '" /fi "IMAGENAME eq ' + exeImage + '" /nh 2>nul | find /i "' + exeImage + '" >nul',
    "if errorlevel 1 goto swap",
    "set /a WAITS+=1",
    "if !WAITS! GEQ 30 goto swap",
    "ping -n 2 127.0.0.1 >nul",
    "goto waitloop",
    // retry the move in case the file lock lingers a moment
    ":swap",
    "set /a TRIES=0",
    ":swaploop",
    'move /y "%NEWFILE%" "%TARGET%" >nul 2>&1',
    "if not errorlevel 1 goto done",
    "set /a TRIES+=1",
    "if !TRIES! GEQ 20 goto fail",
    "ping -n 2 127.0.0.1 >nul",
    "goto swaploop",
    ":done",
    'start "" "%TARGET%"',
    "goto cleanup",
    ":fail",
    'del "%NEWFILE%" >nul 2>&1',
    ":cleanup",
    'del "' + vbsPath + '" >nul 2>&1',
    '(goto) 2>nul & del "%~f0"',
  ].join("\r\n");
  fs.writeFileSync(cmdPath, script, "utf8");

  // Launch the batch through a hidden WScript shell so no console window ever
  // flashes. spawn()'s windowsHide is unreliable for a detached console; the
  // VBScript Run(..., 0, ...) style reliably runs it fully hidden.
  const vbs = 'CreateObject("WScript.Shell").Run "cmd /c ""' + cmdPath + '""", 0, False';
  fs.writeFileSync(vbsPath, vbs, "utf8");

  const child = spawn("wscript.exe", ["//B", "//Nologo", vbsPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return cmdPath;
}

async function install(url, onProgress) {
  if (process.platform !== "win32") {
    throw new Error("Self-update is only supported on Windows.");
  }
  const targetExe = currentExePath();
  const newExe = path.join(path.dirname(targetExe), path.basename(targetExe, ".exe") + ".new.exe");

  if (fs.existsSync(newExe)) {
    try { fs.unlinkSync(newExe); } catch (_) {}
  }
  await download(url, newExe, onProgress);

  const stat = fs.statSync(newExe);
  if (stat.size < 1024 * 1024) {
    try { fs.unlinkSync(newExe); } catch (_) {}
    throw new Error("Downloaded file looks wrong (" + stat.size + " bytes).");
  }

  scheduleSwapAndRestart(newExe, targetExe);
  return { ok: true, targetExe, newExe };
}

module.exports = { check, install, compareVersions, currentExePath, MANIFEST_URL };
