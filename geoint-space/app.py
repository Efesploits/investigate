"""StreetCLIP scoring service — the model half of GEOINT, hosted for free.

The web server keeps every decision (which questions to ask, how to rank the
answers, how to turn a region into coordinates). All this does is the one thing
that needs 400MB of weights: score an image against a list of captions.

    POST /  {"image": "<base64>", "labels": ["...", "..."]}
         -> {"logits": [ ... ], "model": "geolocal/StreetCLIP"}

Deliberately no softmax here. Probabilities only mean something within a single
question, and the caller is the one that knows where its questions begin and
end — it asks about countries, regions and scene attributes in a single batch.

Packaging note: Hugging Face's *Docker* Space tier is paid, so this ships as a
*Gradio* Space (free, more RAM). Gradio is FastAPI underneath, so the real
work is a plain FastAPI POST route on `/` — exactly the contract the Node
server already speaks, unchanged — and a small Gradio page is mounted at `/ui`
only so the Space has a friendly face. Deploy: see README.md.
"""
import base64
import io
import os

import gradio as gr
import torch
from fastapi import FastAPI, HTTPException, Request
from PIL import Image
from transformers import CLIPModel, CLIPProcessor

MODEL_ID = os.environ.get("STREETCLIP_MODEL", "geolocal/StreetCLIP")
# Set this here (as a Space secret) and in the Node server's GEOINT_CLIP_KEY so a
# public Space can't be used as someone else's free compute.
API_KEY = os.environ.get("GEOINT_CLIP_KEY", "")
MAX_LABELS = 512

app = FastAPI()
_model = None
_processor = None


def _load():
    """Loaded on first use, not at import, so the Space reports healthy while
    the weights are still coming down."""
    global _model, _processor
    if _model is None:
        _processor = CLIPProcessor.from_pretrained(MODEL_ID)
        _model = CLIPModel.from_pretrained(MODEL_ID).eval()
    return _model, _processor


def _score(image: "Image.Image", labels):
    model, processor = _load()
    inputs = processor(text=labels, images=image, return_tensors="pt", padding=True, truncation=True)
    with torch.no_grad():
        logits = model(**inputs).logits_per_image[0]
    return [float(v) for v in logits]


@app.get("/")
def health():
    return {"ok": True, "model": MODEL_ID, "loaded": _model is not None}


@app.post("/")
async def score(request: Request):
    if API_KEY:
        sent = (request.headers.get("authorization") or "").removeprefix("Bearer ").strip()
        if sent != API_KEY:
            raise HTTPException(status_code=401, detail="bad key")

    body = await request.json()
    labels = body.get("labels") or []
    raw = body.get("image") or ""
    if not labels or not isinstance(labels, list):
        raise HTTPException(status_code=400, detail="labels required")
    if len(labels) > MAX_LABELS:
        raise HTTPException(status_code=400, detail=f"at most {MAX_LABELS} labels")
    if not raw:
        raise HTTPException(status_code=400, detail="image required")

    if raw.lstrip().startswith("data:") and "," in raw[:64]:
        raw = raw.split(",", 1)[1]
    try:
        image = Image.open(io.BytesIO(base64.b64decode(raw))).convert("RGB")
    except Exception:
        raise HTTPException(status_code=400, detail="could not read that image")

    return {"logits": _score(image, labels), "model": MODEL_ID}


# ---- a friendly page at /ui, so the Space isn't a blank 404 to a human ------
def _demo(image, labels_text):
    labels = [ln.strip() for ln in (labels_text or "").splitlines() if ln.strip()]
    if image is None or not labels:
        return {}
    logits = _score(image, labels)
    mx = max(logits)
    exp = [pow(2.718281828, v - mx) for v in logits]
    s = sum(exp) or 1.0
    return {lab: e / s for lab, e in zip(labels, exp)}


with gr.Blocks(title="GEOINT StreetCLIP") as demo:
    gr.Markdown(
        "# GEOINT · StreetCLIP scorer\n"
        "The API the investigation tool calls is `POST /` — this page is just a "
        "manual check. Drop an image, list a few candidate captions (one per "
        "line), and see how the model scores them."
    )
    with gr.Row():
        _img = gr.Image(type="pil", label="Image")
        _lab = gr.Textbox(
            lines=6, label="Captions (one per line)",
            value="A Street View photo in France.\nA Street View photo in Japan.\n"
                  "A Street View photo in Brazil.\nA Street View photo in Norway.",
        )
    _out = gr.Label(label="Scores")
    gr.Button("Score").click(_demo, [_img, _lab], _out)

app = gr.mount_gradio_app(app, demo, path="/ui")


if __name__ == "__main__":
    import uvicorn
    # HF proxies the Space on 7860; keep an override for local runs.
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 7860)))
