import { beforeEach, describe, expect, it } from 'vitest'
import { Worker } from '../src/worker.ts'
import type { Job } from '../src/tasks.ts'
import { FakeAgents, FakeLine, FakePublisher, FakeStore } from './fakes.ts'

let s: FakeStore, a: FakeAgents, l: FakeLine, p: FakePublisher, w: Worker
const boom = new Error('boom')
const run = (job: Partial<Job>) => w.run({ line_user_id: 'U1', topic: '', mode: 'new', task_id: 't', ...job }, AbortSignal.timeout(10_000))

beforeEach(() => {
  s = new FakeStore(); a = new FakeAgents(); l = new FakeLine(); p = new FakePublisher()
  w = new Worker(s, a, l, p, 'b', { planMs: 1000, searchMs: 1000, writeMs: 1000, retryWaitMs: 1 })
  w.newId = () => 'rid'
})

function seedReport() {
  const now = new Date()
  s.reports.set('rid', { reportId: 'rid', user_id: 'U1', topic: 'topic', summary: '', gcs_url: 'https://x/rid/index.html', version: 1, history: [], created_at: now, updated_at: now })
  s.user().currentReportId = 'rid'
  s.workspaces.set('U1', { topic: 'topic', plan: '{}', sources: '{"sources":[]}', report_md: '# v1' })
}

describe('worker', () => {
  it('runs a new research end to end', async () => {
    await run({ topic: '研究 X' })
    expect(l.texts).toHaveLength(2)
    expect(l.texts[0]).toContain('5 類來源')
    expect(l.texts[1]).toContain('6 份來源，發現 2')
    expect(l.flex).toHaveLength(1)
    expect(p.calls).toEqual([{ reportId: 'rid', md: '# report', version: 1, snapshot: 0 }])
    expect(s.user()).toMatchObject({ currentReportId: 'rid', lastInteractionId: 'ses-write', lastAttemptTopic: '研究 X' })
    expect(s.workspaces.get('U1')).toMatchObject({ plan: '{"plan":1}', sources: '{"sources":[]}', report_md: '# report' })
  })

  it('reports a plan failure', async () => {
    a.planErr = boom
    await run({ topic: 't' })
    expect(l.texts).toEqual(['規劃失敗，請換個說法重試。'])
    expect(s.user().currentReportId).toBe('')
  })

  it('sets retry_write after two failed writes, and retry_write recovers', async () => {
    a.writeErr = boom
    await run({ topic: 't' })
    expect(a.writeCalls).toBe(2)
    expect(s.user().pendingAction).toBe('retry_write')
    expect(l.texts.at(-1)).toContain('再試一次')

    a.writeErr = undefined
    await run({ mode: 'retry_write' })
    expect(s.user()).toMatchObject({ pendingAction: '', currentReportId: 'rid' })
    expect(l.flex).toHaveLength(1)
  })

  it('sets retry_publish when publishing fails, and retry_publish republishes', async () => {
    p.err = boom
    await run({ topic: 't' })
    expect(s.user().pendingAction).toBe('retry_publish')
    expect(s.reports.get('rid')!.summary).toBe('(尚未發佈成功)')

    p.err = undefined
    await run({ mode: 'retry_publish' })
    expect(p.calls.at(-1)!.md).toBe('# report')
    expect(s.user().pendingAction).toBe('')
    expect(l.texts.at(-1)).toMatch(/^✅ 已重新發佈/)
  })

  it('deepens a report: snapshot, version bump, merged sources', async () => {
    seedReport()
    a.write = { report_md: '# v2', summary_500: 'new sum', added_sources: [{ title: 'jp', url: 'https://jp', lang: 'ja', summary: '', key_claims: [] }] }
    await run({ topic: '第 2 章再深一點', mode: 'deepen', report_id: 'rid' })
    expect(a.lastWrite).toMatchObject({ mode: 'deepen', reportMD: '# v1', previousVersion: 1 })
    expect(p.calls[0]).toMatchObject({ version: 2, snapshot: 1 })
    const r = s.reports.get('rid')!
    expect(r.version).toBe(2)
    expect(r.summary).toBe('new sum')
    expect(r.history[0]!.gcs_snapshot_url).toBe('https://storage.googleapis.com/b/rid/snapshots/v1.html')
    expect(s.workspaces.get('U1')!.report_md).toBe('# v2')
    expect(s.workspaces.get('U1')!.sources).toContain('https://jp')
    expect(l.flex).toHaveLength(1)
  })

  it('lists chapters when the requested one does not exist', async () => {
    seedReport()
    a.write = { error: 'chapter_not_found', available_chapters: ['1. A', '2. B'] }
    await run({ topic: '第 9 章', mode: 'deepen', report_id: 'rid' })
    expect(p.calls).toHaveLength(0)
    expect(l.texts[0]).toBe('找不到指定章節。目前報告章節如下：\n1. A\n2. B')
    expect(s.reports.get('rid')!.version).toBe(1)
  })

  it('falls back to report headings when the error value is mangled', async () => {
    seedReport()
    s.workspaces.get('U1')!.report_md = '# T\n\n## 第一章 A\n\ntext\n\n## 第二章 B\n'
    a.write = { error: 'chapter_not_found_chapter_not_found' }
    await run({ topic: '第 9 章', mode: 'deepen', report_id: 'rid' })
    expect(p.calls).toHaveLength(0)
    expect(l.texts[0]).toBe('找不到指定章節。目前報告章節如下：\n第一章 A\n第二章 B')
  })

  it('does not publish an empty deepened report', async () => {
    seedReport()
    a.write = { error: 'something_else', report_md: '   ' }
    await run({ topic: '第 1 章', mode: 'deepen', report_id: 'rid' })
    expect(p.calls).toHaveLength(0)
    expect(l.texts[0]).toBe('深化失敗，請稍後再試。')
  })

  it('restarts the research when the workspace is gone', async () => {
    seedReport()
    s.workspaces.delete('U1')
    await run({ topic: '第 2 章', mode: 'deepen', report_id: 'rid' })
    expect(l.texts[0]).toBe('上次研究檔案已過期，重新從頭研究 🔄')
    expect(l.flex).toHaveLength(1)
    expect(s.user().lastAttemptTopic).toBe('topic')
  })

  it('rejects an unknown user so Cloud Tasks retries', async () => {
    await expect(run({ line_user_id: 'nobody' })).rejects.toThrow(/not found/)
  })
})
