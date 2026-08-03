/* ==========================================================================
 * Image cropper — pick the part of a picture that actually gets used, the way
 * Discord does it: drag to reposition, zoom to frame, apply.
 *
 *   window.Cropper.open(file, {
 *     aspect: 1,          // width / height of the crop window
 *     round: true,        // draw the guide as a circle (avatars)
 *     out:   512,         // output width in px (height follows the aspect)
 *     quality: 0.9,       // JPEG quality
 *     title: "Crop",
 *   }) -> Promise<dataURL | null>        // null when the user cancels
 *
 * Styles are injected here so both the website and the desktop client get the
 * identical dialog from this one file. Colours come from the host app's CSS
 * variables, so it themes itself automatically.
 * ========================================================================== */
(function () {
  "use strict";

  var CSS = [
    ".crop-back{position:fixed;inset:0;background:rgba(0,0,0,.72);backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px);",
    "display:none;align-items:center;justify-content:center;z-index:200;padding:20px}",
    ".crop-back.show{display:flex}",
    ".crop-modal{width:100%;max-width:520px;background:var(--panel,#101010);border:1px solid var(--border,#262626);border-radius:18px;",
    "padding:22px;box-shadow:0 30px 90px rgba(0,0,0,.6)}",
    ".crop-modal h2{margin:0 0 3px;font-size:1.18rem}",
    ".crop-sub{color:var(--muted,#888);font-size:.8rem;margin:0 0 16px}",
    ".crop-stage{position:relative;width:100%;overflow:hidden;border-radius:12px;background:#000;",
    "touch-action:none;cursor:grab;user-select:none}",
    ".crop-stage.grabbing{cursor:grabbing}",
    ".crop-stage img{position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform;pointer-events:none;-webkit-user-drag:none}",
    ".crop-mask{position:absolute;inset:0;pointer-events:none;box-shadow:0 0 0 9999px rgba(0,0,0,.55)}",
    ".crop-mask.round{border-radius:50%}",
    ".crop-grid{position:absolute;inset:0;pointer-events:none;opacity:.35}",
    ".crop-grid::before,.crop-grid::after{content:'';position:absolute;background:rgba(255,255,255,.5)}",
    ".crop-grid::before{left:33.33%;right:33.33%;top:0;bottom:0;border-left:1px solid rgba(255,255,255,.5);border-right:1px solid rgba(255,255,255,.5);background:none}",
    ".crop-grid::after{top:33.33%;bottom:33.33%;left:0;right:0;border-top:1px solid rgba(255,255,255,.5);border-bottom:1px solid rgba(255,255,255,.5);background:none}",
    ".crop-zoom{display:flex;align-items:center;gap:10px;margin-top:16px;color:var(--muted,#888);font-size:.74rem;font-weight:700}",
    ".crop-zoom input[type=range]{flex:1;accent-color:var(--accent,#f4f4f4);cursor:pointer}",
    ".crop-actions{display:flex;gap:9px;justify-content:flex-end;margin-top:16px}",
    ".crop-btn{padding:10px 18px;border-radius:10px;border:1px solid var(--border,#262626);background:transparent;",
    "color:var(--text,#f4f4f4);font-family:inherit;font-weight:700;font-size:.85rem;cursor:pointer}",
    ".crop-btn:hover{border-color:#666}",
    ".crop-btn.primary{border:none;background:var(--accent,#f4f4f4);color:#000;font-weight:800}",
    ".crop-btn.primary:hover{filter:brightness(1.07)}",
    ".crop-hint{color:var(--muted,#888);font-size:.72rem;margin-top:12px;text-align:center}",
  ].join("");

  var el = null; // cached DOM

  function build() {
    if (el) return el;
    var style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    var back = document.createElement("div");
    back.className = "crop-back";
    back.innerHTML =
      '<div class="crop-modal">' +
        '<h2 class="crop-title">Edit image</h2>' +
        '<p class="crop-sub">Drag to reposition · scroll or use the slider to zoom</p>' +
        '<div class="crop-stage"><img alt=""><div class="crop-grid"></div><div class="crop-mask"></div></div>' +
        '<div class="crop-zoom"><span>ZOOM</span><input type="range" min="1" max="4" step="0.01" value="1"></div>' +
        '<div class="crop-actions">' +
          '<button type="button" class="crop-btn crop-cancel">Cancel</button>' +
          '<button type="button" class="crop-btn primary crop-apply">Apply</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(back);

    el = {
      back: back,
      title: back.querySelector(".crop-title"),
      stage: back.querySelector(".crop-stage"),
      img: back.querySelector("img"),
      mask: back.querySelector(".crop-mask"),
      grid: back.querySelector(".crop-grid"),
      zoom: back.querySelector("input[type=range]"),
      cancel: back.querySelector(".crop-cancel"),
      apply: back.querySelector(".crop-apply"),
    };
    return el;
  }

  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var rd = new FileReader();
      rd.onload = function () {
        var im = new Image();
        im.onload = function () { resolve(im); };
        im.onerror = reject;
        im.src = rd.result;
      };
      rd.onerror = reject;
      rd.readAsDataURL(file);
    });
  }

  function open(file, opts) {
    opts = opts || {};
    var aspect = opts.aspect || 1;
    var outW = opts.out || 512;
    var outH = Math.round(outW / aspect);
    var quality = opts.quality || 0.9;

    return readFile(file).then(function (img) {
      var d = build();
      d.title.textContent = opts.title || "Edit image";
      d.mask.classList.toggle("round", !!opts.round);
      d.grid.style.display = opts.round ? "none" : "";
      d.img.src = img.src;

      // Size the stage: as wide as the dialog allows, height from the aspect.
      var stageW = Math.min(460, Math.max(240, window.innerWidth - 100));
      var stageH = Math.round(stageW / aspect);
      var maxH = Math.max(160, window.innerHeight - 320);
      if (stageH > maxH) { stageH = maxH; stageW = Math.round(stageH * aspect); }
      d.stage.style.width = stageW + "px";
      d.stage.style.height = stageH + "px";
      d.stage.style.margin = "0 auto";

      // The image must always cover the crop window, so the smallest allowed
      // zoom is whatever it takes to fill it; everything else clamps to that.
      var minScale = Math.max(stageW / img.naturalWidth, stageH / img.naturalHeight);
      var scale = minScale, offX = 0, offY = 0; // offsets: image centre vs stage centre

      function clamp() {
        var halfW = (img.naturalWidth * scale - stageW) / 2;
        var halfH = (img.naturalHeight * scale - stageH) / 2;
        if (halfW < 0) halfW = 0;
        if (halfH < 0) halfH = 0;
        if (offX > halfW) offX = halfW;
        if (offX < -halfW) offX = -halfW;
        if (offY > halfH) offY = halfH;
        if (offY < -halfH) offY = -halfH;
      }
      function draw() {
        clamp();
        var w = img.naturalWidth * scale, h = img.naturalHeight * scale;
        var x = (stageW - w) / 2 + offX;
        var y = (stageH - h) / 2 + offY;
        d.img.style.width = img.naturalWidth + "px";
        d.img.style.height = img.naturalHeight + "px";
        d.img.style.transform = "translate(" + x + "px," + y + "px) scale(" + scale + ")";
      }
      function setZoomFromSlider() {
        scale = minScale * parseFloat(d.zoom.value || "1");
        draw();
      }

      d.zoom.min = "1"; d.zoom.max = "4"; d.zoom.step = "0.01"; d.zoom.value = "1";
      draw();

      // --- panning -------------------------------------------------------
      var dragging = false, lastX = 0, lastY = 0, pid = null;
      function onDown(e) {
        dragging = true; pid = e.pointerId;
        lastX = e.clientX; lastY = e.clientY;
        d.stage.classList.add("grabbing");
        try { d.stage.setPointerCapture(pid); } catch (_) {}
      }
      function onMove(e) {
        if (!dragging) return;
        offX += e.clientX - lastX;
        offY += e.clientY - lastY;
        lastX = e.clientX; lastY = e.clientY;
        draw();
      }
      function onUp() {
        dragging = false;
        d.stage.classList.remove("grabbing");
        try { if (pid != null) d.stage.releasePointerCapture(pid); } catch (_) {}
        pid = null;
      }
      function onWheel(e) {
        e.preventDefault();
        var next = parseFloat(d.zoom.value) * (e.deltaY < 0 ? 1.08 : 1 / 1.08);
        d.zoom.value = String(Math.min(4, Math.max(1, next)));
        setZoomFromSlider();
      }

      return new Promise(function (resolve) {
        function cleanup() {
          d.back.classList.remove("show");
          d.stage.removeEventListener("pointerdown", onDown);
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          d.stage.removeEventListener("wheel", onWheel);
          d.zoom.removeEventListener("input", setZoomFromSlider);
          d.cancel.removeEventListener("click", onCancel);
          d.apply.removeEventListener("click", onApply);
          d.back.removeEventListener("mousedown", onBackdrop);
          document.removeEventListener("keydown", onKey);
          d.img.removeAttribute("src");
        }
        function onCancel() { cleanup(); resolve(null); }
        function onApply() {
          // Map the crop window back onto the source image and repaint it at
          // the output size — this is what actually trims the picture.
          var w = img.naturalWidth * scale, h = img.naturalHeight * scale;
          var x = (stageW - w) / 2 + offX;
          var y = (stageH - h) / 2 + offY;
          var sx = -x / scale, sy = -y / scale;
          var sw = stageW / scale, sh = stageH / scale;

          var c = document.createElement("canvas");
          c.width = outW; c.height = outH;
          var ctx = c.getContext("2d");
          ctx.fillStyle = "#000";
          ctx.fillRect(0, 0, outW, outH);
          ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH);
          var url = c.toDataURL("image/jpeg", quality);
          cleanup();
          resolve(url);
        }
        function onBackdrop(e) { if (e.target === d.back) onCancel(); }
        function onKey(e) {
          if (e.key === "Escape") onCancel();
          else if (e.key === "Enter") onApply();
        }

        d.stage.addEventListener("pointerdown", onDown);
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        d.stage.addEventListener("wheel", onWheel, { passive: false });
        d.zoom.addEventListener("input", setZoomFromSlider);
        d.cancel.addEventListener("click", onCancel);
        d.apply.addEventListener("click", onApply);
        d.back.addEventListener("mousedown", onBackdrop);
        document.addEventListener("keydown", onKey);
        d.back.classList.add("show");
      });
    });
  }

  window.Cropper = { open: open };
})();
