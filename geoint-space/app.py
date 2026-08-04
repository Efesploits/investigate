"""StreetCLIP scoring service — the model half of GEOINT, hosted for free.

The web server keeps every decision (which questions to ask, how to rank the
answers, how to turn a region into coordinates). All this does is the one thing
that needs 400MB of weights: score an image against a list of captions.

Packaging note: Hugging Face's free Gradio tier runs on **ZeroGPU**, which
hands a GPU only to a `@spaces.GPU`-decorated function called through Gradio's
queue. So this is a plain Gradio app exposing one API endpoint, `score`:

    POST /gradio_api/call/score   {"data": ["<base64 image>", "<json labels>"]}
      -> event id, then an SSE stream whose result is
         "{\"logits\": [ ... ], \"model\": \"geolocal/StreetCLIP\"}"

Text in, text out, so the Node client never has to wrestle with Gradio's file
components. No softmax here — probabilities only mean something within a single
question, and the caller batches several questions per request and normalises
each itself. The `/` page is a human-friendly tester.
"""
import base64
import io
import json
import os

import gradio as gr
import spaces
import torch
from PIL import Image
from transformers import CLIPModel, CLIPProcessor

MODEL_ID = os.environ.get("STREETCLIP_MODEL", "geolocal/StreetCLIP")
MAX_LABELS = 512

# Loaded once at startup on CPU. ZeroGPU only exists inside @spaces.GPU, so the
# move to the GPU happens there, per call, not here.
_model = CLIPModel.from_pretrained(MODEL_ID).eval()
_processor = CLIPProcessor.from_pretrained(MODEL_ID)


@spaces.GPU(duration=60)
def _logits(image: "Image.Image", labels):
    """The only GPU work: encode the image and every caption, return one raw
    logit per caption. Runs inside ZeroGPU's granted context."""
    model = _model.to("cuda")
    inputs = _processor(
        text=labels, images=image, return_tensors="pt", padding=True, truncation=True
    ).to("cuda")
    with torch.no_grad():
        out = model(**inputs).logits_per_image[0]
    return [float(v) for v in out.cpu()]


def _decode_image(raw: str) -> "Image.Image":
    if raw.lstrip().startswith("data:") and "," in raw[:64]:
        raw = raw.split(",", 1)[1]
    return Image.open(io.BytesIO(base64.b64decode(raw))).convert("RGB")


def score(image_b64: str, labels_json: str) -> str:
    """API entrypoint. Text in, JSON-string out, so the whole thing travels as
    plain strings through Gradio's queue."""
    try:
        labels = labels_json if isinstance(labels_json, list) else json.loads(labels_json or "[]")
    except Exception:
        return json.dumps({"error": "labels must be a JSON array of strings"})
    if not labels:
        return json.dumps({"error": "labels required"})
    if len(labels) > MAX_LABELS:
        return json.dumps({"error": f"at most {MAX_LABELS} labels"})
    if not image_b64:
        return json.dumps({"error": "image required"})
    try:
        image = _decode_image(image_b64)
    except Exception:
        return json.dumps({"error": "could not read that image"})
    return json.dumps({"logits": _logits(image, labels), "model": MODEL_ID})


# ---- human-friendly tester at / + the machine endpoint at /call/score -------
def _demo_scores(image, labels_text):
    labels = [ln.strip() for ln in (labels_text or "").splitlines() if ln.strip()]
    if image is None or not labels:
        return {}
    logits = _logits(image, labels)
    mx = max(logits)
    exp = [pow(2.718281828, v - mx) for v in logits]
    s = sum(exp) or 1.0
    return {lab: e / s for lab, e in zip(labels, exp)}


with gr.Blocks(title="GEOINT StreetCLIP") as demo:
    gr.Markdown(
        "# GEOINT · StreetCLIP scorer\n"
        "The investigation tool calls the **`score`** API endpoint. This page is "
        "a manual check: drop an image, list candidate captions (one per line), "
        "and see how the model scores them."
    )
    with gr.Row():
        _img = gr.Image(type="pil", label="Image")
        _lab = gr.Textbox(
            lines=6, label="Captions (one per line)",
            value="A Street View photo in France.\nA Street View photo in Japan.\n"
                  "A Street View photo in Brazil.\nA Street View photo in Norway.",
        )
    _out = gr.Label(label="Scores")
    gr.Button("Score").click(_demo_scores, [_img, _lab], _out)

    # the endpoint the server actually calls: text in, JSON-string out, named
    # "score" so it's reachable at /gradio_api/call/score. Hidden from the UI.
    _api_in_img = gr.Textbox(visible=False)
    _api_in_lab = gr.Textbox(visible=False)
    _api_out = gr.Textbox(visible=False)
    _api_btn = gr.Button("score", visible=False)
    _api_btn.click(score, [_api_in_img, _api_in_lab], _api_out, api_name="score")

demo.queue(max_size=32)

if __name__ == "__main__":
    demo.launch()
