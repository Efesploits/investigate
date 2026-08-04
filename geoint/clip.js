/* StreetCLIP scoring — one interface, two places it can actually run.
 *
 * Everything above this file just wants "score this image against these
 * labels". Where the model lives is a deployment choice, not a pipeline one:
 *
 *   remote  GEOINT_CLIP_URL points at a service that answers {logits:[...]}.
 *           This is the recommended setup — a free Hugging Face Space holds
 *           the 400MB model so the web server stays small. See geoint-space/.
 *
 *   local   The model runs in this process via onnxruntime. Needs ~1.2GB of
 *           RAM, so only turn it on where that exists (GEOINT_ENGINE=local).
 *
 *   off     No model configured. The pipeline falls back to EXIF only and the
 *           UI says so rather than pretending.
 *
 * Note on the model: geolocal/StreetCLIP is licensed CC BY-NC 4.0 and its own
 * model card discourages geolocating private images. Both are the operator's
 * call to make, which is why nothing here turns itself on by default.
 */
"use strict";

const MODEL_ID = process.env.GEOINT_CLIP_MODEL || "onnx-community/StreetCLIP-ONNX";
// fp16 builds fail to initialise on onnxruntime's CPU backend; int8 is the one
// that loads everywhere and measured no worse on a 30-image country benchmark.
const DTYPE = process.env.GEOINT_CLIP_DTYPE || "q8";
// One forward pass encodes the image once and every label after it, so bigger
// batches are cheaper — but the text tower grows with the batch, and past a
// few hundred labels the memory is not worth the saved vision pass.
const MAX_LABELS = 256;

function engine() {
  const forced = String(process.env.GEOINT_ENGINE || "").toLowerCase();
  if (forced === "off" || forced === "none") return "off";
  if (forced === "local") return "local";
  if (process.env.GEOINT_CLIP_URL) return "remote";
  if (forced === "remote") return "remote";       // set but no URL — treated as off below
  return "off";
}

/* ---------------- local backend ---------------- */

/* Each forward pass leaves roughly 8MB behind that a forced GC will not
 * reclaim — measured, not guessed — so a long-lived server would drift a
 * gigabyte every hundred-odd scans. Tearing the session down and building it
 * again every so often keeps that bounded; the weights come back from disk
 * cache in a second or two, which is invisible next to a scan itself. */
const RECYCLE_AFTER = Math.max(1, parseInt(process.env.GEOINT_LOCAL_RECYCLE, 10) || 60);

let localPromise = null;
let passes = 0;

function loadLocal() {
  if (localPromise) return localPromise;
  localPromise = (async () => {
    let mod;
    try {
      // ESM-only, and only worth paying for when this engine is actually used
      mod = await import("@huggingface/transformers");
    } catch (_) {
      throw new Error("GEOINT_ENGINE=local needs the model runtime: npm i @huggingface/transformers");
    }
    const { AutoProcessor, AutoTokenizer, CLIPModel } = mod;
    /* Left to itself onnxruntime opens one compute thread per core and spins
     * them while waiting. Inside a web server those threads fight libuv for
     * the CPU, and on a 20-core box the same scan measured 2s idle but 30s
     * under back-to-back requests. Measured across pool sizes on that machine:
     *
     *   2 threads   14.8s, rock steady      8 threads   2.0-6.7s
     *   4 threads    2.9s median, 4.2s max  all cores   2.0s, then 30s spikes
     *
     * Four is the shape of that curve, not a guess — enough parallelism to be
     * quick, few enough threads to leave the event loop alone. */
    const threads = Math.max(1, parseInt(process.env.GEOINT_LOCAL_THREADS, 10) || 4);
    const session_options = { intraOpNumThreads: threads, interOpNumThreads: 1, executionMode: "sequential" };
    const [model, processor, tokenizer] = await Promise.all([
      CLIPModel.from_pretrained(MODEL_ID, { dtype: DTYPE, session_options }),
      AutoProcessor.from_pretrained(MODEL_ID),
      AutoTokenizer.from_pretrained(MODEL_ID),
    ]);
    return { model, processor, tokenizer, RawImage: mod.RawImage };
  })().catch((e) => {
    localPromise = null;                      // let a later scan try again
    throw e;
  });
  return localPromise;
}

async function recycleIfDue() {
  if (passes < RECYCLE_AFTER || !localPromise) return;
  passes = 0;
  const held = localPromise;
  localPromise = null;
  try {
    const { model } = await held;
    if (model && typeof model.dispose === "function") await model.dispose();
  } catch (_) { /* going away anyway */ }
}

async function scoreLocal(buf, labels) {
  const { model, processor, tokenizer, RawImage } = await loadLocal();
  const image = await RawImage.fromBlob(new Blob([buf]));
  const inputs = await processor(image);          // decode once, reuse per chunk

  const out = [];
  for (let i = 0; i < labels.length; i += MAX_LABELS) {
    const chunk = labels.slice(i, i + MAX_LABELS);
    const text = tokenizer(chunk, { padding: true, truncation: true });
    const res = await model({ ...text, ...inputs });
    out.push(...res.logits_per_image.tolist()[0]);
    passes++;
  }
  await recycleIfDue();
  return out;
}

/* ---------------- remote backend ---------------- */

async function scoreRemote(buf, labels) {
  const url = process.env.GEOINT_CLIP_URL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);   // a cold Space takes a while to wake
  try {
    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    if (process.env.GEOINT_CLIP_KEY) headers.Authorization = "Bearer " + process.env.GEOINT_CLIP_KEY;
    const out = [];
    for (let i = 0; i < labels.length; i += MAX_LABELS) {
      const r = await fetch(url, {
        method: "POST", headers, signal: controller.signal,
        body: JSON.stringify({ image: buf.toString("base64"), labels: labels.slice(i, i + MAX_LABELS) }),
      });
      if (!r.ok) throw new Error("clip service " + r.status);
      const j = await r.json();
      const lg = j && (j.logits || j.scores);
      if (!Array.isArray(lg)) throw new Error("clip service returned no logits");
      out.push(...lg.map(Number));
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- public ---------------- */

const available = () => engine() !== "off" && !(engine() === "remote" && !process.env.GEOINT_CLIP_URL);

/** Raw CLIP logits, one per label, in the order given. */
async function score(buf, labels) {
  if (!labels.length) return [];
  return engine() === "local" ? scoreLocal(buf, labels) : scoreRemote(buf, labels);
}

/** Softmax over a slice of logits — probabilities only mean something within
 *  one question, so callers softmax each label group separately. */
function softmax(logits) {
  if (!logits.length) return [];
  const mx = Math.max(...logits);
  const e = logits.map((v) => Math.exp(v - mx));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / s);
}

module.exports = { score, softmax, available, engine, MODEL_ID };
