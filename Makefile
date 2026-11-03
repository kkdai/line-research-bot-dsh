.PHONY: install check test test-integration litellm run

install:
	npm ci --ignore-scripts

check:
	npm run check

test:
	npm test

# Real DSH runtime + Gemini via LiteLLM; needs ADC, GCP_PROJECT_ID, LITELLM_MASTER_KEY and `make litellm`.
test-integration:
	set -a; [ -f .env ] && . ./.env; set +a; npm run test:integration

# Local LiteLLM sidecar on :4000 with the same pinned versions as litellm/Dockerfile.
litellm:
	set -a; [ -f .env ] && . ./.env; set +a; \
	uv run --no-project --python 3.12 \
	  --with 'litellm[proxy]==1.106.6' --with 'google-auth==2.62.1' --with 'google-cloud-aiplatform==2.7.0' \
	  sh litellm/entrypoint.sh

run:
	set -a; [ -f .env ] && . ./.env; set +a; node src/main.ts
