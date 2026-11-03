# Sidecar: LiteLLM proxy exposing an Anthropic Messages-compatible endpoint
# (/v1/messages) on localhost:4000, backed by Gemini on Vertex AI. DeepSeek
# Harness's model adapter speaks only the Messages protocol, so this is how
# the DSH research agent reaches Gemini.
FROM python:3.12-slim

RUN pip install --no-cache-dir \
      'litellm[proxy]==1.106.6' \
      'google-auth==2.62.1' \
      'google-cloud-aiplatform==2.7.0'

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && useradd --create-home litellm
USER litellm

EXPOSE 4000
ENTRYPOINT ["/entrypoint.sh"]
