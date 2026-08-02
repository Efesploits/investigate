/* ==========================================================================
 * Minimal Lanyard client — live Discord presence for connected members.
 * Reads presence from https://api.lanyard.rest (REST + WebSocket).
 * Docs: https://github.com/Phineas/lanyard
 *
 * Exposes window.Lanyard:
 *   fetchOne(id)            -> Promise<summary|null>   (one-shot REST read)
 *   subscribe(ids, onUpdate)-> { close() }             (live socket, batched)
 *   summarize(data)         -> summary                 (shape a raw payload)
 * A `summary` is { status, color, label, activity, user, spotify, raw }.
 * ========================================================================== */
(function () {
  "use strict";
  var REST = "https://api.lanyard.rest/v1/users/";
  var WS = "wss://api.lanyard.rest/socket";

  function statusColor(s) {
    return s === "online" ? "#3ba55d"
      : s === "idle" ? "#faa61a"
      : s === "dnd" ? "#ed4245"
      : "#747f8d";
  }
  function statusLabel(s) {
    return s === "online" ? "Online"
      : s === "idle" ? "Idle"
      : s === "dnd" ? "Do Not Disturb"
      : "Offline";
  }

  // Turn a Lanyard `data` object into a short, human "what they're up to" line.
  function activityLine(data) {
    if (!data) return "";
    if (data.listening_to_spotify && data.spotify) {
      return "🎧 " + (data.spotify.song || "Spotify") +
        (data.spotify.artist ? " — " + data.spotify.artist : "");
    }
    // type 4 is a custom status ("feeling great") — not an activity we surface here
    var acts = (data.activities || []).filter(function (a) { return a && a.type !== 4; });
    var act = acts.filter(function (a) { return a.type === 0; })[0] || acts[0]; // prefer a game
    if (!act) return "";
    var icon = act.type === 2 ? "🎧 "   // Listening
      : act.type === 3 ? "📺 "          // Watching
      : act.type === 1 ? "🔴 "          // Streaming
      : "🎮 ";                          // Playing
    var text = act.name || "";
    if (act.details) text += " — " + act.details;
    return icon + text;
  }

  function summarize(data) {
    var status = (data && data.discord_status) || "offline";
    return {
      status: status,
      color: statusColor(status),
      label: statusLabel(status),
      activity: activityLine(data),
      user: (data && data.discord_user) || null,
      spotify: (data && data.spotify) || null,
      raw: data || null,
    };
  }

  function fetchOne(id) {
    return fetch(REST + encodeURIComponent(id), { headers: { Accept: "application/json" } })
      .then(function (r) { return r.json(); })
      .then(function (j) { return (j && j.success) ? summarize(j.data) : null; })
      .catch(function () { return null; });
  }

  // Live batch subscription over the socket. onUpdate(id, summary) fires on the
  // first state and on every subsequent presence change. Auto-reconnects.
  function subscribe(ids, onUpdate) {
    ids = [];
    var seen = {};
    (arguments[0] || []).forEach(function (x) {
      if (x == null) return;
      var s = String(x);
      if (!seen[s]) { seen[s] = 1; ids.push(s); }
    });

    var ws = null, heartbeat = null, retry = null, closed = false;

    function open() {
      if (closed || !ids.length) return;
      try { ws = new WebSocket(WS); } catch (_) { schedule(); return; }

      ws.onopen = function () {
        var d = ids.length === 1 ? { subscribe_to_id: ids[0] } : { subscribe_to_ids: ids };
        try { ws.send(JSON.stringify({ op: 2, d: d })); } catch (_) {}
      };
      ws.onmessage = function (ev) {
        var msg; try { msg = JSON.parse(ev.data); } catch (_) { return; }
        if (msg.op === 1 && msg.d && msg.d.heartbeat_interval) {
          clearInterval(heartbeat);
          heartbeat = setInterval(function () {
            try { ws.send(JSON.stringify({ op: 3 })); } catch (_) {}
          }, msg.d.heartbeat_interval);
          return;
        }
        if (msg.op !== 0) return;
        var d = msg.d || {};
        if (msg.t === "INIT_STATE") {
          // multi-subscribe → object keyed by id; single → the data object itself
          if (d.discord_user) onUpdate(String(d.discord_user.id), summarize(d));
          else Object.keys(d).forEach(function (k) { onUpdate(String(k), summarize(d[k])); });
        } else if (msg.t === "PRESENCE_UPDATE") {
          var id = d.discord_user ? String(d.discord_user.id) : (d.user_id != null ? String(d.user_id) : null);
          if (id) onUpdate(id, summarize(d));
        }
      };
      ws.onclose = function () { clearInterval(heartbeat); if (!closed) schedule(); };
      ws.onerror = function () { try { ws.close(); } catch (_) {} };
    }
    function schedule() { clearTimeout(retry); retry = setTimeout(open, 4000); }

    open();
    return {
      close: function () {
        closed = true;
        clearInterval(heartbeat);
        clearTimeout(retry);
        try { ws && ws.close(); } catch (_) {}
      },
    };
  }

  window.Lanyard = {
    fetchOne: fetchOne,
    subscribe: subscribe,
    summarize: summarize,
    statusColor: statusColor,
    statusLabel: statusLabel,
    activityLine: activityLine,
  };
})();
