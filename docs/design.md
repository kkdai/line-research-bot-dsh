# Design: moving the LINE research bot from ADK to DeepSeek Harness

Date: 2026-11-03

## Question

Can the LINE research bot keep its LINE features and Cloud Run setup, but
replace ADK with
[`deepseek-ai/dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype)?

## What dsh-superagent is

dsh-superagent is a TypeScript **bundle (plugin set) for DeepSeek Harness
(DSH)**. It is a proactive **GitHub coding agent**:

- It runs as one long-lived local DSH process (started in tmux). State is a
  SQLite file under `stateDir` with a lock file. Its panel and management API
  are served on `127.0.0.1` only.
- Sources are pulled, not pushed. GitHub notifications are polled, and Feishu
  events arrive over `lark-cli`'s long connection. Setup *requires* a GitHub
  repository and agent account; the runtime waits for setup without them.
- Main and executor sessions run with `danger-full-access` shell access, one
  directory per ticket.
- The LLM layer is DSH's Messages adapter: the Anthropic Messages protocol,
  `https://api.deepseek.com/anthropic` by default, with a configurable
  `baseURL`. There is no Gemini adapter.
- The authors call it a research prototype.

Its domain model (Source → Trigger → Thread → Eval → Ticket → Assignment) and
its `SourceKind` extension point (docs/008-cookbook.md) could carry a LINE
Source.

## Options considered

**A. Fork dsh-superagent and add a LINE Source.** This keeps Eval/Policy,
tickets and the web panel. On Cloud Run it needs:
1. patching setup so GitHub is optional;
2. adding a public, HMAC-checked webhook route, since its HTTP is
   loopback-only with same-origin checks;
3. min = max = 1 instance with always-on CPU, and SQLite on a persistent
   volume (Filestore).

That loses scale-to-zero and puts an alpha, full-shell-access process on
the internet.

**B. Keep the Cloud Run architecture and replace only the agent layer with
DSH.** ✅ Chosen. The webhook, Cloud Tasks, Firestore and GCS stay as they
are. Each research stage becomes a DSH session in a short-lived `dsh` runtime
subprocess, driven by `@deepseek-ai/dsh-sdk-client`. The service stays
stateless and still scales to zero.

**Model:** keep Gemini on Vertex AI behind a LiteLLM sidecar. LiteLLM exposes
`/v1/messages`, the protocol DSH's adapter speaks, and forwards to Vertex AI.
Search grounding would not survive that translation, so it moved into the
`web_research` tool, which calls Vertex AI directly with `googleSearch` and
`urlContext`.

## Verified before building (proof of concept, 2026-11-03)

| Check | Result |
|---|---|
| LiteLLM 1.106.6 `/v1/messages` → `vertex_ai/gemini-3.8-flash` | ✅ Needs `google-auth` + `google-cloud-aiplatform` in the image |
| `dsh` 0.2.1-rc.5 runtime → LiteLLM via `DEEPSEEK_BASE_URL` / `DEEPSEEK_API_KEY` | ✅ Overriding `apiKeyEnv` in a patch did not take effect; the env vars do |
| `sdk-minimal` + overlay patch removes bash/editor tools | ✅ The model sees only `read_image`, `web_research`, `submit_*` |
| Custom tool plugin (`ctx.tools.register(defineTool(...))`) | ✅ Gemini inside DSH calls `web_research` repeatedly and in parallel |
| Plugin resolution | ⚠️ DSH resolves bare plugin names from `$DSH_HOME/profiles/<profile>/` and checks `name` before evaluating `!!js`. The host therefore renders the patch with an absolute `file://` URL ([`renderPatch`](../src/research/agents.ts)) |
| SDK client options | ⚠️ rc.5 takes `profile` / `patches` / `dshHome` / `env`. The `launch` option from the older README is ignored, and the client silently falls back to the full `sdk` profile |
| Session logs | ⚠️ Different profiles cannot share one `DSH_HOME/sessions` root (compression mismatch) |

## Known gaps and risks

- **Pre-release dependencies.** DSH is `0.2.1-rc.5` and pinned. APIs moved
  between rc versions (see the SDK options row above).
- **Per-stage subprocess.** Each stage spawns a `dsh` runtime (~1–2 s to boot).
  That is negligible next to multi-minute research stages, but memory scales
  with concurrent jobs, so the app container gets 4 GiB.
- **No mid-turn cancel in the SDK.** Timeouts close the runtime.
- **LiteLLM without a key returns 500, not 401.** The request is still refused,
  and the sidecar is reachable only inside the instance.
- **What this version leaves out from dsh-superagent:** Eval/Policy admission,
  the operator panel, per-ticket worker directories. They don't fit a
  stateless chat bot; revisit only if the bot needs multi-step, long-lived work.
