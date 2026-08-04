"""StreetCLIP scoring service — the model half of GEOINT, hosted for free.

The web server keeps every decision (which questions to ask, how to rank the
answers, how to turn a region into coordinates). All this does is the one thing
that needs 400MB of weights: score an image against a list of captions.

    POST /  {"image": "<base64>", "labels": ["...", "..."]}
         -> {"logits": [ ... ], "model": "geolocal/StreetCLIP"}

Deliberately no softmax here. Probabilities only mean something within a single
question, and the caller is the one that knows where its questions begin and
end — it asks about countries, regions and scene attributes in a single batch.

Deploy: see README.md. Free CPU hardware is enough; the first request after a
sleep pays for the model load, everything after it is warm.
"""
import base64
import io
import os

import torch
from fastapi import FastAPI, HTTPException, Request
from PIL import Image
from transformers import CLIPModel, CLIPProcessor

MODEL_ID = os.environ.get("STREETCLIP_MODEL", "geolocal/StreetCLIP")
# Set a value here and in the caller's GEOINT_CLIP_KEY to stop a public Space
# from being used as somebody else's free GPU.
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

    if "," in raw[:64] and raw.lstrip().startswith("data:"):
        raw = raw.split(",", 1)[1]
    try:
        image = Image.open(io.BytesIO(base64.b64decode(raw))).convert("RGB")
    except Exception:
        raise HTTPException(status_code=400, detail="could not read that image")

    model, processor = _load()
    inputs = processor(text=labels, images=image, return_tensors="pt", padding=True, truncation=True)
    with torch.no_grad():
        logits = model(**inputs).logits_per_image[0]

    return {"logits": [float(v) for v in logits], "model": MODEL_ID}
