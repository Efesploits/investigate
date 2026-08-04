---
title: GEOINT StreetCLIP
emoji: 🛰️
colorFrom: gray
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

# GEOINT StreetCLIP scorer

Scores a photograph against a list of captions with
[geolocal/StreetCLIP](https://huggingface.co/geolocal/StreetCLIP). The
investigation tool asks the questions and ranks the answers; this only runs the
model, because that is the part that needs 400MB of weights and more RAM than a
small web dyno has.

## Setting it up (free, about five minutes)

1. Create a Space at <https://huggingface.co/new-space> — **Docker** SDK, blank
   template, **CPU basic** hardware (the free tier).
2. Upload `Dockerfile`, `app.py` and `requirements.txt` from this folder, or
   push them to the Space's git remote.
3. Wait for the build. The first scan afterwards pulls the weights and takes
   about a minute; every scan after that is warm.
4. In the Space's **Settings → Variables and secrets**, add a secret
   `GEOINT_CLIP_KEY` with a long random string. Skipping this leaves the Space
   open for anyone to use as free compute.
5. On the web server (Render → Environment):

   ```
   GEOINT_CLIP_URL = https://<your-name>-<space-name>.hf.space/
   GEOINT_CLIP_KEY = <the same random string>
   ```

That is the whole integration — the tool picks the engine up on its own and the
GEOINT page stops saying image matching is unconfigured.

A free Space sleeps after about 48 hours idle and takes ~30s to wake, which the
client's 90s scan timeout already allows for.

## The API

```
POST /
{ "image": "<base64 jpeg/png>", "labels": ["A Street View photo in France.", ...] }

200 { "logits": [12.4, 9.8, ...], "model": "geolocal/StreetCLIP" }
```

Raw logits, one per label, in the order given — no softmax, because the caller
batches several independent questions into one request and normalises each on
its own.

Any service answering that shape works; this Space is just the free one. Point
`GEOINT_CLIP_URL` elsewhere and nothing else changes.

## Licensing

StreetCLIP is **CC BY-NC 4.0 — non-commercial use only**, and its model card
asks that it not be used to geolocate private images. Deploying this is a
decision about how your tool is used; nothing turns it on by itself.
