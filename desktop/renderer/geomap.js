/* ==========================================================================
 * GeoMap — the dark map the GEOINT results land on.
 *
 * A self-contained slippy map (no external mapping library): it lays out
 * Web-Mercator tiles, pans with a drag and zooms on the wheel. Tiles come from
 * CARTO's dark basemap, which is already black — no filter hacks — and needs
 * no API key, so the feature works the moment it is deployed.
 *
 *   const map = GeoMap.create(el);
 *   map.searching(true);                     // white dot breathing, no map
 *   map.locate({ lat, lon, zoom });          // breathe twice, then bloom open
 *   map.destroy();
 *
 * Attribution is required by OpenStreetMap/CARTO and is rendered in-map.
 * ========================================================================== */
(function () {
  "use strict";

  var TILE = 256;
  var TILE_URL = "https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png";
  var MIN_Z = 2, MAX_Z = 19;

  var CSS = [
    ".gm-root{position:relative;width:100%;height:100%;overflow:hidden;background:#05070a;",
    "border-radius:14px;touch-action:none;user-select:none}",
    ".gm-tiles{position:absolute;inset:0;opacity:0;transition:opacity .3s ease}",
    ".gm-tiles.on{opacity:1}",
    ".gm-pane{position:absolute;left:0;top:0;will-change:transform}",
    ".gm-pane img{position:absolute;width:256px;height:256px;pointer-events:none;",
    "opacity:0;transition:opacity .35s ease}",
    ".gm-pane img.ready{opacity:1}",
    /* the bloom: map is revealed by growing a circle out of the centre */
    ".gm-bloom{clip-path:circle(0% at 50% 50%);-webkit-clip-path:circle(0% at 50% 50%)}",
    ".gm-bloom.open{animation:gmBloom 1.15s cubic-bezier(.22,.7,.25,1) forwards}",
    "@keyframes gmBloom{from{clip-path:circle(0% at 50% 50%);-webkit-clip-path:circle(0% at 50% 50%)}",
    "to{clip-path:circle(150% at 50% 50%);-webkit-clip-path:circle(150% at 50% 50%)}}",
    /* the dot: breathing while it looks, settled once it has found the place */
    ".gm-dot{position:absolute;left:50%;top:50%;width:14px;height:14px;margin:-7px 0 0 -7px;",
    "border-radius:50%;background:#fff;pointer-events:none;z-index:4;",
    "box-shadow:0 0 0 0 rgba(255,255,255,.55),0 0 18px 4px rgba(255,255,255,.35)}",
    ".gm-dot.breathing{animation:gmBreathe 1.6s ease-in-out infinite}",
    ".gm-dot.settled{animation:gmSettle 2.8s ease-in-out infinite}",
    ".gm-dot.hidden{display:none}",
    "@keyframes gmBreathe{0%,100%{transform:scale(.72);box-shadow:0 0 0 0 rgba(255,255,255,.5),0 0 14px 3px rgba(255,255,255,.3)}",
    "50%{transform:scale(1.25);box-shadow:0 0 0 14px rgba(255,255,255,0),0 0 26px 8px rgba(255,255,255,.45)}}",
    "@keyframes gmSettle{0%,100%{box-shadow:0 0 0 0 rgba(255,255,255,.45),0 0 16px 4px rgba(255,255,255,.3)}",
    "50%{box-shadow:0 0 0 12px rgba(255,255,255,0),0 0 22px 7px rgba(255,255,255,.4)}}",
    ".gm-ring{position:absolute;left:50%;top:50%;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;",
    "border:1px solid rgba(255,255,255,.55);pointer-events:none;z-index:3;opacity:0}",
    ".gm-ring.on{animation:gmRing 2.8s ease-out infinite}",
    "@keyframes gmRing{0%{opacity:.75;transform:scale(1)}100%{opacity:0;transform:scale(7)}}",
    /* chrome */
    ".gm-logo{position:absolute;left:14px;bottom:12px;z-index:5;display:flex;align-items:center;gap:7px;",
    "opacity:.4;pointer-events:none}",
    ".gm-logo svg{width:26px;height:26px}",
    ".gm-logo span{font-size:.64rem;font-weight:800;letter-spacing:1.4px;text-transform:uppercase;color:#fff}",
    ".gm-attr{position:absolute;right:8px;bottom:7px;z-index:5;font-size:.58rem;color:rgba(255,255,255,.42);",
    "background:rgba(0,0,0,.35);padding:2px 6px;border-radius:5px}",
    ".gm-attr a{color:rgba(255,255,255,.6)}",
    ".gm-zoom{position:absolute;right:10px;top:10px;z-index:5;display:flex;flex-direction:column;gap:5px}",
    ".gm-zoom button{width:29px;height:29px;border-radius:8px;border:1px solid rgba(255,255,255,.16);",
    "background:rgba(10,12,16,.8);color:#fff;font-size:1rem;font-weight:800;cursor:pointer;line-height:1;",
    "display:flex;align-items:center;justify-content:center}",
    ".gm-zoom button:hover{border-color:rgba(255,255,255,.4)}",
    ".gm-grab{cursor:grab}.gm-grab.dragging{cursor:grabbing}",
  ].join("");

  var LOGO = '<svg viewBox="0 0 300 340" aria-hidden="true">' +
    '<line x1="221" y1="211" x2="286" y2="276" stroke="#fff" stroke-width="18" stroke-linecap="round"/>' +
    '<circle cx="150" cy="140" r="100" fill="#000"/>' +
    '<path d="M70,150 C104,120 196,110 230,132 C214,196 92,200 70,150 Z" fill="#fff"/>' +
    '<circle cx="146" cy="156" r="46" fill="#000"/>' +
    '<circle cx="150" cy="140" r="100" fill="none" stroke="#fff" stroke-width="10"/></svg>';

  var styled = false;
  function injectCss() {
    if (styled) return;
    styled = true;
    var s = document.createElement("style");
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  // --- Web Mercator ------------------------------------------------------
  function lonToX(lon, z) { return (lon + 180) / 360 * TILE * Math.pow(2, z); }
  function latToY(lat, z) {
    var s = Math.sin(lat * Math.PI / 180);
    s = Math.max(-0.9999, Math.min(0.9999, s));
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE * Math.pow(2, z);
  }
  function xToLon(x, z) { return x / (TILE * Math.pow(2, z)) * 360 - 180; }
  function yToLat(y, z) {
    var n = Math.PI - 2 * Math.PI * y / (TILE * Math.pow(2, z));
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }

  function create(host, opts) {
    injectCss();
    opts = opts || {};

    var root = document.createElement("div");
    root.className = "gm-root gm-grab";
    root.innerHTML =
      '<div class="gm-tiles gm-bloom"><div class="gm-pane"></div></div>' +
      '<div class="gm-ring"></div>' +
      '<div class="gm-dot hidden"></div>' +
      '<div class="gm-zoom"><button type="button" data-z="1">+</button><button type="button" data-z="-1">−</button></div>' +
      '<div class="gm-logo">' + LOGO + '<span>m3 geoint</span></div>' +
      '<div class="gm-attr">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> · CARTO</div>';
    host.innerHTML = "";
    host.appendChild(root);

    var tiles = root.querySelector(".gm-tiles");
    var pane = root.querySelector(".gm-pane");
    var dot = root.querySelector(".gm-dot");
    var ring = root.querySelector(".gm-ring");

    var lat = opts.lat != null ? opts.lat : 0;
    var lon = opts.lon != null ? opts.lon : 0;
    var zoom = opts.zoom != null ? opts.zoom : 16;
    var cache = {};   // key -> img, so panning back doesn't refetch
    var destroyed = false;

    function size() { return { w: root.clientWidth || 600, h: root.clientHeight || 400 }; }

    function render() {
      if (destroyed) return;
      var s = size();
      var z = Math.round(zoom);
      var cx = lonToX(lon, z), cy = latToY(lat, z);
      // top-left of the viewport in world pixels
      var originX = cx - s.w / 2, originY = cy - s.h / 2;
      var n = Math.pow(2, z);

      var x0 = Math.floor(originX / TILE), x1 = Math.floor((originX + s.w) / TILE);
      var y0 = Math.floor(originY / TILE), y1 = Math.floor((originY + s.h) / TILE);

      var wanted = {};
      for (var ty = y0; ty <= y1; ty++) {
        if (ty < 0 || ty >= n) continue;
        for (var tx = x0; tx <= x1; tx++) {
          var wx = ((tx % n) + n) % n;           // wrap the world horizontally
          var key = z + "/" + wx + "/" + ty;
          wanted[key + "@" + tx] = true;
          var id = key + "@" + tx;
          var img = cache[id];
          if (!img) {
            img = document.createElement("img");
            img.alt = "";
            img.decoding = "async";
            img.loading = "eager";
            img.addEventListener("load", function () { this.classList.add("ready"); });
            img.src = TILE_URL.replace("{z}", z).replace("{x}", wx).replace("{y}", ty);
            cache[id] = img;
            pane.appendChild(img);
          }
          img.style.transform = "translate(" + (tx * TILE - originX) + "px," + (ty * TILE - originY) + "px)";
        }
      }
      // drop tiles that scrolled away so the DOM doesn't grow without bound
      Object.keys(cache).forEach(function (id) {
        if (!wanted[id]) { var el = cache[id]; if (el && el.parentNode) el.parentNode.removeChild(el); delete cache[id]; }
      });
    }

    function clearTiles() {
      Object.keys(cache).forEach(function (id) {
        var el = cache[id]; if (el && el.parentNode) el.parentNode.removeChild(el); delete cache[id];
      });
    }

    // --- interaction -----------------------------------------------------
    var dragging = false, lastX = 0, lastY = 0, pid = null;
    function onDown(e) {
      if (e.target.closest && e.target.closest(".gm-zoom")) return;
      dragging = true; pid = e.pointerId; lastX = e.clientX; lastY = e.clientY;
      root.classList.add("dragging");
      try { root.setPointerCapture(pid); } catch (_) {}
    }
    function onMove(e) {
      if (!dragging) return;
      var z = Math.round(zoom);
      var cx = lonToX(lon, z) - (e.clientX - lastX);
      var cy = latToY(lat, z) - (e.clientY - lastY);
      lon = xToLon(cx, z);
      lat = Math.max(-85, Math.min(85, yToLat(cy, z)));
      lastX = e.clientX; lastY = e.clientY;
      render();
    }
    function onUp() {
      dragging = false; root.classList.remove("dragging");
      try { if (pid != null) root.releasePointerCapture(pid); } catch (_) {}
      pid = null;
    }
    function setZoom(z) {
      z = Math.max(MIN_Z, Math.min(MAX_Z, z));
      if (z === zoom) return;
      zoom = z; clearTiles(); render();
    }
    function onWheel(e) { e.preventDefault(); setZoom(Math.round(zoom) + (e.deltaY < 0 ? 1 : -1)); }
    function onZoomBtn(e) {
      var b = e.target.closest("button[data-z]");
      if (b) setZoom(Math.round(zoom) + Number(b.dataset.z));
    }
    var onResize = function () { render(); };

    root.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    root.addEventListener("wheel", onWheel, { passive: false });
    root.querySelector(".gm-zoom").addEventListener("click", onZoomBtn);
    window.addEventListener("resize", onResize);

    var api = {
      // Just the dot, breathing — shown while the scan is running.
      searching: function (on) {
        dot.classList.toggle("hidden", !on);
        dot.classList.toggle("breathing", !!on);
        if (on) { dot.classList.remove("settled"); ring.classList.remove("on"); tiles.classList.remove("on", "open"); }
        return api;
      },
      // Breathe twice, then let the map bloom out of the centre.
      locate: function (o) {
        o = o || {};
        if (o.lat != null) lat = o.lat;
        if (o.lon != null) lon = o.lon;
        if (o.zoom != null) zoom = o.zoom;
        clearTiles(); render();

        dot.classList.remove("hidden");
        dot.classList.add("breathing");

        // two breaths at 1.6s each, then the reveal; the timer is the only
        // clock here because the dot's animation is infinite by design.
        var t = setTimeout(function () {
          if (destroyed) return;
          tiles.classList.add("on");
          tiles.classList.add("open");
          dot.classList.remove("breathing");
          dot.classList.add("settled");
          ring.classList.add("on");
          render();
        }, 3200);
        api._t = t;
        return api;
      },
      center: function (o) {
        if (o.lat != null) lat = o.lat;
        if (o.lon != null) lon = o.lon;
        if (o.zoom != null) zoom = o.zoom;
        clearTiles(); render();
        return api;
      },
      // reveal with no theatre — used when returning from Street View
      show: function () {
        tiles.classList.add("on", "open");
        dot.classList.remove("hidden", "breathing");
        dot.classList.add("settled");
        ring.classList.add("on");
        render();
        return api;
      },
      invalidate: render,
      get zoom() { return Math.round(zoom); },
      destroy: function () {
        destroyed = true;
        clearTimeout(api._t);
        root.removeEventListener("pointerdown", onDown);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        root.removeEventListener("wheel", onWheel);
        window.removeEventListener("resize", onResize);
        clearTiles();
        if (root.parentNode) root.parentNode.removeChild(root);
      },
    };
    return api;
  }

  window.GeoMap = { create: create };
})();
