#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
LOCATION="${LOCATION:-asia-east1}"
QUEUE="${QUEUE:-research-jobs-dsh}"

gcloud tasks queues create "${QUEUE}" \
    --project="${PROJECT_ID}" \
    --location="${LOCATION}" \
    --max-attempts=3 \
    --min-backoff=10s \
    --max-backoff=120s || true

echo "✅ Cloud Tasks queue ${QUEUE} ready."
