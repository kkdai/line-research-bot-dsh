# Deploy

One-off GCP setup, then `deploy.sh` for every code change. The service is a
Cloud Run **multi-container** service: `app` (ingress) plus a `litellm`
sidecar, described in [`service.yaml`](service.yaml).

## Pre-reqs

```bash
export PROJECT_ID="your-gcp-project"
export REGION="asia-east1"
export SA_EMAIL="line-bot-sa@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud config set project "${PROJECT_ID}"
gcloud auth login
gcloud auth application-default login
```

## 1. Enable APIs

```bash
gcloud services enable \
    aiplatform.googleapis.com run.googleapis.com cloudtasks.googleapis.com \
    firestore.googleapis.com storage.googleapis.com secretmanager.googleapis.com \
    cloudbuild.googleapis.com artifactregistry.googleapis.com
```

## 2. Service account

If you already deployed the Go bot, you can reuse its `line-bot-sa`.

```bash
gcloud iam service-accounts create line-bot-sa --display-name="LINE Research Bot"

for role in aiplatform.user datastore.user cloudtasks.enqueuer \
            storage.objectAdmin secretmanager.secretAccessor \
            iam.serviceAccountTokenCreator run.invoker; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
      --member="serviceAccount:${SA_EMAIL}" --role="roles/${role}"
done

# Cloud Tasks mints OIDC tokens as this SA:
gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" \
    --member="serviceAccount:${SA_EMAIL}" --role="roles/iam.serviceAccountUser"
```

## 3. Firestore (native mode)

```bash
gcloud firestore databases create --location="${REGION}"   # skip if it exists
```

Collections are `line_bot_dsh_users`, `line_bot_dsh_reports` and
`line_bot_dsh_workspaces` by default (`COLLECTION_PREFIX`), so this service
does not touch the Go bot's data.

## 4. Secrets

```bash
printf '%s' '<LINE channel secret>'       | gcloud secrets create LINE_CHANNEL_SECRET --data-file=-
printf '%s' '<LINE channel access token>' | gcloud secrets create LINE_CHANNEL_ACCESS_TOKEN --data-file=-
PROJECT_ID="${PROJECT_ID}" ./create-secrets.sh   # creates a random LITELLM_MASTER_KEY
```

Use a **separate LINE channel** from the Go bot, or point that channel's
webhook here when you switch over.

## 5. Bucket + queue

```bash
PROJECT_ID="${PROJECT_ID}" BUCKET=<bucket> ./create-bucket.sh
PROJECT_ID="${PROJECT_ID}" LOCATION="${REGION}" ./create-tasks-queue.sh   # queue: research-jobs-dsh
```

## 6. Deploy

```bash
PROJECT_ID="${PROJECT_ID}" REGION="${REGION}" SA_EMAIL="${SA_EMAIL}" \
    GCS_BUCKET=<bucket> ./deploy.sh
```

`deploy.sh`:
1. creates the Artifact Registry repo `line-research-bot` if needed;
2. builds `app` and `litellm` with Cloud Build;
3. renders `service.yaml`. `CLOUD_RUN_SERVICE_URL` is the deterministic
   `https://<service>-<project number>.<region>.run.app`, which serves as the
   Cloud Tasks target and the OIDC audience;
4. runs `gcloud run services replace` and allows unauthenticated invocations,
   so LINE can reach `/webhook`.

Optional overrides: `SERVICE` (default `line-research-bot-dsh`),
`GEMINI_MODEL`, `GCP_LOCATION`, `COLLECTION_PREFIX`, `TASKS_QUEUE`, `TAG`.

## 7. LINE console

In the LINE Developers Console for your Messaging API channel:
- Webhook URL: `<service URL>/webhook`
- Use webhook: ON
- Auto-reply messages: OFF
- Verify webhook → expect `200`.

## Operations

```bash
# Logs from both containers
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="line-research-bot-dsh"' \
    --limit=100 --format='value(timestamp,labels.container_name,jsonPayload.message,textPayload)'
```
