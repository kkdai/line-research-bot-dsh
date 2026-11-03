# LINE Research Planner Bot — DeepSeek Harness edition

The LINE research bot from
[`kkdai/line-research-bot-go`](https://github.com/kkdai/line-research-bot-go),
with the agent framework switched from **ADK for Go** to
**[DeepSeek Harness](https://www.deepseek.com/en/harness/) (DSH)**, the runtime
under [`deepseek-ai/dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype).
It still runs on Cloud Run and still uses **Gemini on Vertex AI**.

The LINE behaviour, Firestore documents, GCS report pages and Cloud Tasks flow
are the same as the Go version; only the agent layer changed. Why it is built
this way, and why it does not reuse dsh-superagent wholesale, is in
[`docs/design.md`](docs/design.md).

```
You (LINE):  研究 SOTA 開源向量資料庫的選型
Bot:         📋 已收到題目，開始規劃…
Bot:         🔍 計畫完成：將比對 7 類來源
Bot:         📊 已比對 7 份來源，發現 3 處重要分歧
Bot:         [Flex card]  Title · summary · 3 citations · 閱讀完整報告 →

You (LINE):  第 2 章再深一點，加日文來源
Bot:         [Flex card v2]  same URL, content updated, old version snapshotted
```

## 工作紀錄（2026-11-03）

這個 repo 的目標：沿用 `line-research-bot-go` 的 LINE Bot 功能與 Cloud Run 設定，
把 agent 框架從 ADK 換成 dsh-superagent 所用的 DeepSeek Harness。

**1. 研究 dsh-superagent**
- 它是 DeepSeek Harness 的 bundle，本質是 **GitHub coding agent**：單一長駐程序、
  SQLite 狀態、只聽 `127.0.0.1`、強制需要 GitHub repo 與帳號、模型層只支援 Anthropic Messages 協定。
- 整包 fork 上 Cloud Run 需要拿掉 GitHub 依賴、開放 webhook、固定一台常駐 instance
  並掛 Filestore，等於放棄 scale-to-zero，因此沒有採用。

**2. 採用方案：保留 Cloud Run 架構，只把 agent 層換成 DeepSeek Harness**
- LINE webhook、意圖判斷、Flex 卡片、Firestore、GCS 報告、Cloud Tasks、深化與重試流程
  全部 1:1 從 Go 移植成 TypeScript（Node 24 直接執行 `.ts`，不需 build）。
- 三個研究階段（規劃 → 搜尋比對 → 撰寫）各跑一個 DSH session，
  透過 `@deepseek-ai/dsh-sdk-client` 驅動 `dsh` runtime 子程序。
- 模型仍是 **Vertex AI 上的 Gemini**：Cloud Run 裡多一個 LiteLLM sidecar，
  把 DSH 的 Anthropic Messages 請求轉給 Gemini。
- Google Search grounding 做成 DSH 外掛工具 `web_research`（直接呼叫 Gemini + Google Search），
  結構化輸出改用 `submit_plan` / `submit_sources` / `submit_report` 工具。
- DSH 的 shell、檔案編輯工具全部關閉，agent 只拿得到研究用的工具。

**3. 驗證**
- 先做 PoC，確認 DSH → LiteLLM → Gemini 與自訂工具都能動。
- 52 個單元測試（Node 24 / 26）通過。
- 用真 Gemini 跑完整整合測試（規劃 → 搜尋 → 撰寫 → 深化找不到章節）通過，約 7.5 分鐘。
- 過程中修掉的坑：SDK rc.5 參數改名（`launch` 會被忽略）、DSH 從 `$DSH_HOME` 解析外掛
  （改成啟動時寫入絕對路徑）、DSH 子程序不再繼承 LINE secrets。細節見 [`docs/design.md`](docs/design.md)。

**4. 狀態**
- ✅ 程式碼、測試、部署腳本（`deploy/`）完成。
- ⏳ **尚未部署到 Cloud Run**，Docker image 也還沒實際 build 過。部署步驟見 [`deploy/README.md`](deploy/README.md)。

## Architecture

```
┌──────────┐ webhook/push ┌──────────────────── Cloud Run service (one instance) ────────────────────┐
│ LINE App │ ◀───────────▶│ app container (Node 24, TypeScript)          litellm sidecar (:4000)      │
└──────────┘              │  POST /webhook            (HMAC)              Anthropic /v1/messages      │
                          │  POST /tasks/run-research (OIDC) ─┐                    │                  │
                          │  GET  /readyz                      │                    ▼                  │
                          │                    per stage: spawn `dsh` runtime ──▶ Gemini (Vertex AI)  │
                          │                    (sdk-minimal + dsh/research.patch.yml)                 │
                          │                      tools: web_research ──▶ Gemini + Google Search       │
                          │                             submit_plan / submit_sources / submit_report  │
                          └──────┬───────────────────────┬──────────────────────┬────────────────────┘
                                 │ Cloud Tasks           │ Firestore            │ Cloud Storage
                                 ▼                       ▼                      ▼
                          research-jobs-dsh       <prefix>users/reports/   <id>/index.html
                                                  workspaces               <id>/snapshots/
```

### How DeepSeek Harness is used

| Concern | ADK for Go (before) | DeepSeek Harness (now) |
|---|---|---|
| Agent runtime | `llmagent` + `runner.Runner` in-process | `dsh` runtime subprocess per stage, driven by `@deepseek-ai/dsh-sdk-client` over stdio JSON-RPC |
| Profile | — | `sdk-minimal` + [`dsh/research.patch.yml`](dsh/research.patch.yml): shell and editor tools removed |
| Model | `gemini.NewModel` on Vertex AI | DSH's Messages adapter → LiteLLM sidecar → Gemini on Vertex AI |
| Web research | `geminitool.GoogleSearch` + `url_context` | `web_research` tool in the [DSH plugin](dsh/plugin/index.js): Gemini + Google Search + URL context |
| Structured output | `OutputSchema` | `submit_plan` / `submit_sources` / `submit_report` tools; DSH validates the arguments, the host reads the accepted call from the session events ([`submission.ts`](src/research/submission.ts)) |
| Stage hand-off | ADK session state `{plan}`, `{sources}` | Firestore workspace, inlined into each stage prompt |
| Trace id | ADK invocation id | DSH session id (`last_interaction_id`) |

DeepSeek Harness's model adapter speaks only the Anthropic Messages
protocol, so the LiteLLM sidecar translates for Gemini. Google Search
grounding lives in the `web_research` tool, which calls Vertex AI directly,
so it does not depend on the proxy.

## Repo layout

```
src/
├── main.ts           wiring, HTTP server, graceful shutdown
├── config.ts         env vars
├── server.ts         /webhook, /tasks/run-research, /readyz
├── worker.ts         PLAN → SEARCH_COMPARE → WRITE_REPORT → publish; deepen; retries
├── research/
│   ├── agents.ts     DSH sessions per stage (DeepSeekHarness)
│   ├── submission.ts reads submit_* results from session events
│   ├── types.ts      stage result types and helpers
│   └── prompts/      persona.md, plan.md, search_compare.md, write_report.md
├── state.ts          Firestore DAO (users, reports, workspaces, lock)
├── publisher.ts      Markdown → HTML (marked + footnotes) + GCS upload/snapshot
├── line.ts           @line/bot-sdk wrapper + signature verify
├── tasks.ts          Cloud Tasks dispatcher (OIDC, 30-min deadline) + OIDC verifier
├── intent.ts         keyword intent classifier
└── flex.ts           progress text + Flex card
dsh/
├── research.patch.yml  DSH profile overlay
└── plugin/             DSH plugin: web_research + submit_* tools
litellm/                sidecar image: Anthropic Messages → Gemini (Vertex AI)
deploy/                 service.yaml (multi-container), deploy.sh, setup scripts
tests/                  vitest unit tests + opt-in integration test
```

## Quick start (local)

Prerequisites: Node 24+, [uv](https://docs.astral.sh/uv/) (for the local
LiteLLM), `gcloud auth application-default login`, a GCP project with Vertex
AI enabled, and a LINE Messaging API channel.

```bash
cp .env.example .env      # fill in values
make install
make check                # typecheck + unit tests (no GCP needed)
make litellm              # terminal 1: LiteLLM on :4000
make test-integration     # terminal 2: real DSH + Gemini run, a few minutes
make run
```

## Deploy to Cloud Run

See [`deploy/README.md`](deploy/README.md). TL;DR:

```bash
PROJECT_ID=<project> REGION=asia-east1 \
SA_EMAIL=line-bot-sa@<project>.iam.gserviceaccount.com \
GCS_BUCKET=<bucket> ./deploy/deploy.sh
```

Then set the LINE webhook to `<service URL>/webhook` (Use webhook: ON,
auto-reply: OFF).

## Environment variables

| Var | Purpose |
|---|---|
| `GCP_PROJECT_ID` | GCP project (also used for Vertex AI) |
| `GCP_LOCATION` | Vertex AI location for Gemini (default `global`) |
| `GEMINI_MODEL` | Default `gemini-3.8-flash`; same alias in the LiteLLM sidecar |
| `GCS_BUCKET` | Where report HTML goes |
| `FIRESTORE_COLLECTION_PREFIX` | Default `line_bot_`; deploy uses `line_bot_dsh_` so it can share a project with the Go bot |
| `CLOUD_TASKS_QUEUE` / `CLOUD_TASKS_LOCATION` | Background job queue |
| `CLOUD_RUN_SERVICE_URL` | Service's own URL: Cloud Tasks target and expected OIDC audience |
| `SERVICE_ACCOUNT_EMAIL` | SA for the Cloud Tasks OIDC token (checked on receipt) |
| `LINE_CHANNEL_SECRET` / `LINE_CHANNEL_ACCESS_TOKEN` | LINE channel credentials (Secret Manager) |
| `LITELLM_BASE_URL` | Default `http://127.0.0.1:4000` (the sidecar) |
| `LITELLM_MASTER_KEY` | Shared key between app and sidecar (Secret Manager) |
| `DSH_HOME` | DSH runtime home (profiles, session logs); default `/tmp/dsh-home` |

## Status

DeepSeek Harness and `@deepseek-ai/dsh-sdk-client` are pre-release
(`0.2.1-rc.5`, pinned). dsh-superagent itself is a research prototype; this
repo borrows its runtime, not its code.
