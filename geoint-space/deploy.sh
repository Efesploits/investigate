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

# --- generate a key and set it as a Space secret -----------------------------
# token_urlsafe(32) is ~43 random chars; identical on both sides by construction
KEY="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
python - "$REPO_ID" "$KEY" <<'PY'
import sys
from huggingface_hub import add_space_secret
repo_id, key = sys.argv[1], sys.argv[2]
add_space_secret(repo_id=repo_id, key="GEOINT_CLIP_KEY", value=key)
print("Set secret GEOINT_CLIP_KEY on", repo_id)
PY

# --- upload the service (everything here except this script) ------------------
echo "Uploading service files ..."
huggingface-cli upload "$REPO_ID" "$HERE" . --repo-type space \
  --exclude "deploy.sh" \
  --commit-message "Deploy GEOINT StreetCLIP scorer"

# --- the two values Render needs ---------------------------------------------
# hf.space subdomain = owner and space joined by '-', lowercased, '_' -> '-'
HOST="$(printf '%s' "$REPO_ID" | tr '/_' '--' | tr '[:upper:]' '[:lower:]')"
echo
echo "======================================================================"
echo " Space building:  https://huggingface.co/spaces/$REPO_ID"
echo " Watch the 'Building' badge finish. The FIRST scan after it goes live"
echo " pulls the 400MB model (~1 min); every scan after that is warm."
echo
echo " Then add these on Render -> your web service -> Environment,"
echo " and let it redeploy:"
echo
echo "   GEOINT_CLIP_URL   https://$HOST.hf.space/"
echo "   GEOINT_CLIP_KEY   $KEY"
echo "======================================================================"
