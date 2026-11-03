#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
BUCKET="${BUCKET:-line-reports}"
LOCATION="${LOCATION:-ASIA-EAST1}"

gcloud storage buckets create "gs://${BUCKET}" \
    --project="${PROJECT_ID}" \
    --location="${LOCATION}" \
    --uniform-bucket-level-access \
    --public-access-prevention=inherited || true

# Make all objects publicly readable
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
    --member=allUsers --role=roles/storage.objectViewer

echo "✅ Bucket gs://${BUCKET} ready."
