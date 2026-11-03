// Real DSH runtime + LiteLLM + Gemini on Vertex AI. Opt-in:
//
//   GCP_PROJECT_ID=<project> LITELLM_MASTER_KEY=<key> npm run test:integration
//
// Needs a LiteLLM proxy on LITELLM_BASE_URL (default http://127.0.0.1:4000),
// e.g. `make litellm`, and Application Default Credentials.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DshAgents } from '../src/research/agents.ts'
import { chapterNotFound } from '../src/research/types.ts'

const enabled = !!process.env.RUN_INTEGRATION
const minutes = (n: number) => n * 60_000

describe.runIf(enabled)('research stages on DSH', () => {
  const agents = new DshAgents({
    llmBaseURL: process.env.LITELLM_BASE_URL ?? 'http://127.0.0.1:4000',
    llmApiKey: process.env.LITELLM_MASTER_KEY ?? '',
    model: process.env.GEMINI_MODEL ?? 'gemini-3.8-flash',
    gcpProject: process.env.GCP_PROJECT_ID ?? '',
    gcpLocation: process.env.GCP_LOCATION ?? 'global',
    dshHome: mkdtempSync(join(tmpdir(), 'dsh-home-')),
  })

  it('plans, researches, writes and deepens', async () => {
    const plan = await agents.plan('U-it', '研究 Cloud Run sidecar 的使用情境', AbortSignal.timeout(minutes(3)))
    expect(plan.value.queries.length).toBeGreaterThanOrEqual(3)
    expect(plan.sessionId).toBeTruthy()

    const search = await agents.searchCompare('U-it', plan.raw, AbortSignal.timeout(minutes(10)))
    expect(search.value.sources.length).toBeGreaterThan(0)
    for (const s of search.value.sources) expect(s.url).toMatch(/^https?:\/\//)

    const write = await agents.writeReport('U-it', { sourcesJSON: search.raw, reportID: 'rid-it', mode: 'new' }, AbortSignal.timeout(minutes(8)))
    expect(write.value.report_id).toBe('rid-it')
    expect(write.value.report_md).toMatch(/^#\s/m)
    expect(write.value.summary_500.length).toBeGreaterThan(50)

    const missing = await agents.writeReport('U-it', {
      sourcesJSON: search.raw, reportMD: write.value.report_md, reportID: 'rid-it',
      mode: 'deepen', previousVersion: 1, deepenRequest: '第 99 章再深一點',
    }, AbortSignal.timeout(minutes(8)))
    expect(chapterNotFound(missing.value)).toBe(true)
  }, minutes(30))
})
