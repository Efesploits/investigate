#!/usr/bin/env bash
#
# One-shot deploy for the GEOINT StreetCLIP Space.
#
#   1. huggingface-cli login          <- you do this once (paste a WRITE token
#                                          from huggingface.co/settings/tokens)
#   2. bash geoint-space/deploy.sh     <- this script does the rest
#
# It creates the Space, generates a key, sets it as a Space secret, uploads the
# service, and prints the two values to paste into Render. Nothing here handles
# your password — the login step above is the only place a credential is used,
# and that's the CLI's own prompt, not this script.
#
# Re-runnable: if the Space already exists it just re-uploads. Pass a name as
# the first argument to override the default.
set -euo pipefail

SPACE_NAME="${1:-geoint-streetclip}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- must be logged in; this script deliberately can't do that for you -------
WHO="$(huggingface-cli whoami 2>/dev/null | head -1 || true)"
if [ -z "$WHO" ] || [ "$WHO" = "Not logged in" ]; then
  echo "Not logged in to Hugging Face."
  echo
  echo "  1. Make a token (role: WRITE) at https://huggingface.co/settings/tokens"
  echo "  2. Run:  huggingface-cli login"
  echo "  3. Run this script again."
  exit 1
fi
echo "Logged in as: $WHO"
REPO_ID="$WHO/$SPACE_NAME"

# --- create the Space (harmless if it already exists) ------------------------
echo "Ensuring Space $REPO_ID exists (gradio) ..."
huggingface-cli repo create "$SPACE_NAME" --type space --space_sdk gradio -y \
  || echo "  (already exists — will re-upload)"

# --- upload the service (everything here except this script) ------------------
# A public Gradio Space needs no secret; the client talks to it over the Gradio
# API. To lock it down later, make the Space private and set GEOINT_CLIP_KEY to
# an HF read token on Render — see README.md.
echo "Uploading service files ..."
huggingface-cli upload "$REPO_ID" "$HERE" . --repo-type space \
  --exclude "deploy.sh" \
  --commit-message "Deploy GEOINT StreetCLIP scorer"

# --- the value Render needs --------------------------------------------------
# hf.space subdomain = owner and space joined by '-', lowercased, '_' -> '-'
HOST="$(printf '%s' "$REPO_ID" | tr '/_' '--' | tr '[:upper:]' '[:lower:]')"
echo
echo "======================================================================"
echo " Space building:  https://huggingface.co/spaces/$REPO_ID"
echo " It's on ZeroGPU (free). The build installs PyTorch, so give it a few"
echo " minutes; the first scan pulls the model (~1 min), the GPU does the rest."
echo
echo " Then add this on Render -> your web service -> Environment,"
echo " and let it redeploy:"
echo
echo "   GEOINT_CLIP_URL   https://$HOST.hf.space/"
echo "======================================================================"
