#!/usr/bin/env bash
# Creates LITELLM_MASTER_KEY (random) if missing. The LINE secrets must be
# created by hand because they come from the LINE Developers Console.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"

if ! gcloud secrets describe LITELLM_MASTER_KEY --project="${PROJECT_ID}" >/dev/null 2>&1; then
  printf 'sk-%s' "$(openssl rand -hex 24)" | \
    gcloud secrets create LITELLM_MASTER_KEY --project="${PROJECT_ID}" --data-file=-
fi

for s in LINE_CHANNEL_SECRET LINE_CHANNEL_ACCESS_TOKEN; do
  gcloud secrets describe "$s" --project="${PROJECT_ID}" >/dev/null 2>&1 ||
    echo "⚠️  missing secret $s: printf '%s' '<value>' | gcloud secrets create $s --data-file=-"
done

echo "✅ Secrets checked."
