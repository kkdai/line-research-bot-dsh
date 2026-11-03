#!/bin/sh
# Writes the LiteLLM config from env and starts the proxy.
#   GEMINI_MODEL         model id, used both as the public alias and the Vertex model
#   GCP_PROJECT_ID       Vertex AI project (credentials: the Cloud Run service account / ADC)
#   GCP_LOCATION         Vertex AI location (default: global)
#   LITELLM_MASTER_KEY   key the app sends as x-api-key (Secret Manager)
#   LITELLM_PORT         default 4000
set -eu

: "${GEMINI_MODEL:=gemini-3.8-flash}"
: "${GCP_PROJECT_ID:?set GCP_PROJECT_ID}"
: "${GCP_LOCATION:=global}"
: "${LITELLM_MASTER_KEY:?set LITELLM_MASTER_KEY}"
: "${LITELLM_PORT:=4000}"

CONFIG="${TMPDIR:-/tmp}/litellm.yaml"
cat > "$CONFIG" <<EOF
model_list:
  - model_name: ${GEMINI_MODEL}
    litellm_params:
      model: vertex_ai/${GEMINI_MODEL}
      vertex_project: ${GCP_PROJECT_ID}
      vertex_location: ${GCP_LOCATION}
litellm_settings:
  drop_params: true
general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
EOF

exec litellm --config "$CONFIG" --host 0.0.0.0 --port "$LITELLM_PORT" --num_workers 1
