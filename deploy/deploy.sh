#!/usr/bin/env bash
# Builds both images with Cloud Build and deploys the multi-container service.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-asia-east1}"
SERVICE="${SERVICE:-line-research-bot-dsh}"
SA_EMAIL="${SA_EMAIL:?set SA_EMAIL}"  # e.g. line-bot-sa@PROJECT.iam.gserviceaccount.com
GCS_BUCKET="${GCS_BUCKET:-line-reports}"
GEMINI_MODEL="${GEMINI_MODEL:-gemini-3.8-flash}"
GCP_LOCATION="${GCP_LOCATION:-global}"
COLLECTION_PREFIX="${COLLECTION_PREFIX:-line_bot_dsh_}"
TASKS_QUEUE="${TASKS_QUEUE:-research-jobs-dsh}"
AR_REPO="${AR_REPO:-line-research-bot}"
TAG="${TAG:-$(git rev-parse --short HEAD 2>/dev/null || date +%s)}"

# Required Secret Manager secrets must exist already (see deploy/README.md):
#   LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN, LITELLM_MASTER_KEY

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REGISTRY="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}"
APP_IMAGE="${REGISTRY}/app:${TAG}"
LITELLM_IMAGE="${REGISTRY}/litellm:${TAG}"

gcloud artifacts repositories describe "${AR_REPO}" --project="${PROJECT_ID}" --location="${REGION}" >/dev/null 2>&1 ||
  gcloud artifacts repositories create "${AR_REPO}" --project="${PROJECT_ID}" --location="${REGION}" --repository-format=docker

gcloud builds submit "${ROOT}" --project="${PROJECT_ID}" --region="${REGION}" --tag="${APP_IMAGE}"
gcloud builds submit "${ROOT}/litellm" --project="${PROJECT_ID}" --region="${REGION}" --tag="${LITELLM_IMAGE}"

# Cloud Run's deterministic URL; used as the Cloud Tasks target and the OIDC audience.
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
SERVICE_URL="https://${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app"

export SERVICE REGION SA_EMAIL APP_IMAGE LITELLM_IMAGE PROJECT_ID GCP_LOCATION GEMINI_MODEL GCS_BUCKET \
  COLLECTION_PREFIX TASKS_QUEUE SERVICE_URL
RENDERED="$(mktemp)"
python3 -I -c 'import os, sys, string; sys.stdout.write(string.Template(open(sys.argv[1]).read()).substitute(os.environ))' \
  "${ROOT}/deploy/service.yaml" > "${RENDERED}"

gcloud run services replace "${RENDERED}" --project="${PROJECT_ID}" --region="${REGION}"
gcloud run services add-iam-policy-binding "${SERVICE}" --project="${PROJECT_ID}" --region="${REGION}" \
  --member=allUsers --role=roles/run.invoker >/dev/null
rm -f "${RENDERED}"

echo "✅ Deployed ${SERVICE}: ${SERVICE_URL}"
echo "   LINE webhook URL: ${SERVICE_URL}/webhook"
