---
title: GEOINT StreetCLIP
emoji: 🛰️
colorFrom: gray
colorTo: gray
sdk: gradio
sdk_version: 4.44.1
app_file: app.py
pinned: false
---

# GEOINT StreetCLIP scorer

Scores a photograph against a list of captions with
[geolocal/StreetCLIP](https://huggingface.co/geolocal/StreetCLIP). The
investigation tool asks the questions and ranks the answers; this only runs the
model, because that is the part that needs 400MB of weights and a GPU to be
quick.

Shipped as a **Gradio** Space on Hugging Face's free **ZeroGPU** tier (its
Docker and CPU-basic tiers are paid). ZeroGPU only lends the GPU to a
`@spaces.GPU` function called through Gradio's queue, so the scorer is a Gradio
API endpoint named `score`, and the Node client speaks Gradio's call protocol.

## Setting it up (free)

1. Create a Space at <https://huggingface.co/new-space> — **Gradio** SDK, blank
   template. On the free tier the hardware is **ZeroGPU** automatically.
2. Upload `app.py` and `requirements.txt` from this folder (leave the
   template's generated `README.md` — its `sdk_version` is guaranteed valid).
3. Wait for the build (it installs PyTorch, so give it a few minutes). The
   first scan afterwards pulls the weights (~1 min); the GPU makes the rest
   quick.
4. On the web server (Render → Environment):

   ```
   GEOINT_CLIP_URL = https://<your-name>-<space-name>.hf.space/
   ```

That is the whole integration — the tool detects a `*.hf.space` URL, talks to
it the Gradio way on its own, and the GEOINT page stops saying image matching
is unconfigured.

A free Space sleeps after ~48h idle and takes ~30s to wake, which the client's
90s scan timeout already allows for.

### Locking it down (optional)

The Space is public by default — fine, but anyone who finds the URL can spend
your ZeroGPU quota. To gate it, set the Space **private** (Settings →
Visibility), make a read token at <https://huggingface.co/settings/tokens>, and
set `GEOINT_CLIP_KEY = <that token>` on Render. The client sends it as a bearer
token on every call.

## The API

```
POST /gradio_api/call/score   {"data": ["<base64 image>", "<json labels>"]}
  -> {"event_id": "..."}
GET  /gradio_api/call/score/<event_id>
  -> SSE; the completed result is the string
     "{\"logits\": [12.4, 9.8, ...], \"model\": \"geolocal/StreetCLIP\"}"
```

Raw logits, one per label, in the order given — no softmax, because the caller
batches several independent questions into one request and normalises each on
its own. The `/` page is a human-facing tester.

If you host the scorer elsewhere with a plain `{image,labels} -> {logits}` POST,
point `GEOINT_CLIP_URL` at it and set `GEOINT_CLIP_PROTOCOL=plain`.

## Licensing

StreetCLIP is **CC BY-NC 4.0 — non-commercial use only**, and its model card
asks that it not be used to geolocate private images. Deploying this is a
decision about how your tool is used; nothing turns it on by itself.
