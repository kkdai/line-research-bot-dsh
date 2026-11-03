import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHandler, type Runner } from '../src/server.ts'
import type { Job } from '../src/tasks.ts'
import { FakeLine, FakeStore, FakeTasks } from './fakes.ts'

class FakeWorker implements Runner {
  got: Job[] = []
  err?: Error
  async run(job: Job) {
    this.got.push(job)
    if (this.err) throw this.err
  }
}

let st: FakeStore, l: FakeLine, tk: FakeTasks, wk: FakeWorker, srv: Server, base: string
let verifyToken: ((t: string) => Promise<void>) | undefined

beforeEach(async () => {
  st = new FakeStore(); l = new FakeLine(); tk = new FakeTasks(); wk = new FakeWorker(); verifyToken = undefined
  srv = createServer((req, res) => createHandler({ store: st, line: l, tasks: tk, worker: wk, verifyToken })(req, res))
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
})
afterEach(() => new Promise<void>(r => srv.close(() => r())))

const msg = (text: string) => JSON.stringify({ events: [{ type: 'message', replyToken: 'rt', source: { userId: 'U1' }, message: { type: 'text', text } }] })
const post = (path: string, body: string, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: 'POST', body, headers: { 'X-Line-Signature': 'sig', ...headers } })

describe('webhook', () => {
  it('rejects a bad signature', async () => {
    l.validSignature = false
    expect((await post('/webhook', msg('研究 X'))).status).toBe(401)
  })

  it('enqueues a new research and takes the lock', async () => {
    const res = await post('/webhook', msg('研究 向量資料庫'))
    expect(res.status).toBe(200)
    expect(tk.jobs).toHaveLength(1)
    expect(tk.jobs[0]).toMatchObject({ mode: 'new', topic: '研究 向量資料庫', line_user_id: 'U1' })
    expect(st.locks.has('U1')).toBe(true)
    expect(l.replies[0]).toBe('📋 已收到題目，開始規劃…')
  })

  it('routes deepen and retry', async () => {
    st.user().currentReportId = 'r1'
    await post('/webhook', msg('第 2 章再深一點'))
    expect(tk.jobs[0]).toMatchObject({ mode: 'deepen', report_id: 'r1' })
    st.locks.clear()
    st.user().pendingAction = 'retry_publish'
    await post('/webhook', msg('再發佈一次'))
    expect(tk.jobs[1]!.mode).toBe('retry_publish')
  })

  it('refuses while another job runs', async () => {
    st.lockedFor.add('U1')
    await post('/webhook', msg('研究 X'))
    expect(tk.jobs).toHaveLength(0)
    expect(l.replies[0]).toContain('還在跑')
  })

  it('releases the lock when enqueueing fails', async () => {
    tk.err = new Error('down')
    await post('/webhook', msg('研究 X'))
    expect(st.locks.has('U1')).toBe(false)
    expect(l.replies[0]).toBe('排程失敗，請稍後再試。')
  })

  it('handles recall, chitchat, reset and non-text messages', async () => {
    st.user().currentReportId = 'r1'
    await st.createReport('r1', 'U1', 't', 's', 'https://x/r1/index.html')
    st.workspaces.set('U1', { topic: 't', plan: '', sources: '', report_md: '' })
    await post('/webhook', msg('上次的連結'))
    await post('/webhook', msg('hi'))
    await post('/webhook', msg('重新開始'))
    await post('/webhook', JSON.stringify({ events: [{ type: 'message', replyToken: 'rt', source: { userId: 'U1' }, message: { type: 'image' } }] }))
    const want = ['上次的報告連結：\nhttps://x/r1/index.html', '哈囉', '✅ 已清空', '目前只支援文字']
    want.forEach((w, i) => expect(l.replies[i]).toMatch(new RegExp('^' + w)))
    expect(st.user().currentReportId).toBe('')
    expect(st.workspaces.has('U1')).toBe(false)
  })
})

describe('/tasks/run-research', () => {
  const body = JSON.stringify({ line_user_id: 'U1', topic: 't', mode: 'new', task_id: 't-1' })

  it('checks the OIDC token and always releases the lock', async () => {
    verifyToken = async t => { if (t !== 'good') throw new Error('bad') }
    expect((await post('/tasks/run-research', body)).status).toBe(401)
    expect((await post('/tasks/run-research', body, { Authorization: 'Bearer bad' })).status).toBe(401)

    st.locks.set('U1', 't-1')
    expect((await post('/tasks/run-research', body, { Authorization: 'Bearer good' })).status).toBe(200)
    expect(wk.got).toHaveLength(1)
    expect(st.locks.has('U1')).toBe(false)

    wk.err = new Error('firestore down')
    st.locks.set('U1', 't-1')
    expect((await post('/tasks/run-research', body, { Authorization: 'Bearer good' })).status).toBe(500)
    expect(st.locks.has('U1')).toBe(false)
  })

  it('rejects incomplete jobs', async () => {
    expect((await post('/tasks/run-research', '{"topic":"t"}')).status).toBe(400)
  })
})

it('serves /readyz', async () => {
  expect((await fetch(base + '/readyz')).status).toBe(200)
})
