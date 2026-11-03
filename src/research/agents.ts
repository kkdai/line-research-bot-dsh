// The research stages as DeepSeek Harness (DSH) sessions.
//
// The Go version ran three ADK llmagents. Here each stage is one DSH session
// in a short-lived `dsh` runtime subprocess (profile `sdk-minimal` plus
// dsh/research.patch.yml), driven over stdio JSON-RPC by
// @deepseek-ai/dsh-sdk-client:
//
//   host ──JSON-RPC──▶ dsh runtime ──Anthropic Messages──▶ LiteLLM sidecar ──▶ Gemini (Vertex AI)
//                         │
//                         └─ plugin tools: web_research (Gemini + Google Search), submit_*
//
// Working memory (plan, sources, report) stays in Firestore and is inlined
// into each stage's prompt, so instances remain stateless.

import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { assertTurnCompleted, extractSubmission, type EventLike } from './submission.ts'
import { AgentError, type Agents, type Output, type PlanResult, type SearchResult, type WriteInput, type WriteResult } from './types.ts'

const ROOT = resolve(import.meta.dirname, '../..')
const PLUGIN_URL = pathToFileURL(join(ROOT, 'dsh/plugin/index.js')).href
const prompt = (name: string) => readFileSync(join(import.meta.dirname, 'prompts', `${name}.md`), 'utf8')
const PERSONA = prompt('persona')
const PLAN = prompt('plan')
const SEARCH = prompt('search_compare')
const WRITE = prompt('write_report')

/** Fills `{key}` placeholders in one pass, so braces inside inserted JSON are left alone. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-z_]+)\}/g, (m, key: string) => (key in values ? values[key]! : m))
}

export interface DshAgentsOptions {
  /** Anthropic Messages-compatible root of the LiteLLM sidecar, e.g. http://127.0.0.1:4000 */
  llmBaseURL: string
  llmApiKey: string
  /** Model id as LiteLLM names it. */
  model: string
  gcpProject: string
  gcpLocation: string
  /** DSH_HOME for the runtime: profiles and session logs. Must be writable. */
  dshHome: string
  maxTokens?: number
}

/** The host env minus app secrets the runtime has no use for (it reaches Vertex AI through ADC). */
export function runtimeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env }
  for (const key of ['LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN', 'LITELLM_MASTER_KEY']) delete out[key]
  return out
}

/** Renders dsh/research.patch.yml with the plugin's absolute URL into dshHome; returns its path. */
export async function renderPatch(dshHome: string): Promise<string> {
  const template = readFileSync(join(ROOT, 'dsh/research.patch.yml'), 'utf8')
  const path = join(dshHome, 'research.patch.yml')
  await mkdir(dshHome, { recursive: true })
  await writeFile(path, template.replaceAll('{{PLUGIN_URL}}', PLUGIN_URL))
  return path
}

export class DshAgents implements Agents {
  private readonly opts: DshAgentsOptions
  private patch?: Promise<string>

  constructor(opts: DshAgentsOptions) {
    this.opts = opts
  }

  async plan(userId: string, topic: string, signal: AbortSignal): Promise<Output<PlanResult>> {
    return this.stage<PlanResult>(userId, fill(PLAN, { topic }), 'submit_plan', signal)
  }

  async searchCompare(userId: string, planJSON: string, signal: AbortSignal): Promise<Output<SearchResult>> {
    return this.stage<SearchResult>(userId, fill(SEARCH, { plan: planJSON }), 'submit_sources', signal)
  }

  async writeReport(userId: string, input: WriteInput, signal: AbortSignal): Promise<Output<WriteResult>> {
    const text = fill(WRITE, {
      sources: input.sourcesJSON,
      report_md: input.reportMD ?? '',
      report_id: input.reportID,
      mode: input.mode,
      previous_version: input.mode === 'deepen' ? String(input.previousVersion ?? 0) : '(none)',
      deepen_request: input.deepenRequest ?? '(none)',
    })
    return this.stage<WriteResult>(userId, text, 'submit_report', signal)
  }

  private async stage<T>(userId: string, text: string, tool: string, signal: AbortSignal): Promise<Output<T>> {
    signal.throwIfAborted()
    this.patch ??= renderPatch(this.opts.dshHome)
    const patch = await this.patch
    const workdir = await mkdtemp(join(tmpdir(), 'research-'))
    const harness = new DeepSeekHarness({
      profile: 'sdk-minimal',
      patches: [patch],
      dshHome: this.opts.dshHome,
      processCwd: ROOT,
      cwd: workdir,
      provider: 'deepseek-official',
      model: this.opts.model,
      maxTokens: this.opts.maxTokens ?? 32_000,
      initializeTimeoutMs: 60_000,
      env: {
        ...runtimeEnv(process.env),
        DEEPSEEK_BASE_URL: this.opts.llmBaseURL,
        DEEPSEEK_API_KEY: this.opts.llmApiKey,
        DSH_SYSTEM_PROMPT: PERSONA,
        GCP_PROJECT_ID: this.opts.gcpProject,
        GCP_LOCATION: this.opts.gcpLocation,
        RESEARCH_MODEL: this.opts.model,
      },
    })
    // The SDK has no per-run cancel: abandoning a turn means closing the runtime.
    const onAbort = () => void harness.close().catch(() => {})
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const result = await harness.run(`[user ${userId}]\n\n${text}`)
      signal.throwIfAborted()
      const events = result.events as unknown as EventLike[]
      assertTurnCompleted(events)
      const { value, raw } = extractSubmission<T>(events, tool)
      return { value, raw, sessionId: result.sessionId }
    } catch (err) {
      if (signal.aborted) throw new AgentError(`stage ${tool} timed out`)
      throw err instanceof AgentError ? err : new AgentError(`stage ${tool} failed: ${(err as Error).message}`)
    } finally {
      signal.removeEventListener('abort', onAbort)
      await harness.close().catch(() => {})
      await rm(workdir, { recursive: true, force: true }).catch(() => {})
    }
  }
}
